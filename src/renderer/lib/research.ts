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

const pad = (n: number): string => String(n).padStart(2, '0')
function stamp(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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
export function formatExternal(r: ExternalInput): string {
  if (!r.hits.length) {
    const why = r.error ? `（${r.error.message}）` : ''
    return `【外部资料｜本次未取得外部资料${why}】
你这次没有拿到任何可引用的外部资料。请只凭你自己的知识回答，并明确告诉作者这一点：
哪些内容你不确定、需要作者自己核实。不要假装查过，也不要编造来源或 URL。`
  }
  const head = `【外部资料｜联网检索于 ${stamp(r.at)}${r.cached ? '（命中缓存）' : ''}，非本书设定】\n查询：${r.queries.join('；')}`
  const body = r.hits
    .map((h, i) => `[${i + 1}] ${h.title} — ${h.url}\n${h.snippet || '（无摘要）'}`)
    .join('\n\n')
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
  const plan = buildQueries(question, deps.maxQueries, { general: deps.general })
  if (!plan.queries.length) return { meta: null, text: '', skipped: true, skipReason: plan.reason }

  let res: SearchRunResult
  try {
    res = await deps.run({ channelId: deps.channelId, queries: plan.queries, maxResults: deps.maxResults })
  } catch (e) {
    res = {
      hits: [],
      queries: plan.queries,
      cached: false,
      error: { kind: 'network', message: (e as Error).message }
    }
  }

  let hits = res.hits
  if (hits.length && deps.summarize) {
    try {
      hits = await applySummary(hits, deps.summarize)
    } catch {
      /* 摘要失败用原文，不影响这轮回答 */
    }
  }

  const at = Date.now()
  const meta: ResearchMeta = { queries: res.queries, hits, cached: res.cached, at }
  return {
    meta,
    text: formatExternal({ hits, queries: res.queries, at, cached: res.cached, error: res.error }),
    skipped: false,
    error: res.error
  }
}