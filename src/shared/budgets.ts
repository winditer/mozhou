/**
 * 输出预算（maxTokens）：调用的每个环节各自能吃多少 token。
 *
 * 为什么需要这一层：以前 23 处 maxTokens 散在 11 个文件里硬编码，
 * 换个模型、写长一点的章节，就得挨个文件翻。这里把它们收进一张表，
 * 调用点只认 key，不再手写数字。
 *
 * 两个必须记住的领域事实：
 * 一、maxTokens 只管「输出」，不含提示词。OpenAI、Anthropic、Gemini 三家都是
 *    输入与输出分开计的，所以这里算的是生成侧预算，跟上下文长度无关。
 * 二、思考/推理 token 算在 maxTokens 里面，且没有任何参数能把它单独排除。
 *    推理模型会先想再做，预算被思考吃光后正文就是空的或半截的。
 *    所以按字数估算的预算除了正文本身，还要额外留 thinkPad 给思考。
 *    （旧实现 tokensForWords 就是踩了这个坑才加的 1024。）
 *
 * src/shared 会同时编译进主进程和渲染进程，这里只能用纯 TypeScript：
 * 不引入 electron、react，也不碰 node 内置模块。
 */

/** 全部预算点的字面 key。调用点一律从 BUDGET_KEYS 取，别手写字符串。 */
export type BudgetKey =
  | 'draft.generate'
  | 'draft.continue'
  | 'draft.selection'
  | 'outline.generate'
  | 'outline.chapterBrief'
  | 'bible.entry'
  | 'bible.entryShort'
  | 'quickstart.firstChapter'
  | 'summary.auto'
  | 'summary.audit'
  | 'audit.book'
  | 'audit.chapter'
  | 'audit.thread'
  | 'margin.notes'
  | 'naming.ideas'
  | 'style.traits'
  | 'style.trial'
  | 'chat.reply'
  | 'custom.default'
  | 'quickstart.title'
  | 'quickstart.settings'
  | 'quickstart.volumes'
  | 'quickstart.chapters'

/** 固定预算：无论写多少字都给这么多输出额度。用于摘要、审计这类长度自洽的任务。 */
export interface FixedBudget {
  kind: 'fixed'
  tokens: number
}

/**
 * 按字数预算：写多少字就给多少额度，跟着目标字数走。
 * - perWord：每个字折算多少 token（中文一字约 0.75–1.5 token）。取 2.2 是为了给正文留余量：
 *   模型实际输出常比按字数的估算更铺张，留一点空间避免正文被截断
 * - thinkPad：额外留给思考过程的额度，因为思考也计入 maxTokens
 * - min / max：兜住下限与上限，下限避免小段落预算过低被思考吃光，上限避免超长章节把成本顶穿
 */
export interface PerWordBudget {
  kind: 'perWord'
  perWord: number
  thinkPad: number
  min: number
  max: number
}

export type TokenBudget = FixedBudget | PerWordBudget

/** 一整套预算配置。表里必须有全部 key，缺的直接用 DEFAULT_TOKEN_BUDGETS 里的。 */
export type TokenBudgets = Record<BudgetKey, TokenBudget>

/**
 * camelCase → 字面 key。
 * 调用点写 BUDGET_KEYS.draftGenerate 而不是 'draft.generate'，
 * 一是补全和改错能靠类型挡住，二是这个表顺带就是设置页渲染的顺序。
 */
export const BUDGET_KEYS = {
  draftGenerate: 'draft.generate',
  draftContinue: 'draft.continue',
  draftSelection: 'draft.selection',
  outlineGenerate: 'outline.generate',
  outlineChapterBrief: 'outline.chapterBrief',
  bibleEntry: 'bible.entry',
  bibleEntryShort: 'bible.entryShort',
  quickstartFirstChapter: 'quickstart.firstChapter',
  summaryAuto: 'summary.auto',
  summaryAudit: 'summary.audit',
  auditBook: 'audit.book',
  auditChapter: 'audit.chapter',
  auditThread: 'audit.thread',
  marginNotes: 'margin.notes',
  namingIdeas: 'naming.ideas',
  styleTraits: 'style.traits',
  styleTrial: 'style.trial',
  chatReply: 'chat.reply',
  customDefault: 'custom.default',
  quickstartTitle: 'quickstart.title',
  quickstartSettings: 'quickstart.settings',
  quickstartVolumes: 'quickstart.volumes',
  quickstartChapters: 'quickstart.chapters'
} as const satisfies Record<string, BudgetKey>

/**
 * 按字数那一组的公共参数。
 * 这组数是为「跟旧行为完全一致」定的：旧公式
 * min(16000, max(2048, round(words * 2.2) + 1024)) 原样拆成四个字段，
 * 所以任何一个都不能单独改，改了默认值就会漂。
 */
const PER_WORD = { perWord: 2.2, thinkPad: 1024, min: 2048, max: 16000 } as const
const perWord = (): PerWordBudget => ({ kind: 'perWord', ...PER_WORD })
const fixed = (tokens: number): FixedBudget => ({ kind: 'fixed', tokens })

/** 出厂默认预算。数值取自改造前各调用点的硬编码，一个都没动。 */
export const DEFAULT_TOKEN_BUDGETS: TokenBudgets = {
  'draft.generate': perWord(),
  'draft.continue': perWord(),
  'draft.selection': perWord(),
  'outline.generate': perWord(),
  'outline.chapterBrief': perWord(),
  'bible.entry': perWord(),
  'bible.entryShort': perWord(),
  'quickstart.firstChapter': perWord(),

  'summary.auto': fixed(600),
  'summary.audit': fixed(700),
  'audit.book': fixed(2600),
  'audit.chapter': fixed(2200),
  'audit.thread': fixed(2000),
  'margin.notes': fixed(1500),
  'naming.ideas': fixed(900),
  'style.traits': fixed(700),
  'style.trial': fixed(600),
  'chat.reply': fixed(3000),
  'custom.default': fixed(3000),
  'quickstart.title': fixed(1200),
  'quickstart.settings': fixed(6000),
  'quickstart.volumes': fixed(3000),
  'quickstart.chapters': fixed(6000)
}

/** 数值兜底：非有限数一律回 fallback，避免 NaN 一路传进请求参数。 */
function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 夹到 [lo, hi] 并取整。 */
function clampInt(value: number | undefined, lo: number, hi: number, fallback = lo): number {
  const n = Math.round(finiteOr(value, fallback))
  return Math.min(hi, Math.max(lo, n))
}

/**
 * 把一份预算校验成合法值，配置脏了也不许抛错。
 *
 * 规则：
 * - fixed.tokens → [1, 32768]，取整；非有限数按 1
 * - perWord.perWord → [0.5, 8]（太小的倍数会让正文根本写不完，太大纯属浪费）
 * - perWord.thinkPad → [0, 16384]，取整
 * - perWord.min / max → [1, 32768]，取整，并保证 min <= max（用户填反了就换过来）
 *
 * 永远返回新对象，字段顺序固定为 kind 打头，设置页表单按这个顺序排。
 */
export function clampBudget(budget: TokenBudget): TokenBudget {
  if (budget?.kind === 'perWord') {
    const min = clampInt(budget.min, 1, 32768)
    const max = clampInt(budget.max, 1, 32768)
    return {
      kind: 'perWord',
      /** 倍率不取整 */
      perWord: Math.min(8, Math.max(0.5, finiteOr(budget.perWord, 0.5))),
      thinkPad: clampInt(budget.thinkPad, 0, 16384),
      min: Math.min(min, max),
      max: Math.max(min, max)
    }
  }
  // kind 不是 perWord 的（含 undefined / 被用户存坏的数据）一律当固定预算处理
  const tokens = budget?.kind === 'fixed' || budget === undefined ? budget?.tokens : undefined
  return { kind: 'fixed', tokens: clampInt(tokens, 1, 32768, 1) }
}

/**
 * 判断一份原始配置是不是「结构完整」的预算。
 *
 * 只看形状，不管数值是否越界——越界交给 clampBudget 去夹。
 * 之所以要先判形状：clampBudget 拿不到 key，遇到看不懂的东西只能兜成
 * tokens: 1；而 1 个 token 的请求等于什么都没写出来。resolveBudget 知道 key，
 * 所以有资格判断「这不是配置，是脏数据」，然后改回默认值。
 *
 * 要求 kind 严格等于 'fixed' / 'perWord'（大小写都不能差），
 * 对应字段必须都存在且是有限数。少一个字段就算结构不全，整个回默认。
 */
function isWellFormed(budget: unknown): budget is TokenBudget {
  if (typeof budget !== 'object' || budget === null) return false
  const b = budget as Record<string, unknown>
  const isNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
  if (b.kind === 'fixed') return isNum(b.tokens)
  if (b.kind === 'perWord') return isNum(b.perWord) && isNum(b.thinkPad) && isNum(b.min) && isNum(b.max)
  return false
}

/**
 * 算出某个调用点这次该给多少输出预算。
 *
 * - fixed：直接给配置的 token 数。
 * - perWord 且知道目标字数：round(字数 × perWord) + thinkPad，再夹到 [min, max]。
 *   加 thinkPad 是因为思考 token 也吃 maxTokens，不加就会被思考占光。
 * - perWord 但字数未知（undefined / NaN / Infinity）：给 min，绝不给 0——
 *   0 会让请求直接报错，比写不完整还糟。
 * - 传进来的表缺这个 key（老配置、老存档）：回落到 DEFAULT_TOKEN_BUDGETS。
 * - 传进来的条目结构是坏的（不是对象、kind 拼错、字段缺失或不是数）：也回落到
 *   DEFAULT_TOKEN_BUDGETS。这类数据如果直接过 clampBudget 会被兜成 tokens: 1，
 *   等于静默把请求废掉，所以必须先认出来。
 *
 * 拿到的预算一律先过 clampBudget，所以越界的数值也不会算出非法值。
 */
export function resolveBudget(budgets: TokenBudgets, key: BudgetKey, targetWords?: number): number {
  const entry = budgets?.[key]
  const raw = isWellFormed(entry) ? entry : DEFAULT_TOKEN_BUDGETS[key]
  const budget = clampBudget(raw)
  if (budget.kind === 'fixed') return budget.tokens

  const words = finiteOr(targetWords, Number.NaN)
  if (!Number.isFinite(words)) return budget.min
  const wanted = Math.round(words * budget.perWord) + budget.thinkPad
  return Math.min(budget.max, Math.max(budget.min, wanted))
}
