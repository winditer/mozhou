/**
 * 把 `mz-edit` 的 op 变成「能画在界面上、能一键应用」的具体改动。
 *
 * 两件事分开做，因为它们的正确性标准不同：
 *
 *   resolveEdits —— 只读。逐条回正文/大纲/设定里定位，产出改前/改后。
 *                   定位不到就是定位不到，绝不猜、也不许退化成整章重写。
 *   applyResolved —— 纯函数。拿已经定好位的改动一次算出新 Project。
 *
 * 分成纯函数是因为它最需要被测：改稿是这套功能里唯一不可逆的动作，
 * 而纯函数能在 node 里跑几百个用例，不用起 Electron。
 */
import type { Chapter, OutlineNode, Project } from '@shared/types'
import { uid, outlineTitleKey } from '@shared/utils'
import {
  BIBLE_SCHEMA,
  resolveChapterRef,
  resolveOutlineNode,
  type BibleCollection,
  type EditOp
} from '@shared/editProtocol'
import { paragraphMatches, splitParagraphs, textToParagraph } from './paragraphs'

export type EditStatus = 'found' | 'ambiguous' | 'not-found'

/**
 * 一轮最多给几章写稿。
 * 写一章是一次完整生成（默认 2500 字、带自动补写），两三章连着跑会让作者以为卡死；
 * 超出的那条降级成「只建章」，让他下一轮再说。
 */
const MAX_ROUND_DRAFTS = 2

export interface ResolvedEdit {
  op: EditOp
  status: EditStatus
  /** 这一条改的是哪一类东西：正文段落 / 字段 / 新增条目 */
  display: 'paragraph' | 'field' | 'new-entry'
  /** 给人看的一行标题，如「第3章 第 4 段」或「角色卡·林昭·动机」 */
  label: string
  chapterId?: string
  chapterTitle?: string
  /** 正文段落改动时是原段落纯文本；字段改动时是旧值；新增条目时为空 */
  before: string
  /** 新内容 */
  after: string
  /** 正文改动的段落下标（applyResolved 用它定位） */
  paragraphIndex?: number
  /** 歧义时所有命中段落下标 */
  hits?: number[]
  /** 补充说明：候选章节、大纲路径、全书命中数等 */
  note?: string
  /**
   * 这句话其实在别的章里：AI 报的章节不对，按逐字匹配把它找回来了。
   * 界面要显眼标出来——「改哪一章」是作者最需要复核的信息。
   */
  chapterCorrected?: boolean
  /** 设定改动：集合与识别名，apply 时用来回写 */
  collection?: BibleCollection
  entryName?: string
  /** create_chapter 建完之后要不要写稿：有值就是写，targetWords 用于预算 */
  draftTarget?: { title: string; targetWords: number }
  /** write_chapter 的目标：已有正文的章按差额接着写 */
  writeTarget?: { chapterId: string; targetWords: number; continueOnly: boolean }
  /** create_chapter 建章所需的一切 */
  chapterCreate?: { title: string; summary: string; targetWords: number; afterIndex?: number; parentId?: string }
  /** 新增大纲节点时带过去的数据 */
  outlineNode?: { parentId?: string; title: string; summary: string; status: OutlineNode['status'] }
  /** 设定改动的字段名 */
  fieldName?: string
}

/* ────────────────────────────── 定位 ────────────────────────────── */

const MAX_LITERAL_HITS = 500

function chapterLabel(c: Chapter): string {
  return c.title || '（未命名章节）'
}

/** 在章节正文里找 anchor 落在哪些段。跳过标题段——那是章名，改了文档结构就散 */
function findParagraphs(chapter: Chapter, anchor: string): { indexes: number[]; exact: boolean } {
  const paragraphs = splitParagraphs(chapter.content)
  const indexes: number[] = []
  let exact = false
  paragraphs.forEach((p, i) => {
    if (/^<(h[1-6])\b/i.test(p.html)) return
    const hit = paragraphMatches(p.text, anchor)
    if (!hit) return
    if (hit === 'exact') exact = true
    indexes.push(i)
  })
  return { indexes, exact }
}

/**
 * 在**其它**章里找 anchor。用于 AI 报错章节时的兜底。
 *
 * 只做逐字/归一化匹配（沿用 paragraphMatches），不做模糊相似度：
 * 找回来的是「确实写着这几个字的那一段」，作者在预览里能立刻认出是不是要改的地方。
 * 相似度匹配会把「差不多的一段」当成目标，那才是真正的猜。
 */
function findAcrossChapters(project: Project, anchor: string, excludeId: string): { chapterId: string; indexes: number[] }[] {
  if (!anchor.trim()) return []
  return project.chapters
    .filter((c) => c.id !== excludeId)
    .map((c) => ({ chapterId: c.id, indexes: findParagraphs(c, anchor).indexes }))
    .filter((x) => x.indexes.length > 0)
}

/**
 * 逐条定位。返回顺序与入参一致，界面按章分组时再排。
 *
 * 三种结果都要能画：found 可勾选；ambiguous 列出所有命中段让作者自己在对话里说清；
 * not-found 红字说明「第 3 章里没找到这句话」——作者一句话就能补正，猜反而是灾难。
 */
export function resolveEdits(project: Project, ops: EditOp[]): ResolvedEdit[] {
  // 一轮最多 2 章写稿：一次点应用就长跑十分钟，是这一功能最容易失控的地方
  const budget = { draftLeft: MAX_ROUND_DRAFTS }
  // 一条 op 可能展成多条改动（全书替换会命中很多段、设定改动会改很多字段），
  // 所以这里 flatMap，界面上一行一条，作者才能逐条否决
  return ops.flatMap((op) => {
    const r = resolveOne(project, op, budget)
    return Array.isArray(r) ? r : [r]
  })
}

function resolveOne(project: Project, op: EditOp, budget: { draftLeft: number }): ResolvedEdit | ResolvedEdit[] {
  switch (op.op) {
    case 'replace_paragraph':
    case 'insert_paragraph':
    case 'delete_paragraph': {
      const ref = resolveChapterRef(project, op.chapter ?? '')
      if (!ref.chapterId) {
        const cands = ref.candidates.map((c) => c.title)
        // 章号都指不准时，还有最后一招：这句话全书只有一处逐字对得上，就把它捞回来。
        // （模型写「第 30 章」而书里只有 29 章，这种错很常见。）
        const found = findAcrossChapters(project, op.anchor ?? '', '')
        if (cands.length === 0 && found.length === 1 && found[0].indexes.length === 1) {
          const target = project.chapters.find((c) => c.id === found[0].chapterId) as Chapter
          const paras = splitParagraphs(target.content)
          const i = found[0].indexes[0]
          const p = paras[i]
          return {
            op,
            status: 'found',
            display: 'paragraph',
            label: `${chapterLabel(target)} · 第 ${i + 1} 段`,
            chapterId: target.id,
            chapterTitle: chapterLabel(target),
            before: op.op === 'insert_paragraph' ? '' : p.text,
            after: op.op === 'delete_paragraph' ? '' : (op.after ?? ''),
            paragraphIndex: i,
            chapterCorrected: true,
            note: `AI 报的章节「${op.chapter ?? ''}」在书里对不上，这句话只在「${chapterLabel(target)}」里出现过`
          }
        }
        return {
          op,
          status: 'not-found',
          display: 'paragraph',
          label: op.chapter ? `章节「${op.chapter}」` : '（未指定章节）',
          before: '',
          after: op.after ?? '',
          note: cands.length
            ? `这本书里有 ${cands.length} 章对得上，请指明是哪一个：${cands.join('、')}`
            : '书里找不到这一章，请用完整章节标题再试一次'
        }
      }
      const chapter = project.chapters.find((c) => c.id === ref.chapterId) as Chapter
      const anchor = op.anchor ?? ''
      const { indexes } = findParagraphs(chapter, anchor)
      const chapters = splitParagraphs(chapter.content)
      if (!indexes.length) {
        // AI 报的章节经常不对：它手里可能还攥着上一章的正文（问的时候在写第 28 章，
        // 落笔却写了「第 29 章」）。这时按**逐字匹配**到全书找一遍——这是定位，不是猜：
        // 找回来了也照样在预览里标明「AI 说的是第29章，这句话在第28章」，作者一点就否掉。
        // 全书中命中多处时仍然只标歧义，绝不挑一个。
        const found = findAcrossChapters(project, anchor, chapter.id)
        if (found.length === 1 && found[0].indexes.length === 1) {
          const hit = found[0]
          const target = project.chapters.find((c) => c.id === hit.chapterId) as Chapter
          const paras = splitParagraphs(target.content)
          const i = hit.indexes[0]
          const p = paras[i]
          return {
            op,
            status: 'found',
            display: 'paragraph',
            label: `${chapterLabel(target)} · 第 ${i + 1} 段`,
            chapterId: target.id,
            chapterTitle: chapterLabel(target),
            before: op.op === 'insert_paragraph' ? '' : p.text,
            after: op.op === 'delete_paragraph' ? '' : (op.after ?? ''),
            paragraphIndex: i,
            chapterCorrected: true,
            note: [
              `AI 说是「${chapterLabel(chapter)}」，这句话实际在「${chapterLabel(target)}」`,
              op.op === 'insert_paragraph' ? `在「${p.text.slice(0, 18)}…」之后插入` : undefined
            ]
              .filter(Boolean)
              .join('；')
          }
        }
        return {
          op,
          status: found.length ? 'ambiguous' : 'not-found',
          display: 'paragraph',
          label: chapterLabel(chapter),
          chapterId: chapter.id,
          chapterTitle: chapterLabel(chapter),
          before: '',
          after: op.after ?? '',
          note: found.length
            ? `这一章里没有这句话，但全书中${found
                .map((f) => `「${chapterLabel(project.chapters.find((c) => c.id === f.chapterId) as Chapter)}」${f.indexes.length} 处`)
                .join('、')}能对上，请指明改哪一处`
            : '这一章里没找到这句话，全书也没有逐字对得上的段落。请让 AI 重新摘录原文，或直接把那句原文贴给它'
        }
      }
      if (indexes.length > 1) {
        return {
          op,
          status: 'ambiguous',
          display: 'paragraph',
          label: chapterLabel(chapter),
          chapterId: chapter.id,
          chapterTitle: chapterLabel(chapter),
          before: chapters[indexes[0]].text,
          after: op.after ?? '',
          hits: indexes.map((i) => i + 1),
          note: `同样的话在这一章出现了 ${indexes.length} 次（第 ${indexes.map((i) => i + 1).join('、')} 段），请指明改哪一段`
        }
      }
      const i = indexes[0]
      const p = chapters[i]
      return {
        op,
        status: 'found',
        display: 'paragraph',
        label: `${chapterLabel(chapter)} · 第 ${i + 1} 段`,
        chapterId: chapter.id,
        chapterTitle: chapterLabel(chapter),
        before: op.op === 'insert_paragraph' ? '' : p.text,
        after: op.op === 'delete_paragraph' ? '' : (op.after ?? ''),
        paragraphIndex: i,
        note: op.op === 'insert_paragraph' ? `在「${p.text.slice(0, 18)}…」之后插入一段` : undefined
      }
    }

    case 'replace_literal': {
      const chapters =
        op.scope === 'chapter'
          ? (() => {
              const ref = resolveChapterRef(project, op.chapter ?? '')
              return ref.chapterId ? project.chapters.filter((c) => c.id === ref.chapterId) : []
            })()
          : project.chapters
      if (!chapters.length) {
        return {
          op,
          status: 'not-found',
          display: 'paragraph',
          label: op.chapter ? `章节「${op.chapter}」` : '全书',
          before: '',
          after: op.to ?? '',
          note: '找不到要替换的章节'
        }
      }
      const from = op.from ?? ''
      const to = op.to ?? ''
      const out: ResolvedEdit[] = []
      for (const c of chapters) {
        const paragraphs = splitParagraphs(c.content)
        paragraphs.forEach((p, i) => {
          if (/^<(h[1-6])\b/i.test(p.html)) return
          if (!p.text.includes(from)) return
          const count = p.text.split(from).length - 1
          out.push({
            op,
            status: 'found',
            display: 'paragraph',
            label: `${chapterLabel(c)} · 第 ${i + 1} 段`,
            chapterId: c.id,
            chapterTitle: chapterLabel(c),
            before: p.text,
            after: p.text.split(from).join(to),
            paragraphIndex: i,
            note: count > 1 ? `这一段里有 ${count} 处` : undefined
          })
        })
      }
      if (!out.length) {
        return {
          op,
          status: 'not-found',
          display: 'paragraph',
          label: op.scope === 'chapter' ? `章节「${op.chapter}」` : '全书',
          before: '',
          after: to,
          note: `「${from}」在${op.scope === 'chapter' ? '这一章' : '全书'}里一次都没出现`
        }
      }
      if (out.length > MAX_LITERAL_HITS) {
        // 极端情况不静默截断：保留前 N 条，并把总量说清楚
        const kept = out.slice(0, MAX_LITERAL_HITS)
        kept[0] = {
          ...kept[0],
          note: `命中 ${out.length} 段，先列出前 ${MAX_LITERAL_HITS} 段；建议把范围缩到单章再改`
        }
        return kept
      }
      out[0] = { ...out[0], note: [out[0].note, `共 ${out.length} 段命中`].filter(Boolean).join('；') }
      return out
    }

    case 'set_chapter_summary': {
      const ref = resolveChapterRef(project, op.chapter ?? '')
      if (!ref.chapterId) {
        return {
          op,
          status: 'not-found',
          display: 'field',
          label: op.chapter ? `章节「${op.chapter}」` : '（未指定章节）',
          before: '',
          after: op.after ?? '',
          note: ref.candidates.length
            ? `对得上的章节有：${ref.candidates.map((c) => c.title).join('、')}`
            : '书里找不到这一章'
        }
      }
      const chapter = project.chapters.find((c) => c.id === ref.chapterId) as Chapter
      return {
        op,
        status: 'found',
        display: 'field',
        label: `${chapterLabel(chapter)} · 梗概`,
        chapterId: chapter.id,
        chapterTitle: chapterLabel(chapter),
        before: chapter.summary ?? '',
        after: op.after ?? ''
      }
    }

    case 'set_outline_node': {
      const ref = resolveOutlineNode(project.outline, op.node ?? '')
      if (!ref.node) {
        return {
          op,
          status: 'not-found',
          display: 'field',
          label: `大纲节点「${op.node ?? ''}」`,
          before: '',
          after: op.after ?? '',
          note: ref.candidates.length
            ? `同名的节点有 ${ref.candidates.length} 个：${ref.candidates.map((c) => c.title).join('、')}`
            : `大纲里还没有「${op.node ?? ''}」这个节点。如果是要补一章新大纲，请让 AI 改用 add_outline_node 新增`
        }
      }
      const field = op.field ?? 'summary'
      const oldVal = field === 'title' ? ref.node.title : field === 'summary' ? ref.node.summary : ref.node.status
      return {
        op,
        status: 'found',
        display: 'field',
        label: `大纲 · ${ref.path.join(' › ')} · ${field === 'title' ? '标题' : field === 'summary' ? '情节点' : '状态'}`,
        before: String(oldVal ?? ''),
        after: op.after ?? '',
        note: ref.path.length > 1 ? ref.path.slice(0, -1).join(' › ') : undefined
      }
    }

    case 'add_outline_node': {
      const title = (op.title ?? '').trim()
      if (!title) {
        return {
          op,
          status: 'not-found',
          display: 'new-entry',
          label: '新增大纲节点',
          before: '',
          after: '',
          note: '没给出节点标题'
        }
      }
      // 已经有同名节点就不加：大纲里两个「第 30 章」会让后续按标题定位全乱
      const dup = flattenOutlineTitles(project.outline).find((t) => t.title.trim() === title)
      if (dup) {
        return {
          op,
          status: 'not-found',
          display: 'new-entry',
          label: `新增大纲节点「${title}」`,
          before: '',
          after: '',
          note: `大纲里已经有「${dup.title}」了，要改内容请用 set_outline_node`
        }
      }
      const parentRef = op.parent ? resolveOutlineNode(project.outline, op.parent) : null
      if (op.parent && !parentRef?.node) {
        const cands = parentRef?.candidates.map((c) => c.title) ?? []
        return {
          op,
          status: 'not-found',
          display: 'new-entry',
          label: `新增大纲节点「${title}」`,
          before: '',
          after: '',
          note: cands.length
            ? `要挂的节点有 ${cands.length} 个同名：${cands.join('、')}`
            : `大纲里没有「${op.parent}」这个节点，请换用卷标题或省略 parent`
        }
      }
      const parent = parentRef?.node
      const status = op.status ?? 'planned'
      const summary = op.summary ?? ''
      return {
        op,
        status: 'found',
        display: 'new-entry',
        label: `新增大纲节点「${title}」${parent ? `· 挂在 ${parentRef?.path.join(' › ')}` : '· 挂在最后一卷'}`,
        before: '',
        after: [title, summary, OUTLINE_STATUS_LABEL[status]].filter(Boolean).join('　'),
        outlineNode: { parentId: parent?.id, title, summary, status }
      }
    }

    case 'create_chapter': {
      const title = (op.title ?? '').trim()
      const key = outlineTitleKey(title)
      const clashChapter = project.chapters.find((c) => outlineTitleKey(c.title) === key)
      const clashNode = flattenOutlineTitles(project.outline).find((t) => outlineTitleKey(t.title) === key)
      if (clashChapter || clashNode) {
        return {
          op,
          status: 'not-found',
          display: 'new-entry',
          label: `新建章节「${title}」`,
          before: '',
          after: '',
          note: clashChapter
            ? `书里已经有「${clashChapter.title}」这一章了，要改它请用 set_chapter_summary / replace_paragraph`
            : `大纲里已经有「${clashNode?.title}」这个节点了，要建章请换个标题，或先让作者在大纲页处理`
        }
      }
      const parentRef = op.parent ? resolveOutlineNode(project.outline, op.parent) : null
      if (op.parent && !parentRef?.node) {
        return {
          op,
          status: 'not-found',
          display: 'new-entry',
          label: `新建章节「${title}」`,
          before: '',
          after: '',
          note: `大纲里没有「${op.parent}」这个节点，请换用卷标题或省略 parent`
        }
      }
      let afterIndex: number | undefined
      if (op.after) {
        const ref = resolveChapterRef(project, op.after)
        if (!ref.chapterId) {
          return {
            op,
            status: 'not-found',
            display: 'new-entry',
            label: `新建章节「${title}」`,
            before: '',
            after: '',
            note: `找不到要插在后面的章节「${op.after}」`
          }
        }
        afterIndex = project.chapters.findIndex((c) => c.id === ref.chapterId)
      }
      const targetWords = op.targetWords ?? Math.max(300, Math.round(project.settings?.targetWordsPerChapter || 2500))
      const parent = parentRef?.node
      const outlineRow: ResolvedEdit = {
        op: { op: 'add_outline_node', parent: op.parent, title, summary: op.summary ?? '', status: 'planned' },
        status: 'found',
        display: 'new-entry',
        label: `新增大纲节点「${title}」`,
        before: '',
        after: [title, op.summary ?? '', OUTLINE_STATUS_LABEL.planned].filter(Boolean).join('　'),
        outlineNode: { parentId: parent?.id, title, summary: op.summary ?? '', status: 'planned' },
        note: parent ? `挂在 ${parentRef?.path.join(' › ')}` : '挂在最后一卷'
      }
      // 限额：前两章写稿，其余只建章
      const wantsDraft = op.draft === true
      const allowDraft = wantsDraft && budget.draftLeft > 0
      if (allowDraft) budget.draftLeft -= 1
      const chapterRow: ResolvedEdit = {
        op,
        status: 'found',
        display: 'new-entry',
        label: `新增章节「${title}」`,
        before: '',
        after: [
          `目标 ${targetWords} 字`,
          op.after ? `插在「${op.after}」之后` : '加在书尾',
          allowDraft ? '应用后开始写初稿' : ''
        ]
          .filter(Boolean)
          .join('　'),
        chapterCreate: { title, summary: op.summary ?? '', targetWords, afterIndex, parentId: parent?.id },
        draftTarget: allowDraft ? { title, targetWords } : undefined,
        note:
          wantsDraft && !allowDraft
            ? '这一轮先建章，写稿下一轮再说（一次最多 2 章）'
            : op.after
              ? '只改顺序，不重排后面章节的标题编号'
              : undefined
      }
      return [outlineRow, chapterRow]
    }

    case 'write_chapter': {
      const ref = resolveChapterRef(project, op.chapter ?? '')
      if (!ref.chapterId) {
        return {
          op,
          status: 'not-found',
          display: 'new-entry',
          label: `为「${op.chapter ?? ''}」写稿`,
          before: '',
          after: '',
          note: ref.candidates.length
            ? `这本书里有 ${ref.candidates.length} 章对得上：${ref.candidates.map((c) => c.title).join('、')}`
            : '书里找不到这一章'
        }
      }
      const chapter = project.chapters.find((c) => c.id === ref.chapterId) as Chapter
      if (budget.draftLeft <= 0) {
        return {
          op,
          status: 'not-found',
          display: 'new-entry',
          label: `为「${chapter.title}」写稿`,
          before: '',
          after: '',
          note: '这一轮已经排了 2 章写稿了，下一轮再写这一章'
        }
      }
      const hasText = chapter.content.replace(/<[^>]+>/g, '').trim().length > 0
      const targetWords = Math.max(300, Math.round(chapter.targetWords || 2500))
      budget.draftLeft -= 1
      return {
        op,
        status: 'found',
        display: 'new-entry',
        label: `为「${chapter.title}」${hasText ? '接着写' : '写初稿'}`,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        before: '',
        after: `约 ${targetWords} 字`,
        writeTarget: { chapterId: chapter.id, targetWords, continueOnly: hasText }
      }
    }

    case 'bible_upsert': {
      const collection = op.collection as BibleCollection
      const schema = BIBLE_SCHEMA[collection]
      const list = (project.bible?.[collection] ?? []) as unknown as Record<string, unknown>[]
      const key = schema.keyField
      const name = (op.name ?? '').trim()
      const existing = list.find((e) => String(e[key] ?? '').trim() === name)
      const fields = op.fields ?? {}
      if (!existing) {
        const summary = Object.entries(fields)
          .map(([k, v]) => `${k}: ${v}`)
          .join('　')
        return {
          op,
          status: 'found',
          display: 'new-entry',
          label: `新增 ${collectionLabel(collection)}「${name}」`,
          before: '',
          after: summary,
          collection,
          entryName: name
        }
      }
      // 已存在：每条字段一行，方便逐条否决
      const changed = Object.entries(fields).filter(([k, v]) => String(existing[k] ?? '') !== String(v))
      if (!changed.length) {
        return {
          op,
          status: 'not-found',
          display: 'field',
          label: `${collectionLabel(collection)}「${name}」`,
          before: '',
          after: '',
          note: '这条设定已经和 AI 写的完全一样，不需要改'
        }
      }
      return changed.map(([k, v]) => ({
        op,
        status: 'found' as const,
        display: 'field' as const,
        label: `${collectionLabel(collection)}「${name}」· ${FIELD_LABEL[k] ?? k}`,
        before: String(existing[k] ?? ''),
        after: v,
        collection,
        entryName: name,
        fieldName: k
      }))
    }
  }
}

/** 摊平大纲标题，用于「是不是已经有这一章了」的判断 */
function flattenOutlineTitles(nodes: OutlineNode[]): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = []
  const walk = (list: OutlineNode[]): void => {
    for (const n of list) {
      out.push({ id: n.id, title: n.title })
      anyChildren(n)
    }
  }
  const anyChildren = (n: OutlineNode): void => {
    if (n.children?.length) walk(n.children)
  }
  walk(nodes)
  return out
}

const OUTLINE_STATUS_LABEL: Record<OutlineNode['status'], string> = {
  planned: '待写',
  writing: '撰写中',
  done: '已完成'
}

/**
 * 往大纲里挂一个新节点。
 *
 * 指定了 parentId 就挂到该节点下；没指定就挂进**最后一卷**——作者说「补第 30 章大纲」时，
 * 意思是接在书尾，而不是另起一卷。一本书连卷都没有（有人不写卷）就直接挂根上。
 */
function appendOutlineNode(
  outline: OutlineNode[],
  node: { parentId?: string; title: string; summary: string; status: OutlineNode['status'] }
): OutlineNode[] {
  const fresh: OutlineNode = {
    id: uid(),
    title: node.title,
    summary: node.summary,
    type: 'chapter',
    status: node.status,
    children: []
  }
  const parentId = node.parentId
  if (parentId) {
    // 顶层命中就直接挂；否则往下找（卷 › 章 › 情节点三层）
    return outline.map((n) =>
      n.id === parentId ? { ...n, children: [...(n.children ?? []), fresh] } : { ...n, children: cloneWithInsert(n.children ?? [], parentId, fresh) }
    )
  }
  const lastVolumeIdx = (() => {
    for (let i = outline.length - 1; i >= 0; i--) if (outline[i].type === 'volume') return i
    return -1
  })()
  if (lastVolumeIdx < 0) return [...outline, { ...fresh, type: outline.length ? 'chapter' : 'volume' }]
  return outline.map((n, i) => (i === lastVolumeIdx ? { ...n, children: [...(n.children ?? []), fresh] } : n))
}

/** 深层查找 parentId 并插入（大纲只有两三层，递归足够） */
function cloneWithInsert(nodes: OutlineNode[], parentId: string, fresh: OutlineNode): OutlineNode[] {
  return nodes.map((n) =>
    n.id === parentId
      ? { ...n, children: [...(n.children ?? []), fresh] }
      : { ...n, children: n.children?.length ? cloneWithInsert(n.children, parentId, fresh) : n.children }
  )
}

function collectionLabel(c: BibleCollection): string {
  return { characters: '角色', world: '世界观', terms: '词条', timeline: '时间线', threads: '线索' }[c]
}

/**
 * 设定字段的中文名。界面上一行一条「角色「林昭」· 动机」比「· motivation」好读得多，
 * 而模型写的是英文字段名，所以在这里换一次，别指望模型写中文键。
 */
const FIELD_LABEL: Record<string, string> = {
  name: '姓名',
  role: '身份',
  age: '年龄',
  identity: '身世',
  appearance: '外貌',
  personality: '性格',
  motivation: '动机',
  flaw: '缺陷',
  arc: '成长线',
  speechStyle: '说话方式',
  notes: '备注',
  hidden: '隐藏',
  title: '标题',
  category: '分类',
  content: '内容',
  visible: '注入给 AI',
  term: '词条',
  definition: '释义',
  time: '时间',
  desc: '描述',
  setup: '铺垫',
  payoff: '回收',
  status: '状态',
  level: '层级'
}

/* ────────────────────────────── 应用 ────────────────────────────── */

/** 正文改动按段落起止位置倒序回填，倒序才不会让后面的偏移失效 */
function applyChapterTextEdits(chapter: Chapter, edits: ResolvedEdit[]): string {
  const paragraphs = splitParagraphs(chapter.content)
  type Splice = { start: number; end: number; text: string }
  const splices: Splice[] = []
  const seen = new Set<number>()

  for (const e of edits) {
    if (e.display !== 'paragraph' || e.status !== 'found') continue
    const i = e.paragraphIndex
    if (i === undefined || !paragraphs[i]) continue
    // 同一段被两条 op 点名时只认第一条：两条一起上要么互相覆盖，要么把段落拼坏
    if (seen.has(i)) continue
    seen.add(i)
    const p = paragraphs[i]
    if (e.op.op === 'delete_paragraph') {
      splices.push({ start: p.start, end: p.end, text: '' })
    } else if (e.op.op === 'insert_paragraph') {
      splices.push({ start: p.end, end: p.end, text: textToParagraph(e.after) })
    } else {
      splices.push({ start: p.start, end: p.end, text: textToParagraph(e.after) })
    }
  }
  if (!splices.length) return chapter.content
  splices.sort((a, b) => b.start - a.start)
  let html = chapter.content
  for (const s of splices) {
    html = html.slice(0, s.start) + s.text + html.slice(s.end)
  }
  return html
}

function updateOutlineNode(nodes: OutlineNode[], nodeId: string, field: string, value: string): OutlineNode[] {
  return nodes.map((n) => {
    if (n.id === nodeId) {
      if (field === 'title') return { ...n, title: value }
      if (field === 'status') return { ...n, status: value as OutlineNode['status'] }
      return { ...n, summary: value }
    }
    return n.children?.length ? { ...n, children: updateOutlineNode(n.children, nodeId, field, value) } : n
  })
}

/** 设定条目：旧条目按字段覆盖，新条目按集合的字段表补空值 */
function upsertBibleEntry(project: Project, e: ResolvedEdit): Project['bible'] {
  const collection = e.collection as BibleCollection
  const schema = BIBLE_SCHEMA[collection]
  const key = schema.keyField
  const list = [...((project.bible?.[collection] ?? []) as unknown as Record<string, unknown>[])]
  const name = (e.entryName ?? '').trim()

  if (e.display === 'new-entry') {
    const base: Record<string, unknown> = { id: uid('b') }
    for (const f of schema.fields) base[f] = ''
    for (const b of schema.bools ?? []) base[b] = b === 'visible'
    base[key] = name
    // what：新条目的字段来自 op.fields，这里从 after 文本里还原不现实，
    // 所以由 applyResolved 直接把 op.fields 传进来（见下方调用点）。
    const fields = (e.op.fields ?? {}) as Record<string, string>
    for (const [k, v] of Object.entries(fields)) {
      base[k] = (schema.bools ?? []).includes(k) ? v === 'true' : v
    }
    if (collection === 'characters') base.relations = []
    list.push(base)
  } else {
    const idx = list.findIndex((x) => String(x[key] ?? '').trim() === name)
    if (idx >= 0 && e.fieldName) {
      const patch: Record<string, unknown> = { [e.fieldName]: e.after }
      if ((schema.bools ?? []).includes(e.fieldName)) patch[e.fieldName] = e.after === 'true'
      list[idx] = { ...list[idx], ...patch }
    }
  }
  return { ...project.bible, [collection]: list } as Project['bible']
}

/**
 * 纯函数：把已定位的改动一次算进新 Project。
 *
 * 只处理 status='found' 的条目；ambiguous / not-found 由调用方过滤，
 * 这里再兜一层，避免误传。
 */
export function applyResolved(project: Project, edits: ResolvedEdit[]): Project {
  const usable = edits.filter((e) => e.status === 'found')
  if (!usable.length) return project

  let next: Project = { ...project }

  // 正文：按章归组，一章只重算一次
  const byChapter = new Map<string, ResolvedEdit[]>()
  for (const e of usable) {
    if (e.display !== 'paragraph' || !e.chapterId) continue
    if (!byChapter.has(e.chapterId)) byChapter.set(e.chapterId, [])
    ;(byChapter.get(e.chapterId) as ResolvedEdit[]).push(e)
  }
  if (byChapter.size) {
    next = {
      ...next,
      chapters: next.chapters.map((c) => {
        const list = byChapter.get(c.id)
        if (!list) return c
        const content = applyChapterTextEdits(c, list)
        return content === c.content ? c : { ...c, content, updatedAt: Date.now() }
      })
    }
  }

  // 梗概与大纲节点
  for (const e of usable) {
    if (e.display !== 'field') continue
    if (e.op.op === 'set_chapter_summary' && e.chapterId) {
      next = {
        ...next,
        chapters: next.chapters.map((c) => (c.id === e.chapterId ? { ...c, summary: e.after, updatedAt: Date.now() } : c))
      }
    } else if (e.op.op === 'set_outline_node') {
      const ref = resolveOutlineNode(next.outline, e.op.node ?? '')
      if (ref.node) {
        next = { ...next, outline: updateOutlineNode(next.outline, ref.node.id, e.op.field ?? 'summary', e.after) }
      }
    }
  }

  // 新增大纲节点：按出现顺序追加，作者在预览里排的就是最终顺序
  for (const e of usable) {
    if (e.op.op !== 'add_outline_node' || !e.outlineNode) continue
    next = { ...next, outline: appendOutlineNode(next.outline, e.outlineNode) }
  }

  // 新建章节：大纲先加完再建章，才能把 outlineNodeId 直接指到**本次新建**的节点上，
  // 而不是回头靠标题兜底匹配（那会在同名时挂错）
  for (const e of usable) {
    if (e.op.op !== 'create_chapter' || !e.chapterCreate) continue
    const info = e.chapterCreate
    const node = flattenOutlineTitles(next.outline).find((t) => outlineTitleKey(t.title) === outlineTitleKey(info.title))
    const chapter: Chapter = {
      id: uid('c'),
      title: info.title,
      content: '',
      summary: info.summary,
      status: 'planning',
      targetWords: info.targetWords,
      words: 0,
      outlineNodeId: node?.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      versions: []
    }
    const chapters = [...next.chapters]
    const at = info.afterIndex === undefined ? chapters.length : Math.min(info.afterIndex + 1, chapters.length)
    chapters.splice(at, 0, chapter)
    next = { ...next, chapters }
  }

  // 设定库
  for (const e of usable) {
    if (e.op.op === 'bible_upsert') next = { ...next, bible: upsertBibleEntry(next, e) }
  }

  return next
}