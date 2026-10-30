/**
 * 书稿导入 · AI 识别（纯函数，无 React）
 *
 * 两件事：
 * 1) 为「元信息识别 / 章节摘要 / 按情节分卷」拼提示词并算批量与成本；
 * 2) 把模型返回的半结构化内容解析成固定形状 —— 模型不守 JSON 纪律是常态，
 *    这里的容错程度直接决定作者要不要手工重敲 30 章摘要。
 *
 * 为什么分三个独立调用而不是一次全包：几十万字的书塞不进一次上下文；
 * 元信息只需要抽样，章节摘要必须逐批，两者的输入完全不同的量级。
 */
import type { PromptMessage } from '@shared/types'
import { GENRES, getGenre } from '@shared/genres'
import { truncate } from '@shared/utils'
import { extractJson } from '../quickstart/pipeline'

/* ───────────────────────── 类型 ───────────────────────── */

export interface ImportMetaCharacter {
  name: string
  /** 主角 / 配角 / 反派 …… 模型给什么就存什么，界面不解析这一列 */
  role: string
  desc: string
}

export interface ImportMeta {
  title: string
  author: string
  /** 必须落在 GENRES 的 16 个 id 之一，认不出就是空串（不许猜一个最像的） */
  genreId: string
  logline: string
  premise: string
  keywords: string[]
  characters: ImportMetaCharacter[]
}

export interface ChapterSummary {
  /** 全书章节序号，从 1 开始 */
  index: number
  summary: string
}

export interface VolumePlanItem {
  title: string
  from: number
  to: number
}

/** 一批摘要请求的输入：哪几章、拼好的文本、字数 */
export interface SummaryBatch {
  indexes: number[]
  text: string
  chars: number
}

/* ───────────────────────── 通用小工具 ───────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function pickArray(obj: Record<string, unknown>, keys: readonly string[]): unknown[] | null {
  for (const key of keys) {
    const value = obj[key]
    if (Array.isArray(value)) return value
  }
  return null
}

/** 文本里的第一个数组值（模型常包一层 {"chapters":[...]}） */
function firstArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  const obj = asRecord(value)
  if (!obj) return null
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) return v
  }
  return null
}

/** 掐断到 n 字，尽量落在标点上，读起来不像被腰斩 */
function clip(text: string, n: number): string {
  const t = (text ?? '').trim()
  if (t.length <= n) return t
  const head = t.slice(0, n)
  const lastBreak = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('\n'))
  return (lastBreak > n * 0.5 ? head.slice(0, lastBreak + 1) : head) + '…'
}

/* ───────────────────────── 题材映射 ───────────────────────── */

/**
 * 把模型给的题材落到 16 个内置 id 上。
 *
 * 只做「名字/ id 精确匹配」+ 去掉「小说/类/题材」这类尾巴，
 * 不做模糊联想：把「悬疑推理」猜成悬疑看着聪明，一旦猜错，整本书的题材公约、
 * 提示词基调、书架标签全跟着错，作者还未必看得出来。认不出就留空。
 */
export function normalizeGenreId(raw: string): string {
  const t = (raw ?? '').trim()
  if (!t) return ''
  if (getGenre(t)) return t
  const trimmed = t.replace(/[（(].*?[）)]/g, '').replace(/(小说|类|题材|类型|流派)$/g, '').trim()
  if (getGenre(trimmed)) return trimmed
  const byName = GENRES.find((g) => g.name === t || g.name === trimmed)
  return byName ? byName.id : ''
}

/** 提示词里要列出的题材清单 */
export function genreListForPrompt(): string {
  return GENRES.map((g) => `${g.name}（${g.id}）`).join('、')
}

/* ───────────────────────── 元信息解析 ───────────────────────── */

export const EMPTY_META: ImportMeta = {
  title: '',
  author: '',
  genreId: '',
  logline: '',
  premise: '',
  keywords: [],
  characters: []
}

const META_TITLE_KEYS = ['title', '书名', 'name', 'bookName', '作品名'] as const
const META_AUTHOR_KEYS = ['author', '作者', 'writer', '著者'] as const
const META_GENRE_KEYS = ['genre', 'genreId', '题材', '类型', 'category'] as const
const META_LOGLINE_KEYS = ['logline', 'oneLine', '一句话简介', '一句话', 'tagline', 'hook'] as const
const META_PREMISE_KEYS = ['premise', '梗概', '故事梗概', 'summary', '简介', 'synopsis', 'intro'] as const
const META_KEYWORD_KEYS = ['keywords', '关键词', 'tags', '标签'] as const
const META_CHARACTER_KEYS = ['characters', '人物', '角色', 'roles'] as const

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : typeof v === 'object' && v ? pickString(asRecord(v) ?? {}, ['name', 'text', '名称', '词']) : ''))
      .map((v) => v.trim())
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(/[、,，;；/|]+/)
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

function toCharacters(value: unknown): ImportMetaCharacter[] {
  if (!Array.isArray(value)) return []
  const out: ImportMetaCharacter[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const name = item.trim()
      if (name) out.push({ name, role: '', desc: '' })
      continue
    }
    const obj = asRecord(item)
    if (!obj) continue
    const name = pickString(obj, ['name', '姓名', '名字', '角色名'])
    const role = pickString(obj, ['role', '定位', '身份', '类型'])
    const desc = pickString(obj, ['desc', 'description', '简介', '描述', '介绍', 'note'])
    if (name || desc) out.push({ name: name || '未命名角色', role, desc })
  }
  return out
}

/**
 * 解析元信息返回。
 * 容忍：```json 围栏、前后废话、{"book":{...}} 包一层、非 JSON 的「书名：x」逐行文本。
 */
export function parseMetaOutput(text: string): ImportMeta {
  const raw = (text ?? '').trim()
  if (!raw) return { ...EMPTY_META }

  let obj = asRecord(extractJson(raw))
  if (!obj) {
    const arr = firstArray(extractJson(raw))
    obj = arr ? asRecord(arr[0]) : null
  }
  // 模型爱套一层 {"book": {...}} / {"result": {...}}
  if (obj) {
    const nested = ['book', 'data', 'result', 'meta', 'info', '书籍', '信息']
      .map((k) => asRecord(obj![k]))
      .find(Boolean)
    if (nested) obj = nested
  }

  if (obj) {
    return {
      title: pickString(obj, META_TITLE_KEYS),
      author: pickString(obj, META_AUTHOR_KEYS),
      genreId: normalizeGenreId(pickString(obj, META_GENRE_KEYS)),
      logline: pickString(obj, META_LOGLINE_KEYS),
      premise: pickString(obj, META_PREMISE_KEYS),
      keywords: toStringList(pickArray(obj, META_KEYWORD_KEYS) ?? pickString(obj, META_KEYWORD_KEYS)),
      characters: toCharacters(pickArray(obj, META_CHARACTER_KEYS))
    }
  }

  // 非 JSON 兜底：逐行抠「书名：/作者：/题材：/一句话：/梗概：」
  const lines = raw.split('\n').map((l) => l.trim())
  const grab = (label: RegExp): string => {
    for (const line of lines) {
      const m = label.exec(line)
      if (m && m[1]) return m[1].trim().replace(/^[《「"]+|[》」"]+$/g, '')
    }
    return ''
  }
  return {
    title: grab(/^(?:书名|标题|作品名)\s*[:：]\s*(.+)$/),
    author: grab(/^(?:作者|著者)\s*[:：]\s*(.+)$/),
    genreId: normalizeGenreId(grab(/^(?:题材|类型)\s*[:：]\s*(.+)$/)),
    logline: grab(/^(?:一句话简介|一句话)\s*[:：]\s*(.+)$/),
    premise: grab(/^(?:故事梗概|梗概|简介)\s*[:：]\s*(.+)$/),
    keywords: [],
    characters: []
  }
}

/* ───────────────────────── 章节摘要解析 ───────────────────────── */

/** 从 item 里抠章节序号；认不出返回 0 */
function pickIndex(obj: Record<string, unknown>): number {
  const direct = ['index', 'idx', 'chapter', 'chapterIndex', 'no', 'n', '序号', '章节', '章']
  for (const key of direct) {
    const value = obj[key]
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    if (typeof value === 'string') {
      const digits = /(\d{1,4})/.exec(value)
      if (digits && digits[1]) return Number(digits[1])
    }
  }
  return 0
}

const SUMMARY_KEYS = ['summary', '摘要', '梗概', 'content', '一句话', 'desc', 'description', 'text'] as const

/**
 * 抢救被截断的 JSON 数组：逐个 `{` 做括号配平，配不上的丢弃。
 * 一批 8 章常常在最后一条撞上 max_tokens，能救回 7 条就不该让整批重来。
 */
function salvageObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let j = i; j < text.length; j++) {
      const c = text.charAt(j)
      if (inString) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') {
        inString = true
        continue
      }
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end < 0) break
    try {
      const obj = asRecord(JSON.parse(text.slice(i, end + 1)) as unknown)
      if (obj) out.push(obj)
    } catch {
      /* 单条坏了不影响其他条 */
    }
    i = end
  }
  return out
}

/**
 * 解析一批章节摘要。
 *
 * opts.batch 是本批送出去的章节序号。两个用途：
 * - 模型整批都没写 index（只按顺序回 8 条）时，按发送顺序补上序号；
 * - 越界校验需要知道「本来该有哪些」。
 * 解析结果按序号升序去重，重复的保留第一条。
 */
export function parseChapterSummaries(
  text: string,
  opts: { batch?: number[]; chapterCount?: number } = {}
): ChapterSummary[] {
  const raw = (text ?? '').trim()
  if (!raw) return []

  const json = extractJson(raw)
  let objects: Record<string, unknown>[] = []
  const arr = firstArray(json)
  if (arr) {
    for (const item of arr) {
      const obj = asRecord(item)
      if (obj) objects.push(obj)
      else if (typeof item === 'string' && item.trim()) objects.push({ summary: item.trim() })
    }
  }
  // JSON 解析不出来但看起来是被截断的数组：逐条抢救
  if (objects.length === 0 && /^\s*\[\s*\{/.test(raw.replace(/^```[a-zA-Z]*\s*/, ''))) {
    objects = salvageObjects(raw.replace(/^```[a-zA-Z]*\s*/, ''))
  }

  const batch = opts.batch ?? []
  // 越界判据：给了全书章数就按全书夹；只给了本批就要求落在本批里
  const inRange = (n: number): boolean => {
    if (opts.chapterCount && opts.chapterCount > 0) return n >= 1 && n <= opts.chapterCount
    if (batch.length > 0) return batch.includes(n)
    return n >= 1
  }

  const byIndex = new Map<number, string>()
  objects.forEach((obj, i) => {
    const summary = pickString(obj, SUMMARY_KEYS)
    if (!summary) return
    // 没写序号：按发送顺序一一对应（模型「乖但不听话」时最典型的形态）
    let index = pickIndex(obj)
    if (index <= 0 && batch.length === objects.length) index = batch[i] ?? 0
    // 写了「批内第几条」（1..8）而不是全书章序号：条数与本批对得上就换算回全书序号，
    // 否则第 3 批的 8 条摘要会全部被当成越界丢掉
    if (index > 0 && batch.length === objects.length && !batch.includes(index) && index <= batch.length) {
      index = batch[index - 1] ?? index
    }
    if (index <= 0 || !inRange(index)) return
    if (byIndex.has(index)) return
    byIndex.set(index, summary)
  })

  return [...byIndex.entries()]
    .map(([index, summary]) => ({ index, summary }))
    .sort((a, b) => a.index - b.index)
}

/* ───────────────────────── 分卷解析 ───────────────────────── */

/**
 * 解析「按情节分卷」的返回。
 * 契约是 [{title,from,to}]，但模型会写成 {chapters:[1..9]} 或 {start,end}，
 * 三种都认；区间越界直接夹回 1..chapterCount，重叠的以先出现的为准。
 */
export function parseVolumePlanOutput(text: string, chapterCount: number): VolumePlanItem[] {
  const raw = (text ?? '').trim()
  if (!raw || chapterCount <= 0) return []
  const arr = firstArray(extractJson(raw))
  if (!arr) return []

  const items: VolumePlanItem[] = []
  for (const entry of arr) {
    const obj = asRecord(entry)
    if (!obj) continue
    const title = pickString(obj, ['title', 'name', '卷名', '标题']) || `第 ${items.length + 1} 卷`
    let from = 0
    let to = 0
    const list = pickArray(obj, ['chapters', '章', '章节'])
    if (list && list.length) {
      const nums = list
        .map((v) => (typeof v === 'number' ? v : Number(/(\d{1,4})/.exec(String(v))?.[1] ?? NaN)))
        .filter((n) => Number.isFinite(n)) as number[]
      if (nums.length) {
        from = Math.min(...nums)
        to = Math.max(...nums)
      }
    }
    if (!from || !to) {
      const f = pickString(obj, ['from', 'start', '起', '起始'])
      const t = pickString(obj, ['to', 'end', '止', '结束'])
      from = Number(/(\d{1,4})/.exec(f)?.[1] ?? 0)
      to = Number(/(\d{1,4})/.exec(t)?.[1] ?? 0)
    }
    if (!from || !to) continue
    const lo = Math.max(1, Math.min(from, to))
    const hi = Math.min(chapterCount, Math.max(from, to))
    if (hi < lo) continue
    items.push({ title: title.trim(), from: lo, to: hi })
  }

  // 按起点排序，重叠区间截断到上一个的末尾，保证每一章只属于一卷
  items.sort((a, b) => a.from - b.from)
  const out: VolumePlanItem[] = []
  let cursor = 1
  for (const item of items) {
    if (item.to < cursor) continue
    const from = Math.max(item.from, cursor)
    out.push({ ...item, from })
    cursor = item.to + 1
  }
  return out
}

/**
 * 把分卷计划摊成「每章归哪一卷」。
 * 计划外的章（模型常常漏掉开头或结尾的几章）归第一卷，不能出现无家可归的章。
 */
export function planVolumeAssignments(
  plan: VolumePlanItem[],
  chapterCount: number
): { titles: string[]; volumeOf: Map<number, number> } {
  const titles = plan.map((p, i) => p.title.trim() || `第 ${i + 1} 卷`)
  if (titles.length === 0) titles.push('第一卷')
  const volumeOf = new Map<number, number>()
  plan.forEach((p, i) => {
    for (let n = Math.max(1, p.from); n <= Math.min(chapterCount, p.to); n++) {
      if (!volumeOf.has(n)) volumeOf.set(n, i)
    }
  })
  return { titles, volumeOf }
}

/* ───────────────────────── 抽样与分批 ───────────────────────── */

export interface ChapterLike {
  index: number
  title: string
  body: string
}

/** 元信息抽样：开头 2 章细读 + 之后均匀取点，总量不超过 maxChars */
export function sampleForMeta(chapters: readonly ChapterLike[], maxChars = 12000): string {
  if (chapters.length === 0) return ''
  const blocks: string[] = []
  let used = 0
  const push = (block: string): boolean => {
    if (used + block.length > maxChars) return false
    blocks.push(block)
    used += block.length
    return true
  }

  for (const c of chapters.slice(0, 2)) {
    push(`【${c.title}】\n${clip(c.body, 1200)}`)
  }

  const rest = chapters.slice(2)
  if (rest.length > 0) {
    // 最多再取 12 个点：取太密没有额外信息量，只会把成本顶高
    const step = Math.max(1, Math.ceil(rest.length / 12))
    for (let i = 0; i < rest.length; i += step) {
      const c = rest[i]!
      if (!push(`【${c.title}】\n${clip(c.body, 800)}`)) break
    }
  }

  return blocks.join('\n\n')
}

/**
 * 章节摘要分批：每批 ≤ maxChapters 章、且输入 ≤ maxChars 字。
 * 单章无论多长只截前 1200 字（摘要只需要情节骨架，不需要文笔）。
 */
export function batchChapters(
  chapters: readonly ChapterLike[],
  maxChapters = 8,
  maxChars = 7000
): SummaryBatch[] {
  const batches: SummaryBatch[] = []
  let current: SummaryBatch = { indexes: [], text: '', chars: 0 }

  for (const c of chapters) {
    const piece = `【第 ${c.index} 章】${c.title}\n${clip(c.body, 1200)}\n`
    const tooMany = current.indexes.length >= maxChapters
    const tooBig = current.chars + piece.length > maxChars && current.indexes.length > 0
    if (tooMany || tooBig) {
      batches.push(current)
      current = { indexes: [], text: '', chars: 0 }
    }
    current.indexes.push(c.index)
    current.text += piece
    current.chars += piece.length
  }
  if (current.indexes.length > 0) batches.push(current)
  return batches
}

/* ───────────────────────── 提示词 ───────────────────────── */

function systemPrompt(role: string): PromptMessage {
  return {
    role: 'system',
    content: [
      role,
      '严格遵守：只输出 JSON，不要 markdown 代码围栏、不要任何解释性文字。',
      '不确定的字段一律留空字符串，禁止编造。'
    ].join('\n')
  }
}

/** 元信息识别：1 次调用 */
export function metaMessages(input: {
  fileName?: string
  titleGuess: string
  authorGuess: string
  sample: string
}): PromptMessage[] {
  return [
    systemPrompt('你是资深图书编辑，正在为一部导入的书稿补全作品档案。'),
    {
      role: 'user',
      content: [
        `文件名：${input.fileName || '（未知）'}`,
        input.titleGuess ? `本地解析的书名候选：${input.titleGuess}` : '',
        input.authorGuess ? `本地解析的作者候选：${input.authorGuess}` : '',
        '',
        '以下是书稿的抽样片段（不是全文，按章节顺序拼接）：',
        input.sample,
        '',
        '请输出这份 JSON：',
        JSON.stringify({
          title: '书名（若书中没写明，按内容起一个，8 字以内）',
          author: '作者（书中没署名就留空）',
          genre: `题材，必须严格从这个清单里选一个中文名：${genreListForPrompt()}`,
          logline: '一句话简介（30–50 字，说清主角、困境、钩子）',
          premise: '故事梗概（300–600 字，按起承转合讲清主线，不要罗列章节）',
          keywords: ['3–6 个标签'],
          characters: [{ name: '姓名', role: '主角/配角/反派', desc: '一句话' }]
        }),
        '题材认不出就填空字符串，不要硬猜。'
      ]
        .filter((x) => x !== '')
        .join('\n')
    }
  ]
}

/** 章节摘要：每批 1 次调用 */
export function chapterSummaryMessages(input: { bookTitle: string; batch: SummaryBatch }): PromptMessage[] {
  return [
    systemPrompt('你是图书编辑，正在为已写好的书稿逐章写摘要。'),
    {
      role: 'user',
      content: [
        `书稿：《${input.bookTitle || '未命名'}》`,
        `下面是第 ${input.batch.indexes[0]} 到 ${input.batch.indexes[input.batch.indexes.length - 1]} 章的节选：`,
        input.batch.text,
        '',
        '请为每一章写 40–80 字摘要，说清这一章发生了什么、推进了什么、留下什么钩子。',
        '只输出 JSON 数组，index 用上面标明的章序号：',
        '[{"index":1,"summary":"..."}]'
      ].join('\n')
    }
  ]
}

/** 按情节分卷：整本书 1 次调用 */
export function volumePlanMessages(input: {
  bookTitle: string
  chapters: readonly { index: number; title: string; summary: string }[]
}): PromptMessage[] {
  return [
    systemPrompt('你是图书编辑，正在把一部没有分卷的长篇按情节切分成若干卷。'),
    {
      role: 'user',
      content: [
        `书稿：《${input.bookTitle || '未命名'}》，共 ${input.chapters.length} 章。`,
        input.chapters.map((c) => `${c.index}. ${c.title}${c.summary ? ` —— ${truncate(c.summary, 40)}` : ''}`).join('\n'),
        '',
        '请按主线情节的转折点分卷（每卷 3–15 章，不要出现空卷），卷名 10 字以内且体现本卷核心冲突。',
        '只输出 JSON 数组，from/to 是章节序号（含两端），必须连续覆盖全部章节：',
        '[{"title":"第一卷 起棺","from":1,"to":8}]'
      ].join('\n')
    }
  ]
}

/** 粗略估算提示词的输入 token（渠道不回 usage 时兜底展示用） */
export function messagesChars(messages: readonly PromptMessage[]): number {
  return messages.reduce((s, m) => s + m.content.length, 0)
}