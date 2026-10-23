import type { OutlineNode } from '@shared/types'
import { uid } from '@shared/utils'

/* ───────────────────── 文本解析 ───────────────────── */

const NUM = '零〇一二三四五六七八九十百千两0-9０-９'
const RE_VOLUME = new RegExp(`^第\\s*[${NUM}]+\\s*[卷部篇]`)
const RE_VOLUME_BARE = new RegExp(`^[卷部篇]\\s*[${NUM}]?`)
const RE_CHAPTER = new RegExp(`^第\\s*[${NUM}]+\\s*[章节回]`)
const RE_NUMBERING = /^\d{1,3}\s*[.、)．]/

/** 清理 markdown 装饰，保留文字本体 */
function cleanLine(input: string): string {
  return input
    .replace(/^[\s\u3000]+/, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*•·–—+]\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/[`|]?\s*$/g, (m) => (m.trim() === '|' ? '' : m))
    .trim()
}

/** 「标题：摘要」拆成两段；支持中英文冒号、破折号、竖线 */
export function splitTitleSummary(line: string): { title: string; summary: string } {
  const m = line.match(/^(.{1,80}?)\s*(?:[：:]|——|—|\||｜)\s*([\s\S]+)$/)
  if (m) {
    const title = m[1].trim()
    const summary = m[2].trim()
    if (title) return { title, summary }
  }
  return { title: line.trim(), summary: '' }
}

function makeNode(type: OutlineNode['type'], title: string, summary: string): OutlineNode {
  return { id: uid(type === 'volume' ? 'vol' : 'ch'), title, summary, type, status: 'planned', children: [] }
}

/** 一行里挤了多个章节标记时，先按标记切开（常见于模型「压缩成一行」） */
const INLINE_CHAPTER = new RegExp(`第\\s*[${NUM}]+\\s*[章节回]`, 'g')
const INLINE_SPLIT = new RegExp(`(?=第\\s*[${NUM}]+\\s*[章节回])`)

/** 表格行 → 单元格；分隔行（---）返回 null */
function tableCells(line: string): string[] | null {
  if (!line.startsWith('|')) return null
  const cells = line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
  if (!cells.length) return null
  if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) return null
  return cells.filter((c) => c !== '')
}

/** 表格行里找「第X章 / 第X卷」单元格，拼出标题与情节点 */
function fromTableRow(cells: string[]): { type: 'volume' | 'chapter'; title: string; summary: string } | null {
  const cell = cells.find((c) => RE_CHAPTER.test(c) || RE_VOLUME.test(c) || RE_VOLUME_BARE.test(c))
  const numeric = cells[0] && /^\d{1,3}$/.test(cells[0]) ? cells[0] : ''
  if (cell) {
    const isVol = !RE_CHAPTER.test(cell) && (RE_VOLUME.test(cell) || RE_VOLUME_BARE.test(cell))
    const rest = cells.filter((c) => c !== cell)
    // 单元格只有「第3章」没标题时，把下一格当标题，再往后是情节点
    const bareMarker = /^第\s*[零〇一二三四五六七八九十百千两0-9０-９]+\s*[章节回]$/.test(cell)
    if (!isVol && bareMarker && rest.length) {
      return { type: 'chapter', title: rest[0] ?? cell, summary: rest.slice(1).join(' · ') }
    }
    return { type: isVol ? 'volume' : 'chapter', title: cell, summary: rest.join(' · ') }
  }
  // 「| 1 | 烧信 | 周砚秋烧掉最后一封信 |」这种以序号开头的表格
  if (numeric && cells.length >= 2) {
    const title = cells[1] ?? ''
    const summary = cells.slice(2).join(' · ')
    return title ? { type: 'chapter', title, summary } : null
  }
  return null
}

/**
 * 把 AI 返回的纯文本大纲解析成卷/章两级树。
 * 支持：纯文本列表、markdown 标题、数字编号、两行式（标题一行/描述缩进一行）、
 * markdown 表格（章节 | 标题 | 情节点）、以及多章挤在一行（按章节标记切开）。
 * 规则：
 *  - 以「第X卷 / 卷X / 部X / 篇X」开头 → 卷
 *  - 以「第X章 / 第X节 / X. / 数字开头」开头 → 章（挂在当前卷下）
 *  - 未命中但上面已有节点 → 视为上一条的续写摘要
 */
export function parseOutlineText(raw: string): OutlineNode[] {
  const volumes: OutlineNode[] = []
  let current: OutlineNode | null = null
  let last: OutlineNode | null = null

  const ensureVolume = (): OutlineNode => {
    if (!current) {
      current = makeNode('volume', '第一卷', '')
      volumes.push(current)
    }
    return current
  }

  const addVolume = (title: string, summary: string): void => {
    const node = makeNode('volume', title, summary)
    volumes.push(node)
    current = node
    last = node
  }

  const addChapter = (title: string, summary: string): void => {
    const vol = ensureVolume()
    const node = makeNode('chapter', title, summary)
    vol.children.push(node)
    last = node
  }

  const consume = (rawLine: string): void => {
    const line0 = rawLine.trim()
    if (!line0) return
    if (/^```/.test(line0)) return
    if (/^[-=_*~]{3,}$/.test(line0)) return

    // 表格：整行单独处理，不参与「续写摘要」逻辑
    const cells = tableCells(line0)
    if (cells) {
      const row = fromTableRow(cells)
      if (!row) return
      if (row.type === 'volume') addVolume(row.title, row.summary)
      else addChapter(row.title, row.summary)
      return
    }

    if (/^(以下是|下面是|说明|备注)[：: ]/.test(line0) && !RE_CHAPTER.test(line0)) return

    const line = cleanLine(line0)
    if (!line) return

    // 一行挤了多个章节：切开分别解析（不算「续写」）
    const marks = line.match(INLINE_CHAPTER)
    if (marks && marks.length > 1) {
      for (const seg of line.split(INLINE_SPLIT)) consume(seg)
      return
    }

    const bare = line.replace(RE_NUMBERING, '').trim()
    const isVolume = RE_VOLUME.test(line) || RE_VOLUME.test(bare) || RE_VOLUME_BARE.test(bare)
    const isChapter = !isVolume && (RE_CHAPTER.test(line) || RE_CHAPTER.test(bare) || RE_NUMBERING.test(line))

    if (isVolume) {
      const { title, summary } = splitTitleSummary(line)
      addVolume(title, summary)
      return
    }

    if (isChapter) {
      // 「1. 第四章 钥匙」这类行：剥掉前置编号，标题本身保留章名
      const body = RE_NUMBERING.test(line) && !RE_CHAPTER.test(line) ? bare : line
      const { title, summary } = splitTitleSummary(body)
      addChapter(title, summary)
      return
    }

    // 续写行：并入上一条的摘要
    if (last) {
      const node = last as OutlineNode
      node.summary = node.summary ? `${node.summary}\n${line}` : line
    }
  }

  for (const rawLine of raw.replace(/\r\n/g, '\n').split('\n')) consume(rawLine)
  return volumes
}

/** 统计原文里出现了多少个「第X章」标记，用来判断是模型没给够还是解析漏了 */
export function countChapterMarkers(raw: string): number {
  return (raw.match(new RegExp(`第\\s*[${NUM}]+\\s*[章节回]`, 'g')) || []).length
}

/** 层的自然顺序归一：保证 chapter 不会挂成 volume 的兄弟（解析兜底用） */
export function normalizeOutline(nodes: OutlineNode[]): OutlineNode[] {
  const volumes: OutlineNode[] = []
  let loose: OutlineNode[] = []
  for (const n of nodes) {
    if (n.type === 'volume') {
      volumes.push({ ...n, children: [...n.children] })
      loose = []
    } else {
      loose.push(n)
      if (!volumes.length) volumes.push(makeNode('volume', '第一卷', ''))
      volumes[volumes.length - 1]!.children.push(n)
    }
  }
  return volumes
}

/* ───────────────────── 树操作 ───────────────────── */

export function mapTree(nodes: OutlineNode[], fn: (n: OutlineNode) => OutlineNode): OutlineNode[] {
  return nodes.map((n) => fn({ ...n, children: mapTree(n.children, fn) }))
}

export function findNode(nodes: OutlineNode[], id: string): OutlineNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    const hit = findNode(n.children, id)
    if (hit) return hit
  }
  return null
}

export function updateNode(nodes: OutlineNode[], id: string, patch: Partial<OutlineNode>): OutlineNode[] {
  return nodes.map((n) => {
    if (n.id === id) return { ...n, ...patch }
    if (!n.children.length) return n
    const children = updateNode(n.children, id, patch)
    return children === n.children ? n : { ...n, children }
  })
}

export function removeNode(nodes: OutlineNode[], id: string): OutlineNode[] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) => (n.children.length ? { ...n, children: removeNode(n.children, id) } : n))
}

export function insertChild(nodes: OutlineNode[], parentId: string | null, node: OutlineNode): OutlineNode[] {
  if (!parentId) return [...nodes, node]
  return nodes.map((n) => (n.id === parentId ? { ...n, children: [...n.children, node] } : { ...n, children: insertChild(n.children, parentId, node) }))
}

function moveWithin(list: OutlineNode[], id: string, dir: -1 | 1): { list: OutlineNode[]; moved: boolean } {
  const i = list.findIndex((n) => n.id === id)
  if (i >= 0) {
    const j = i + dir
    if (j < 0 || j >= list.length) return { list, moved: false }
    const next = [...list]
    const [item] = next.splice(i, 1)
    next.splice(j, 0, item!)
    return { list: next, moved: true }
  }
  // 只在真正发生移动时才构造新数组，避免无意义的写盘
  let hitIndex = -1
  let hitResult: OutlineNode[] | null = null
  list.forEach((n, idx) => {
    if (hitResult || !n.children.length) return
    const r = moveWithin(n.children, id, dir)
    if (r.moved) {
      hitIndex = idx
      hitResult = r.list
    }
  })
  if (hitIndex < 0 || !hitResult) return { list, moved: false }
  const next = [...list]
  const target = next[hitIndex]!
  next[hitIndex] = { ...target, children: hitResult }
  return { list: next, moved: true }
}

export function moveNode(nodes: OutlineNode[], id: string, dir: -1 | 1): OutlineNode[] {
  return moveWithin(nodes, id, dir).list
}

export interface OutlineStats {
  volumes: number
  chapters: number
  planned: number
  writing: number
  done: number
  words: number
}

/** 统计卷/章数量、状态分布与大纲字数（标题 + 摘要） */
export function outlineStats(nodes: OutlineNode[], countWords: (s: string) => number): OutlineStats {
  const stat: OutlineStats = { volumes: 0, chapters: 0, planned: 0, writing: 0, done: 0, words: 0 }
  const walk = (list: OutlineNode[]): void => {
    for (const n of list) {
      stat.words += countWords(n.title) + countWords(n.summary)
      if (n.type === 'volume') stat.volumes += 1
      else {
        stat.chapters += 1
        stat[n.status] += 1
      }
      walk(n.children)
    }
  }
  walk(nodes)
  return stat
}

export const STATUS_LABEL: Record<OutlineNode['status'], string> = {
  planned: '待写',
  writing: '进行中',
  done: '已完成'
}

export function nextStatus(s: OutlineNode['status']): OutlineNode['status'] {
  return s === 'planned' ? 'writing' : s === 'writing' ? 'done' : 'planned'
}