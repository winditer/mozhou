import type { Project } from '@shared/types'
import { uid } from '@shared/utils'

/* ────────────────────────── 类型 ────────────────────────── */

export type IssueLevel = 'high' | 'medium' | 'low'

export interface AuditIssue {
  id: string
  level: IssueLevel
  /** 人物 / 时间线 / 设定 / 伏笔 / 逻辑 */
  type: string
  title: string
  detail: string
  /** 从原文里摘出的证据片段，可能为空 */
  evidence: string
  chapterIds: string[]
  suggestion: string
}

export interface ChapterScores {
  rhythm: number
  conflict: number
  suspense: number
  water: number
}

export interface ChapterReport {
  scores: ChapterScores
  comment: string
  issues: AuditIssue[]
}

export interface ThreadSuggestion {
  id: string
  title: string
  setup: string
  chapterId: string | null
  suggestion: string
}

export type ParseOutcome<T> = { ok: true; value: T; note?: string } | { ok: false; raw: string; note: string }

/* ────────────────────────── 基础取值 ────────────────────────── */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean).join('；')
  return ''
}

/** 从字段里取第一个非空字符串 */
function pick(obj: Record<string, unknown> | null, keys: string[]): string {
  if (!obj) return ''
  for (const k of keys) {
    const s = str(obj[k])
    if (s) return s
  }
  return ''
}

function pickNum(obj: Record<string, unknown> | null, keys: string[], dflt: number): number {
  if (!obj) return dflt
  for (const k of keys) {
    const raw = obj[k]
    if (typeof raw === 'number' && Number.isFinite(raw)) return clamp01to100(raw)
    const s = str(raw)
    if (s) {
      const m = s.match(/-?\d+(?:\.\d+)?/)
      if (m) return clamp01to100(parseFloat(m[0]))
    }
  }
  return dflt
}

function clamp01to100(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

/* ────────────────────────── JSON 容错抽取 ────────────────────────── */

/** 去掉 markdown 代码块围栏；有围栏时优先取围栏内容 */
function stripFences(input: string): string {
  const s = input.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\r\n/g, '\n').trim()
  const fenced = s.match(/```(?:json|JSON|javascript|js)?\s*\n?([\s\S]*?)```/)
  if (fenced && fenced[1] && fenced[1].trim()) return fenced[1].trim()
  return s.replace(/^```(?:json|JSON)?\s*/i, '').replace(/```\s*$/, '').trim()
}

/** 常见的模型手滑修复：尾逗号、全角引号、注释、未加引号的 key */
function repairJson(s: string): string {
  return s
    .replace(/\/\/[^\n"]*$/gm, '')
    .replace(/,\s*([\]}])/g, '$1')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/：/g, ':')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
}

function tryParse(s: string): unknown {
  const candidates = [s, repairJson(s)]
  for (const c of candidates) {
    try {
      return JSON.parse(c) as unknown
    } catch {
      /* 继续尝试下一种 */
    }
  }
  return null
}

/** 从任意文本里截出第一个配平的 [...]（考虑字符串内的括号） */
function sliceBalanced(s: string, open: '[' | '{', close: ']' | '}'): string | null {
  const start = s.indexOf(open)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s.charAt(i)
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 把一段「被 max_tokens 截断在半路」的对象补全成可解析的 JSON。
 *
 * 为什么必须有这一步：体检的输出是 3–12 条问题组成的数组，额度一旦不够，
 * 模型会在**最后一个问题写到一半**时被硬切断。完整对象能被 salvageObjects 救回来，
 * 但正在写的那个永远闭合不了、被直接丢弃——如果切在第一 条中间（额度特别紧时常发生），
 * 结果就是「零条」，界面上表现为「体检跑完了但什么都没有」。
 *
 * 做法：先按 JSON 字符串状态机截到最后一个完整的「成员值」，再补齐缺的引号与括号。
 * 补出来的这条通常仍有 title/detail 可读，比整条丢掉有用得多。
 */
function completeTruncatedObject(piece: string): Record<string, unknown> | null {
  let depth = 0
  let inStr = false
  let esc = false
  // 记住「最后一个可以安全截断的位置」：只有处于对象内部、且不在字符串里时才算
  let lastSafe = -1
  for (let i = 0; i < piece.length; i++) {
    const c = piece.charAt(i)
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') {
        inStr = false
        lastSafe = i + 1
      }
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      lastSafe = i + 1
    } else if (c === ',') lastSafe = i
    else if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t' && c !== ':') lastSafe = i + 1
  }

  // 逐个候选截断点往回退，找到第一个能补成合法 JSON 的
  for (let cut = lastSafe; cut > 1; cut--) {
    let head = piece.slice(0, cut).replace(/,\s*$/, '')
    if (!head.startsWith('{')) continue
    // 清掉尾部悬挂的 "key":（没有值的情况）
    head = head.replace(/,\s*"[^"]*"\s*:\s*$/, '').replace(/"[^"]*"\s*:\s*$/, '')
    if (head.length < 3) continue
    // 补齐未闭合的字符串与花括号
    let needQuote = false
    let quoteEsc = false
    let str = false
    let braces = 0
    for (let i = 0; i < head.length; i++) {
      const c = head.charAt(i)
      if (str) {
        if (quoteEsc) quoteEsc = false
        else if (c === '\\') quoteEsc = true
        else if (c === '"') str = false
        continue
      }
      if (c === '"') str = true
      else if (c === '{') braces++
      else if (c === '}') braces--
    }
    needQuote = str
    const tail = (needQuote ? '"' : '') + '}'.repeat(Math.max(0, braces))
    const parsed = asRecord(tryParse(head + tail))
    if (parsed) return parsed
  }
  return null
}

/** 输出被截断时的兜底：把已经写完的 {...} 一个个抠出来 */
function salvageObjects(s: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let i = 0
  while (i < s.length) {
    const start = s.indexOf('{', i)
    if (start < 0) break
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let j = start; j < s.length; j++) {
      const c = s.charAt(j)
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') {
        inStr = true
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
    if (end < 0) {
      // 截断在对象中间：把这条写了一半的也抢救出来，别整条丢掉
      const rescued = completeTruncatedObject(s.slice(start))
      if (rescued) out.push(rescued)
      break
    }
    const piece = s.slice(start, end + 1)
    const parsed = asRecord(tryParse(piece))
    if (parsed) out.push(parsed)
    i = end + 1
  }
  return out
}

/** 抽取 JSON 数组；支持 [..] / {"issues":[..]} / 代码块 / 截断 */
export function extractArray(raw: string): unknown[] | null {
  const text = stripFences(raw)
  if (!text) return null

  const whole = tryParse(text)
  if (Array.isArray(whole)) return whole
  const wrapped = asRecord(whole)
  if (wrapped) {
    for (const v of Object.values(wrapped)) {
      if (Array.isArray(v)) return v
    }
  }

  const balanced = sliceBalanced(text, '[', ']')
  if (balanced) {
    const parsed = tryParse(balanced)
    if (Array.isArray(parsed)) return parsed
  }

  // 截断 / 局部损坏：逐对象抢救
  const salvaged = salvageObjects(text.indexOf('[') >= 0 ? text.slice(text.indexOf('[')) : text)
  if (salvaged.length) return salvaged
  return null
}

/** 抽取 JSON 对象；支持包装、代码块、截断 */
export function extractObject(raw: string): Record<string, unknown> | null {
  const text = stripFences(raw)
  if (!text) return null

  const whole = asRecord(tryParse(text))
  if (whole) return whole

  const balanced = sliceBalanced(text, '{', '}')
  if (balanced) {
    const parsed = asRecord(tryParse(balanced))
    if (parsed) return parsed
  }

  const salvaged = salvageObjects(text)
  if (salvaged.length) {
    // 取字段最多的那个（通常是主对象）
    return salvaged.reduce((best, cur) =>
      Object.keys(cur).length > Object.keys(best).length ? cur : best
    )
  }
  return null
}

export function extractRawArrayBlock(raw: string): string {
  const text = stripFences(raw)
  const balanced = sliceBalanced(text, '[', ']')
  return balanced ?? text
}

/* ────────────────────────── 章节定位 ────────────────────────── */

const CN_DIGIT: Record<string, number> = {
  零: 0,
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

function cn2num(input: string): number | null {
  if (/^\d+$/.test(input)) return parseInt(input, 10)
  let section = 0
  let number = 0
  for (const ch of input) {
    if (ch in CN_DIGIT) number = CN_DIGIT[ch] ?? 0
    else if (ch === '十') {
      section += (number || 1) * 10
      number = 0
    } else if (ch === '百') {
      section += (number || 1) * 100
      number = 0
    } else if (ch === '千') {
      section += (number || 1) * 1000
      number = 0
    } else return null
  }
  const total = section + number
  return total > 0 ? total : null
}

function normalizeTitle(t: string): string {
  return t
    .replace(/^第[零一二三四五六七八九十百千0-9]{1,8}[章节回卷]\s*[：:.、-]?\s*/, '')
    .replace(/[《》「」【】"'“”\s]/g, '')
    .trim()
}

/** 把一个可能很脏的章节引用（id / 「第3章」/「第三章 雨夜」/《雨夜》）解析成真实 chapterId */
export function resolveChapterId(input: string, project: Project): string | null {
  const s = input.trim()
  if (!s) return null

  const byId = project.chapters.find((c) => c.id === s)
  if (byId) return byId.id

  const numMatch = s.match(/第\s*([0-9零一二三四五六七八九十百千两]{1,8})\s*[章节回]/)
  if (numMatch) {
    const n = cn2num(numMatch[1] ?? '')
    if (n && project.chapters[n - 1]) return project.chapters[n - 1]?.id ?? null
  }

  const target = normalizeTitle(s)
  if (!target) return null

  let best: { id: string; len: number } | null = null
  for (const c of project.chapters) {
    const t = normalizeTitle(c.title)
    if (!t) continue
    if (t === target) return c.id
    if (t.includes(target) || target.includes(t)) {
      if (!best || t.length > best.len) best = { id: c.id, len: t.length }
    }
  }
  return best ? best.id : null
}

function resolveChapterIds(raw: unknown, project: Project): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  const out: string[] = []
  for (const item of list) {
    const id = resolveChapterId(str(item), project)
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/* ────────────────────────── 问题归一化 ────────────────────────── */

const LEVEL_ALIAS: Record<string, IssueLevel> = {
  high: 'high',
  高: 'high',
  严重: 'high',
  高危: 'high',
  高优先级: 'high',
  critical: 'high',
  major: 'high',
  fatal: 'high',
  3: 'high',
  medium: 'medium',
  中: 'medium',
  一般: 'medium',
  中等: 'medium',
  warning: 'medium',
  moderate: 'medium',
  2: 'medium',
  low: 'low',
  低: 'low',
  轻微: 'low',
  建议: 'low',
  minor: 'low',
  info: 'low',
  1: 'low'
}

const TYPE_ALIAS: { key: string; value: string }[] = [
  { key: '人物', value: '人物' },
  { key: '角色', value: '人物' },
  { key: '人设', value: '人物' },
  { key: 'character', value: '人物' },
  { key: '时间', value: '时间线' },
  { key: '时序', value: '时间线' },
  { key: 'timeline', value: '时间线' },
  { key: '设定', value: '设定' },
  { key: '世界观', value: '设定' },
  { key: 'world', value: '设定' },
  { key: 'setting', value: '设定' },
  { key: '伏笔', value: '伏笔' },
  { key: '悬念', value: '伏笔' },
  { key: '线索', value: '伏笔' },
  { key: 'foreshadow', value: '伏笔' },
  { key: '逻辑', value: '逻辑' },
  { key: '剧情', value: '逻辑' },
  { key: '情节', value: '逻辑' },
  { key: 'logic', value: '逻辑' },
  { key: 'plot', value: '逻辑' }
]

function normalizeLevel(raw: unknown): IssueLevel {
  const key = str(raw).toLowerCase().replace(/[「」【】"']/g, '')
  return LEVEL_ALIAS[key] ?? 'medium'
}

function normalizeType(raw: unknown): string {
  const key = str(raw).toLowerCase()
  // 没给类型就不猜：宁可少一个标签，也不要给单章体检的问题硬贴「逻辑」
  if (!key) return ''
  for (const t of TYPE_ALIAS) {
    if (key.includes(t.key)) return t.value
  }
  const plain = str(raw)
  return plain.length <= 6 ? plain : '逻辑'
}

function toIssue(v: unknown, project: Project, fallbackChapterId?: string): AuditIssue | null {
  const obj = asRecord(v)
  const title = pick(obj, ['title', '标题', 'name', '问题', 'issue'])
  const detail = pick(obj, ['detail', 'desc', 'description', '说明', '描述', 'content'])
  if (!title && !detail) return null

  const ids = resolveChapterIds(
    obj?.['chapterIds'] ?? obj?.['chapters'] ?? obj?.['chapterId'] ?? obj?.['章节'] ?? obj?.['chapter'],
    project
  )
  if (!ids.length && fallbackChapterId) ids.push(fallbackChapterId)

  return {
    id: uid('is'),
    level: normalizeLevel(obj?.['level'] ?? obj?.['severity'] ?? obj?.['等级'] ?? obj?.['严重度']),
    type: normalizeType(obj?.['type'] ?? obj?.['category'] ?? obj?.['类型'] ?? obj?.['类别']),
    title: title || detail.slice(0, 18),
    detail: detail || title,
    evidence: pick(obj, ['evidence', 'quote', '原文', '证据', 'excerpt', 'sample']),
    chapterIds: ids,
    suggestion: pick(obj, ['suggestion', 'fix', 'advice', '建议', '修改建议', 'solution'])
  }
}

const LEVEL_ORDER: Record<IssueLevel, number> = { high: 0, medium: 1, low: 2 }

export function sortIssues(list: AuditIssue[]): AuditIssue[] {
  return [...list].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
}

/* ────────────────────────── 三个检查器的解析入口 ────────────────────────── */

export function parseBookIssues(raw: string, project: Project): ParseOutcome<AuditIssue[]> {
  const arr = extractArray(raw)
  if (!arr) {
    return { ok: false, raw, note: '返回内容里没有可解析的 JSON 数组' }
  }
  const issues: AuditIssue[] = []
  for (const item of arr) {
    const issue = toIssue(item, project)
    if (issue) issues.push(issue)
  }
  if (!issues.length && arr.length > 0) {
    return { ok: false, raw, note: '数组里每一项都缺少 title / detail 字段' }
  }
  return { ok: true, value: sortIssues(issues) }
}

export function parseChapterReport(
  raw: string,
  project: Project,
  chapterId: string
): ParseOutcome<ChapterReport> {
  const obj = extractObject(raw)

  const scores: ChapterScores = {
    rhythm: pickNum(obj, ['rhythm', '节奏', '节奏感', 'pacing'], -1),
    conflict: pickNum(obj, ['conflict', '冲突', '冲突强度', 'tension'], -1),
    suspense: pickNum(obj, ['suspense', '悬念', '悬念感'], -1),
    water: pickNum(obj, ['water', '注水', '注水程度', '水分', 'filler'], -1)
  }

  // 正则兜底：对象整体解析失败时，直接从原文里抠分数
  if (scores.rhythm < 0 || scores.conflict < 0 || scores.suspense < 0 || scores.water < 0) {
    const grab = (keys: string[], dflt: number): number => {
      for (const k of keys) {
        const m = raw.match(new RegExp(`["']?${k}["']?\\s*[:：]\\s*"?\\s*(-?\\d{1,3})`, 'i'))
        if (m && m[1]) return clamp01to100(parseInt(m[1], 10))
      }
      return dflt
    }
    if (scores.rhythm < 0) scores.rhythm = grab(['rhythm', '节奏'], 0)
    if (scores.conflict < 0) scores.conflict = grab(['conflict', '冲突'], 0)
    if (scores.suspense < 0) scores.suspense = grab(['suspense', '悬念'], 0)
    if (scores.water < 0) scores.water = grab(['water', '注水', '水分'], 0)
  }

  const comment = pick(obj, ['comment', '评语', 'summary', '总评', 'overall', 'note'])

  const rawIssues = obj?.['issues'] ?? obj?.['问题'] ?? obj?.['problems']
  const issueArr = Array.isArray(rawIssues) ? rawIssues : extractArray(raw) ?? []
  const issues: AuditIssue[] = []
  for (const item of issueArr) {
    const issue = toIssue(item, project, chapterId)
    if (issue) issues.push(issue)
  }

  const hasAnyScore =
    scores.rhythm > 0 || scores.conflict > 0 || scores.suspense > 0 || scores.water > 0
  if (!obj && !hasAnyScore && !comment) {
    // 模型常常无视 JSON 要求、直接回一段分析文字。那种文字里其实已经有评价，
    // 尽力兜住，比让作者面对「解析失败」重跑一次更好。
    const salvaged = salvageChapterProse(raw)
    if (salvaged) {
      return {
        ok: true,
        value: { scores: salvaged.scores, comment: salvaged.comment, issues: [] },
        note: '模型没有输出 JSON，已从文字里尽量还原评分与评语'
      }
    }
    return { ok: false, raw, note: '既没有解析出评分，也没有评语' }
  }

  return {
    ok: true,
    value: {
      scores: {
        rhythm: Math.max(0, scores.rhythm),
        conflict: Math.max(0, scores.conflict),
        suspense: Math.max(0, scores.suspense),
        water: Math.max(0, scores.water)
      },
      comment: comment || (hasAnyScore ? '' : '（模型没有给出评语）'),
      issues: sortIssues(issues)
    }
  }
}

/**
 * 从「模型没按格式走」的散文里尽量救回可用结果。
 *
 * 真实遇到的情况：模型无视 JSON 要求，直接回了一段分析文字——
 * 「这一章的节奏整体偏慢，前半段环境描写过多……冲突方面，主角的动机不够明确……」
 * 这时如果只报「解析失败」，作者拿不到任何东西，只能重跑或换模型；
 * 但那句话里其实已经点出了节奏慢、冲突弱，是有信息量的。
 *
 * 所以这里做两件事：从散文里抠四维评分的线索词，并把分析文字当作评语。
 * 分数只在能从文字判断出好坏时才给，判断不出就留 0（表示未评）
 * ——宁可显示「未评」，也不凭空编一个数字骗人。
 */
export function salvageChapterProse(raw: string): { scores: ChapterScores; comment: string } | null {
  const text = String(raw || '').trim()
  // 太短的多半是模型发呆或报错，不像分析
  if (text.length < 12) return null
  // 已经能解析出 JSON 的就不用走这条路
  if (/^\s*[{[]/.test(text) && text.length > 2 && tryParse(text)) return null

  const NEG = /(偏慢|太慢|拖|拖沓|冗长|泄了气|弱|不够|不足|平淡|缺乏|散|水|凑字数|重复|没推进|停滞)/g
  const POS = /(紧凑|扎实|有力|清晰|到位|强|饱满|抓人|有钩子|有效|不错|很好)/g

  /** 反向指标换算：好评（70）在注水上意味着「水分少」，应映射成低分 */
  const invertScore = (v: number): number => (v === 0 ? 0 : 100 - v)

  /** 找出某个维度在文中的描述句，判断它是好评还是差评 */
  const scoreOf = (keys: string[]): number => {
    for (const k of keys) {
      const i = text.indexOf(k)
      if (i < 0) continue
      // 取关键词前后一个窗口，看评价倾向
      const win = text.slice(Math.max(0, i - 30), Math.min(text.length, i + 60))
      // 「几乎不注水」「没有水分」是否定式好评：关键词前面紧挨着否定词，
      // 不能因为窗口里出现「不」就当成差评。
      const before = text.slice(Math.max(0, i - 4), i)
      const negated = /(几乎不|没有|不怎么|不|无|没)$/.test(before)
      const neg = (win.match(NEG) || []).length
      const pos = (win.match(POS) || []).length
      if (negated && !pos) return 70
      if (!neg && !pos) continue
      // 明确说「好」「够」给及格以上，明确说差给不及格，都没提就不评
      if (neg > pos) return 40
      if (pos > neg) return 70
      return 55
    }
    // 退一步：整段文字里如果只出现了某维度的负向词，也算弱
    return 0
  }

  const scores: ChapterScores = {
    rhythm: scoreOf(['节奏']),
    conflict: scoreOf(['冲突', '对抗', '张力']),
    suspense: scoreOf(['悬念', '钩子']),
    // 注水是**反向指标**：越高越糟。说「不注水/几乎不注水」是好话，要给低分。
    water: invertScore(scoreOf(['注水', '水分', '凑字数']))
  }

  const hasAny = scores.rhythm || scores.conflict || scores.suspense || scores.water
  if (!hasAny) return null
  return { scores, comment: text.slice(0, 600) }
}

export function parseThreadSuggestions(raw: string, project: Project): ParseOutcome<ThreadSuggestion[]> {
  const arr = extractArray(raw)
  if (!arr) return { ok: false, raw, note: '返回内容里没有可解析的 JSON 数组' }

  const existing = new Set(project.bible.threads.map((t) => normalizeTitle(t.title)))
  const out: ThreadSuggestion[] = []
  for (const item of arr) {
    const obj = asRecord(item)
    if (!obj) continue
    const title = pick(obj, ['title', '标题', 'name', '伏笔'])
    if (!title) continue
    if (existing.has(normalizeTitle(title))) continue
    out.push({
      id: uid('ts'),
      title,
      setup: pick(obj, ['setup', 'description', 'desc', '说明', '埋设', 'detail']),
      chapterId: resolveChapterId(
        pick(obj, ['chapterId', 'chapter', '章节']) ||
          (Array.isArray(obj['chapterIds']) ? str((obj['chapterIds'] as unknown[])[0]) : ''),
        project
      ),
      suggestion: pick(obj, ['suggestion', 'payoff', '建议', '回收建议', 'advice'])
    })
  }
  if (!out.length && arr.length > 0) {
    return { ok: false, raw, note: '没有解析出标题，或全部与台账重复' }
  }
  return { ok: true, value: out }
}

/**
 * 伏笔台账里「埋设章」的本地定位：
 * 优先 setup 文本里明确写的「第N章」，其次匹配章节标题。
 */
export function locateThreadChapter(setup: string, project: Project): string | null {
  const text = (setup || '').trim()
  if (!text) return null

  const direct = text.match(/第\s*([0-9零一二三四五六七八九十百千两]{1,8})\s*[章节回]/)
  if (direct) {
    const n = cn2num(direct[1] ?? '')
    if (n && project.chapters[n - 1]) return project.chapters[n - 1]?.id ?? null
  }

  let best: { id: string; len: number } | null = null
  for (const c of project.chapters) {
    const full = c.title.trim()
    const bare = normalizeTitle(c.title)
    if (full && text.includes(full)) return c.id
    if (bare.length >= 2 && text.includes(bare)) {
      if (!best || bare.length > best.len) best = { id: c.id, len: bare.length }
    }
  }
  return best ? best.id : null
}