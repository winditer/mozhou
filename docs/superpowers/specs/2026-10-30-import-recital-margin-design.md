# 书稿导入、AI 评书与旁批重设计

日期：2026-10-30
版本：1.7.0
状态：设计已评审（用户已确认两个产品选择）

## 背景

三条用户反馈，指向三个缺口：

1. **书稿只能「追加进当前书」**。写作页导出菜单里的「导入 TXT / Markdown」只按正则切章、直接追加到当前作品；没有「导入到书架」这条入口，也不识别书名、作者、题材、一句话简介、故事梗概，更不会生成大纲。拿到一部成稿的人，只能先新建一本空书、再导入、再手动补全书信息。
2. **没有评书能力**。作者想要一个「说书人」视角：把已经写好的章节改写成评书体（定场诗、扣子、且听下回分解），并能直接听。
3. **段落侧批不自洽**。现状（`audit/MarginNotes.tsx`）没有范围选择：它拿 `currentChapterId`（缺省是 `chapters[0]`）直接批，界面上只写「第 N 段」，不写章名，不能跳转；结果只存在组件 state，切走即丢；和「章节体检」挤在同一个页面里，像体检的附赠品而不是一个功能。

## 目标与非目标

### 目标

- 书架有「导入书稿」：选一个 TXT/Markdown 文件 → 本地解析 → AI 识别元信息与章节摘要 → 预览可改 → 创建作品并自动生成大纲。
- 没有配置模型也能导入（本地结果），AI 只是增强；AI 失败要说清楚哪一步失败，不阻塞导入。
- 「评书」成为写作台的一级页签：选范围、选风格、生成评书稿、系统语音朗读、导出文稿；评书稿按章持久化。
- 「段落侧批」重做成两处：体检页是**批量工作台**（本章 / 指定章节 / 全书，按章分组、可停止、结果持久化）；写作页右侧是**旁批栏**（当前章、点击跳到段落、标记已处理）。
- 旧作品读盘不报错：新字段由 `normalizeProject` 补默认值。

### 非目标

- 不做 DOCX/EPUB/PDF 导入（需要新依赖；本期只收 TXT/Markdown）。
- 不接入外部 TTS 服务、不产出音频文件（用户已选「系统语音 + 评书稿」）。
- 不做「评书稿自动分段成音频并导出」。
- 不做评书多人对播、背景音效。
- 不改写正文：评书稿是独立文稿，绝不回写章节正文；旁批同样只批注不改稿。

## 全局约束

- `src/shared/**` 是纯 TS：不许 import electron / react / node 内置模块。
- 注释与界面文案一律中文；注释写「为什么」，不写「做了什么」。
- 不新增 npm 依赖。
- 每个任务结束 `npm run typecheck` 必须干净。
- 纯逻辑测试放在 `scripts/test-*.mjs`，用 esbuild 把真实实现打包成 ESM 后直接 import（照 `scripts/test-quickstart.mjs` 的写法）。
- 新增数据字段必须同时改：`src/shared/types.ts`、`src/shared/factory.ts` 的 `createBlankProject`、`src/main/storage/projects.ts` 的 `normalizeProject`。
- 兼容老书：`Project.marginNotes` / `Project.recitals` 读盘缺失时补 `{}`，不许抛错。

## 数据模型（Lead 先落地，其他人直接使用）

```ts
export type MarginNoteKind = '删' | '改' | '慢' | '快' | '虚' | '偏'

export interface MarginNote {
  /** 段落序号，从 1 开始（按 stripHtml 后按空行切分） */
  paragraph: number
  kind: MarginNoteKind
  note: string
  /** 批注指向的原文片段，模型尽量给；用于跳转与核对 */
  quote?: string
  /** 作者标记：已处理（列表默认仍显示，可筛「只看未处理」） */
  resolved?: boolean
}

export interface MarginNoteSet {
  at: number
  /** 生成这份结果的模型显示名 */
  model?: string
  /** 生成时这一章有多少段（正文改短后序号会错位） */
  paragraphs: number
  /** 生成时正文指纹（词数 + 首尾片段），用于提示「批注基于旧稿」 */
  fingerprint: string
  notes: MarginNote[]
}

export interface Recital {
  at: number
  /** 风格 id，见评书面板内的 RECITAL_STYLES */
  styleId: string
  /** 回目名（评书稿标题） */
  title: string
  /** 评书稿全文（纯文本，空行分段） */
  script: string
  model?: string
  /** 作者手改过：重新生成前要确认是否覆盖 */
  edited?: boolean
}
```

`Project` 新增两个必填字段：

```ts
marginNotes: Record<string, MarginNoteSet> // chapterId → 批注集，只存有结果的章
recitals: Record<string, Recital>          // chapterId → 评书稿
```

输出预算新增三个 key（`src/shared/budgets.ts` + 设置页 `BudgetsSection`）：

| key | 默认 | 用途 |
|---|---|---|
| `import.meta` | fixed(2200) | 导入时识别书名/作者/题材/简介/梗概/人物 |
| `import.chapters` | fixed(2400) | 导入时一批章节压成摘要 |
| `recital.script` | perWord() | 单章评书稿 |

`WorkspaceTab` 增加 `'recital'`。

## 一、导入到书架

### 入口

书架工具条新增按钮「导入书稿」（不要放进 `⋯` 菜单里，这是首次使用就要看到的能力）。点击 → `mz.io.importFile()`（复用现有 IPC，已支持 txt/md/markdown）→ 打开 `ImportBookWizard`。

### 向导四步

**第 1 步 · 本地解析（零成本、即时）**

- 书名候选：文件名去扩展名（`《书名》`/`书名`），若首行是 1–30 字的短行且不含正文标点，优先首行。
- 作者候选：首行/前 5 行里的 `作者[:：]xxx`、`著`。
- 切分：先按 **卷** 标记切（`第X卷` / `卷X` / `Volume X`），再按 **章** 标记切（复用并加强 `splitChapters` 的规则：`第X章/回/节`、`Chapter N`、Markdown `#`、`1. 标题`）。
- **修复现有缺陷**：`splitChapters` 把「第X卷」也当成一章；导入路径不能再这样，卷是分组，不是章节。
- 每章记录：标题、去序号后的显示名、正文纯文本、字数。
- 没有任何章节标记时：按空行每 ~3000 字切一块，标题「第 N 节」；在预览里明确提示「没识别到章节标记，已按字数切分，可在预览里改名」。

**第 2 步 · AI 识别（默认勾选，可取消）**

- 元信息调用（1 次）：从正文里均匀抽样（开头 2 章 + 每 N 章取 800 字，总量 ≤ 12000 字），输出 JSON：
  ```json
  {"title":"...","author":"...","genre":"悬疑","logline":"一句话","premise":"300-600字故事梗概","keywords":["..."],"characters":[{"name":"","role":"主角/配角","desc":"一句话"}]}
  ```
- 题材必须落到 16 个内置 id 之一（按中文名映射，不认识的留空，不许瞎猜一个）。
- 章节摘要调用（每批 ≤ 8 章或 ≤ 7000 字输入）：输入「章序号 + 章标题 + 该章前 1200 字」，输出 `[{"index":1,"summary":"40-80字"}]`。用于 `chapter.summary` 与大纲节点 `summary`。
- 分卷：优先用本地卷标记；没有卷标记且章节数 ≥ 6 时，允许一次调用让模型按情节分卷（可省略：失败就归入「第一卷」）。
- 成本与进度可见：显示「将调用 N 次 · 输入约 X 字」，逐批显示进度；每批失败重试 1 次，仍失败则保留本地结果并列出哪几章没有摘要。
- 流式输出不算正文，界面显示「已收到 N 字」即可。

**第 3 步 · 预览与修正（必须可编辑）**

- 书名、作者、题材（16 题材下拉）、一句话简介、故事梗概（Textarea）。
- 章节清单：序号、标题（可改）、字数、摘要（可改，折叠）；可取消勾选「不导入」的章。
- 大纲预览：卷 → 章两级，显示「3 卷 28 章」；可取消勾选「生成大纲」。
- 顶部统计：章数、总字数、将创建的作品。

**第 4 步 · 导入**

- `createBlankProject` 建底 → 覆盖 title/author/genreId/brief/sceneId（默认 `long-novel`，若场景 id 不存在回退 `free`）→ 写入章节与大纲 → `mz.project.create` → 打开作品。
- 章节：`status: 'done'`（有正文）、`words`、`summary`、`outlineNodeId`。
- 大纲：`volume` 节点 → `chapter` 节点；章节点 `status: 'done'`；`summary` 用章节摘要。
- 成功 toast：「已导入《书名》· 28 章 · 43.2 万字」，并直接进入写作台第一章。

### 装配规则（纯函数，必须可测）

- 卷的连续性：卷标记之前的章节归入「第一卷」；两个卷标记之间的章节归当前卷。
- 章节与大纲节点一一对应，id 用 `uid('o')`；`chapter.outlineNodeId` 必须指向本节点的 id（不许靠标题兜底）。
- 空章（正文为空白）不导入。
- 标题去重：同卷内同名章节追加序号，避免大纲里两个同名节点。
- 书名为空 → 「未命名作品」；作者空 → `''`。

## 二、AI 评书

### 入口与形态

写作台新增一级页签「评书」（rail 在「文风」之后）。页面 `RecitalTab`：

- **范围**：`本章` / `指定章节`（多选）/ `全书`（逐章串行）。
- **风格**：内置 5 种（id + 名称 + 一句说明）：
  - `classic` 单田芳式：沙哑苍劲、短句多、爱用「话说」「且说」
  - `beijing` 老北京说书：京腔口语、夹叙夹议、俏皮
  - `fast` 快节奏评书：两句一个转折，少描写多动作
  - `suspense` 悬疑夜场：压低嗓子、慢、专在关键处停
  - `kids` 少儿故事：句子短、解释多、不用生僻词
- **时长**：1 / 3 / 5 分钟（按每分钟约 260 字折算目标字数：260 / 780 / 1300）。
- 按钮：`生成评书稿` / `停止`；进度显示「第 2/5 章 · 已收到 320 字」。
- 结果区：回目名 + 评书稿（可编辑 Textarea，改动即落盘 `recitals[chapterId]` 并置 `edited: true`）+ 播放器 + 导出。

### 评书稿格式（模型输出契约）

```
【回目】第七回 灰线尽头
【定场诗】一张图纸千条线，线线都通鬼门关。
【正文】
话说……
（正文口语化，短句，设扣子）
【收尾】欲知后事如何，且听下回分解。
```

解析器要容忍：没有 `【回目】` 时用章名；定场诗缺失不算失败；`【正文】` 缺失时把剩余文本全当正文；解析不出任何正文 → 明确报错「模型没给出评书稿」。

### 朗读（系统语音，零依赖）

- `window.speechSynthesis` + `SpeechSynthesisUtterance`；**不引入任何 TTS 依赖**。
- 文稿按句切分（句号/问号/感叹号/分号/换行；单句 > 100 字再按逗号切），顺序排队播报，按 utterance 边界高亮当前句。
- 控制：播放 / 暂停 / 继续 / 停止；语速 0.7–1.5；音色下拉（筛选 `voice.lang` 以 `zh` 开头，默认第一个中文音色）。
- 环境不支持（无 `speechSynthesis` 或音色列表为空）：显示「当前系统没有可用中文语音，可导出评书稿到别处朗读」，播放器置灰，不报错。
- 切章 / 离开页面 / 重新生成时必须 `speechSynthesis.cancel()`，不许后台继续念。
- 隐藏的坑：Chrome/Electron 的 `getVoices()` 初始可能为空，要监听 `voiceschanged` 重新取；暂停在部分系统上无效，用 `pause()` 后若 `speaking === false` 则退回「停止并从当前句重播」。

### 持久化与导出

- 每章生成成功立即 `patchProject` 写入 `recitals[chapter.id]`（批量生成时逐章写，中途停止已完成的保留）。
- 导出：`mz.io.exportFile` 复用 Markdown/TXT 通道；默认文件名 `《书名》评书稿.md`。多章导出拼成一份，每章一个二级标题。
- 重新生成已存在且 `edited` 的稿子：弹确认「这份稿子你改过，重新生成会覆盖」。

## 三、段落侧批重设计

### 现状问题（逐条对应修法）

| 问题 | 修法 |
|---|---|
| 不让你选范围，默认拿 `chapters[0]` 就批 | 显式范围选择器：本章 / 指定章节 / 全书 |
| 界面上只有「第 N 段」，看不出哪一章 | 每条批注带章名与章节序号；结果按章分组 |
| 结果只在内存，切走即丢 | 存进 `project.marginNotes[chapterId]`，跨会话可见 |
| 不能跳到正文 | 点批注：切到该章、滚到该段、选中该段并高亮 |
| 和章节体检混在一起，像附赠品 | 体检页做批量工作台；写作页加独立「旁批」栏 |

### A. 体检页 › 段落侧批（批量工作台）

- **范围选择器**（Segmented）：
  - `本章`：下拉选章，默认当前打开的章；没有打开章时明确提示「先选一章」。
  - `指定章节`：章节多选列表（全选/全不选/反选），显示已选 N 章 / 共 M 章、合计字数。
  - `全书`：全部有正文的章；0 字的章自动跳过并说明。
- **任务摘要**：「将批注 N 章 · 合计 X 字 · 预计 N 次调用」+ 已有批注的章数（「其中 3 章已有批注，重跑会覆盖」）。
- **运行**：逐章串行；进度条 `已完成/总数` + 当前章名 + 已收到字数；`停止` 按钮（正在跑的这一次 abort，已完成的保留并落盘）。
- **失败处理**：单章失败记一条错误（章名 + 原因），继续下一章；结束后汇总「3 章成功 / 1 章失败」并列出失败原因。除「没有配置模型」外，任何失败都不许静默。
- **结果**：按章分组（折叠），组头「03 第 3 章 灰线 · 4 条 · 10-30 14:22 · 模型名」；每条：`kind` 徽标 + 段落序号 + 批注 + 原文摘录（可展开）+ 操作：`跳到正文` / `标记已处理` / `删除`。
- **筛选**：全部 / 未处理 / 已处理；按 kind 过滤；「清空全部批注」二次确认。
- **空态**：没批注时说清「选范围 → 开始批注」；批完为 0 条时说「这一批没挑出毛病」。

### B. 写作页右侧「旁批」栏

- 工具栏新增 `旁批 N` 按钮（N = 当前章批注数），与「搜索」「校读」互斥，宽 320px。
- 顶部：章名 + 「N 条 · 生成于 10-30 14:22 · 模型」+ 操作：`重新批注本章` / `清空本章`。
- 列表：按段落序号升序；每条高亮当前跳转目标；点击 → `editor.chain().focus().setTextSelection(段落起止).scrollIntoView().run()`。
- 正文改动检测：与 `MarginNoteSet.fingerprint` 比对，不一致时顶部黄条提示「正文改过，批注的段落可能对不上；建议重新批注本章」，并提供按钮。
- 本章没有批注：说明 + `批注这一章` 按钮（直接跑单章，不需要离开写作页）。
- 标记已处理、删除都要同步 `patchProject`，不许只改本地 state。

### C. 共享逻辑（纯函数）

`src/renderer/pages/Workspace/audit/margin.ts` 扩展为唯一事实来源：

- `splitParagraphs(chapter)`：保持现有语义（`stripHtml` → 按空行切 → 去空），供正文跳转、批注序号、指纹共用。
- `paragraphRange(editor, index)`：段落序号 → ProseMirror 选区（跳转用）。
- `chapterFingerprint(chapter)`：`词数|前 30 字|后 30 字`。
- `buildMarginNoteMessages(project, chapter)`：提示词里必须写**章名与章序号**，要求每条带 `quote`（原文里连续 6–30 字），最多 6 条。
- `parseMarginNotes(raw, paragraphCount)`：容错（代码围栏、前后废话、索引越界丢弃、同段去重、`quote` 在正文里找不到就置空而不是丢批注）。
- `mergeMarginSet(prev, next)`：保留作者已标记的 `resolved`（按段落 + 批注文本匹配）。
- `runMarginForChapters(...)`：串行执行器，注入 `generate` 函数便于测试；返回每章结果 / 失败原因，支持 `shouldStop()`。

### 跳转契约（Workspace 负责接线）

`AuditTab` 与 `MarginGutter` 需要从「体检页」或「旁批栏」跳到某一章的某一段：

- `useApp` 已有 `setActiveChapter` / `setTab`。
- 跳转 = `setTab('write')` → `setActiveChapter(chapterId)` → 等编辑器重建后按段落序号选中。
- 用一个一次性信号表达「等编辑器就绪后选中第 N 段」：在 `store/app.ts` 增加 `pendingReveal: { chapterId: string; paragraph: number } | null` + `setPendingReveal`，`Workspace` 在 `chapter` 与 `editorRef` 就绪时消费并清空。不要用 setTimeout 猜。

## 团队分工与写作用域

| 角色 | 负责 | 写作用域 |
|---|---|---|
| Lead | 共享类型/预算/store/Workspace 接线/集成/验收/版本与 README | `src/shared/**`、`src/main/**`、`src/renderer/store/app.ts`、`src/renderer/pages/Workspace/index.tsx`、`src/renderer/components/ui.tsx`、`src/renderer/pages/Settings/BudgetsSection.tsx`、`README.md`、`package.json` |
| A 导入 | 书稿解析、向导、书架入口、测试 | `src/renderer/pages/Bookshelf/**`、`scripts/test-import-book.mjs` |
| B 评书 | 评书页签、提示词、解析、朗读、导出、测试 | `src/renderer/pages/Workspace/recital/**`、`scripts/test-recital.mjs` |
| C 旁批 | 旁批工作台、旁批栏、共享批注逻辑、测试 | `src/renderer/pages/Workspace/audit/**`、`src/renderer/pages/Workspace/AuditTab.tsx`、`scripts/test-margin-notes.mjs` |

Lead 先落地共享层（类型/预算/store/Workspace 骨架 + 两个占位组件），再并行开三条线；任何跨作用域改动先找 Lead。

## 验收

1. `npm run typecheck` 干净。
2. `node scripts/test-import-book.mjs`：书名/作者识别、卷章切分、无标记降级、元信息解析容错、装配出的 Project 字段与大纲层级正确。
3. `node scripts/test-recital.mjs`：评书稿解析容错、目标字数换算、风格提示词包含正确约束、TTS 切句（长句/无标点/空稿）。
4. `node scripts/test-margin-notes.mjs`：段落切分与指纹、批注解析容错、已处理合并、批量执行器的成功/失败/停止。
5. `npm run build` 通过。
6. 人工冒烟（截图）：书架导入一本测试稿、生成一章评书并播放、体检页批注全书、写作页旁批跳段。