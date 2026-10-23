import type { Chapter, Project } from '@shared/types'
import { stripHtml } from '@shared/utils'

/**
 * ── 全书搜索 / 章节内搜索 ──
 *
 * 设计取两点：
 *
 * 1. **纯函数**。搜索的全部逻辑（切段、找命中、算偏移、给上下文）都不碰 DOM、
 *    不碰 React，只吃字符串吐结果。这样能单独测，也不用为了测搜索去点界面。
 * 2. **偏移与编辑器同源**。命中的 offset 是按「段落以 \n 相连」的纯文本算的，
 *    和 ProofreadPanel 里校读用的是同一套拼法；跳转时再把纯文本偏移映射回
 *    ProseMirror 位置，保证点下去光标真的落在那个字上。
 */

export interface SearchHit {
  /** 唯一键：章节 id + 偏移 */
  id: string
  chapterId: string
  chapterTitle: string
  /** 命中在章节纯文本中的起止偏移 */
  start: number
  end: number
  /** 命中所在的段落序号（从 0 开始，含标题段） */
  paragraphIndex: number
  /** 命中前文（已截断） */
  before: string
  /** 命中的原文 */
  match: string
  /** 命中后文（已截断） */
  after: string
}

export interface SearchOptions {
  /** 是否区分大小写 */
  caseSensitive?: boolean
  /** 是否按整词匹配（仅对拉丁字母有意义，中文不分词） */
  wholeWord?: boolean
}

/** 上下文各保留多少字符，够看清是哪一句就行 */
const CONTEXT = 28

/**
 * 把一章的 HTML 转成「与编辑器同源」的纯文本。
 *
 * 标题段（第一段）保留不遮掉——搜索理应能搜到章节标题里的字。
 * 段落之间用 \n 相连，与编辑器里的块顺序一致。
 */
export function chapterToPlain(html: string): string {
  return stripHtml(html).replace(/\r\n/g, '\n')
}

/** 建立「纯文本偏移 → 段落序号」的索引 */
export function paragraphIndexAt(plain: string, offset: number): number {
  let idx = 0
  let line = 0
  while (idx >= 0 && idx < offset) {
    const nl = plain.indexOf('\n', idx)
    if (nl < 0 || nl >= offset) break
    line++
    idx = nl + 1
  }
  return line
}

/** 转义正则元字符，让用户输入的 . * ? 之类按字面匹配 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 在单章正文里找全部命中。
 * 空查询返回空数组——不返回"全部"，否则刚打开面板就会刷出一整本书。
 */
export function searchInChapter(
  chapter: Chapter,
  query: string,
  options: SearchOptions = {}
): SearchHit[] {
  const q = query.trim()
  if (!q) return []
  // 中文搜索不该因为输入法带进来的全角空格而搜不到
  const needle = q.replace(/\u3000/g, ' ')
  const plain = chapterToPlain(chapter.content)
  if (!plain) return []

  const flags = options.caseSensitive ? 'gu' : 'giu'
  let pattern = escapeRegExp(needle)
  if (options.wholeWord) {
    // 只在两侧都是拉丁字母/数字时才加边界，否则会把中文整段当词
    pattern = `(?<![A-Za-z0-9_])${pattern}(?![A-Za-z0-9_])`
  }

  let re: RegExp
  try {
    re = new RegExp(pattern, flags)
  } catch {
    return []
  }

  const hits: SearchHit[] = []
  let m: RegExpExecArray | null
  // 上限防止在超长章节里把内存吃光；真要翻完，应该改成分页
  while ((m = re.exec(plain)) !== null) {
    const start = m.index
    const end = start + m[0].length
    hits.push({
      id: `${chapter.id}:${start}`,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      start,
      end,
      paragraphIndex: paragraphIndexAt(plain, start),
      before: plain.slice(Math.max(0, start - CONTEXT), start).replace(/\n/g, ' '),
      match: m[0],
      after: plain.slice(end, Math.min(plain.length, end + CONTEXT)).replace(/\n/g, ' ')
    })
    // 零宽匹配会死循环，强制前进一位
    if (m[0].length === 0) re.lastIndex++
    if (hits.length >= 2000) break
  }
  return hits
}

/** 全书搜索：逐章找，按书里的顺序返回 */
export function searchBook(
  project: Project,
  query: string,
  options: SearchOptions = {}
): SearchHit[] {
  if (!query.trim()) return []
  const out: SearchHit[] = []
  for (const c of project.chapters) {
    out.push(...searchInChapter(c, query, options))
  }
  return out
}

/** 按章节把命中分组，供 UI 折叠显示 */
export interface SearchGroup {
  chapterId: string
  chapterTitle: string
  hits: SearchHit[]
}

export function groupByChapter(hits: SearchHit[], project: Project): SearchGroup[] {
  const map = new Map<string, SearchGroup>()
  for (const h of hits) {
    let g = map.get(h.chapterId)
    if (!g) {
      g = { chapterId: h.chapterId, chapterTitle: h.chapterTitle, hits: [] }
      map.set(h.chapterId, g)
    }
    g.hits.push(h)
  }
  // 按书里的章节顺序排，而不是命中顺序
  const order = new Map(project.chapters.map((c, i) => [c.id, i]))
  return [...map.values()].sort((a, b) => (order.get(a.chapterId) ?? 0) - (order.get(b.chapterId) ?? 0))
}

/**
 * 把纯文本偏移映射回 ProseMirror 文档位置。
 *
 * 纯文本按「段落以 \n 相连」拼成，所以每处理完一段要多加一格。
 * 返回 -1 表示找不到（正文已变或偏移越界）。
 */
export function plainOffsetToPos(
  blocks: { textStart: number; textEnd: number; posStart: number }[],
  offset: number
): number {
  for (const b of blocks) {
    if (offset >= b.textStart && offset <= b.textEnd) return b.posStart + (offset - b.textStart)
  }
  return -1
}

/** 从编辑器文档收集块信息，与 plainOffsetToPos 配套 */
export function collectBlocks(doc: {
  descendants: (cb: (node: { isTextblock: boolean; textContent: string }, pos: number) => boolean) => void
}): { textStart: number; textEnd: number; posStart: number }[] {
  const blocks: { textStart: number; textEnd: number; posStart: number }[] = []
  let cursor = 0
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const len = node.textContent.length
    blocks.push({ textStart: cursor, textEnd: cursor + len, posStart: pos + 1 })
    cursor += len + 1
    return false
  })
  return blocks
}

/** 命中总数按章节统计，给侧栏角标用 */
export function countByChapter(hits: SearchHit[]): Record<string, number> {
  const m: Record<string, number> = {}
  for (const h of hits) m[h.chapterId] = (m[h.chapterId] ?? 0) + 1
  return m
}