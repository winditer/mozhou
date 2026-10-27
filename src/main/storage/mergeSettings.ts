/**
 * 设置合并：把磁盘上可能残缺的老配置补成完整的 AppSettings。
 *
 * 为什么单独一个文件：`config.ts` 引了 electron（safeStorage）和 node:fs，
 * 没法在普通 node 测试里打包运行；而「老配置升级」恰恰是最需要回归测试的部分
 * ——它只在用户升过一次级之后才出问题，平时根本看不出来。合并逻辑放这里，
 * scripts/test-config-merge.mjs 就能直接打包真正的实现来测。
 *
 * 这个文件只能引 @shared/*，不许碰 electron、react 和 node 内置模块。
 */
import type { AppSettings } from '@shared/types'
import {
  DEFAULT_TOKEN_BUDGETS,
  clampBudget,
  type BudgetKey,
  type TokenBudget,
  type TokenBudgets
} from '@shared/budgets'

/** 出厂默认设置。与改造前的硬编码值逐项对齐，零行为变化。 */
export const DEFAULT_SETTINGS: AppSettings = {
  themeId: 'paper',
  typography: {
    fontFamily: '"Songti SC", "STSong", "Noto Serif SC", Georgia, serif',
    fontSize: 17,
    lineHeight: 1.9,
    pageWidth: 760,
    indent: true,
    paragraphSpacing: 0.6,
    dimUnfocused: false
  },
  typewriter: false,
  focusMode: false,
  shelfCoverSize: 'm',
  dailyGoal: 3000,
  taskModels: {
    draft: null,
    outline: null,
    polish: null,
    naming: null,
    summary: null,
    audit: null,
    chat: null
  },
  lastProjectId: null,
  tokenBudgets: DEFAULT_TOKEN_BUDGETS,
  temperature: 0.85,
  firstRunDone: false,
  showWordCountBar: true,
  // 空表 = 全部沿用 genres.ts 的内置公约；作者在设置里改过谁就出现谁
  genreConventions: {},
  // 空表 = 新书默认不带任何技法卡；作者在设置页勾了谁就出现谁
  defaultSkillIds: [],
  // 对话默认可以提改稿：真正的闸门是「应用前必须确认」，不是这个开关
  allowChatEdits: true
}

/**
 * 题材公约覆盖表是用户手写正文，落盘前必须洗一遍：
 * 丢掉空值 / 非字符串（空值等于「恢复默认」，存着只会让解析逻辑多绕一步），
 * 顺手去首尾空白，避免「改了两个空格」也算覆盖、在设置页里显示成已自定义。
 */
export function normalizeConventions(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') continue
    const text = val.trim()
    if (text) out[k] = text
  }
  return out
}

/** 老配置里可能存着已下线的 'sl' 档位，统一落到新的最小档 's' */
function normalizeCoverSize(v: unknown): 's' | 'm' | 'l' {
  if (v === 'l' || v === 'm' || v === 's') return v
  return v === 'sl' ? 's' : 'm'
}

/**
 * 判断磁盘上的这一项是不是「像预算配置」。
 *
 * 只认结构，不管数值是否越界——越界交给 clampBudget 去夹。
 * 之所以要区分：clampBudget 拿不到 key，遇到看不懂的东西只能兜成 tokens: 1，
 * 等于把那次请求静默废掉；而这里知道自己在处理哪个 key，有资格判「这不是配置，
 * 是脏数据」，然后改回该 key 的默认值。
 *
 * kind 必须严格等于 'fixed' / 'perWord'（大小写都不能差），
 * 对应字段必须存在且是有限数。少一个字段就算结构不全，整项回默认。
 * 与 shared/budgets.ts 里 resolveBudget 的形状判断保持一致。
 */
function isWellFormed(budget: unknown): budget is TokenBudget {
  if (typeof budget !== 'object' || budget === null || Array.isArray(budget)) return false
  const b = budget as Record<string, unknown>
  const isNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
  if (b.kind === 'fixed') return isNum(b.tokens)
  if (b.kind === 'perWord') return isNum(b.perWord) && isNum(b.thinkPad) && isNum(b.min) && isNum(b.max)
  return false
}

/**
 * 旧版本里「对话助手」的出厂额度是 3000，而对话一次问答的思考过程同样吃这份额度，
 * 于是推理模型经常把 3000 用完、正文一个字没写（用户报的「右侧 AI 对话总是中断」）。
 * 默认值已抬到 8192，但老配置里存着的是 3000 这个**旧默认**——不迁移的话，
 * 升级之后症状照旧，用户还得自己去设置页翻。
 *
 * 只迁移「恰好等于旧默认」的那一档：作者自己调过的值（比如 5000、12000）原样保留。
 */
const LEGACY_CHAT_REPLY_TOKENS = 3000

/**
 * 合并预算表。逐键遍历默认表（而不是用户的表），保证：
 * - 缺的 key 用默认值，老配置（压根没有 tokenBudgets）也能一次补齐；
 * - 用户表里多出来的未知 key 不会漏进结果；
 * - 结构对但数值越界的只夹取、保留用户的意图；结构坏的才回默认。
 *
 * 每个条目都必须新建对象，不能直接引用 DEFAULT_TOKEN_BUDGETS[key]：
 * 那是个共享的进程级常量，调用方只要就地改一次（budget.tokens = 5），
 * 默认表就被永久改坏，之后所有 mergeSettings 都拿到污染后的值。
 * 走默认分支时用 spread 复制——TokenBudget 的字段全是原始值，浅拷贝即够深。
 */
function mergeTokenBudgets(raw: unknown): AppSettings['tokenBudgets'] {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const out = {} as TokenBudgets
  for (const key of Object.keys(DEFAULT_TOKEN_BUDGETS) as BudgetKey[]) {
    const v = src[key]
    const merged = isWellFormed(v) ? clampBudget(v) : { ...DEFAULT_TOKEN_BUDGETS[key] }
    // 对话额度的旧默认迁移：3000 对思考类模型明显不够，见 LEGACY_CHAT_REPLY_TOKENS
    if (key === 'chat.reply' && merged.kind === 'fixed' && merged.tokens === LEGACY_CHAT_REPLY_TOKENS) {
      out[key] = { ...DEFAULT_TOKEN_BUDGETS[key] }
      continue
    }
    out[key] = merged
  }
  return out
}

/**
 * 把磁盘上可能残缺的 settings 合并成完整对象。
 *
 * - 传 undefined / {} 也返回完整设置；
 * - 用户值优先，但 typography 与 taskModels 是深合并，缺的字段补默认；
 * - shelfCoverSize 走 normalizeCoverSize，老 'sl' 落到 's'；
 * - tokenBudgets 逐键补齐，规则见 mergeTokenBudgets。
 *
 * 返回的 typography / taskModels / tokenBudgets 都是新对象，
 * 连 tokenBudgets 里每个条目也是新对象，调用方就地改也不会污染 DEFAULT_SETTINGS。
 */
export function mergeSettings(raw: Partial<AppSettings> | undefined): AppSettings {
  const r = raw ?? {}
  return {
    ...DEFAULT_SETTINGS,
    ...r,
    shelfCoverSize: normalizeCoverSize(r.shelfCoverSize),
    typography: { ...DEFAULT_SETTINGS.typography, ...(r.typography ?? {}) },
    taskModels: { ...DEFAULT_SETTINGS.taskModels, ...(r.taskModels ?? {}) },
    tokenBudgets: mergeTokenBudgets(r.tokenBudgets),
    genreConventions: normalizeConventions(r.genreConventions),
    defaultSkillIds: normalizeIdList(r.defaultSkillIds)
  }
}

/**
 * id 列表洗一遍：丢掉非字符串与空串，去重但**保留顺序**。
 * 顺序是作者勾选顺序，也就是技法卡的注入顺序——排序会让结果不可复现。
 */
function normalizeIdList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const id = x.trim()
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}
