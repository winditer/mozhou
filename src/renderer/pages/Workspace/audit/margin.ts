import type {
  Chapter,
  MarginNote,
  MarginNoteKind,
  MarginNoteSet,
  Project,
  PromptMessage
} from '@shared/types'
import { countWords, stripHtml, truncate } from '@shared/utils'
import { characterDigest, threadDigest } from './prompts'

/**
 * 段落侧批：不改稿，只在段落旁边写一句话。
 *
 * 这是编辑真正干的事——红笔不是用来替作者写的，是用来让作者看见自己没看见的东西。
 * 所以这里的输出被刻意约束成「一句一句的批注」，不是整段改写，也不是打分。
 *
 * 本文件是旁批的**唯一事实来源**：提示词、解析、指纹、执行器都在这里，
 * 体检页的批量工作台和写作页的旁批栏共用同一套规则，两处口径才不会分叉。
 */

/** 六种批注口吻，顺序固定：界面筛选与提示词枚举都按它来 */
export const MARGIN_KINDS: MarginNoteKind[] = ['删', '改', '慢', '快', '虚', '偏']

const KIND_SET = new Set<string>(MARGIN_KINDS)

export const MARGIN_NO_MODEL = '还没有配置「一致性审校」模型'

const MARGIN_SYSTEM = `你是一位在稿纸上用红笔写批注的老编辑。你带过作者，也退过无数稿子。
你的批注有三条规矩：
一、只说这一处，不总结全章，不夸人，不做总体评价。
二、每条批注必须指向一个具体的词、一句动作或一句对话，能让人一眼找到你说的是哪里。不写"这里可以更生动"这种空话。
三、宁少勿多。一趟批注里，没毛病的地方就跳过；批注超过六条，作者就不会看了。
你只说问题，也顺带说清怎么改，但绝不替作者把那段重写一遍。
你的输出必须是可被 JSON.parse 解析的纯数据。`

/**
 * 把正文切成段落，过滤空段。
 *
 * 规则必须只有一份：批注序号、正文跳转、指纹校验全都靠它对齐。
 * 任何一处自己再写一遍切分，序号就会错位，批注会挂到别的段落上。
 */
export function splitParagraphs(chapter: Chapter | null): string[] {
  if (!chapter) return []
  return stripHtml(chapter.content)
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 正文指纹：词数 + 首尾各 30 字。
 *
 * 只比整篇文本会太脆（改一个标点就不一致），只比词数又太钝（换掉整段但字数相同查不出来）。
 * 首尾片段负责捕捉「开头或结尾被重写」，词数负责捕捉「中间被加删」。
 * 归一化空白后再截，避免编辑器把 <p> 换成 <br> 就误报「正文改过」。
 */
export function chapterFingerprint(chapter: Chapter | null): string {
  if (!chapter) return ''
  const text = splitParagraphs(chapter).join(' ').replace(/\s+/g, ' ').trim()
  const head = text.slice(0, 30)
  const tail = text.length > 30 ? text.slice(-30) : text
  return `${countWords(stripHtml(chapter.content))}|${head}|${tail}`
}

/**
 * 提示词里必须写清「这是第几章、全本共几章、章名」。
 *
 * 以前只给分段正文，模型会把这一章当成全书开头，评「开篇没有交代人物」——
 * 明明第三章了，人物早在第一章交代过。章名还给模型一个语义坐标，
 * 章标题里的线索（「灰线」「十六人抬棺」）经常就是这一章的主问题。
 */
export function buildMarginNoteMessages(
  project: Project,
  chapter: Chapter,
  chapterIndex?: number,
  chapterTotal?: number
): PromptMessage[] {
  const paras = splitParagraphs(chapter)
  const numbered = paras.map((p, i) => `${i + 1}. ${p}`).join('\n\n')

  // 调用方没传序号时自己从项目里找，别让提示词出现「第 undefined 章」
  const found = project.chapters.findIndex((c) => c.id === chapter.id) + 1
  const idx = chapterIndex && chapterIndex > 0 ? chapterIndex : found > 0 ? found : 1
  const total = chapterTotal && chapterTotal > 0 ? chapterTotal : Math.max(idx, project.chapters.length || 1)

  const parts: string[] = []
  if (project.brief.logline.trim()) parts.push(`一句话前提：${project.brief.logline.trim()}`)
  const chars = characterDigest(project)
  if (chars) parts.push(`【角色卡】\n${chars}`)
  const threads = threadDigest(project)
  if (threads) parts.push(`【伏笔台账】\n${threads}`)

  const user = `${parts.length ? `${parts.join('\n\n')}\n\n` : ''}【这一章的位置】
这是第 ${idx} 章（共 ${total} 章）〈${chapter.title}〉。只批这一章，不要评价全书，也不要假设读者是第一次见到这些人物。

【本章〈${chapter.title}〉分段正文】
${truncate(numbered, 14000)}

【批注任务】
逐段读，只给真正需要动的地方写批注。每条批注必须是下面六种之一：

- "删"：这句是多余的注释、重复信息、或替读者下结论。例："这个心理注解删掉，前面的动作已经说完了。"
- "改"：这句写得别扭、用词不准、或不像这个人会说的话。例："'孩提时代'不像她会用的词，换成她真会说的说法。"
- "慢"：该停下来的地方写快了，细节不够，情绪没落地。
- "快"：该过去的写慢了，在拖。
- "虚"：写了抽象的感受而不是具体的画面。例："'心里一阵酸楚'是虚的，写她手上的动作。"
- "偏"：这一处偏离了人物、设定或前后文（前后矛盾、人物说了不该知道的事、腔调突然变）。

【输出格式】
严格输出一个 JSON 数组，不要 markdown 代码块包裹，不要在前后写任何解释：
[{"paragraph":1,"kind":"删","note":"一句话批注，40 字以内","quote":"这一处要改的原文片段"}]

要求：
- paragraph 必须是对应段落的序号，只能使用上面实际存在的序号。
- quote 必须是该段里**连续 6–30 字**的原文（照抄，不要改写、不要加省略号），用来定位你说的那一句。
- 最多 6 条，按重要程度从高到低排。宁可只给 2 条最有用的，也不要凑满。
- note 要具体到那一句，不要泛泛而谈；不要出现"建议对……进行优化"这种腔调。
- 如果整章都很干净，直接输出 []。`

  return [
    { role: 'system', content: MARGIN_SYSTEM },
    { role: 'user', content: user }
  ]
}

/**
 * 从模型输出里抠出 JSON 数组。
 *
 * 单独导出是因为执行器要区分两件事：模型说「没毛病」（[]）和模型根本没按格式给东西。
 * 两者都解析成空数组的话，解析失败会被界面显示成「这一章很干净」——那是撒谎。
 */
export function extractMarginArray(raw: string): unknown[] | null {
  if (!raw || !raw.trim()) return null
  // 整段被 ```json 包裹是最常见的「礼貌」，先剥掉外壳
  const text = raw
    .trim()
    .replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?```\s*$/, '')
    .trim()

  const start = text.indexOf('[')
  if (start < 0) return null
  const end = text.lastIndexOf(']')

  if (end > start) {
    try {
      const arr: unknown = JSON.parse(text.slice(start, end + 1))
      if (Array.isArray(arr)) return arr
    } catch {
      /* 落下去走截断抢救 */
    }
  }
  // 输出被 max_tokens 截断时最后一个对象没写完：把已经完整的对象捞出来，
  // 前面几条批注是真花钱换来的，不该因为最后一条断掉就整批作废。
  return salvageObjects(text.slice(start))
}

/** 逐字符扫描，按顶层对象切分（只在整体 JSON.parse 失败后用） */
function salvageObjects(text: string): unknown[] | null {
  const out: unknown[] = []
  let depth = 0
  let objStart = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) objStart = i
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      if (depth === 0 && objStart >= 0) {
        try {
          out.push(JSON.parse(text.slice(objStart, i + 1)))
        } catch {
          /* 这一条坏了就跳过，不影响其它条 */
        }
        objStart = -1
      }
      if (depth < 0) depth = 0
      continue
    }
    if (ch === ']' && depth === 0) break
  }
  return out.length ? out : null
}

/** 比对 quote 时忽略空白与标点：模型经常把中文引号换成英文、多打一个逗号 */
function normalizeForMatch(s: string): string {
  return s
    .replace(/\s+/g, '')
    .replace(/[“”"'‘’「」『』（）()【】\[\]，。！？、；：…—–\-·,.!?;:]/g, '')
}

function quoteMatches(paragraphs: string[] | undefined, paragraph: number, quote: string): boolean {
  // 没给正文就没法校验，先信任模型（置空反而丢信息）
  if (!paragraphs || !paragraphs.length) return true
  const para = paragraphs[paragraph - 1]
  if (!para) return false
  const needle = normalizeForMatch(quote)
  if (!needle) return false
  return normalizeForMatch(para).includes(needle)
}

/**
 * 解析批注数组。
 *
 * 容错范围按真实翻车现场定：围栏、前后废话、索引越界、同段重复、quote 对不上。
 * quote 对不上时只清掉引用、**不丢这条批注**：批注本身可能是对的，
 * 而错的 quote 会让「跳到正文」指到别处，所以只清引用。
 */
export function parseMarginNotes(
  raw: string,
  paragraphCount: number,
  paragraphs?: string[]
): MarginNote[] {
  const arr = extractMarginArray(raw)
  if (!arr) return []
  const total = Math.max(0, Math.floor(paragraphCount) || 0)
  const out: MarginNote[] = []
  const seen = new Set<number>()

  for (const item of arr) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    // 老提示词用 index、新契约用 paragraph：两个都认，换提示词不至于整批作废
    const paragraph = Math.round(Number(o.paragraph ?? o.index))
    const note = typeof o.note === 'string' ? o.note.trim() : ''
    if (!Number.isFinite(paragraph) || paragraph < 1 || paragraph > total) continue
    if (!note) continue
    if (seen.has(paragraph)) continue
    seen.add(paragraph)

    const rawKind = typeof o.kind === 'string' ? o.kind.trim() : ''
    const kind: MarginNoteKind = KIND_SET.has(rawKind) ? (rawKind as MarginNoteKind) : '改'
    const quoteRaw = typeof o.quote === 'string' ? o.quote.trim() : ''
    const quote = quoteRaw && quoteMatches(paragraphs, paragraph, quoteRaw) ? quoteRaw : ''

    out.push({ paragraph, kind, note, ...(quote ? { quote } : {}) })
  }

  // 按段落升序：界面、旁批栏、跳转都按这个顺序，排序放在这里只做一次
  return out.sort((a, b) => a.paragraph - b.paragraph)
}

/**
 * 重新生成时保留作者已标记的「已处理」。
 *
 * 作者勾掉一条批注的意思是「这条我改过了」。重跑一次就把勾全清掉，
 * 等于逼他从头核对一遍——那这个勾就没人愿意点了。
 * 匹配用「段落 + 批注原文」：模型重跑措辞可能微调，但同一处同一句话的批注应视为同一条。
 */
export function mergeMarginSet(
  prev: MarginNoteSet | undefined | null,
  next: MarginNoteSet
): MarginNoteSet {
  const prevNotes = prev?.notes ?? []
  if (!prevNotes.length) return next
  const resolvedKeys = new Set(
    prevNotes.filter((n) => n.resolved).map((n) => `${n.paragraph}|${n.note.trim()}`)
  )
  if (!resolvedKeys.size) return next
  return {
    ...next,
    notes: next.notes.map((n) =>
      resolvedKeys.has(`${n.paragraph}|${n.note.trim()}`) ? { ...n, resolved: true } : n
    )
  }
}

/** 注入给执行器的单章生成上下文：执行器不关心模型怎么调，只给提示词和进度口 */
export interface MarginGenerateContext {
  project: Project
  chapter: Chapter
  /** 这一章在全书里的序号（从 1 开始），用于提示词 */
  chapterIndex: number
  chapterTotal: number
  system: string
  user: string
  /** 流式增量回调：执行器用它累计「已收到字数」 */
  onDelta: (d: string) => void
}

export interface MarginProgress {
  chapterId: string
  chapterTitle: string
  /** 本批次内第几章（从 1 开始） */
  index: number
  total: number
  stage: 'start' | 'delta' | 'done' | 'fail' | 'skip'
  /** 本次调用累计收到字数（思考不算） */
  received: number
  /** 成功时本章的批注条数 */
  notes?: number
  message?: string
}

export interface MarginFailure {
  chapterId: string
  title: string
  message: string
  /** 模型原样返回：解析失败时贴出来，别把「格式不对」显示成「没问题」 */
  raw?: string
}

export interface MarginRunResult {
  sets: Record<string, MarginNoteSet>
  failures: MarginFailure[]
  /** 用户中途停止：已完成的章节保留在 sets 里，没跑的跳过 */
  stopped: boolean
  /** 压根没跑起来的原因（例如没配模型）；有值时不产生任何结果 */
  blocked?: string
}

export interface MarginRunOptions {
  chapters: Chapter[]
  project: Project
  modelLabel: string
  generate: (ctx: MarginGenerateContext) => Promise<string>
  shouldStop?: () => boolean
  onProgress?: (p: MarginProgress) => void
  /** 每章成功立刻回调：调用方逐章落盘，中途停止时已完成的不能丢 */
  onChapter?: (chapter: Chapter, set: MarginNoteSet) => void
  /** 时间源，注入便于测试 */
  now?: () => number
}

/**
 * 串行批注一批章节。
 *
 * 为什么必须串行：一次只发一个请求，作者才能用「停止」真正停下来；
 * 并发出去五个请求，点停止只能 abort 一个，剩下四个照样扣钱。
 */
export async function runMarginForChapters(opts: MarginRunOptions): Promise<MarginRunResult> {
  const { chapters, project, modelLabel, generate, shouldStop, onProgress, onChapter } = opts
  const now = opts.now ?? Date.now
  const result: MarginRunResult = { sets: {}, failures: [], stopped: false }

  // 没配模型不是「失败」，是「还没开始」：不许假装跑过，也不许把每章都记成错误刷屏
  const label = (modelLabel ?? '').trim()
  if (!label || label.includes('未配置')) {
    result.blocked = MARGIN_NO_MODEL
    return result
  }

  const total = chapters.length
  const chapterTotal = project.chapters.length || total
  const positions = new Map(project.chapters.map((c, i) => [c.id, i + 1]))

  for (let i = 0; i < total; i++) {
    const chapter = chapters[i]
    if (!chapter) continue
    if (shouldStop?.()) {
      result.stopped = true
      break
    }

    const paragraphs = splitParagraphs(chapter)
    if (!paragraphs.length) {
      // 空章不该花一次调用，也不该占成功名额
      onProgress?.({
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        index: i + 1,
        total,
        stage: 'skip',
        received: 0
      })
      continue
    }

    const chapterIndex = positions.get(chapter.id) ?? i + 1
    const messages = buildMarginNoteMessages(project, chapter, chapterIndex, chapterTotal)
    let received = 0

    onProgress?.({
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      index: i + 1,
      total,
      stage: 'start',
      received: 0
    })

    let text = ''
    try {
      text = await generate({
        project,
        chapter,
        chapterIndex,
        chapterTotal,
        system: messages[0].content,
        user: messages[1].content,
        onDelta: (d) => {
          received += d.length
          onProgress?.({
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            index: i + 1,
            total,
            stage: 'delta',
            received
          })
        }
      })
    } catch (e) {
      // 点了停止导致的“失败”不是失败，静默收尾（界面已给「已停止」提示）
      if (shouldStop?.()) {
        result.stopped = true
        break
      }
      const message = (e as Error)?.message || '这一章批注失败'
      result.failures.push({ chapterId: chapter.id, title: chapter.title, message })
      onProgress?.({
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        index: i + 1,
        total,
        stage: 'fail',
        received,
        message
      })
      continue
    }

    if (!extractMarginArray(text)) {
      const message = text.trim()
        ? '模型没有按约定返回 JSON 数组'
        : '模型没有返回内容（已重试一次；多半是思考占满了输出额度，可到「输出预算 → 段落侧批」调大额度）'
      result.failures.push({
        chapterId: chapter.id,
        title: chapter.title,
        message,
        raw: text.trim() ? truncate(text, 1500) : undefined
      })
      onProgress?.({
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        index: i + 1,
        total,
        stage: 'fail',
        received: text.length,
        message
      })
      continue
    }

    const next: MarginNoteSet = {
      at: now(),
      model: label,
      paragraphs: paragraphs.length,
      fingerprint: chapterFingerprint(chapter),
      notes: parseMarginNotes(text, paragraphs.length, paragraphs)
    }
    const prev = project.marginNotes ? project.marginNotes[chapter.id] : undefined
    const merged = mergeMarginSet(prev, next)
    result.sets[chapter.id] = merged
    onChapter?.(chapter, merged)
    onProgress?.({
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      index: i + 1,
      total,
      stage: 'done',
      received: text.length,
      notes: merged.notes.length
    })

    // 停止信号在「这一章已经完整拿到并落盘」之后才生效：
    // 点停止时模型刚好答完，把这章丢掉等于白花一次钱。
    if (shouldStop?.()) {
      result.stopped = true
      break
    }
  }

  return result
}