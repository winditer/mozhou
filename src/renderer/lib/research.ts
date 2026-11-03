/**
 * 联网查资料：判断该不该查、把查询拼出来、把检索结果讲给模型听。
 *
 * 全部是纯函数 + 一个注入依赖的 research()，不直接碰 window.mz、不碰 React——
 * 与 applyEdits.ts 同一条纪律：这套逻辑要能在 node 里逐条断言，
 * 因为「该不该联网」和「怎么标来源」这两件事一旦错，作者很难自己发现。
 */
import type { ResearchMeta, SearchErrorKind, SearchHit, SearchRunResult } from '@shared/types'

export type QueryReason = 'fact' | 'general' | 'creative' | 'fiction-system' | 'no-entity'

export interface QueryPlan {
  queries: string[]
  reason: QueryReason
}

/** 这些词说明作者要的是事实，不是桥段 */
const FACT_HINT =
  /(历史|朝代|年代|真实|现实|史实|工艺|材质|参数|温度|尺寸|价格|品级|官职|制度|生平|人物|发明|战争|地点|坐标|在哪|什么时候|哪一年|多少|是什么|有哪些)/

/** 这些词指向虚构设定：搜到的就是别人的小说，等于雷同 */
const FICTION_SYSTEM = /(境界|体系|流派|功法|修炼|等级划分|世界观|力量体系|设定集)/

/** 创作指令本身不会因为联网变好 */
const CREATIVE_ONLY = /(帮我写|写一段|写个|续写|接着写|润色|改写|起个名|取个名|来一段|生成一段)/

/** 疑问词与语气词：留着会让搜索把整句当自然语言处理，丢掉更准 */
const NOISE =
  /(请问|帮我|能不能|可以|麻烦|我想知道|想了解|查一下|查查|查询|搜一下|找一下|关于|有关|资料|信息|详细介绍|介绍一下|是什么|是多少|是怎么|怎么回事|为什么|怎么样|如何|哪些|吗|呢|吧|啊|？|\?|，|。|、|；|：|,|\.)/g

function clean(question: string): string {
  return question.replace(NOISE, ' ').replace(/\s+/g, ' ').trim()
}

export function buildQueries(
  question: string,
  maxQueries: number,
  opts?: { general?: boolean }
): QueryPlan {
  const q = question.trim()
  const isFact = FACT_HINT.test(q)
  // 创作指令到哪儿都不该查：检索的结果只会把别人的桥段塞进来
  if (CREATIVE_ONLY.test(q) && !isFact) return { queries: [], reason: 'creative' }
  /*
   * 通用模式（对话里开了「通用」）只跳创作指令。
   *
   * FACT_HINT 是一张窄词表，服务的是「这本书里要不要查」——它认不出「今天有什么热榜」
   * 「2026 年诺贝尔文学奖是谁」这类问题，于是作者明明开了通用、也配了搜索源，
   * 这一轮却根本没发请求，模型只能说「我没联网」。通用模式的意思就是「去外面查」，
   * 所以这里不再拿词表判它该不该查。
   */
  if (!opts?.general) {
    if (FICTION_SYSTEM.test(q) && !isFact) return { queries: [], reason: 'fiction-system' }
    if (!isFact) return { queries: [], reason: 'no-entity' }
  }

  // 通用模式的查询词就用问题本身（去掉语气词），不再要求命中那张窄词表
  const core = (clean(q) || q).slice(0, opts?.general ? 60 : 30)
  if (core.length < 2) return { queries: [], reason: 'no-entity' }

  const queries = [core]
  // 第二条查询只在作者一次问了两件事（有顿号/逗号分隔）时才加，
  // 否则两条几乎一样的查询等于白花一次钱
  if (maxQueries > 1 && /[、，,]/.test(q)) {
    const parts = q
      .split(/[、，,]/)
      .map((s) => clean(s).slice(0, 30))
      .filter((s) => s.length >= 2)
    for (const p of parts) {
      if (queries.length >= maxQueries) break
      if (!queries.includes(p)) queries.push(p)
    }
  }
  return { queries: queries.slice(0, Math.max(1, maxQueries)), reason: opts?.general ? 'general' : 'fact' }
}

/**
 * 让模型把问题改写成检索词。
 *
 * 规则拼接的查询词有两个硬伤：长句照抄会被搜索引擎当自然语言处理，
 * 相对时间（今天 / 最近 / 昨天）离开上下文就失去意义。这两件事模型一眼能办。
 * 代价是每轮检索多一次很小的请求（maxTokens 200），换来查询词干净。
 */
export function planQueryPrompt(question: string, now: Date, maxQueries = 3): { system: string; user: string } {
  const stamp = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`
  return {
    system: `你是检索词规划员。把作者的问题改写成 ${Math.max(1, maxQueries)} 条以内适合搜索引擎的查询词。

规则：
- 一行一条，最多 ${Math.max(1, maxQueries)} 条，不要编号、不要解释、不要引号。
- 只保留关键专名、时间、指标；去掉「帮我」「请问」「我想知道」「是什么」这类词。
- 相对时间必须换成绝对时间：今天是 ${stamp}，「今天」指 ${stamp}，「最近」按 ${now.getFullYear()} 年内理解，「去年」是 ${now.getFullYear() - 1} 年。
- 需要最新动态时，查询词里带上年份 ${now.getFullYear()}。
- 如果这个问题根本不需要查外部资料（纯创作指令，例如「帮我写一段」），只输出一行：无需检索`,
    user: question
  }
}

/**
 * 模型输出的检索词 → 数组。
 *
 * 模型经常带回编号、项目符号、解释性长句，这里一律清洗；清洗完为空就返回空数组，
 * 由上层退回规则词——宁可用规则词查一次，也不能因为解析失败这一轮就不查了。
 */
export function parseQueryPlan(raw: string, maxQueries: number): string[] | null {
  const lines = String(raw || '')
    .split(/\r?\n|；|;/)
    // 只清「1. 」「- 」「• 」这类前缀；不能把开头的数字一起吃掉，「2026 年」也是数字开头
    .map((s) => s.replace(/^\s*(?:[-*•·]+|\d{1,2}\s*[.、)）])\s*/, '').replace(/^[[\]「」"']+/, '').trim())
    .filter(Boolean)
  // [] 只表示「模型明确说不用查」；解析不出任何可用词时返回 null，让上层退回规则词
  if (!lines.length) return null
  if (lines.some((l) => /无需检索|不需要检索|不用检索|无需联网/.test(l)) && lines.length <= 2) return []
  const out: string[] = []
  for (const line of lines) {
    // 超过 80 字的基本是解释，不是查询词
    if (line.length > 80) continue
    const q = line.replace(/[。，,！!？?]+$/g, '').trim().slice(0, 60)
    if (q.length < 2) continue
    if (!out.includes(q)) out.push(q)
    if (out.length >= Math.max(1, maxQueries)) break
  }
  return out.length ? out : null
}

const pad = (n: number): string => String(n).padStart(2, '0')
function stamp(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 「先压缩再注入」什么时候才值得。
 *
 * 摘要是一次完整的 LLM 调用（实测 2.5 秒），5 条短结果压一遍纯属浪费——
 * 它本来是为了别让长文把上下文挤爆。所以只在原始文本确实很长时才压。
 */
export const COMPRESS_MIN_CHARS = 3000

export function needsCompression(raw: string): boolean {
  return String(raw || '').length > COMPRESS_MIN_CHARS
}

export interface ExternalInput {
  hits: SearchHit[]
  queries: string[]
  at: number
  cached: boolean
  error?: { kind: SearchErrorKind; message: string }
}

/**
 * 检索结果 → 提示词块。有空结果与失败两种形态，都必须说人话：
 * 静默失败会让模型拿训练记忆冒充「查证过」，这是这套功能最怕的翻车方式。
 */
export function formatExternal(r: ExternalInput, opts?: { general?: boolean }): string {
  if (!r.hits.length) {
    const why = r.error ? `（${r.error.message}）` : ''
    return `【外部资料｜本次未取得外部资料${why}】
你这次没有拿到任何可引用的外部资料。请只凭你自己的知识回答，并明确告诉作者这一点：
哪些内容你不确定、需要作者自己核实。不要假装查过，也不要编造来源或 URL。`
  }
  const body = r.hits
    .map((h, i) => `[${i + 1}] ${h.title} — ${h.url}\n${h.snippet || '（无摘要）'}`)
    .join('\n\n')
  /*
   * 通用模式不能照搬本书模式那套规则。
   *
   * 原来这块结尾写着「以上资料与本书设定冲突时，一律以本书设定为准」，
   * 而通用模式的 system 又说「你是一个通用问答助手」——模型手里根本没有本书，
   * 这句话等于告诉它「这批资料不归你用」，于是它宁可回「我没有联网」。
   */
  if (opts?.general) {
    const head = `【外部资料｜刚刚为你联网检索于 ${stamp(r.at)}${r.cached ? '（命中缓存）' : ''}】\n查询：${r.queries.join('；')}`
    return `${head}\n\n${body}\n\n使用规则：
- 这就是你此刻的检索结果，请直接据此回答；不要再说「我没有联网」「拿不到实时信息」「你自己去看」。
- 用到哪条就在句末标 [编号]；没标编号的事实视为你自己的推断。
- 与问题无关的条目直接忽略，不要为了凑数把 9 条都念一遍。
- 只可化用，不得整段搬运原文（有版权与雷同风险）。
- 结果不足以回答的部分，明说「资料里没有」，不要编。`
  }
  const head = `【外部资料｜联网检索于 ${stamp(r.at)}${r.cached ? '（命中缓存）' : ''}，非本书设定】\n查询：${r.queries.join('；')}`
  return `${head}\n\n${body}\n\n使用规则：
- 引用以上内容时在句末标注 [编号]；未标注的事实视为你自己的推断。
- 以上资料与本书设定冲突时，一律以本书设定为准，并明确告诉作者哪里有出入。
- 只可化用，不得整段搬运原文（有版权与雷同风险）。`
}

export interface ResearchDeps {
  /** 通用模式：不按「像不像事实问题」跳过检索，只跳纯创作指令 */
  general?: boolean
  channelId: string
  maxResults: number
  maxQueries: number
  run: (req: { channelId: string; queries: string[]; maxResults: number }) => Promise<SearchRunResult>
  /** 可选：让模型把问题改写成检索词。返回空数组或抛错时退回规则拼的查询词 */
  plan?: (question: string) => Promise<string[] | null>
  /** 可选：把结果压成摘要。抛错或条数对不上都退回原始 snippet */
  summarize?: (text: string) => Promise<string | null>
}

export interface ResearchOutcome {
  meta: ResearchMeta | null
  text: string
  /** 没联网时文本为空，上层据此决定要不要显示「已检索」 */
  skipped: boolean
  /** 为什么跳过：上层据此给作者一句准确的话，而不是笼统说「没联网」 */
  skipReason?: QueryReason
  /**
   * 真的发了请求但没拿到结果。必须让作者看见——只把降级块塞给模型的话，
   * 界面上一切正常，作者只会以为「这个 AI 不会联网」。
   */
  error?: { kind: SearchErrorKind; message: string }
}

/**
 * 摘要只在「条数对得上」时才采用。
 * 模型漏掉一条就等于凭空丢掉一个来源，而界面上仍然显示「来源 N 条」，
 * 那种错位作者永远发现不了——宁可退回原文 snippet。
 */
async function applySummary(
  hits: SearchHit[],
  summarize: (t: string) => Promise<string | null>
): Promise<SearchHit[]> {
  const raw = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.snippet}`).join('\n\n')
  const brief = await summarize(raw)
  if (!brief || !brief.trim()) return hits
  const lines = brief
    .split(/\n(?=\[\d+\])/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (lines.length !== hits.length) return hits
  return hits.map((h, i) => ({ ...h, snippet: lines[i].replace(/^\[\d+\]\s*/, '') }))
}

export async function research(question: string, deps: ResearchDeps): Promise<ResearchOutcome> {
  const rulePlan = buildQueries(question, deps.maxQueries, { general: deps.general })
  // 创作指令连查询词都不用请模型规划：这类问题查了只会把别人的桥段塞进来
  if (rulePlan.reason === 'creative') return { meta: null, text: '', skipped: true, skipReason: 'creative' }

  let queries = rulePlan.queries
  if (deps.plan) {
    try {
      const planned = await deps.plan(question)
      if (planned && planned.length) queries = planned
      // 模型明说「无需检索」：尊重它（这条路径只在通用模式出现，规则词在那儿总是有的）
      else if (planned) return { meta: null, text: '', skipped: true, skipReason: 'creative' }
      // planned === null：解析不出可用词，退回规则词——宁可查得糙一点，也不能这一轮不查
    } catch {
      /* 规划失败就用规则词，不能因为这一步让这一轮不查 */
    }
  }
  if (!queries.length) return { meta: null, text: '', skipped: true, skipReason: rulePlan.reason }

  let res: SearchRunResult
  try {
    res = await deps.run({ channelId: deps.channelId, queries, maxResults: deps.maxResults })
  } catch (e) {
    res = {
      hits: [],
      queries,
      cached: false,
      error: { kind: 'network', message: (e as Error).message }
    }
  }

  let hits = res.hits
  if (hits.length && deps.summarize) {
    // 只有原文够长才值得多花一次模型调用（见 needsCompression）
    const raw = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.snippet}`).join('\n\n')
    if (needsCompression(raw)) {
      try {
        hits = await applySummary(hits, deps.summarize)
      } catch {
        /* 摘要失败用原文，不影响这轮回答 */
      }
    }
  }

  const at = Date.now()
  const meta: ResearchMeta = { queries: res.queries, hits, cached: res.cached, at }
  return {
    meta,
    text: formatExternal(
      { hits, queries: res.queries, at, cached: res.cached, error: res.error },
      { general: deps.general }
    ),
    skipped: false,
    error: res.error
  }
}