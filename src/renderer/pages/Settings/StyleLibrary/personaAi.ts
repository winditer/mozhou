import type { PromptMessage } from '@shared/types'
import type { StyleCategory } from '@shared/styleLibrary'
import { CATEGORY_LABELS } from '@shared/styleLibrary'
import { truncate } from '@shared/utils'

/**
 * 系统分身的 AI 辅助提示词。
 *
 * 和书内「提炼文风特征」（style/prompts.ts）的差别在于输入：
 * 那边只有样本，这边可能只有一句「我想要古龙那种腔」。
 * 所以 draft 模式要允许「凭描述写」，但必须强制模型写上可执行规则，
 * 否则它会给你一堆「文笔凝练、意境深远」这类废话，注入后反而有害。
 */

export interface PersonaDraft {
  name: string
  category: StyleCategory
  summary: string
  tags: string[]
  traits: string[]
  refs: string[]
  samples: string[]
}

const SYSTEM = `你是中文文学编辑与写作教练，擅长把「一位作者的笔感」翻译成 AI 能照着执行的写作规则。
你只输出 JSON 对象，不写任何解释、不写 markdown 代码块以外的文字。`

const OUTPUT_SPEC = `【输出格式】只输出一个 JSON 对象：
{
  "summary": "40–70 字的风格摘要，说清句子质感、叙事镜头距离、适合写什么",
  "tags": ["3–5 个 2–4 字的风格标签", "..."],
  "traits": ["6–8 条可执行规则", "..."],
  "refs": ["1–3 个代表作书名，用《》，不确定就留空数组"]
}`

const TRAIT_RULES = `【特征硬性要求】
- 每条 18–42 字，必须是祈使句或可照做的规则，写清：句子长短、对话密度、叙述镜头距离、比喻取材、段落与标点习惯、场景节奏、章末钩子类型等具体项。
- 严禁「文笔优美」「语言流畅」「感情真挚」「风格独特」「意境深远」这类无法执行的评价。
- 每条都要能让另一位编辑逐条核对是否做到。
- 同一份输出里的 6–8 条必须互相区分，不要用同义词重复说一遍。`

export function buildPersonaMessages(
  mode: 'draft' | 'polish',
  seed: PersonaDraft,
  brief: string
): PromptMessage[] {
  const facts: string[] = []
  if (seed.name) facts.push(`名称：${seed.name}`)
  if (seed.category) facts.push(`分类：${CATEGORY_LABELS[seed.category] ?? seed.category}`)
  if (brief) facts.push(`用户的补充描述：${brief}`)
  if (seed.refs.length) facts.push(`已知代表作：${seed.refs.join('、')}`)

  /* ── 有样本：按样本提炼（这是最可靠的一条路，优先级最高） ── */
  if (seed.samples.length) {
    const body = seed.samples
      .slice(0, 5)
      .map((s, i) => `〈样本 ${i + 1}〉\n${truncate(s, 2200)}`)
      .join('\n\n')
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `下面是一位作者（或用户）的 ${seed.samples.length} 段文字样本。请据此提炼可执行的文风规则。\n\n${facts.join('\n')}\n\n${body}\n\n${TRAIT_RULES}\n\n${OUTPUT_SPEC}\n\n只描述这位作者与通用 AI 腔调不同的地方。`
      }
    ]
  }

  /* ── 无样本 + polish：按现有特征卡优化 ── */
  if (mode === 'polish') {
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `${facts.join('\n')}\n\n现有草稿：\n摘要：${seed.summary || '（空）'}\n标签：${seed.tags.join('、') || '（空）'}\n特征：\n${seed.traits.map((t, i) => `${i + 1}. ${t}`).join('\n') || '（空）'}\n\n请改写这份草稿：把模糊的条目改成可执行规则，补齐缺失的维度（句长 / 对话密度 / 镜头距离 / 比喻取材 / 节奏），去掉重复与空话。保留原作者的调性，不要换成另一位的风格。\n\n${TRAIT_RULES}\n\n${OUTPUT_SPEC}`
      }
    ]
  }

  /* ── 无样本 + draft：凭名称/描述写，必须诚实 ── */
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${facts.join('\n')}\n\n请为这个文风分身写出完整的特征卡。\n\n要求：\n- 如果你熟悉这位作者，按其真实笔法写；如果是用户自定义的调性，按描述写。\n- 无论哪种，都只描述「怎么写」，不要写作者生平、不要写作品评价。\n- 不确定代表作就留空数组，不要编造书名。\n\n${TRAIT_RULES}\n\n${OUTPUT_SPEC}`
    }
  ]
}

/** 宽容解析：兼容代码块、前后说明、字段缺失 */
export function parsePersonaDraft(raw: string): PersonaDraft | null {
  let s = (raw || '').trim()
  if (!s) return null
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fence && fence[1]) s = fence[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)

  const tidy = (v: unknown): string =>
    typeof v === 'string'
      ? v
          .trim()
          .replace(/^[-–—•·*]\s*/, '')
          .replace(/^\d+[.、)]\s*/, '')
          .replace(/^["'「『]|["'」』]$/g, '')
          .trim()
      : ''

  const isNoise = (v: string): boolean =>
    /^(抱歉|对不起|很抱歉|我无法|无法提供|好的|以下是|当然|Sure)/.test(v) || v.length < 4

  /**
   * 标签和特征的长度门槛不一样：
   * - 特征至少 4 字，否则「句子短」这种残句会混进来；
   * - 标签本身就是 2–4 字（冷峻 / 短句 / 爽点密集），
   *   用 4 字门槛会把最常用的两字标签全部滤掉——这是实测踩到的坑。
   */
  const strList = (v: unknown, max: number, minLen = 4): string[] =>
    Array.isArray(v)
      ? v
          .map(tidy)
          .filter((x) => x && !/^(抱歉|对不起|很抱歉|我无法|无法提供|好的|以下是|当然|Sure)/.test(x) && x.length >= minLen)
          .slice(0, max)
      : []

  /** 全字段补齐，调用方不用再处理 undefined */
  const empty: PersonaDraft = { name: '', category: 'custom', summary: '', tags: [], traits: [], refs: [], samples: [] }

  try {
    const parsed: unknown = JSON.parse(s)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    return {
      ...empty,
      summary: tidy(o.summary ?? o['摘要']),
      tags: strList(o.tags ?? o['标签'], 8, 2),
      traits: strList(o.traits ?? o['特征'], 12, 4),
      refs: strList(o.refs ?? o['代表作'], 6, 2)
    }
  } catch {
    // 不是合法 JSON：退化成「逐行当特征」，至少别让用户白等一次调用的钱
    const lines = s
      .split('\n')
      .map(tidy)
      .filter((v) => v && !isNoise(v))
    if (!lines.length) return null
    return { ...empty, traits: lines.slice(0, 12) }
  }
}