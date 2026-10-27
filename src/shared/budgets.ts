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
 *    （旧实现里那个按字数估算的辅助函数就是踩了这个坑才加的 1024，现已删除，
 *    统一改成 perWord 预算自带的 thinkPad 字段。）
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
  | 'persona.generate'
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
  personaGenerate: 'persona.generate',
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
  // 体检类的输出是 JSON 结构体，比同字数的中文散文费 token 得多：每条问题含
  // level/type/title/detail/evidence/chapterIds/suggestion 七个字段，中文一个字约占
  // 1~1.5 token，一条中等长度的问题就要 200+ token。提示词又明确要求「共 3–12 条」，
  // 2600 装不下 12 条，模型会在写到一半时被硬截断——这正是「体检跑完却什么都没看到」
  // 的主因。给足到能容纳上限条数，宁可多花一点也不要交回一份残缺的 JSON。
  'audit.book': fixed(6000),
  'audit.chapter': fixed(4000),
  'audit.thread': fixed(3600),
  'margin.notes': fixed(1500),
  'naming.ideas': fixed(900),
  'style.traits': fixed(700),
  'style.trial': fixed(600),
  'persona.generate': fixed(1200),
  // 对话没有目标字数，只能拍一个固定额度；而思考类模型的 reasoning_content
  // 同样计入 maxTokens。旧值 3000 常常只够它想完、来不及写，表现就是回答半截
  // 甚至一片空白（用户报的「右侧 AI 对话总是中断」）。抬高上限不会让回答变长，
  // 只是不再被硬截断；重试逻辑在 generateChatReply 里另有一层兜底。
  'chat.reply': fixed(8192),
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
 * 这次「要写出来的字」与「一共能吐多少字」的差额。
 *
 * 为什么要有这个数：maxTokens 是**整次回复**的总输出额度，思考 token 和正文 token
 * 共用它。而长度守护的补写轮面对的从来不是「再写一整章」，是「还差多少」。
 * 早前补写轮拿「还差多少字」当 targetWords 递进 resolveBudget，按字数预算的下限
 * 是 2048 token，于是越补给的额度越多、越补越不划算；换成「整章目标」当字数时，
 * 章节写到 1 万字时上限（16000）又够不着。单独把这个差额暴露出来，让调用点
 * 能说清「这是补写，请按差额给」而不用去猜哪一路进了哪个分支。
 */
export interface BudgetHeadroom {
  /** 目标字数 */
  targetWords: number
  /** 本次之前已经写出来的字数（首轮传 0） */
  writtenWords: number
  /** 还差多少字；已经达到或超过目标时为 0 */
  remainingWords: number
  /**
   * 已经写出来的字占这次总输出的比例上限。
   * 总额度里要抠出这一块——已经吐出去的 token 不会再吐第二遍，
   * 但账本上得留出位置，否则「整章目标 × perWord」会把上限顶穿。
   */
  writtenRatio: number
}

/**
 * 把「已写字数」换算成这次还需要预留的整章比例。
 *
 * 中文一字约 0.75–1.5 token，perWord 已经留了余量，所以这里不做 token 换算，
 * 只做字数比例——预算里要关心的不是绝对 token 数，而是「这次请求的总盘子够不够容纳
 * 已经写出来的部分 + 还要写的部分」。上限 0.9 是防呆：已经写了 100 字但目标只有 100 字，
 * 不该把整份预算都判给「已写」而让正文没额度可用。
 */
export function budgetHeadroom(targetWords: number, writtenWords: number): BudgetHeadroom {
  const target = finiteOr(targetWords, 0)
  const written = Math.max(0, finiteOr(writtenWords, 0))
  const remaining = Math.max(0, target - written)
  const writtenRatio = target > 0 ? Math.min(0.9, written / target) : 0
  return { targetWords: target, writtenWords: written, remainingWords: remaining, writtenRatio }
}

/**
 * 算出某个调用点这次该给多少输出预算。
 *
 * - fixed：直接给配置的 token 数。
 * - perWord 且知道目标字数：round(字数 × perWord) + thinkPad，再夹到 [min, max]。
 *   加 thinkPad 是因为思考 token 也吃 maxTokens，不加就会被思考占光。
 * - perWord 且同时给了 headroom（补写轮）：按「还差多少字」算正文额度，
 *   但下限跟着「这一章总共要写多少」走，见下面的 comment。
 * - perWord 但字数未知（undefined / NaN / Infinity）：给 min，绝不给 0——
 *   0 会让请求直接报错，比写不完整还糟。
 * - 传进来的表缺这个 key（老配置、老存档）：回落到 DEFAULT_TOKEN_BUDGETS。
 * - 传进来的条目结构是坏的（不是对象、kind 拼错、字段缺失或不是数）：也回落到
 *   DEFAULT_TOKEN_BUDGETS。这类数据如果直接过 clampBudget 会被兜成 tokens: 1，
 *   等于静默把请求废掉，所以必须先认出来。
 *
 * 拿到的预算一律先过 clampBudget，所以越界的数值也不会算出非法值。
 *
 * 为什么要 headroom：补写轮的额度必须**随剩余字数递减**。按「还差多少字」算，
 * 差得越少给得越少，模型才不会明明只差 300 字却继续往下铺 2000 字；
 * 而按「已写字数」算（早前的写法）会反过来越补越多。
 */
export function resolveBudget(
  budgets: TokenBudgets,
  key: BudgetKey,
  targetWords?: number,
  headroom?: BudgetHeadroom
): number {
  const entry = budgets?.[key]
  const raw = isWellFormed(entry) ? entry : DEFAULT_TOKEN_BUDGETS[key]
  const budget = clampBudget(raw)
  if (budget.kind === 'fixed') return budget.tokens

  const words = finiteOr(targetWords, Number.NaN)
  if (!Number.isFinite(words)) return budget.min

  // 补写轮：正文额度按「还差多少字」算，下限按「整章一共要写多少」算。
  // 下限不跟着剩余字数走，是因为补写轮的正文往往只有几百字，
  // 按剩余字数算会掉到 min（2048）以下，思考一开头就把额度吃光，正文还是空的。
  // 而总量（整章）给下限，是为了让「最后一小段」也有足够的思考 + 收束空间。
  if (headroom && headroom.targetWords > 0) {
    const forBody = Math.round(headroom.remainingWords * budget.perWord)
    const floorByChapter = Math.round(headroom.targetWords * budget.perWord)
    const wanted = Math.max(forBody + budget.thinkPad, Math.round(floorByChapter * 0.35))
    return Math.min(budget.max, Math.max(budget.min, wanted))
  }

  const wanted = Math.round(words * budget.perWord) + budget.thinkPad
  return Math.min(budget.max, Math.max(budget.min, wanted))
}
