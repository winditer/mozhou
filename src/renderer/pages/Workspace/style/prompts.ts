import type { PromptMessage, Project } from '@shared/types'
import { countWords, stripHtml, truncate } from '@shared/utils'

/** 样本总量硬上限（字） */
export const MAX_TOTAL_WORDS = 5000
/** 最多几段样本 */
export const MAX_SAMPLES = 5
/** 单段建议区间 */
export const SAMPLE_WORDS_HINT = '每段建议 200–800 字'
/** 特征建议条数 */
export const TRAIT_RANGE = '建议 3–6 条'

/**
 * 兜底规则：lib/prompt.ts 只在 traits 非空时才注入「特征 + 样本」整块，
 * 所以没提炼特征时补一条如实的规则，保证样本仍能被真实生成消费。
 */
export const FALLBACK_TRAIT = '贴合下方样本的句子节奏、用词密度与叙述镜头，不要写成通用 AI 腔'

export interface StyleSource {
  traits: string[]
  samples: string[]
  /** 分身取法的一句话摘要：引用系统分身时才有，放在特征前作为总纲 */
  summary?: string
}

export function cleanList(list: string[]): string[] {
  return list.map((x) => x.trim()).filter(Boolean)
}

export function totalWords(samples: string[]): number {
  return samples.reduce((s, x) => s + countWords(x), 0)
}

/* ─────────────────── 特征提炼 ─────────────────── */

export function buildTraitMessages(samples: string[]): PromptMessage[] {
  const useful = cleanList(samples)
  const body = useful
    .map((x, i) => `〈样本 ${i + 1}〉\n${truncate(x, 2600)}`)
    .join('\n\n')
  return [
    {
      role: 'system',
      content:
        '你是中文小说编辑，擅长从作者的原创文字中提炼出「可执行、可检验」的文风规则。你只输出 JSON 数组，不写任何解释。'
    },
    {
      role: 'user',
      content: `下面是一位作者的 ${useful.length} 段原创文字样本。请从中提炼这位作者独有的文风规则。\n\n${body}\n\n【要求】\n- 输出 3–6 条，每条一句话，20–40 字。\n- 每条都必须能被写作者照做、被编辑逐条核对：写清句子长短、对话密度（如"每 300 字至少一组对话"）、叙述镜头距离、比喻与成语的使用倾向、标点与段落习惯等具体特征。\n- 严禁写"文笔优美""语言流畅""感情真挚"这类无法执行的评价。\n- 只描述这位作者与通用 AI 腔调不同的地方。\n\n只输出 JSON 数组，例如：\n["短句为主，一句话很少超过 20 字","对话密度高，每 300 字至少一组对话","偏爱具体名词与实物细节，几乎不用四字成语"]`
    }
  ]
}

/** 宽容解析：兼容代码块包裹、前后缀说明、换行列表 */
export function parseTraits(raw: string): string[] {
  let s = raw.trim()
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fence && fence[1]) s = fence[1].trim()
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)

  const tidy = (v: string): string =>
    v
      .trim()
      .replace(/^[-–—•·*]\s*/, '')
      .replace(/^\d+[.、)]\s*/, '')
      .replace(/^["'「『]|["'」』]$/g, '')
      .trim()

  /** 模型拒答/寒暄不是特征 */
  const isNoise = (v: string): boolean =>
    /^(抱歉|对不起|很抱歉|我无法|无法提供|好的|以下是|当然|Sure)/.test(v) || v.length < 4

  const collect = (arr: unknown[]): string[] =>
    arr
      .map((v) => (typeof v === 'string' ? tidy(v) : ''))
      .filter((v) => v && !isNoise(v))
      .slice(0, 8)

  try {
    const parsed: unknown = JSON.parse(s)
    // JSON 解析成功就以它为准：是数组取字符串项，是对象则取 traits 字段
    if (Array.isArray(parsed)) return collect(parsed)
    if (parsed && typeof parsed === 'object') {
      const traits = (parsed as { traits?: unknown }).traits
      if (Array.isArray(traits)) return collect(traits)
    }
    return []
  } catch {
    /* 不是 JSON，退回逐行解析 */
  }

  return s
    .split('\n')
    .map(tidy)
    .filter((v) => v && !isNoise(v))
    .slice(0, 8)
}

/* ─────────────────── 试写对比 ─────────────────── */

const TRIAL_BASE = [
  '你是中文小说作者。根据用户给出的引子，接续写一小段正文。',
  '要求：只输出正文本身，不要标题、不要解释、不要"以下是"这类开场白；约 150 字；可用 1—2 个自然段。'
].join('\n')

/**
 * 与 lib/prompt.ts 注入格式保持一致：
 * 摘要一行 + 特征逐条编号 + 前 3 段样本，让试写结果能代表真实生成效果。
 * 没有特征卡时仍注入样本，避免「裸写」与「带分身」两栏完全一样而误导判断。
 */
export function styleBlock(src: StyleSource): string {
  const summary = (src.summary ?? '').trim()
  const traits = cleanList(src.traits)
  const samples = cleanList(src.samples).slice(0, 3)
  // 和 lib/prompt.ts 的 renderStyleBlock 同一条判据：没有任何特征/样本就不注入。
  // 只有摘要时也不注入——摘要说明的是「怎么取法」，没有细则时它落不到可执行的指令上。
  if (!traits.length && !samples.length) return ''

  const title = traits.length ? '【文风要求 —— 必须严格遵守】' : '【文风要求】\n贴合下面样本的句子节奏与用词习惯。'
  // 摘要必须紧跟标题、在编号特征之前：它先说「怎么取法」，特征再说细则
  const intro = summary ? `\n本分身取法：${summary}` : ''
  const list = traits.length ? `\n${traits.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : ''
  const tail = samples.length
    ? `\n下面是作者的原文样本，请仔细体会其句子节奏、用词习惯与叙述密度，写作时保持同样的笔感：\n\n${samples
        .map((x, i) => `〈样本 ${i + 1}〉\n${truncate(x, 1600)}`)
        .join('\n\n')}`
    : ''

  return `${title}${intro}${list}${tail}`
}

export function buildTrialMessages(seed: string, src: StyleSource | null): PromptMessage[] {
  const block = src ? styleBlock(src) : ''
  const system = block ? `${TRIAL_BASE}\n\n${block}` : TRIAL_BASE
  return [
    { role: 'system', content: system },
    { role: 'user', content: `引子：${seed.trim()}\n\n请接着写下去。` }
  ]
}

/** 默认引子：优先一句话前提，其次第一章第一句 */
export function seedFromProject(project: Project): string {
  const logline = project.brief.logline?.trim()
  if (logline) return logline
  const first = project.chapters.find((c) => stripHtml(c.content).replace(/\s+/g, '').length > 8)
  if (!first) return ''
  const text = stripHtml(first.content).replace(/\s+/g, ' ').trim()
  const sentence = text.match(/[^。！？…]{6,}[。！？…]/)
  return truncate(sentence ? sentence[0] : text, 80)
}

/** 从章节正文里截一段当样本 */
export function excerptOf(content: string, chars = 600): string {
  const text = stripHtml(content).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return text.slice(0, chars).trim()
}