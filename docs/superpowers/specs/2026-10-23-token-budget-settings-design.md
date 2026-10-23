# 输出预算（maxTokens）配置化设计

日期：2026-10-23
状态：待评审

## 背景

`maxTokens` 目前有 23 处硬编码，散落在 11 个文件里。它们在传输链路上只是原样透传（只换字段名：OpenAI `max_tokens` / `max_completion_tokens`、Anthropic `max_tokens`、Gemini `maxOutputTokens`），但取值分两类：

- **动态**：8 处用 `tokensForWords(目标字数)` 按目标字数反推；
- **固定**：15 处写死常数（600 / 700 / 900 / 1500 / 2000 / 2200 / 2600 / 3000 …）。

动态项比源码里的 `tokensForWords` 调用点只多一个：`bible.entry` / `bible.entryShort` 同出自 `BibleAiModal.tsx:100` 的一个三元表达式，配置化后拆成两个独立键。

问题有两个：

1. 用户无法针对自己用的模型调整预算。推理类模型的思考过程也计入 `max_tokens`，预算偏紧时正文为空或半截——这是历史上「一键开书解析失败」的根因。
2. 同一任务下的不同调用点值并不一致，且这种不一致不可见。例如章节摘要：`generateSummary` 用 600，体检流程 `AuditTab` 用 700，提示词完全相同、温度相同。

## 目标

把 23 个硬编码预算全部变成设置项，为每一个调用点单独设置。

## 非目标

- 不改变鉴权、重试、流式解析等传输逻辑。
- 不为「渠道连通性测试」的 `maxTokens: 8` 提供配置。它是探测用的极限值，调大即失去意义，保持硬编码。
- 不引入「任务级默认值 + 调用点覆盖」的两级继承模型（见方案对比）。

## 决策记录

| 议题 | 决策 |
| --- | --- |
| 粒度 | 按调用点，23 个独立配置项 |
| 动态项表达 | 公式参数全暴露（字数倍数 / 思考余量 / 下限 / 上限） |
| 默认值 | 逐一沿用当前硬编码值，零行为变化 |
| 连通性测试 8 | 排除，保持硬编码 |
| 设置页位置 | 新增独立 tab |

## 方案

### 数据模型

新增独立的键空间 `BudgetKey`，与现有 `TaskKind` 正交。不复用 `TaskKind`，因为同一 `TaskKind` 下存在多个调用点且取值不同，按 `TaskKind` 无法承载所需粒度。

```ts
export type BudgetKey =
  // 动态项（按目标字数反推）
  | 'draft.generate'      // 正文生成
  | 'draft.continue'      // 长度守护补写
  | 'draft.selection'     // 选中段落润色
  | 'outline.generate'    // 大纲推演
  | 'outline.chapterBrief'// 章节简介
  | 'bible.entry'         // 设定卡（人物）
  | 'bible.entryShort'    // 设定卡（其他）
  | 'quickstart.firstChapter'
  // 固定项
  | 'summary.auto' | 'summary.audit'
  | 'audit.book' | 'audit.chapter' | 'audit.thread'
  | 'margin.notes'
  | 'naming.ideas'
  | 'style.traits' | 'style.trial'
  | 'chat.reply'
  | 'custom.default'
  | 'quickstart.title' | 'quickstart.settings'
  | 'quickstart.volumes' | 'quickstart.chapters'

export interface FixedBudget {
  kind: 'fixed'
  tokens: number
}

export interface PerWordBudget {
  kind: 'perWord'
  /** 每字预算倍数 */
  perWord: number
  /** 思考余量，额外加给模型的推理过程 */
  thinkPad: number
  /** 下限 */
  min: number
  /** 上限 */
  max: number
}

export type TokenBudget = FixedBudget | PerWordBudget
export type TokenBudgets = Record<BudgetKey, TokenBudget>

// AppSettings 新增字段
interface AppSettings {
  // ...
  tokenBudgets: TokenBudgets
}
```

### 解析函数

纯函数，放 `src/shared/` 以便主进程与渲染进程共用，且可单测：

```ts
export function resolveBudget(budgets: TokenBudgets, key: BudgetKey, targetWords?: number): number
```

- `fixed` → `clamp(budget.tokens, 1, 32768)`
- `perWord` → `clamp(round(targetWords * perWord) + thinkPad, min, max)`
- `perWord` 但 `targetWords` 缺失 → 以 `min` 兜底

`tokensForWords` 保留为薄封装，内部用当前默认参数构造 `perWord` 预算，保证既有调用点不传设置时行为不变。

注意区分两种下限，实现时不要合并：

- **字数下限**：`draft.continue` 的 `max(400, …)` 和 `draft.selection` 的 `max(300, …)` 是算 `targetWords` **之前**对字数的兜底，属于调用点的取值逻辑，保留在原处不动。
- **token 下限**：`perWord` 预算的 `min`（默认 2048），作用在乘完倍数、加完思考余量**之后**。

即 `resolveBudget(budgets, 'draft.continue', max(400, 目标 − 已完成))`。

### 默认值

`DEFAULT_SETTINGS.tokenBudgets` 逐一照抄当前值，零行为变化：

| Key | 当前值 | 默认类型 |
| --- | --- | --- |
| `draft.generate` | `tokensForWords(targetWords)` | perWord: 2.2 / 1024 / 2048 / 16000 |
| `draft.continue` | `tokensForWords(max(400, 目标−已完成))` | perWord: 同上 |
| `draft.selection` | `tokensForWords(max(300, 选中×2))` | perWord: 同上 |
| `outline.generate` | `tokensForWords(3200)` | perWord: 同上 |
| `outline.chapterBrief` | `tokensForWords(420)` | perWord: 同上 |
| `bible.entry` | `tokensForWords(900)` | perWord: 同上 |
| `bible.entryShort` | `tokensForWords(800)` | perWord: 同上 |
| `quickstart.firstChapter` | `tokensForWords(perChapter)` | perWord: 同上 |
| `summary.auto` | 600 | fixed |
| `summary.audit` | 700 | fixed |
| `audit.book` | 2600 | fixed |
| `audit.chapter` | 2200 | fixed |
| `audit.thread` | 2000 | fixed |
| `margin.notes` | 1500 | fixed |
| `naming.ideas` | 900 | fixed |
| `style.traits` | 700 | fixed |
| `style.trial` | 600 | fixed |
| `chat.reply` | 3000 | fixed |
| `custom.default` | 3000 | fixed |
| `quickstart.title` | 1200 | fixed |
| `quickstart.settings` | 6000 | fixed |
| `quickstart.volumes` | 3000 | fixed |
| `quickstart.chapters` | 6000 | fixed |

`summary.auto`（600）与 `summary.audit`（700）保持各自独立默认值。配置化后它们会在设置页并排显示，使这处不一致变得可见，由用户决定是否统一。

### 持久化与迁移

- [config.ts](../../../src/main/storage/config.ts) 的 `DEFAULT_SETTINGS` 增加 `tokenBudgets`。
- `loadConfig` 的合并逻辑增加一层 `tokenBudgets: { ...DEFAULT.tokenBudgets, ...(raw.settings?.tokenBudgets ?? {}) }`，老配置自动补齐缺失键。
- 不做 `version` 升级：缺失键由深合并补齐，且新旧结构互不冲突。

### 校验

主进程加载与保存时 `clamp`：

- `fixed.tokens`：`1..32768` 整数；
- `perWord.perWord`：`0.5..8`；
- `perWord.thinkPad`：`0..16384`；
- `perWord.min` / `perWord.max`：整数且 `min ≤ max`，两者均 `1..32768`。

非法值回落默认，而不是让请求带上 0 或负数。

### 设置 UI

新增 `BudgetsSection.tsx` 与独立 tab「输出预算」（[index.tsx](../../../src/renderer/pages/Settings/index.tsx) 的 `NAV` / `SectionId` 增加一项）。

- 按功能分组：写作 / 大纲与设定 / 开书 / 摘要 / 体检 / 其他。
- 固定项：数字输入框，附粗略估算提示（如「≈ 450 汉字」）。
- 动态项：四个参数（倍数 / 思考余量 / 下限 / 上限）同行展示。
- 每项标注来源文件与行为描述，便于用户判断该不该动。
- 「恢复默认」按钮，按组和全局两档。

### 调用点改造

11 个文件、23 处，逐一替换为 `resolveBudget(budgets, BUDGET_KEYS.x, targetWords)`：

- `src/renderer/lib/generate.ts`（共 6 处：62、92、115、132、158、177）
- `src/renderer/lib/prompt.ts`（`tokensForWords` 改造）
- `src/renderer/pages/Bookshelf/QuickStart.tsx`（`STEP_TOKENS` → 预算键）
- `src/renderer/pages/Workspace/AuditTab.tsx`（339、379、447、508）
- `src/renderer/pages/Workspace/IdeasTab.tsx`（47）
- `src/renderer/pages/Workspace/outline/GenOutlineModal.tsx`（85）
- `src/renderer/pages/Workspace/outline/ChapterBriefModal.tsx`（61）
- `src/renderer/pages/Workspace/bible/BibleAiModal.tsx`（100）
- `src/renderer/pages/Workspace/audit/MarginNotes.tsx`（59）
- `src/renderer/pages/Workspace/style/StyleEditorModal.tsx`（136）
- `src/renderer/pages/Workspace/style/TrialCompare.tsx`（155）

渲染进程取值路径：`useApp.getState().config.settings.tokenBudgets`。

## 测试

1. **单元**：`resolveBudget` 的 fixed / perWord / clamp / 缺 `targetWords` 兜底 / 非法值回落，共 6 类用例。放在现有 `scripts/test-*.mjs` 风格下。
2. **回归**：`npm run typecheck` 通过；`npm run test:quickstart` 通过。
3. **默认值等价性**：断言 `DEFAULT_SETTINGS.tokenBudgets` 经 `resolveBudget` 求值后等于改造前各处硬编码值（尤其 `tokensForWords` 那 7 项的边界：字数 0、400、3200、超大字数触顶）。
4. **手动**：设置页改一项 → 触发对应功能 → 确认请求体里 `max_tokens` 是新值；点恢复默认 → 回到原值。

## 风险

- **23 个配置项对用户偏多**：靠分组与说明文字缓解；默认值不变，不改也能用。
- **动态项参数被改坏**：`perWord` 太小或 `thinkPad` 为 0 会重现「正文为空」。校验仅保底线，设置页对偏小值给警告提示，但不阻断保存。
- **`out/` 是构建产物**：改动只在 `src/`，需重新构建才对运行中的 GUI 生效。

## 未决

无。