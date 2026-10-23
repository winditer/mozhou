# 输出预算（maxTokens）配置化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把散落在 11 个文件里的 23 处硬编码 `maxTokens` 抽成设置项，为每个调用点提供独立可配置的输出预算。

**Architecture:** 在 `src/shared/budgets.ts` 定义独立键空间 `BudgetKey` 与联合类型 `TokenBudget`（`fixed` / `perWord`），用纯函数 `resolveBudget()` 求值；预算存进 `AppSettings.tokenBudgets`，由主进程深合并补齐默认值；新增「输出预算」设置 tab 分组件编辑；11 个调用点逐一改为从配置取值。

**Tech Stack:** TypeScript、Electron、React、zustand、esbuild（测试用）、electron-vite。

**Spec:** [2026-10-23-token-budget-settings-design.md](../specs/2026-10-23-token-budget-settings-design.md)

## Global Constraints

- 依赖 `src/shared/budgets.ts` 同时被主进程与渲染进程引用，**不得** import 任何 Electron / React / node 内置模块。
- 默认值必须与改造前逐处硬编码值**完全一致**，零行为变化。
- 连通性测试的 `maxTokens: 8`（`src/main/ai/registry.ts:233`）**保持硬编码**，不纳入配置。
- 思考过程计入 `maxTokens` 且无法排除，`perWord` 预算必须保留 `thinkPad` 余量；prompt **不**计入，无需处理。
- 校验上下限：`fixed.tokens` ∈ [1, 32768]；`perWord.perWord` ∈ [0.5, 8]；`perWord.thinkPad` ∈ [0, 16384]；`perWord.min`、`perWord.max` ∈ [1, 32768] 且 `min ≤ max`。非法值回落默认。
- 所有 UI 文案用中文，与现有设置页风格一致（`PageHead`、`card`、`--text-faint` 等）。
- 每个 Task 结束必须 `npm run typecheck` 通过后再提交。

---

### Task 1: 预算类型与解析函数

**Files:**
- Create: `src/shared/budgets.ts`
- Test: `scripts/test-budgets.mjs`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `type BudgetKey` — 23 个字面量联合类型
  - `interface FixedBudget { kind: 'fixed'; tokens: number }`
  - `interface PerWordBudget { kind: 'perWord'; perWord: number; thinkPad: number; min: number; max: number }`
  - `type TokenBudget = FixedBudget | PerWordBudget`
  - `type TokenBudgets = Record<BudgetKey, TokenBudget>`
  - `const BUDGET_KEYS: Record<string, BudgetKey>` — 供调用点用名字引用
  - `const DEFAULT_TOKEN_BUDGETS: TokenBudgets`
  - `function resolveBudget(budgets: TokenBudgets, key: BudgetKey, targetWords?: number): number`
  - `function clampBudget(budget: TokenBudget): TokenBudget` — 校验并回落

- [ ] **Step 1: 写失败的测试**

创建 `scripts/test-budgets.mjs`：

```js
/**
 * 输出预算解析的回归测试。
 * 运行：node scripts/test-budgets.mjs
 *
 * 直接跑真正的实现（esbuild 临时打包），不复制一份逻辑来测。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '../src/shared/budgets.ts')

const outdir = mkdtempSync(join(tmpdir(), 'mozhou-budget-'))
const outfile = join(outdir, 'budgets.mjs')
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile, logLevel: 'silent' })
const { resolveBudget, DEFAULT_TOKEN_BUDGETS, clampBudget, BUDGET_KEYS } = await import(
  pathToFileURL(outfile).href
)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

const B = DEFAULT_TOKEN_BUDGETS

/* ── fixed：原样返回，但受 clamp ── */
console.log('fixed 固定预算')
check('summary.auto 默认 600', resolveBudget(B, 'summary.auto') === 600, resolveBudget(B, 'summary.auto'))
check('summary.audit 默认 700', resolveBudget(B, 'summary.audit') === 700)
check('audit.book 默认 2600', resolveBudget(B, 'audit.book') === 2600)
check('chat.reply 默认 3000', resolveBudget(B, 'chat.reply') === 3000)
check('quickstart.settings 默认 6000', resolveBudget(B, 'quickstart.settings') === 6000)

/* ── perWord：正文按倍数 + 思考余量，再夹到 [min,max] ── */
console.log('perWord 动态预算')
// draft.generate 默认 perWord 2.2 / thinkPad 1024 / min 2048 / max 16000
// 3000 字 → 3000*2.2=6600 +1024 = 7624
check('draft.generate 3000 字 → 7624', resolveBudget(B, 'draft.generate', 3000) === 7624,
  resolveBudget(B, 'draft.generate', 3000))
// 100 字 → 220+1024=1244 < min 2048 → 2048
check('draft.generate 100 字 触下限 2048', resolveBudget(B, 'draft.generate', 100) === 2048,
  resolveBudget(B, 'draft.generate', 100))
// 0 字 → 0+1024=1024 < 2048 → 2048
check('draft.generate 0 字 触下限 2048', resolveBudget(B, 'draft.generate', 0) === 2048)
// 超大字数触上限 16000
check('draft.generate 超大字数额 触上限 16000',
  resolveBudget(B, 'draft.generate', 999999) === 16000,
  resolveBudget(B, 'draft.generate', 999999))

/* ── perWord 缺 targetWords：用 min 兜底 ── */
console.log('perWord 缺 targetWords')
check('缺 targetWords 回落 min', resolveBudget(B, 'draft.generate') === 2048,
  resolveBudget(B, 'draft.generate'))

/* ── clampBudget：非法值回落 ── */
console.log('clampBudget 非法值')
check('tokens=0 回落 1', clampBudget({ kind: 'fixed', tokens: 0 }).tokens === 1)
check('tokens=-5 回落 1', clampBudget({ kind: 'fixed', tokens: -5 }).tokens === 1)
check('tokens=999999 夹到 32768', clampBudget({ kind: 'fixed', tokens: 999999 }).tokens === 32768)
const badPerWord = clampBudget({ kind: 'perWord', perWord: 0, thinkPad: -1, min: 9000, max: 100 })
check('perWord=0 抬到 0.5', badPerWord.perWord === 0.5, badPerWord.perWord)
check('thinkPad=-1 抬到 0', badPerWord.thinkPad === 0, badPerWord.thinkPad)
check('min>max 时 min 被压到 max', badPerWord.min <= badPerWord.max,
  `${badPerWord.min}/${badPerWord.max}`)

/* ── 默认值等价性：与改造前硬编码逐项对齐 ── */
console.log('默认值等价性')
const FIXED_EXPECT = {
  'summary.auto': 600,
  'summary.audit': 700,
  'audit.book': 2600,
  'audit.chapter': 2200,
  'audit.thread': 2000,
  'margin.notes': 1500,
  'naming.ideas': 900,
  'style.traits': 700,
  'style.trial': 600,
  'chat.reply': 3000,
  'custom.default': 3000,
  'quickstart.title': 1200,
  'quickstart.settings': 6000,
  'quickstart.volumes': 3000,
  'quickstart.chapters': 6000
}
for (const [key, want] of Object.entries(FIXED_EXPECT)) {
  check(`${key} == ${want}`, resolveBudget(B, key) === want, resolveBudget(B, key))
}

// tokensForWords 原实现：min(16000, max(2048, round(w*2.2)+1024))
const legacy = (w) => Math.min(16000, Math.max(2048, Math.round(w * 2.2) + 1024))
for (const w of [0, 1, 100, 420, 800, 900, 3200, 5000, 20000]) {
  const perWordKeys = ['draft.generate', 'outline.generate', 'outline.chapterBrief', 'bible.entry', 'bible.entryShort']
  for (const k of perWordKeys) {
    check(`${k} @${w} 字 等于旧 tokensForWords`, resolveBudget(B, k, w) === legacy(w),
      `${resolveBudget(B, k, w)} vs ${legacy(w)}`)
  }
}

/* ── BUDGET_KEYS 完整性 ── */
console.log('BUDGET_KEYS 完整性')
const keyValues = Object.values(BUDGET_KEYS)
check('BUDGET_KEYS 有 23 项', keyValues.length === 23, keyValues.length)
check('每个 BUDGET_KEYS 值都在默认表里', keyValues.every((k) => k in B), 
  keyValues.filter((k) => !(k in B)).join(','))
check('默认表有 23 项', Object.keys(B).length === 23, Object.keys(B).length)

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/test-budgets.mjs`
Expected: FAIL — esbuild 报找不到 `src/shared/budgets.ts`

- [ ] **Step 3: 写实现**

创建 `src/shared/budgets.ts`：

```ts
/**
 * 输出预算（maxTokens）的键空间、默认值与求值逻辑。
 *
 * 这里只管「给模型多少输出预算」，不碰传输：三家协议的字段名差异在
 * main/ai/* 适配器里处理。本文件被主进程与渲染进程共用，不得 import
 * 任何 Electron / React / node 内置模块。
 *
 * 两个必须记住的事实：
 * - prompt 不计入 maxTokens（输入是独立维度）；
 * - 思考过程（reasoning / thinking）计入 maxTokens 且无法排除，
 *   所以 perWord 预算要额外留 thinkPad。
 */

export type BudgetKey =
  // 动态项：按目标字数反推
  | 'draft.generate'
  | 'draft.continue'
  | 'draft.selection'
  | 'outline.generate'
  | 'outline.chapterBrief'
  | 'bible.entry'
  | 'bible.entryShort'
  | 'quickstart.firstChapter'
  // 固定项
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

export interface FixedBudget {
  kind: 'fixed'
  tokens: number
}

export interface PerWordBudget {
  kind: 'perWord'
  /** 每字预算倍数 */
  perWord: number
  /** 思考余量：额外留给模型的推理过程 */
  thinkPad: number
  min: number
  max: number
}

export type TokenBudget = FixedBudget | PerWordBudget
export type TokenBudgets = Record<BudgetKey, TokenBudget>

/** 调用点用名字引用，避免手里攥字符串字面量写错 */
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

const MIN_TOKENS = 1
const MAX_TOKENS = 32768
const MIN_PER_WORD = 0.5
const MAX_PER_WORD = 8
const MAX_THINK_PAD = 16384

/** 老 tokensForWords 的四个参数：改造前后必须等价 */
const LEGACY_PER_WORD = { perWord: 2.2, thinkPad: 1024, min: 2048, max: 16000 } as const

const perWord = (): PerWordBudget => ({ kind: 'perWord', ...LEGACY_PER_WORD })
const fixed = (tokens: number): FixedBudget => ({ kind: 'fixed', tokens })

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

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * 把用户存的值收敛到安全区间。
 * 用户可能把值填成 0 或负数——那会让请求直接 400，所以这里保底线而不抛错。
 */
export function clampBudget(budget: TokenBudget): TokenBudget {
  if (budget.kind === 'fixed') {
    const t = Number.isFinite(budget.tokens) ? budget.tokens : MIN_TOKENS
    return { kind: 'fixed', tokens: Math.round(clamp(t, MIN_TOKENS, MAX_TOKENS)) }
  }
  const pw = Number.isFinite(budget.perWord) ? budget.perWord : MIN_PER_WORD
  const pad = Number.isFinite(budget.thinkPad) ? budget.thinkPad : 0
  const lo = Number.isFinite(budget.min) ? budget.min : LEGACY_PER_WORD.min
  const hi = Number.isFinite(budget.max) ? budget.max : LEGACY_PER_WORD.max
  const min = Math.round(clamp(lo, MIN_TOKENS, MAX_TOKENS))
  const max = Math.round(clamp(hi, MIN_TOKENS, MAX_TOKENS))
  return {
    kind: 'perWord',
    perWord: clamp(pw, MIN_PER_WORD, MAX_PER_WORD),
    thinkPad: Math.round(clamp(pad, 0, MAX_THINK_PAD)),
    min: Math.min(min, max),
    max: Math.max(min, max)
  }
}

/**
 * 求一个调用点最终该发多少输出预算。
 * 缺 targetWords 时按 min 兜底，而不是算出个 0。
 */
export function resolveBudget(budgets: TokenBudgets, key: BudgetKey, targetWords?: number): number {
  const budget = clampBudget(budgets[key] ?? DEFAULT_TOKEN_BUDGETS[key])
  if (budget.kind === 'fixed') return budget.tokens
  if (targetWords === undefined || !Number.isFinite(targetWords)) return budget.min
  const words = Math.max(0, targetWords)
  const raw = Math.round(words * budget.perWord) + budget.thinkPad
  return clamp(raw, budget.min, budget.max)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/test-budgets.mjs`
Expected: PASS — 末行 `N 通过, 0 失败`

- [ ] **Step 5: typecheck 并提交**

```bash
npm run typecheck && git add src/shared/budgets.ts scripts/test-budgets.mjs && git commit -m "feat(budget): 新增输出预算类型与 resolveBudget 解析函数"
```

---

### Task 2: 接入 AppSettings 持久化与迁移

**Files:**
- Modify: `src/shared/types.ts:60-73`（`AppSettings` 增加 `tokenBudgets`）
- Modify: `src/main/storage/config.ts:7-35`（`DEFAULT_SETTINGS` 增加字段）、`:50`（深合并）
- Test: `scripts/test-config-merge.mjs`

**Interfaces:**
- Consumes: Task 1 的 `TokenBudgets`、`DEFAULT_TOKEN_BUDGETS`。
- Produces: `AppSettings.tokenBudgets: TokenBudgets`；`loadConfig()` 返回值中该字段必然完整（23 个键齐全）。

- [ ] **Step 1: 写失败的测试**

创建 `scripts/test-config-merge.mjs`：

```js
/**
 * 配置合并的回归测试：老配置缺 tokenBudgets 时必须被补齐。
 * 运行：node scripts/test-config-merge.mjs
 *
 * 直接测真实的合并纯函数，不复制一份逻辑。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outdir = mkdtempSync(join(tmpdir(), 'mozhou-cfg-'))
const outfile = join(outdir, 'merge.mjs')
// 只打包 settings 合并逻辑，绕开 electron 依赖
await build({
  entryPoints: [join(here, '../src/main/storage/mergeSettings.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
  external: ['electron']
})
const { mergeSettings } = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

console.log('老配置迁移')
const legacy = mergeSettings({ themeId: 'ink', temperature: 0.5 })
check('保留用户已有 themeId', legacy.themeId === 'ink', legacy.themeId)
check('保留用户已有 temperature', legacy.temperature === 0.5)
check('补齐 tokenBudgets', legacy.tokenBudgets != null)
check('tokenBudgets 有 23 个键', Object.keys(legacy.tokenBudgets).length === 23,
  Object.keys(legacy.tokenBudgets).length)
check('summary.auto 补成 600', legacy.tokenBudgets['summary.auto'].tokens === 600)

console.log('已有配置不被覆盖')
const partial = mergeSettings({
  tokenBudgets: { 'summary.auto': { kind: 'fixed', tokens: 1234 } }
})
check('用户改过的 summary.auto 保留', partial.tokenBudgets['summary.auto'].tokens === 1234,
  partial.tokenBudgets['summary.auto'].tokens)
check('未改过的键仍补齐', partial.tokenBudgets['audit.book'].tokens === 2600)

console.log('空配置')
const empty = mergeSettings(undefined)
check('undefined 也能得到完整默认值', Object.keys(empty.tokenBudgets).length === 23)

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/test-config-merge.mjs`
Expected: FAIL — esbuild 报找不到 `src/main/storage/mergeSettings.ts`

- [ ] **Step 3: 抽出合并逻辑**

创建 `src/main/storage/mergeSettings.ts`（从 `config.ts:50` 那行内联表达式抽出，便于单测）：

```ts
import type { AppSettings } from '@shared/types'
import { DEFAULT_TOKEN_BUDGETS, clampBudget, type BudgetKey, type TokenBudget } from '@shared/budgets'

/** 默认设置：与改造前的硬编码值逐项对齐，零行为变化 */
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
  tokenBudgets: DEFAULT_TOKEN_BUDGETS,
  lastProjectId: null,
  temperature: 0.85,
  firstRunDone: false,
  showWordCountBar: true
}

function normalizeCoverSize(v: unknown): 's' | 'm' | 'l' {
  if (v === 'l' || v === 'm' || v === 's') return v
  return v === 'sl' ? 's' : 'm'
}

/**
 * 把磁盘上可能残缺的 settings 合并成完整对象。
 * 老配置没有 tokenBudgets → 补默认；有但缺某个键 → 逐键补；
 * 值非法（0、负数、min>max）→ clamp 到安全区间，而不是让请求 400。
 */
export function mergeSettings(raw: Partial<AppSettings> | undefined): AppSettings {
  const r = raw ?? {}
  const rawBudgets = (r.tokenBudgets ?? {}) as Partial<Record<BudgetKey, TokenBudget>>
  const tokenBudgets = { ...DEFAULT_TOKEN_BUDGETS }
  for (const key of Object.keys(DEFAULT_TOKEN_BUDGETS) as BudgetKey[]) {
    const v = rawBudgets[key]
    if (v && (v.kind === 'fixed' || v.kind === 'perWord')) tokenBudgets[key] = clampBudget(v)
  }
  return {
    ...DEFAULT_SETTINGS,
    ...r,
    shelfCoverSize: normalizeCoverSize(r.shelfCoverSize),
    typography: { ...DEFAULT_SETTINGS.typography, ...(r.typography ?? {}) },
    taskModels: { ...DEFAULT_SETTINGS.taskModels, ...(r.taskModels ?? {}) },
    tokenBudgets
  }
}
```

- [ ] **Step 4: 改 config.ts 使用它**

`src/main/storage/config.ts` 顶部 import 改为：

```ts
import type { Channel, Config, ModelEntry } from '@shared/types'
import { DEFAULT_SETTINGS, mergeSettings } from './mergeSettings'
```

删除原 `DEFAULT_SETTINGS` 定义（第 7–35 行）与 `normalizeCoverSize` 函数（第 54–58 行，已移入 mergeSettings.ts），把 `loadConfig` 的 settings 行改为：

```ts
    settings: mergeSettings(raw.settings)
```

并重新导出以保持既有引用：

```ts
export { DEFAULT_SETTINGS } from './mergeSettings'
```

- [ ] **Step 5: 在 types.ts 加字段**

`src/shared/types.ts` 的 `AppSettings` 接口里，`temperature` 上方加一行：

```ts
  /** 各调用点的输出预算（maxTokens），键见 shared/budgets.ts */
  tokenBudgets: TokenBudgets
```

并在该文件顶部加：

```ts
import type { TokenBudgets } from './budgets'
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node scripts/test-config-merge.mjs && npm run typecheck`
Expected: PASS — 末行 `N 通过, 0 失败`

- [ ] **Step 7: 提交**

```bash
git add src/shared/types.ts src/main/storage/config.ts src/main/storage/mergeSettings.ts scripts/test-config-merge.mjs
git commit -m "feat(budget): 接入 AppSettings 并支持老配置自动补齐"
```

---

### Task 3: 改造 tokensForWords 与 generate.ts

**Files:**
- Modify: `src/renderer/lib/prompt.ts:348-360`
- Modify: `src/renderer/lib/generate.ts:56-68, 77-98, 109-118, 126-135, 152-161, 168-180`

**Interfaces:**
- Consumes: Task 1 的 `resolveBudget`、`BUDGET_KEYS`、`TokenBudgets`。
- Produces: `tokensForWords(words, budgets?)` 保持向后兼容；`generateDraft` / `generateSelection` / `generateSummary` / `generateChatReply` / `generateCustom` 额外接受可选 `budgets: TokenBudgets`。

- [ ] **Step 1: 改造 tokensForWords**

`src/renderer/lib/prompt.ts` 第 348–360 行整体替换为：

```ts
/**
 * 按目标字数给出输出预算——保留为薄封装，内部走配置化的 resolveBudget。
 * 不传 budgets 时用默认参数（perWord 2.2 / thinkPad 1024 / min 2048 / max 16000），
 * 与改造前完全等价。
 */
export function tokensForWords(words: number, budgets: TokenBudgets = DEFAULT_TOKEN_BUDGETS): number {
  return resolveBudget(budgets, BUDGET_KEYS.draftGenerate, words)
}
```

并在文件顶部 import 区加：

```ts
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, resolveBudget, type TokenBudgets } from '@shared/budgets'
```

- [ ] **Step 2: 改造 generate.ts**

`src/renderer/lib/generate.ts`：

顶部 import 增加：

```ts
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, resolveBudget, type TokenBudgets } from '@shared/budgets'
```

`GenParams` 接口（第 14–25 行）末尾加：

```ts
  /** 输出预算配置；不传则用默认值 */
  budgets?: TokenBudgets
```

`generateDraft`（第 44 行起）内：函数体开头加

```ts
  const budgets = p.budgets ?? DEFAULT_TOKEN_BUDGETS
```

把首次调用的 `maxTokens: tokensForWords(p.targetWords)`（第 62 行）改为

```ts
    maxTokens: resolveBudget(budgets, BUDGET_KEYS.draftGenerate, p.targetWords),
```

把续写调用的 `maxTokens: tokensForWords(Math.max(400, p.targetWords - countWords(text)))`（第 92 行）改为

```ts
      maxTokens: resolveBudget(budgets, BUDGET_KEYS.draftContinue, Math.max(400, p.targetWords - countWords(text))),
```

> 注意：`Math.max(400, …)` 是**字数**下限，保留在原处；预算里的 `min` 是 **token** 下限，在 `resolveBudget` 内部生效。两者不可合并。

`generateSelection`：`const budgets = p.budgets ?? DEFAULT_TOKEN_BUDGETS`，第 115 行改为

```ts
    maxTokens: resolveBudget(budgets, BUDGET_KEYS.draftSelection, Math.max(300, countWords(p.selection) * 2)),
```

`generateSummary`：同上取 budgets，第 132 行 `maxTokens: 600` 改为

```ts
    maxTokens: resolveBudget(budgets, BUDGET_KEYS.summaryAuto),
```

`generateChatReply`：同上取 budgets，第 158 行 `maxTokens: 3000` 改为

```ts
    maxTokens: resolveBudget(budgets, BUDGET_KEYS.chatReply),
```

`generateCustom`：`maxTokens: p.maxTokens ?? 3000`（第 177 行）改为

```ts
    maxTokens: p.maxTokens ?? resolveBudget(p.budgets ?? DEFAULT_TOKEN_BUDGETS, BUDGET_KEYS.customDefault),
```

- [ ] **Step 3: typecheck 并跑既有测试**

Run: `npm run typecheck && node scripts/test-budgets.mjs`
Expected: 均通过。`tokensForWords` 的默认行为不变，故 `test-budgets.mjs` 的等价性断言仍然成立。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/lib/prompt.ts src/renderer/lib/generate.ts
git commit -m "refactor(budget): generate.ts 五个调用点改用配置预算"
```

---

### Task 4: 改造 QuickStart 与 Workspace 各调用点

**Files:**
- Modify: `src/renderer/pages/Bookshelf/QuickStart.tsx:50-68, 172-215, 325-360`
- Modify: `src/renderer/pages/Workspace/AuditTab.tsx:335-345, 375-385, 443-453, 504-514`
- Modify: `src/renderer/pages/Workspace/IdeasTab.tsx:44-50`
- Modify: `src/renderer/pages/Workspace/outline/GenOutlineModal.tsx:83-90`
- Modify: `src/renderer/pages/Workspace/outline/ChapterBriefModal.tsx:57-63`
- Modify: `src/renderer/pages/Workspace/bible/BibleAiModal.tsx:96-103`
- Modify: `src/renderer/pages/Workspace/audit/MarginNotes.tsx:50-62`
- Modify: `src/renderer/pages/Workspace/style/StyleEditorModal.tsx:132-140`
- Modify: `src/renderer/pages/Workspace/style/TrialCompare.tsx:150-158`

**Interfaces:**
- Consumes: Task 1 的 `resolveBudget` / `BUDGET_KEYS`；Task 2 的 `config.settings.tokenBudgets`。
- Produces: 无新导出，仅替换取值来源。

**统一取预算的写法**（每处按需引入）：

```ts
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, resolveBudget } from '@shared/budgets'
import { useApp } from '../../store/app'
// 组件内：
const budgets = useApp((s) => s.config?.settings.tokenBudgets) ?? DEFAULT_TOKEN_BUDGETS
```

- [ ] **Step 1: QuickStart**

`STEP_TOKENS` 常量（第 58–63 行）删掉，改为在 `runStep` 内部按 key 求值。`runStep` 签名（第 174–181 行）最后一个参数由 `maxTokens: number` 改为 `budgetKey: BudgetKey`，内部 `sendChat` 的 `maxTokens`（第 205 行）改为：

```ts
          maxTokens: resolveBudget(budgets, budgetKey),
```

四个调用点改为传 key：

```ts
    runStep(1, 'outline', () => titleMessages(idea), BUDGET_KEYS.quickstartTitle, applyTitle)
    return runStep(2, 'outline', () => settingsMessages({ ...idea, title, perChapter: form.perChapter }), BUDGET_KEYS.quickstartSettings, applySettings)
    return runStep(3, 'outline', () => volumesMessages({ ...idea, title, settings }), BUDGET_KEYS.quickstartVolumes, applyVolumes)
    return runStep(4, 'outline', () => chaptersMessages({ ...idea, title, settings, volumes }), BUDGET_KEYS.quickstartChapters, applyChapters)
```

第五步首章是动态项，单独处理：

```ts
    runStep(5, 'draft', () => firstChapterMessages(productNow('')), BUDGET_KEYS.quickstartFirstChapter, applyFirstChapter)
```

并让 `runStep` 内部按 key 区分是否需要 `targetWords`：

```ts
          maxTokens: resolveBudget(
            budgets,
            budgetKey,
            budgetKey === BUDGET_KEYS.quickstartFirstChapter ? form.perChapter : undefined
          ),
```

- [ ] **Step 2: AuditTab 四处**

四处的 `maxTokens` 依次替换（其余参数不动）：

- 第 339 行 `maxTokens: 700` → `maxTokens: resolveBudget(budgets, BUDGET_KEYS.summaryAudit)`
- 第 379 行 `maxTokens: 2600` → `maxTokens: resolveBudget(budgets, BUDGET_KEYS.auditBook)`
- 第 447 行 `maxTokens: 2200` → `maxTokens: resolveBudget(budgets, BUDGET_KEYS.auditChapter)`
- 第 508 行 `maxTokens: 2000` → `maxTokens: resolveBudget(budgets, BUDGET_KEYS.auditThread)`

在组件顶部取 `const budgets = useApp((s) => s.config?.settings.tokenBudgets) ?? DEFAULT_TOKEN_BUDGETS`。

- [ ] **Step 3: 其余七处**

- `IdeasTab.tsx:47` `maxTokens: 900` → `resolveBudget(budgets, BUDGET_KEYS.namingIdeas)`
- `GenOutlineModal.tsx:85` `const maxTokens = tokensForWords(3200)` → `const maxTokens = resolveBudget(budgets, BUDGET_KEYS.outlineGenerate, 3200)`
- `ChapterBriefModal.tsx:61` `maxTokens: tokensForWords(420)` → `maxTokens: resolveBudget(budgets, BUDGET_KEYS.outlineChapterBrief, 420)`
- `BibleAiModal.tsx:100` → `maxTokens: resolveBudget(budgets, kind === 'characters' ? BUDGET_KEYS.bibleEntry : BUDGET_KEYS.bibleEntryShort, kind === 'characters' ? 900 : 800)`
- `MarginNotes.tsx:59` `maxTokens: 1500` → `resolveBudget(budgets, BUDGET_KEYS.marginNotes)`
- `StyleEditorModal.tsx:136` `maxTokens: 700` → `resolveBudget(budgets, BUDGET_KEYS.styleTraits)`
- `TrialCompare.tsx:155` `maxTokens: 600` → `resolveBudget(budgets, BUDGET_KEYS.styleTrial)`

- [ ] **Step 4: 确认无遗漏**

Run: `grep -rn "maxTokens: [0-9]" src/renderer/ src/main/`
Expected: 只剩 `src/main/ai/registry.ts:233`（连通性测试的 8，按设计保留）和类型定义行。若有其它数字命中即为遗漏，逐一改掉。

- [ ] **Step 5: typecheck 并提交**

```bash
npm run typecheck && git add -A src/renderer/pages && git commit -m "refactor(budget): QuickStart 与 Workspace 全部调用点改用配置预算"
```

---

### Task 5: 「输出预算」设置页

**Files:**
- Create: `src/renderer/pages/Settings/BudgetsSection.tsx`
- Modify: `src/renderer/pages/Settings/index.tsx:2-24, 69`

**Interfaces:**
- Consumes: Task 1 的 `BUDGET_KEYS`、`DEFAULT_TOKEN_BUDGETS`、`TokenBudget`、`clampBudget`；Task 2 的 `config.settings.tokenBudgets`；现有 `patchSettingsSafe`（`./common`）、`PageHead`、`Button`。
- Produces: `export function BudgetsSection(): ReactNode`。

- [ ] **Step 1: 写设置页**

创建 `src/renderer/pages/Settings/BudgetsSection.tsx`：

```tsx
import type { ReactNode } from 'react'
import { RotateCcw, AlertTriangle } from 'lucide-react'
import {
  BUDGET_KEYS,
  DEFAULT_TOKEN_BUDGETS,
  clampBudget,
  type BudgetKey,
  type TokenBudget,
  type TokenBudgets
} from '@shared/budgets'
import { Button } from '../../components/ui'
import { useApp } from '../../store/app'
import { LoadingHint, PageHead, patchSettingsSafe } from './common'

interface Row {
  key: BudgetKey
  label: string
  desc: string
}

interface Group {
  title: string
  note?: string
  rows: Row[]
}

/**
 * 分组按「用户在写什么」排，不按类型定义顺序。
 * 说明文字里点明调用点，让用户知道改这里会影响到哪。
 */
const GROUPS: Group[] = [
  {
    title: '写作',
    rows: [
      { key: BUDGET_KEYS.draftGenerate, label: '正文生成', desc: '按本章目标字数反推预算' },
      { key: BUDGET_KEYS.draftContinue, label: '长度守护补写', desc: '篇幅不足时自动续写，按剩余字数反推' },
      { key: BUDGET_KEYS.draftSelection, label: '选中段落润色', desc: '按选中字数反推' },
      { key: BUDGET_KEYS.chatReply, label: '对话助手', desc: '右侧助手的自由问答' }
    ]
  },
  {
    title: '大纲与设定',
    rows: [
      { key: BUDGET_KEYS.outlineGenerate, label: '大纲推演', desc: '一次生成多章大纲' },
      { key: BUDGET_KEYS.outlineChapterBrief, label: '章节简介', desc: '单章简介，按 420 字估算' },
      { key: BUDGET_KEYS.bibleEntry, label: '设定卡（人物）', desc: '设定库中的人物条目' },
      { key: BUDGET_KEYS.bibleEntryShort, label: '设定卡（其他）', desc: '地点、组织、道具等条目' }
    ]
  },
  {
    title: '一键开书',
    note: '这五项是一次性生成，预算偏紧会导致 JSON 截断、解析失败',
    rows: [
      { key: BUDGET_KEYS.quickstartTitle, label: '书名与简介', desc: '第 1 步' },
      { key: BUDGET_KEYS.quickstartSettings, label: '核心设定', desc: '第 2 步' },
      { key: BUDGET_KEYS.quickstartVolumes, label: '分卷', desc: '第 3 步' },
      { key: BUDGET_KEYS.quickstartChapters, label: '首卷章纲', desc: '第 4 步' },
      { key: BUDGET_KEYS.quickstartFirstChapter, label: '首章正文', desc: '第 5 步，按每章字数反推' }
    ]
  },
  {
    title: '摘要与体检',
    rows: [
      { key: BUDGET_KEYS.summaryAuto, label: '章节摘要（自动）', desc: '生成正文后自动压缩' },
      { key: BUDGET_KEYS.summaryAudit, label: '章节摘要（体检用）', desc: '全书体检前的批量摘要' },
      { key: BUDGET_KEYS.auditBook, label: '全书体检', desc: '汇总所有摘要做一致性审校' },
      { key: BUDGET_KEYS.auditChapter, label: '单章体检', desc: '针对一章的详细审校' },
      { key: BUDGET_KEYS.auditThread, label: '伏笔猎手', desc: '扫描未登记的伏笔' }
    ]
  },
  {
    title: '其它',
    rows: [
      { key: BUDGET_KEYS.namingIdeas, label: '取名灵感', desc: '角色、地点、功法取名' },
      { key: BUDGET_KEYS.styleTraits, label: '文风特征提取', desc: '从样文提炼写作特征' },
      { key: BUDGET_KEYS.styleTrial, label: '文风试写对比', desc: '同段落的多个候选' },
      { key: BUDGET_KEYS.marginNotes, label: '段边批注', desc: '逐段给修改建议' },
      { key: BUDGET_KEYS.customDefault, label: '自定义调用兜底', desc: '未显式指定预算时的默认值' }
    ]
  }
]

const num = (v: string, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function BudgetsSection(): ReactNode {
  const config = useApp((s) => s.config)
  const toast = useApp((s) => s.toast)

  if (!config) return <LoadingHint />

  const budgets = config.settings.tokenBudgets

  async function save(key: BudgetKey, next: TokenBudget): Promise<void> {
    const merged: TokenBudgets = { ...budgets, [key]: clampBudget(next) }
    const ok = await patchSettingsSafe({ tokenBudgets: merged })
    if (!ok) toast('保存失败', 'error')
  }

  async function resetOne(key: BudgetKey): Promise<void> {
    await save(key, DEFAULT_TOKEN_BUDGETS[key])
    toast('已恢复默认值', 'ok')
  }

  async function resetAll(): Promise<void> {
    const ok = await patchSettingsSafe({ tokenBudgets: DEFAULT_TOKEN_BUDGETS })
    if (ok) toast('全部恢复默认', 'ok')
  }

  // 逐字段比较，不依赖对象键顺序（JSON.stringify 对键序敏感，容易误判）
  const isDefault = (key: BudgetKey): boolean => {
    const a = clampBudget(budgets[key])
    const b = clampBudget(DEFAULT_TOKEN_BUDGETS[key])
    if (a.kind !== b.kind) return false
    if (a.kind === 'fixed' && b.kind === 'fixed') return a.tokens === b.tokens
    if (a.kind === 'perWord' && b.kind === 'perWord') {
      return a.perWord === b.perWord && a.thinkPad === b.thinkPad && a.min === b.min && a.max === b.max
    }
    return false
  }

  return (
    <div>
      <PageHead
        title="输出预算"
        desc="每个 AI 调用点各自能生成多少内容。数值越大越不容易被截断，但耗时与费用也越高。思考类模型的推理过程也占预算，所以留有余量。"
      />

      <div
        className="card p-3.5 flex items-start gap-2.5 text-[12px] leading-relaxed mb-4"
        style={{ color: 'var(--text-faint)' }}
      >
        <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--warn)' }} />
        <span>
          「按字数」类预算是一个公式：<b>目标字数 × 每字倍数 + 思考余量</b>，再夹到下限与上限之间。
          调小「每字倍数」或「思考余量」可能让推理模型把预算全花在思考上，正文变成空的。
        </span>
      </div>

      {GROUPS.map((group) => (
        <div key={group.title} className="card px-4 py-3 mb-3">
          <div className="text-[12.5px] font-medium mb-1">{group.title}</div>
          {group.note ? (
            <div className="text-[11.5px] mb-2" style={{ color: 'var(--warn)' }}>
              {group.note}
            </div>
          ) : null}
          {group.rows.map((row, i) => {
            const b = budgets[row.key]
            return (
              <div
                key={row.key}
                className="py-2.5"
                style={i === 0 ? undefined : { borderTop: '1px solid var(--border)' }}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-[12.5px]">{row.label}</div>
                    <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                      {row.desc}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {b.kind === 'fixed' ? (
                      <label className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                        token
                        <input
                          type="number"
                          min={1}
                          max={32768}
                          value={b.tokens}
                          onChange={(e) =>
                            void save(row.key, { kind: 'fixed', tokens: num(e.target.value, b.tokens) })
                          }
                          className="input text-[12.5px]"
                          style={{ width: 88 }}
                        />
                      </label>
                    ) : (
                      <span className="text-[11px]" style={{ color: 'var(--accent)' }}>
                        按字数计算
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isDefault(row.key)}
                      onClick={() => void resetOne(row.key)}
                      title="恢复默认"
                    >
                      <RotateCcw size={13} />
                    </Button>
                  </div>
                </div>

                {b.kind === 'perWord' ? (
                  <div className="mt-2 flex items-center gap-3 flex-wrap">
                    <label className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                      每字倍数
                      <input
                        type="number"
                        step={0.1}
                        min={0.5}
                        max={8}
                        value={b.perWord}
                        onChange={(e) => void save(row.key, { ...b, perWord: num(e.target.value, b.perWord) })}
                        className="input text-[12.5px]"
                        style={{ width: 70 }}
                      />
                    </label>
                    <label className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                      思考余量
                      <input
                        type="number"
                        min={0}
                        max={16384}
                        value={b.thinkPad}
                        onChange={(e) => void save(row.key, { ...b, thinkPad: num(e.target.value, b.thinkPad) })}
                        className="input text-[12.5px]"
                        style={{ width: 78 }}
                      />
                    </label>
                    <label className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                      下限
                      <input
                        type="number"
                        min={1}
                        max={32768}
                        value={b.min}
                        onChange={(e) => void save(row.key, { ...b, min: num(e.target.value, b.min) })}
                        className="input text-[12.5px]"
                        style={{ width: 78 }}
                      />
                    </label>
                    <label className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                      上限
                      <input
                        type="number"
                        min={1}
                        max={32768}
                        value={b.max}
                        onChange={(e) => void save(row.key, { ...b, max: num(e.target.value, b.max) })}
                        className="input text-[12.5px]"
                        style={{ width: 78 }}
                      />
                    </label>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ))}

      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => void resetAll()}>
          全部恢复默认
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 注册 tab**

`src/renderer/pages/Settings/index.tsx`：

第 2 行图标 import 增加 `Gauge`：

```ts
import { Database, Gauge, Info, ListChecks, Palette, PenLine, Plug } from 'lucide-react'
```

import 区增加：

```ts
import { BudgetsSection } from './BudgetsSection'
```

`SectionId` 类型增加 `'budgets'`：

```ts
type SectionId = 'channels' | 'tasks' | 'budgets' | 'appearance' | 'prefs' | 'data' | 'about'
```

`NAV` 数组在「任务分配」后插入一项：

```ts
  { id: 'budgets', label: '输出预算', icon: Gauge },
```

渲染区在 `tasks` 分支后插入：

```tsx
          {active === 'budgets' && <BudgetsSection />}
```

- [ ] **Step 3: typecheck 并构建**

Run: `npm run typecheck && npm run build`
Expected: 均无错误。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/pages/Settings/BudgetsSection.tsx src/renderer/pages/Settings/index.tsx
git commit -m "feat(budget): 新增「输出预算」设置页"
```

---

### Task 6: 端到端验证与回归

**Files:**
- Test: `scripts/test-budgets.mjs`、`scripts/test-config-merge.mjs`（复用，不改）
- Verify: 运行中的应用

**Interfaces:**
- Consumes: Task 1–5 全部产出。
- Produces: 无代码产出，只确认既有行为未回退。

- [ ] **Step 1: 跑全部预算相关测试**

```bash
node scripts/test-budgets.mjs && node scripts/test-config-merge.mjs
```

Expected: 两个脚本末行都是 `N 通过, 0 失败`。

- [ ] **Step 2: 跑既有回归测试确认没波及**

```bash
npm run typecheck && npm run test:quickstart
```

Expected: typecheck 无错；quickstart 测试按脚本自身约定输出结果。

- [ ] **Step 3: 手动验证请求体带的是配置值**

启动 `npm run dev`，进「设置 → 输出预算」，把「章节摘要（体检用）」从 700 改成 1234，然后：

1. 在应用内打开「体检 → 全书体检」；
2. 观察主进程控制台打印的请求体，确认 `max_tokens: 1234`；
3. 回到设置页点该行「恢复默认」，确认变回 700。

再验证动态项：把「正文生成」的「每字倍数」从 2.2 改成 1.0，生成一章 2000 字的正文，确认请求体 `max_tokens` 从 `2000*2.2+1024=5424` 变为 `2000*1.0+1024=3024`。

- [ ] **Step 4: 验证老配置迁移**

1. 备份当前 `config.json`（`app.getPath('userData')` 下）；
2. 手动删掉其中 `settings.tokenBudgets` 字段；
3. 重启应用，确认设置页「输出预算」显示的都是默认值，且旧的项目、渠道、模型分配都还在。

- [ ] **Step 5: 提交测试脚本（若有改动）**

```bash
git add -A && git commit -m "test(budget): 补充输出预算端到端验证" || echo "无改动"
```

---

## 附：23 个预算键与调用点对照

| # | BudgetKey | 类型 | 默认值 | 调用点 |
| --- | --- | --- | --- | --- |
| 1 | `draft.generate` | perWord | 2.2/1024/2048/16000 | `generate.ts:62` |
| 2 | `draft.continue` | perWord | 同上 | `generate.ts:92` |
| 3 | `draft.selection` | perWord | 同上 | `generate.ts:115` |
| 4 | `outline.generate` | perWord | 同上 | `GenOutlineModal.tsx:85` |
| 5 | `outline.chapterBrief` | perWord | 同上 | `ChapterBriefModal.tsx:61` |
| 6 | `bible.entry` | perWord | 同上 | `BibleAiModal.tsx:100`（人物） |
| 7 | `bible.entryShort` | perWord | 同上 | `BibleAiModal.tsx:100`（其他） |
| 8 | `quickstart.firstChapter` | perWord | 同上 | `QuickStart.tsx:359` |
| 9 | `summary.auto` | fixed | 600 | `generate.ts:132` |
| 10 | `summary.audit` | fixed | 700 | `AuditTab.tsx:339` |
| 11 | `audit.book` | fixed | 2600 | `AuditTab.tsx:379` |
| 12 | `audit.chapter` | fixed | 2200 | `AuditTab.tsx:447` |
| 13 | `audit.thread` | fixed | 2000 | `AuditTab.tsx:508` |
| 14 | `margin.notes` | fixed | 1500 | `MarginNotes.tsx:59` |
| 15 | `naming.ideas` | fixed | 900 | `IdeasTab.tsx:47` |
| 16 | `style.traits` | fixed | 700 | `StyleEditorModal.tsx:136` |
| 17 | `style.trial` | fixed | 600 | `TrialCompare.tsx:155` |
| 18 | `chat.reply` | fixed | 3000 | `generate.ts:158` |
| 19 | `custom.default` | fixed | 3000 | `generate.ts:177` |
| 20 | `quickstart.title` | fixed | 1200 | `QuickStart.tsx:329` |
| 21 | `quickstart.settings` | fixed | 6000 | `QuickStart.tsx:333` |
| 22 | `quickstart.volumes` | fixed | 3000 | `QuickStart.tsx:338` |
| 23 | `quickstart.chapters` | fixed | 6000 | `QuickStart.tsx:343` |

`registry.ts:233` 的 `maxTokens: 8` 按设计**不纳入**。