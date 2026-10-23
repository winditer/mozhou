/**
 * AI 一键开书 —— 流水线内核（纯函数，无 React）
 *
 * 三件事：
 * 1) 为五个步骤拼提示词（书名/设定/分卷/章纲/正文）；
 * 2) 容错解析模型返回的 JSON 或半结构化文本；
 * 3) 把五步产物装配成一份可直接落盘的 Project。
 */
import type { Character, OutlineNode, Project, PromptMessage, WorldEntry } from '@shared/types'
import { getScene } from '@shared/scenes'
import { getGenre } from '@shared/genres'
import { COVER_COLORS, createBlankProject } from '@shared/factory'
import { clamp, countWords, estimateTokens, truncate, uid } from '@shared/utils'
import { textToParagraphHtml } from '../../../lib/generate'
import type { StyleLibrary } from '@shared/styleLibrary'
import { buildDraftMessages } from '../../../lib/prompt'

/* ───────────────────────── 类型 ───────────────────────── */

export type StepStatus = 'pending' | 'running' | 'done' | 'error'

/** 第一步产物：书名 + 简介 */
export interface TitleItem {
  title: string
  intro: string
}

/** 设定条目：世界观条目或角色 */
export interface SettingItem {
  id: string
  kind: 'world' | 'character'
  title: string
  content: string
}

/** 分卷 */
export interface VolumeItem {
  id: string
  title: string
  summary: string
}

/** 章纲 */
export interface ChapterItem {
  id: string
  title: string
  summary: string
}

/** 五步产物汇总 */
export interface QuickStartProduct {
  idea: string
  sceneId: string
  genreId: string
  perChapter: number
  title: TitleItem
  settings: SettingItem[]
  volumes: VolumeItem[]
  chapters: ChapterItem[]
  firstChapter: string
}

/* ───────────────────────── JSON 容错解析 ───────────────────────── */

/** 去掉 ```json …``` 围栏 */
function stripFence(text: string): string {
  const t = text.trim()
  const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(t)
  if (fenced && fenced[1]) return fenced[1].trim()
  return t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
}

/** 从任意文本里抠出第一段括号平衡的 {...} 或 [...]（跳过字符串内的括号） */
function firstBalanced(text: string): string | null {
  let depth = 0
  let begin = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i)
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
    if (c === '{' || c === '[') {
      if (depth === 0) begin = i
      depth += 1
      continue
    }
    if (c === '}' || c === ']') {
      if (depth > 0) depth -= 1
      if (depth === 0 && begin >= 0) return text.slice(begin, i + 1)
    }
  }
  return null
}

/**
 * 容错 JSON 解析：
 * 直接 parse → 去围栏 → 抠第一段平衡括号 → 去尾逗号后再试，全失败返回 null。
 */
export function extractJson(text: string): unknown {
  const raw = (text ?? '').trim()
  if (!raw) return null
  const stripped = stripFence(raw)
  const candidates: string[] = [raw, stripped]
  const balanced = firstBalanced(stripped)
  if (balanced && balanced !== stripped) candidates.push(balanced)
  for (const candidate of candidates) {
    for (const variant of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        return JSON.parse(variant) as unknown
      } catch {
        /* 换下一个候选继续试 */
      }
    }
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 从对象里按候选键名取第一个非空字符串 */
function pickString(obj: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** 对象里第一个数组值（模型有时会包一层 {items:[...]}） */
function firstArrayValue(obj: Record<string, unknown>): unknown[] | null {
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) return value
  }
  return null
}

/* ───────────────────────── 列表解析（通用） ───────────────────────── */

interface LooseItem {
  title: string
  content: string
  /** JSON 里可能给出的类型标记（world / character …） */
  kind?: string
}

const TITLE_FIELDS = ['title', 'name', '标题', '名称', '章名', '卷名', '书名'] as const
const CONTENT_FIELDS = [
  'summary',
  'content',
  'desc',
  'description',
  'intro',
  'detail',
  '一句话',
  '内容',
  '概要',
  '简介',
  '情节点'
] as const
const KIND_FIELDS = ['kind', 'type', 'category', '类型'] as const

function objectToLoose(obj: Record<string, unknown>): LooseItem | null {
  const title = pickString(obj, TITLE_FIELDS)
  let content = pickString(obj, CONTENT_FIELDS)
  if (!content) {
    // 没有约定字段时，把其余文本字段拼起来，尽量不丢信息
    content = Object.entries(obj)
      .filter(([key, value]) => typeof value === 'string' && String(value).trim() && !TITLE_FIELDS.includes(key as (typeof TITLE_FIELDS)[number]))
      .map(([, value]) => String(value).trim())
      .join('；')
  }
  const kind = pickString(obj, KIND_FIELDS)
  if (!title && !content) return null
  return { title: title || truncate(content, 18), content, kind: kind || undefined }
}

function arrayToLoose(list: unknown[]): LooseItem[] {
  const out: LooseItem[] = []
  for (const value of list) {
    if (typeof value === 'string') {
      const text = value.trim()
      if (text) out.push(splitInline(text))
      continue
    }
    const obj = asRecord(value)
    if (!obj) continue
    const item = objectToLoose(obj)
    if (item) out.push(item)
  }
  return out
}

/** 「标题：内容」→ {title, content}；没有分隔符则整体当标题 */
function splitInline(text: string): LooseItem {
  const m = /^(.{2,28}?)\s*(?:[:：]|::|——| - )\s*(.+)$/.exec(text)
  if (m && m[1] && m[2]) return { title: m[1].replace(/[【】[\]]/g, '').trim(), content: m[2].trim() }
  return { title: truncate(text.trim(), 40), content: '' }
}

/** markdown 小标题 → 条目（标题下的段落作为内容） */
function parseHeadings(text: string): LooseItem[] {
  const out: LooseItem[] = []
  let current: LooseItem | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const heading = /^#{1,6}\s+(.+)$/.exec(line) ?? /^\*\*(.+?)\*\*[:：]?$/.exec(line)
    if (heading && heading[1]) {
      if (current) out.push(current)
      current = { title: heading[1].replace(/\*\*/g, '').replace(/[【】]/g, '').trim(), content: '' }
      continue
    }
    if (!current) continue
    current.content = current.content ? `${current.content}\n${line}` : line
  }
  if (current) out.push(current)
  return out.filter((it) => it.title || it.content)
}

/** 「标题 :: 内容」逐行解析 */
function parseColonLines(text: string): LooseItem[] {
  const out: LooseItem[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*•]\s*/, '')
    if (!line) continue
    const m = /^(.{2,28}?)\s*(?:::|：|——| - )\s*(.+)$/.exec(line)
    if (!m || !m[1] || !m[2]) continue
    out.push({ title: m[1].replace(/[【】[\]]/g, '').trim(), content: m[2].trim() })
  }
  return out
}

/** 纯列表行（-、1.、第X章）逐行解析 */
function parseListLines(text: string): LooseItem[] {
  const out: LooseItem[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const bullet = /^(?:[-*•]|\d+\s*[.、)])\s*(.+)$/.exec(line)
    const body = bullet && bullet[1] ? bullet[1].trim() : line
    const isChapterLine = /^第[0-9一二三四五六七八九十百千]+[章节卷回]/.test(body)
    if (!bullet && !isChapterLine) return [] // 有不像列表的段落，整体降级失败
    const item = splitInline(body)
    if (item.title) out.push(item)
  }
  return out
}

/**
 * 抢救被截断的 JSON 数组。
 *
 * 典型场景：模型输出到第 3 条时撞上 max_tokens，最后一段 JSON 断在半句上。
 * 直接 JSON.parse 必然失败，退化成「整体当标题」又会把原始 JSON 字符串
 * 塞进 title（并丢掉所有正文）。所以这里逐个对象扫描：
 * 从每个 { 开始做括号平衡，能配平的就 parse，配不上的丢弃。
 * 已经完整的条目照样能用，用户不必整步重跑。
 */
function salvageTruncatedArray(text: string): LooseItem[] {
  const out: LooseItem[] = []
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
    if (end < 0) break // 这个对象没配平，后面的更不可能配平
    const slice = text.slice(i, end + 1)
    try {
      const obj = asRecord(JSON.parse(slice) as unknown)
      if (obj) {
        const item = objectToLoose(obj)
        if (item && (item.title || item.content)) out.push(item)
      }
    } catch {
      /* 单条坏了不影响其他条 */
    }
    i = end
  }
  return out
}

/**
 * 通用列表解析，优先级：JSON 数组 → markdown 小标题 →「标题：内容」→ 列表行。
 * 全部失败时返回空数组，由调用方决定是否提示重试。
 */
export function parseLooseList(text: string): LooseItem[] {
  const json = extractJson(text)
  if (Array.isArray(json)) {
    const items = arrayToLoose(json)
    if (items.length) return items
  } else {
    const obj = asRecord(json)
    const nested = obj ? firstArrayValue(obj) : null
    if (nested) {
      const items = arrayToLoose(nested)
      if (items.length) return items
    }
  }

  // JSON 没解析成功但看起来像被截断的数组：先抢救完整的那几条
  if (/^\s*\[\s*\{/.test(stripFence(text))) {
    const salvaged = salvageTruncatedArray(stripFence(text))
    if (salvaged.length) return salvaged
  }

  const headings = parseHeadings(text)
  if (headings.length >= 2) return headings

  const colon = parseColonLines(text)
  if (colon.length) return colon

  const lines = parseListLines(text)
  if (lines.length) return lines

  // 兜底：整段当一条。但「[]」「{}」这类空结构、以及纯标点没有信息量，
  // 不该被当成一条设定塞进设定库
  const fallback = text.trim()
  if (!fallback) return []
  if (/^[\s\[\]{}()（）,，.。;；:：'"\-—_]+$/.test(fallback)) return []
  return [{ title: truncate(fallback, 30), content: '' }]
}

/* ───────────────────────── 各步骤解析 ───────────────────────── */

function cleanTitle(raw: string): string {
  return raw
    .replace(/^(?:书名|标题|作品名|name)\s*[:：]\s*/i, '')
    .replace(/^[《「【"']+/, '')
    .replace(/[》」】"']+$/, '')
    .trim()
}

/** 书名 + 简介 */
export function parseTitleOutput(text: string): TitleItem {
  const json = extractJson(text)
  const obj = asRecord(json)
  if (obj) {
    const title = cleanTitle(pickString(obj, ['title', '书名', 'name', 'bookName']))
    const intro = pickString(obj, ['intro', 'summary', '简介', 'description', 'desc', 'logline', 'premise'])
    if (title || intro) return { title, intro }
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  let title = ''
  let intro = ''
  for (const line of lines) {
    const t = /^(?:书名|标题|作品名)\s*[:：]\s*(.+)$/.exec(line)
    if (t && t[1] && !title) {
      title = cleanTitle(t[1])
      continue
    }
    const s = /^(?:一句话简介|简介|梗概|故事简介)\s*[:：]\s*(.+)$/.exec(line)
    if (s && s[1] && !intro) {
      intro = s[1].trim()
    }
  }

  if (!title) {
    const first = lines.find((line) => !/^(?:一句话简介|简介|梗概|故事简介)/.test(line))
    title = cleanTitle(first ?? '')
  }
  if (!intro) {
    const rest = lines.filter((line) => line && line !== title && !line.includes(title))
    intro = rest
      .join('\n')
      .replace(/^(?:一句话简介|简介|梗概|故事简介)\s*[:：]\s*/, '')
      .trim()
  }
  // 兜底也要有底线：模型跑题时可能只吐「OK」「好的」这类碎片，
  // 不能拿它当书名交差，否则一步"成功"其实是废的，后面全建在空地上。
  if (!looksLikeTitle(title)) return { title: '', intro: '' }
  return { title, intro }
}

/**
 * 判断一段文本像不像书名：2–30 个字符、含中文且不含明显的应答/解释词。
 * 用来拦住「OK」「好的」「以下是书名」这类模型跑题产物。
 */
export function looksLikeTitle(raw: string): boolean {
  const t = raw.trim()
  if (t.length < 2 || t.length > 30) return false
  // 纯英文短词多半是应答或占位
  if (/^[A-Za-z0-9\s.,!?]+$/.test(t)) return false
  if (!/[\u4e00-\u9fa5]/.test(t)) return false
  if (/^(?:好的|好|ok|OK|可以|没问题|以下是|下面是|当然|明白|收到)/.test(t)) return false
  // 说明性长句不是书名
  if (/[。；;]/.test(t)) return false
  return true
}

/** 判断设定/章纲条目是否真有内容（不是空壳） */
export function looksSubstantial(
  items: readonly { title: string; content?: string; summary?: string }[]
): boolean {
  const real = items.filter(
    (it) => (it.title + (it.content ?? '') + (it.summary ?? '')).replace(/\s/g, '').length >= 8
  )
  return real.length > 0
}

/** 设定条目：识别为世界的存进设定库，识别为角色的存进角色档案 */
export function parseSettingsOutput(text: string): SettingItem[] {
  return parseLooseList(text)
    .filter((item) => item.title || item.content)
    .slice(0, 16)
    .map((item) => ({
      id: uid('qs'),
      kind: normalizeKind(item.kind ?? '', item.title, item.content),
      title: item.title.replace(/^设定\s*[·:：]\s*/, '').trim(),
      content: item.content.trim()
    }))
}

function normalizeKind(raw: string, title: string, content: string): 'world' | 'character' {
  const flag = raw.toLowerCase()
  if (/char|role|人物|角色/.test(flag)) return 'character'
  if (/world|setting|世界|设定|规则|势力/.test(flag)) return 'world'
  return detectKind(title, content)
}

/** 标题或内容里出现明显的人物特征时当角色处理 */
function detectKind(title: string, content: string): 'world' | 'character' {
  if (/角色|人物|主角|女主|男主|反派|配角|师父|师兄/.test(title)) return 'character'
  if (/姓名|出身|身份|性格|动机|说话方式|口癖/.test(content) && /他|她|这个人/.test(content)) return 'character'
  return 'world'
}

/** 分卷 */
export function parseVolumesOutput(text: string): VolumeItem[] {
  return parseLooseList(text)
    .filter((item) => item.title.trim() || item.content.trim())
    .slice(0, 6)
    .map((item, index) => ({
      id: uid('qs'),
      title: item.title.trim() || `第 ${index + 1} 卷`,
      summary: item.content.trim()
    }))
}

/** 章纲 */
export function parseChaptersOutput(text: string): ChapterItem[] {
  return parseLooseList(text)
    .filter((item) => item.title.trim() || item.content.trim())
    .slice(0, 24)
    .map((item, index) => ({
      id: uid('qs'),
      title: item.title.trim() || `第 ${index + 1} 章`,
      summary: item.content.trim()
    }))
}

/* ───────────────────────── 提示词 ───────────────────────── */

/** 策划类任务的系统提示：场景人设 + 题材公约 + JSON 纪律 */
function planSystem(sceneId: string, genreId: string, job: string): string {
  const scene = getScene(sceneId)
  const genre = genreId ? getGenre(genreId) : undefined
  const parts: string[] = [scene.systemPrompt]
  if (genre) parts.push(`【题材】${genre.name}。${genre.convention}`)
  parts.push(
    `【注意】本轮不写正文，上面的人设与写作法则是你判断质量的标尺；下面的输出纪律优先级最高。`,
    `【本次工作】${job}`,
    `【输出纪律】
- 只输出合法 JSON，不要用 markdown 代码块包裹，不要任何解释、前言、结语或注释。
- 字符串里的双引号用「」代替，避免破坏 JSON。
- 内容必须具体到可以落笔：写清谁、在哪、要做什么、代价是什么；禁止「宏大的世界观」「跌宕起伏的情节」这类空话。
- 与下面的灵感与已定信息保持严格一致，不要另起炉灶。`
  )
  return parts.join('\n\n')
}

/** 把已定设定压成简短摘要，避免提示词过长 */
function digest(items: readonly { title: string; content: string }[], max = 6): string {
  return items
    .filter((item) => item.title || item.content)
    .slice(0, max)
    .map((item) => `· ${item.title}${item.content ? `：${truncate(item.content, 70)}` : ''}`)
    .join('\n')
}

export interface IdeaInput {
  idea: string
  sceneId: string
  genreId: string
}

/** 步骤 1：书名 + 简介 */
export function titleMessages(input: IdeaInput): PromptMessage[] {
  const user = `灵感：${input.idea.trim()}

请为这本书定书名，并写一段简介。
要求：
1. 书名 2–10 个汉字，有画面感或钩子，不带书名号，不用「××的××」这类模板，不用生僻字。
2. 简介 100–200 字：第一句就是核心钩子（谁 + 什么处境 + 哪里不对劲），接着写核心矛盾、主角想要什么、最大悬念。不要写推荐语、不要作者自述。
3. 必须紧扣上面这条灵感，不要泛化成通用套路。

只输出 JSON，不要 markdown 代码块：
{"title":"书名","intro":"100–200 字简介"}`
  return [
    { role: 'system', content: planSystem(input.sceneId, input.genreId, '为整本书定名并写简介') },
    { role: 'user', content: user }
  ]
}

/** 步骤 2：核心设定（6–10 条） */
export function settingsMessages(input: IdeaInput & { title: TitleItem; perChapter: number }): PromptMessage[] {
  const user = `灵感：${input.idea.trim()}
书名：${input.title.title}
简介：${input.title.intro}

请为这本书设计 8 条核心设定（可 6–10 条），覆盖：
- 1–2 条世界观底层规则：这个世界怎么运转，与现实最大的差别是什么，谁在维持它。
- 1–2 条力量/规则体系：阶次或等级、获得方式、必须付出的代价、不可逾越的边界（要可量化、可写进冲突）。
- 2–3 条主要角色：姓名、身份职务、他想要什么、致命缺陷、说话方式（句长/口癖/称呼习惯），并说明他在故事里会做什么选择。
- 1–2 条势力、地点或背景悬案：能直接当冲突现场用。
每条 80–160 字，具体可写。
kind 字段取值："world"（世界观/势力/地点/规则）或 "character"（人物）。
每章目标字数约 ${input.perChapter} 字，设定要支撑得起这个体量的展开。

只输出 JSON 数组，不要 markdown 代码块：
[{"kind":"world","title":"不超过 14 字","content":"80–160 字"}]`
  return [
    { role: 'system', content: planSystem(input.sceneId, input.genreId, '设计整本书的核心设定') },
    { role: 'user', content: user }
  ]
}

/** 步骤 3：分卷结构（3 卷） */
export function volumesMessages(
  input: IdeaInput & { title: TitleItem; settings: readonly SettingItem[] }
): PromptMessage[] {
  const user = `书名：${input.title.title}
简介：${input.title.intro}
已定设定：
${digest(input.settings) || '（尚未确定）'}

请把这本书拆成 3 卷，每卷一句概要。
要求：
1. 三卷的冲突必须升级：第一卷立足与结仇，第二卷扩张与强敌，第三卷掀桌与代价。
2. 每卷 summary 60–120 字，写清三件事：本卷要解决什么冲突、主角要付出什么代价、卷末留下什么悬念。
3. 卷与卷之间要有因果，不要三卷都在打同一批人。

只输出 JSON 数组，不要 markdown 代码块：
[{"title":"第一卷 ×××","summary":"60–120 字"}]`
  return [
    { role: 'system', content: planSystem(input.sceneId, input.genreId, '规划全书分卷结构') },
    { role: 'user', content: user }
  ]
}

/** 步骤 4：首卷章纲（8–12 章） */
export function chaptersMessages(
  input: IdeaInput & { title: TitleItem; settings: readonly SettingItem[]; volumes: readonly VolumeItem[] }
): PromptMessage[] {
  const vol = input.volumes[0]
  const user = `书名：${input.title.title}
简介：${input.title.intro}
第一卷：${vol ? `${vol.title}——${vol.summary}` : '（尚未确定）'}
已定设定：
${digest(input.settings) || '（尚未确定）'}

请为第一卷写 10 章章纲（可 8–12 章）。
要求：
1. 第 1 章前 300 字内必须发生事件，完成「立住主角处境 + 抛出核心矛盾」。
2. 每章 summary 30–60 字，写清：这一章发生什么、谁推动了什么、章末钩子落在哪里（具体到一句台词或一个动作）。
3. 相邻章的钩子类型不要重复（悬念 / 反转 / 危机 / 信息断层轮换）。
4. 每章都要有信息增量或情绪推进，不要写「休整」「日常」这种空章。

只输出 JSON 数组，不要 markdown 代码块：
[{"title":"第1章 ×××","summary":"30–60 字"}]`
  return [
    { role: 'system', content: planSystem(input.sceneId, input.genreId, '写第一卷章纲') },
    { role: 'user', content: user }
  ]
}

/**
 * 步骤 5：首章正文。
 * 先把已定产物装配成临时 Project，复用 buildSystemPrompt / assembleContext
 * 那套上下文机制，保证设定与章纲都被注入。
 */
export function firstChapterMessages(product: QuickStartProduct, library?: StyleLibrary | null): PromptMessage[] {
  const project = assembleProject({ ...product, firstChapter: '' })
  const chapter = project.chapters[0] ?? null
  return buildDraftMessages(
    project,
    chapter,
    {
      instruction: `写出《${product.title.title}》第一章的完整正文。严格按本章情节点展开，第一段就要把读者拉进场景；不要复述设定，不要写「本章看点」，不要总结。`,
      targetWords: product.perChapter,
      chapterTitle: chapter?.title
    },
    library
  )
}

/** 提示词估算 token（渠道不回 usage 时兜底） */
export function messagesTokens(messages: readonly PromptMessage[]): number {
  return estimateTokens(messages.map((m) => m.content).join('\n'))
}

/* ───────────────────────── 装配 Project ───────────────────────── */

function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const m = /^[^。！？!?]{1,60}/.exec(t)
  return (m ? m[0] : t.slice(0, 60)).trim()
}

/** 按书名散列挑一个封面色，避免每本新书都是同一个蓝 */
function pickCoverColor(seed: string): string {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) % 9973
  return COVER_COLORS[hash % COVER_COLORS.length] ?? COVER_COLORS[0]!
}

function toCharacter(item: SettingItem): Character {
  const name = item.title.replace(/^(?:人物|角色)\s*[·:：]\s*/, '').trim() || '未命名角色'
  const role = /主角|女主|男主/.test(item.title) ? '主角' : /反派|对手/.test(item.title) ? '反派' : ''
  return {
    id: uid('ch'),
    name,
    role,
    age: '',
    identity: firstSentence(item.content),
    appearance: '',
    personality: '',
    motivation: '',
    flaw: '',
    arc: '',
    speechStyle: '',
    relations: [],
    hidden: false,
    notes: item.content
  }
}

/**
 * 把五步产物装配成 Project：
 * brief = 书名简介，bible = 世界观条目 + 角色，outline = 分卷（第一卷挂章纲），
 * chapters = 章纲对应章节（第一章带正文）。
 */
export function assembleProject(product: QuickStartProduct): Project {
  const scene = getScene(product.sceneId)
  const perChapter = clamp(Math.round(product.perChapter || scene.defaultChapterWords), scene.minChapterWords, scene.maxChapterWords)
  const title = product.title.title.trim() || '未命名作品'
  const intro = product.title.intro.trim()

  const project = createBlankProject({
    title,
    sceneId: scene.id,
    genreId: product.genreId || undefined,
    logline: firstSentence(intro) || product.idea.trim(),
    premise: intro,
    targetWordsPerChapter: perChapter,
    targetTotalWords: 0,
    coverColor: pickCoverColor(title)
  })

  // 设定库 + 角色档案
  const world: WorldEntry[] = []
  const characters: Character[] = []
  for (const item of product.settings) {
    const name = item.title.trim()
    const content = item.content.trim()
    if (!name && !content) continue
    if (item.kind === 'character') {
      characters.push(toCharacter(item))
    } else {
      world.push({ id: uid('w'), category: 'world', title: name || '设定', content, visible: true })
    }
  }
  project.bible = { ...project.bible, world, characters }

  // 章纲 → 大纲节点 + 章节
  const now = Date.now()
  const chapterNodes: OutlineNode[] = []
  const chapters: Project['chapters'] = []
  product.chapters.forEach((item, index) => {
    const chapterTitle = item.title.trim() || `第 ${index + 1} 章`
    const node: OutlineNode = {
      id: uid('o'),
      title: chapterTitle,
      summary: item.summary.trim(),
      type: 'chapter',
      status: 'planned',
      children: []
    }
    chapterNodes.push(node)
    const content = index === 0 ? textToParagraphHtml(product.firstChapter) : ''
    chapters.push({
      id: uid('c'),
      title: chapterTitle,
      content,
      summary: item.summary.trim(),
      status: content ? 'draft' : 'planned',
      targetWords: perChapter,
      words: content ? countWords(content) : 0,
      outlineNodeId: node.id,
      createdAt: now,
      updatedAt: now,
      versions: []
    })
  })

  // 分卷 → 大纲（第一卷挂首卷章纲）
  const volumeItems = product.volumes.filter((v) => v.title.trim() || v.summary.trim())
  project.outline = volumeItems.length
    ? volumeItems.map((volume, index) => ({
        id: uid('o'),
        title: volume.title.trim() || `第 ${index + 1} 卷`,
        summary: volume.summary.trim(),
        type: 'volume',
        status: 'planned',
        children: index === 0 ? chapterNodes : []
      }))
    : [
        {
          id: uid('o'),
          title: '第一卷',
          summary: '',
          type: 'volume',
          status: 'planned',
          children: chapterNodes
        }
      ]

  if (chapters.length > 0) project.chapters = chapters
  project.updatedAt = Date.now()
  return project
}