/**
 * 对话改稿协议（mz-edit）。
 *
 * 右侧的 AI 对话原本只能聊天：它读得到当前章、前文、设定与大纲，也说得清哪里松，
 * 但说完就断了——找那句话、想怎么改、敲进去，全丢回给作者。这里定义的是一份
 * **受控的**修改指令：模型在自然语言回答后面追加一个 `mz-edit` 代码块，里面是
 * 一份 JSON 数组，每条描述一处改动。
 *
 * 为什么是 JSON 围栏而不是 tool calling：作者可能用任何第三方中转渠道，
 * 那类网关不保证把 `tools` 透传给上游；而「照格式输出一段 JSON」是所有模型都会的事。
 * 代价是模型可能写坏，所以校验必须严格到「坏一条丢一条」，并且在界面上说清丢了什么——
 * 静默丢弃比不支持更糟，作者会以为 AI 没听懂。
 *
 * 这个文件只能引 `./types`，不许碰 electron / react / node 内置模块：
 * 主进程将来把它包成 tool schema 时还要用同一份定义。
 */
import type { OutlineNode, Project } from './types'

/** 一轮最多接受多少条改动。超了一律整轮拒收——防模型跑飞，也防作者审不过来。 */
export const MAX_EDITS = 20

export type EditOpKind =
  | 'replace_paragraph'
  | 'insert_paragraph'
  | 'delete_paragraph'
  | 'replace_literal'
  | 'set_chapter_summary'
  | 'set_outline_node'
  | 'add_outline_node'
  | 'create_chapter'
  | 'write_chapter'
  | 'bible_upsert'

export const EDIT_OP_KINDS: EditOpKind[] = [
  'replace_paragraph',
  'insert_paragraph',
  'delete_paragraph',
  'replace_literal',
  'set_chapter_summary',
  'set_outline_node',
  'add_outline_node',
  'create_chapter',
  'write_chapter',
  'bible_upsert'
]

/** 设定库的五个集合，key 必须与 Project['bible'] 的字段名逐字一致 */
export type BibleCollection = 'characters' | 'world' | 'terms' | 'timeline' | 'threads'

export const BIBLE_COLLECTIONS: BibleCollection[] = ['characters', 'world', 'terms', 'timeline', 'threads']

/**
 * 每个集合「用什么认人」和「允许改哪些字段」。
 *
 * 只放开文本字段加两个布尔（hidden / visible）：布尔用字符串 "true"/"false" 传，
 * 应用时再转回去。之所以不放开 id 和结构字段——AI 改一次 id，全书引用它的地方
 * 就全断了，而它根本不知道自己破坏了什么。
 */
export const BIBLE_SCHEMA: Record<BibleCollection, { keyField: string; fields: string[]; bools?: string[] }> = {
  characters: {
    keyField: 'name',
    fields: [
      'name',
      'role',
      'age',
      'identity',
      'appearance',
      'personality',
      'motivation',
      'flaw',
      'arc',
      'speechStyle',
      'notes'
    ],
    bools: ['hidden']
  },
  world: { keyField: 'title', fields: ['title', 'category', 'content'], bools: ['visible'] },
  terms: { keyField: 'term', fields: ['term', 'definition'] },
  timeline: { keyField: 'title', fields: ['title', 'time', 'desc'] },
  threads: { keyField: 'title', fields: ['title', 'setup', 'payoff', 'status', 'level'] }
}

export interface EditOp {
  op: EditOpKind
  /** 章节引用：id / 完整标题 /「第3章」都行，解析见 resolveChapterRef */
  chapter?: string
  /** 必须是正文原话（逐字摘录）。定位不到就报找不到，绝不猜 */
  anchor?: string
  /** 新文本。delete_paragraph 不用，replace_literal 的替换文本可以为空串 */
  after?: string
  scope?: 'book' | 'chapter'
  from?: string
  to?: string
  /** 大纲节点引用：id / 完整标题 / 唯一子串 */
  node?: string
  /** add_outline_node：新节点挂在哪个节点下（卷标题）。省略则挂到最后一卷 */
  parent?: string
  /** add_outline_node：新节点标题 */
  title?: string
  /** add_outline_node：新节点情节点 */
  summary?: string
  /** add_outline_node：新节点状态，默认 planned */
  status?: OutlineNode['status']
  /** create_chapter：新章目标字数，缺省取本书 settings.targetWordsPerChapter */
  targetWords?: number
  /** create_chapter：应用后是否当场写初稿。默认 false——「补大纲」不该顺手写两章正文 */
  draft?: boolean
  field?: 'title' | 'summary' | 'status'
  collection?: BibleCollection
  /** 设定条目的识别名（characters 用 name，其余用 title/term） */
  name?: string
  fields?: Record<string, string>
}

export interface ParseResult {
  /** 去掉编辑块之后的自然语言正文（给气泡显示用） */
  text: string
  ops: EditOp[]
  /** 每条都是给人看的中文说明，直接显示在气泡下方 */
  errors: string[]
}

/** 认 ```mz-edit 围栏；模型偶尔会写成 ```json 或 ```JSON，内容里有 edits 也算 */
const FENCE_RE = /```(mz-edit|json|JSON)[ \t]*\r?\n([\s\S]*?)```/g

/**
 * 把文本里所有编辑围栏摘出来，返回「最后一个可用的块」和「去掉围栏的正文」。
 *
 * 取最后一个而不是第一个：模型爱先给一个格式示例再给真正的指令，
 * 取第一个会把示例当成修改执行——那是真会改错稿子的。
 */
export function splitEditBlocks(raw: string): { json: string | null; rest: string } {
  const src = String(raw ?? '')
  let last: string | null = null
  let lastIsMz = false
  FENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  const kept: string[] = []
  let cursor = 0
  while ((m = FENCE_RE.exec(src)) !== null) {
    const label = m[1]
    const body = m[2]
    const looksLikeEdits = body.includes('"edits"') || body.includes("'edits'")
    if (label === 'mz-edit' || looksLikeEdits) {
      // mz-edit 优先：晚出现的 mz-edit 一定覆盖早出现的 json 示例
      if (label === 'mz-edit' || !lastIsMz) {
        last = body
        lastIsMz = label === 'mz-edit'
      }
      kept.push(src.slice(cursor, m.index))
      cursor = m.index + m[0].length
    }
  }
  kept.push(src.slice(cursor))
  const rest = kept
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { json: last, rest }
}

/** 只去掉编辑块，保留自然语言——解析失败时还要靠它给作者看 */
export function stripEditBlock(raw: string): string {
  return splitEditBlocks(raw).rest
}

/**
 * 解析 + 校验。
 *
 * 三条纪律：
 * 1. 坏一条丢一条，不牵连其他条目（模型常在一轮里写对五条、写坏一条）；
 * 2. 超过 MAX_EDITS 整轮拒收，不静默截断——截断了作者以为全改了；
 * 3. 每条错误都带序号和人话，界面直接显示。
 */
export function parseEditBlock(raw: string): ParseResult {
  const { json, rest } = splitEditBlocks(raw)
  if (json === null) return { text: rest, ops: [], errors: [] }

  let data: unknown
  try {
    data = JSON.parse(json)
  } catch (e) {
    return {
      text: rest,
      ops: [],
      errors: [`修改指令不是合法 JSON（${(e as Error).message.slice(0, 80)}），这一轮不能应用`]
    }
  }
  const list = (data as { edits?: unknown })?.edits
  if (!Array.isArray(list)) {
    return { text: rest, ops: [], errors: ['修改指令缺少 edits 数组，这一轮不能应用'] }
  }
  if (list.length > MAX_EDITS) {
    return {
      text: rest,
      ops: [],
      errors: [`一轮最多 ${MAX_EDITS} 处修改，这次提了 ${list.length} 处，请分批处理`]
    }
  }

  const ops: EditOp[] = []
  const errors: string[] = []
  list.forEach((item, i) => {
    const r = validateOp(item, i)
    if (r.op) ops.push(r.op)
    else if (r.error) errors.push(r.error)
  })
  return { text: rest, ops, errors }
}

function isText(v: unknown): v is string {
  return typeof v === 'string'
}

/** 单条校验。返回 op 表示可用，返回 error 表示丢弃原因 */
export function validateOp(item: unknown, index: number): { op?: EditOp; error?: string } {
  const at = `第 ${index + 1} 条`
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { error: `${at}：不是一个对象` }
  }
  const o = item as Record<string, unknown>
  const kind = o.op
  if (!isText(kind) || !EDIT_OP_KINDS.includes(kind as EditOpKind)) {
    return { error: `${at}：不认识的 op「${String(kind)}」` }
  }

  const need = (v: unknown): boolean => isText(v) && v.trim().length > 0

  switch (kind as EditOpKind) {
    case 'replace_paragraph':
    case 'insert_paragraph': {
      if (!need(o.chapter)) return { error: `${at}：缺少 chapter` }
      if (!need(o.anchor)) return { error: `${at}：缺少 anchor（原文片段）` }
      if (!need(o.after)) return { error: `${at}：缺少 after（新内容）` }
      return { op: { op: kind as EditOpKind, chapter: o.chapter as string, anchor: o.anchor as string, after: o.after as string } }
    }
    case 'delete_paragraph': {
      if (!need(o.chapter)) return { error: `${at}：缺少 chapter` }
      if (!need(o.anchor)) return { error: `${at}：缺少 anchor（原文片段）` }
      return { op: { op: 'delete_paragraph', chapter: o.chapter as string, anchor: o.anchor as string } }
    }
    case 'replace_literal': {
      const scope = o.scope === 'book' || o.scope === 'chapter' ? o.scope : null
      if (!scope) return { error: `${at}：scope 只能是 book 或 chapter` }
      if (!need(o.from)) return { error: `${at}：缺少 from（要被替换的文字）` }
      if (!isText(o.to)) return { error: `${at}：缺少 to（替换成的文字，留空表示删除）` }
      if (scope === 'chapter' && !need(o.chapter)) return { error: `${at}：scope=chapter 时必须给 chapter` }
      return {
        op: {
          op: 'replace_literal',
          scope,
          from: o.from as string,
          to: o.to as string,
          chapter: need(o.chapter) ? (o.chapter as string) : undefined
        }
      }
    }
    case 'set_chapter_summary': {
      if (!need(o.chapter)) return { error: `${at}：缺少 chapter` }
      if (!need(o.after)) return { error: `${at}：缺少 after（新梗概）` }
      return { op: { op: 'set_chapter_summary', chapter: o.chapter as string, after: o.after as string } }
    }
    case 'set_outline_node': {
      if (!need(o.node)) return { error: `${at}：缺少 node（大纲节点）` }
      const field = o.field
      if (field !== 'title' && field !== 'summary' && field !== 'status') {
        return { error: `${at}：field 只能是 title / summary / status` }
      }
      if (!need(o.after)) return { error: `${at}：缺少 after（新值）` }
      if (field === 'status' && !['planned', 'writing', 'done'].includes(String(o.after))) {
        return { error: `${at}：status 只能是 planned / writing / done` }
      }
      return { op: { op: 'set_outline_node', node: o.node as string, field, after: o.after as string } }
    }
    case 'add_outline_node': {
      if (!need(o.title)) return { error: `${at}：缺少 title（新大纲节点的标题）` }
      const status = o.status === undefined ? undefined : String(o.status)
      if (status !== undefined && !['planned', 'writing', 'done'].includes(status)) {
        return { error: `${at}：status 只能是 planned / writing / done` }
      }
      return {
        op: {
          op: 'add_outline_node',
          parent: isText(o.parent) && o.parent.trim() ? o.parent : undefined,
          title: (o.title as string).trim(),
          summary: isText(o.summary) ? o.summary : undefined,
          status: status as OutlineNode['status'] | undefined
        }
      }
    }
    case 'create_chapter': {
      if (!need(o.title)) return { error: `${at}：缺少 title（章节标题）` }
      let targetWords: number | undefined
      if (o.targetWords !== undefined && o.targetWords !== null) {
        const n = Number(o.targetWords)
        // 300 字以下不像一章，20000 以上一次生成必然跑很久：两头都挡掉，比事后解释便宜
        if (!Number.isFinite(n) || n < 300 || n > 20000) return { error: `${at}：targetWords 需在 300–20000 之间` }
        targetWords = Math.round(n)
      }
      if (o.draft !== undefined && typeof o.draft !== 'boolean') return { error: `${at}：draft 只能是 true / false` }
      return {
        op: {
          op: 'create_chapter',
          title: (o.title as string).trim(),
          summary: isText(o.summary) ? o.summary : undefined,
          targetWords,
          draft: o.draft === true,
          after: isText(o.after) && o.after.trim() ? o.after : undefined,
          parent: isText(o.parent) && o.parent.trim() ? o.parent : undefined
        }
      }
    }
    case 'write_chapter': {
      if (!need(o.chapter)) return { error: `${at}：缺少 chapter（要写哪一章）` }
      return { op: { op: 'write_chapter', chapter: o.chapter as string } }
    }
    case 'bible_upsert': {
      const collection = o.collection
      if (!isText(collection) || !BIBLE_COLLECTIONS.includes(collection as BibleCollection)) {
        return { error: `${at}：collection 只能是 ${BIBLE_COLLECTIONS.join(' / ')}` }
      }
      const schema = BIBLE_SCHEMA[collection as BibleCollection]
      if (!need(o.name)) return { error: `${at}：缺少 name（${schema.keyField}）` }
      const raw = o.fields
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: `${at}：缺少 fields 对象` }
      }
      const allowed = new Set([...schema.fields, ...(schema.bools ?? [])])
      const fields: Record<string, string> = {}
      const dropped: string[] = []
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!allowed.has(k)) {
          dropped.push(k)
          continue
        }
        if (isText(v) || typeof v === 'number' || typeof v === 'boolean') fields[k] = String(v)
      }
      if (!Object.keys(fields).length) {
        return { error: `${at}：fields 里没有 ${collection} 能写的字段（可用：${[...allowed].join('/')}）` }
      }
      if (dropped.length) {
        // 不静默：告诉作者哪些字段被丢了，他们才知道模型想改什么、为什么没改成
        return {
          op: { op: 'bible_upsert', collection: collection as BibleCollection, name: o.name as string, fields },
          error: `${at}：${collection} 没有这些字段，已忽略：${dropped.join('、')}`
        }
      }
      return { op: { op: 'bible_upsert', collection: collection as BibleCollection, name: o.name as string, fields } }
    }
  }
  return { error: `${at}：无法处理` }
}

/* ──────────────────────── 章节与大纲节点的引用解析 ──────────────────────── */

const CN_DIGIT: Record<string, number> = {
  零: 0,
  '〇': 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
}
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100 }

/** 「3」「三」「十三」「二十五」「一百零三」→ 数字；认不出返回 null */
export function cnToNumber(s: string): number | null {
  const raw = String(s ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return Number(raw)
  let total = 0
  let cur = 0
  for (const ch of raw) {
    if (CN_DIGIT[ch] !== undefined) {
      cur = CN_DIGIT[ch] as number
    } else if (CN_UNIT[ch] !== undefined) {
      const unit = CN_UNIT[ch] as number
      total += (cur || 1) * unit
      cur = 0
    } else {
      return null
    }
  }
  return total + cur
}

/** 从章节标题里取章号：「第3章 她烧了信」→ 3；取不到 open return null */
export function chapterNumber(title: string): number | null {
  const m = String(title ?? '').match(/第\s*([0-9０-９零〇一二两三四五六七八九十百]+)\s*[章回节篇话]/)
  if (!m) return null
  return cnToNumber(m[1])
}

export interface ChapterRef {
  chapterId?: string
  /** 解析不出唯一章节时，把候选列出来让作者在对话里说清 */
  candidates: { id: string; title: string }[]
}

/**
 * 章节引用解析：id → 标题全等 → 章号 → 标题唯一子串。
 *
 * 多解不猜：全书有「第 3 章」两章（比如分卷各自从 1 开始）时给候选，
 * 让作者补一句「第一卷的第 3 章」。
 */
export function resolveChapterRef(project: Project, ref: string): ChapterRef {
  const r = String(ref ?? '').trim()
  const chapters = project.chapters ?? []
  if (!r) return { candidates: [] }

  const byId = chapters.find((c) => c.id === r)
  if (byId) return { chapterId: byId.id, candidates: [] }

  const exact = chapters.filter((c) => c.title.trim() === r)
  if (exact.length === 1) return { chapterId: exact[0].id, candidates: [] }
  if (exact.length > 1) return { candidates: exact.map((c) => ({ id: c.id, title: c.title })) }

  const n = chapterNumber(r)
  if (n !== null) {
    const hit = chapters.filter((c) => chapterNumber(c.title) === n)
    if (hit.length === 1) return { chapterId: hit[0].id, candidates: [] }
    if (hit.length > 1) return { candidates: hit.map((c) => ({ id: c.id, title: c.title })) }
  }

  const partial = chapters.filter((c) => c.title.includes(r))
  if (partial.length === 1) return { chapterId: partial[0].id, candidates: [] }
  return { candidates: partial.map((c) => ({ id: c.id, title: c.title })) }
}

export interface OutlineRef {
  node?: OutlineNode
  path: string[]
  candidates: { id: string; title: string }[]
}

/** 大纲是树，按先序遍历拍平并记下路径（「第一卷 › 开端」），报错时能说清是哪一层 */
function flattenOutline(nodes: OutlineNode[], trail: string[] = []): { node: OutlineNode; path: string[] }[] {
  const out: { node: OutlineNode; path: string[] }[] = []
  for (const n of nodes ?? []) {
    const path = [...trail, n.title]
    out.push({ node: n, path })
    if (n.children?.length) out.push(...flattenOutline(n.children, path))
  }
  return out
}

export function resolveOutlineNode(nodes: OutlineNode[], ref: string): OutlineRef {
  const r = String(ref ?? '').trim()
  const all = flattenOutline(nodes)
  if (!r) return { path: [], candidates: [] }

  const byId = all.find((x) => x.node.id === r)
  if (byId) return { node: byId.node, path: byId.path, candidates: [] }

  const exact = all.filter((x) => x.node.title.trim() === r)
  if (exact.length === 1) return { node: exact[0].node, path: exact[0].path, candidates: [] }
  if (exact.length > 1) {
    return { path: [], candidates: exact.map((x) => ({ id: x.node.id, title: x.path.join(' › ') })) }
  }

  const partial = all.filter((x) => x.node.title.includes(r))
  if (partial.length === 1) return { node: partial[0].node, path: partial[0].path, candidates: [] }
  return { path: [], candidates: partial.map((x) => ({ id: x.node.id, title: x.path.join(' › ') })) }
}

/* ──────────────────────────── 提示词 ──────────────────────────── */

/**
 * 追加进对话 system 的「你可以直接改稿」说明。
 *
 * 写得克制的原因：这段话会跟着每一轮对话发给模型，占的是作者的钱。
 * 只讲清三件事——什么时候动手、anchor 必须逐字抄、拿不准就别猜。
 */
/**
 * @param currentChapterTitle 作者此刻正在看的那一章标题。
 * 给出来是为了让模型**照抄**而不是凭印象写章名——「第 29 章 信」与「第29章」在匹配器里
 * 都能认，但模型真正写错的是**章号**（说 29 章、引 28 章的原文），所以这段话连同
 * 「只填你确实看到过正文的章」一起放在最前面。
 */
export function renderEditPrompt(currentChapterTitle?: string): string {
  return `## 你可以直接改稿

当作者要你「改」「换」「加一段」「统一改成」「更新设定/大纲」时，不要只在回答里描述改法，另外输出一个 mz-edit 代码块，让改动可以被应用。只讨论写法、诊断问题、出主意时不要输出该代码块。

${currentChapterTitle ? `作者此刻正在看的是「${currentChapterTitle}」，下面【作品资料】里给出正文的也是这一章。` : ''}

格式（整块是合法 JSON，只输出一个这样的块）：
\`\`\`mz-edit
{"edits":[{"op":"replace_paragraph","chapter":"第3章","anchor":"原文的连续片段","after":"改写后的整段"}]}
\`\`\`

规则（逐条照做，违反第 1、2 条会导致改动被丢弃）：
1. **anchor 必须是【一章正文里同一段】的连续文字，逐字复制**：不要概括、不要改标点、不要跨段拼接、不要用「……」省略、不要凭记忆写。长度取 10–40 字，够唯一即可。
2. **chapter 只填「当前章节」那个标题**。如果作者让你改的是别的章，chapter 就填你确实看到过正文的那一章标题；如果你没有看到过那一章的正文，就别输出这一条，改在回答里说明。
3. 一轮最多 20 条。只提真正需要改的地方，不要为了显得勤奋而重写整章。
4. replace_paragraph / insert_paragraph 的 after 可以是多段：用空行分隔，一段一行。
5. 拿不准原文就说明白，不要猜——anchor 对不上时这条改动会被整个丢弃，作者只会看到「找不到原文」。
5b. **你自己在对话里写过的正文不等于书里的正文**：作者可能没采用、可能改过、也可能另写了一版。anchor 只认【作品资料】里「当前章节正文」那一段，绝不从你自己的上文里抄。这一条是最常见的翻车点。
5c. 【作品资料】若写着「这里省略了本章后面的 N 字」，那部分你没看到——不要为它提段落改动，直接在回答里说「结尾那段我需要看到才能改」。
6. 要「补第 30 章的大纲」而大纲里还没有这一章时，用 add_outline_node 新增，别用 set_outline_node —— 后者只能改已有的，找不到就整条作废。
7. 「补第 30 章的大纲」这种只要计划的事，用 add_outline_node；作者说「建第 30 章」是要真章节和正文，用 create_chapter。
8. draft 只在作者明确要正文时给 true（「建第 30 章并写出来」「把这章补完」）。一轮最多 2 章带 draft。
9. 自然语言的回答照常写给作者看，改稿块放在最后。**不要把整章正文贴在回答里**：要写正文就用 create_chapter（draft:true）或 write_chapter，让它直接落进章节。

可用操作：
- replace_paragraph：换掉 anchor 所在的整段。字段 chapter / anchor / after
- insert_paragraph：在 anchor 所在段之后插入一段。字段 chapter / anchor / after
- delete_paragraph：删掉 anchor 所在的整段。字段 chapter / anchor
- replace_literal：纯文本批量替换。字段 scope（book|chapter）/ from / to（+chapter）
- set_chapter_summary：重写章节梗概。字段 chapter / after
- set_outline_node：改**已有**大纲节点。字段 node / field（title|summary|status）/ after
- add_outline_node：大纲里还没有这一章时，新增一个节点。字段 title / summary（情节点）/ status（默认 planned）/ parent（卷标题，省略则挂最后一卷）
- create_chapter：新建一章（同时补一个同名大纲节点）。字段 title / summary（章梗概）/ targetWords / draft（true=建完就写初稿，默认 false）/ after（插在哪一章之后，省略=书尾）/ parent（大纲节点挂哪一卷）
- write_chapter：给**已存在**的章写初稿或接着写。字段 chapter
- bible_upsert：新增或更新设定条目。字段 collection（characters|world|terms|timeline|threads）/ name / fields`
}