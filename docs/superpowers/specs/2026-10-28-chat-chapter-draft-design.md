# 对话建章与写稿（Chat Chapter Authoring）设计

日期：2026-10-28
版本：1.5.0
状态：设计已评审

## 背景

1.4.x 让对话能改稿（mz-edit）：改段落、批量替换、改梗概、改大纲、改设定。1.4.1 补了
`add_outline_node`，但**大纲有节点 ≠ 书里有章**。作者实际说出的下一步是：

> 补 29、30 的大纲，并生成第 30 章，为作品收尾

`add_outline_node` 只能补计划。要变成真的一章，得让作者离开对话、去左侧章节列表点「+」、
再把大纲节点内容抄成标题、再点续写。这条链子断在对话里，作者就得手动接上。

本设计让对话能把「计划」推成「正文」：**建真实章节**，并且**当场写初稿**。

## 目标与非目标

### 目标

1. 对话里能新建真实章节（`Chapter`），标题/梗概/目标字数一次说清。
2. 建章时**一并补大纲节点**，两边标题与情节点一致，章节的 `outlineNodeId` 直接指向新节点。
3. 作者确认后，能**当场写初稿**：按目标字数整章生成、自动补写、流式可见、可停止。
4. 对**已存在的空章**也能触发写初稿（作者常说「开始写第 30 章」）。
5. 失败/中断不吞稿：已写的部分留着，说清楚怎么接着写。

### 非目标

- 不让模型在对话回答里直接吐整章正文（2500 字在 12000 的对话预算里必被截断，且气泡里读长文体验差）。
- 不做自动建卷（`add_outline_node` 的 `parent` 已够用）。
- 不做「写稿失败自动整章重试」（留半成品比反复重写可控；补写逻辑本身已在 `generateDraft` 里）。
- 不重排章节标题编号：插在第 5 章后不会把「第 6 章」改成「第 7 章」。

## 协议：两个新 op

```json
{"op":"create_chapter","title":"第30章 027","summary":"陈屿追编号，要一张纸","targetWords":2500,"draft":true}
{"op":"write_chapter","chapter":"第30章 027"}
```

### create_chapter

| 字段 | 必填 | 语义 |
|---|---|---|
| `title` | 是 | 章节标题。与书里已有章节或大纲节点**重名则整条作废**并说明 |
| `summary` | 否 | 章梗概，同时写入大纲节点的情节点 |
| `targetWords` | 否 | 目标字数，缺省取 `settings.targetWordsPerChapter`（2500） |
| `draft` | 否 | **应用后是否当场写初稿**，默认 `false`。「补大纲」为 false，「建章并写出来」为 true |
| `after` | 否 | 插到该章节之后；省略则追加书尾 |
| `parent` | 否 | 大纲节点挂到哪个卷；省略则挂最后一卷 |

一条 `create_chapter` 在预览里展开成**两条**改动：

1. `新增大纲节点「第30章 027」· 挂在 第二卷`（`display: 'new-entry'`）
2. `新增章节「第30章 027」· 目标 2500 字`（`display: 'new-entry'`，带 `draftTarget`）

两条可以分别勾选——作者只想补大纲不建章时，取消第二条即可。

### write_chapter

给**已存在**的章触发一次生成：正文为空 → 「写初稿」；已有正文 → 「接着写」（与工具栏续写同一套逻辑，
`generateDraft` 会按整章差额补写）。章引用支持 id / 完整标题 / 「第30章」；找不到或有歧义 → 作废并列出相近章名。

## 数据流

```
用户：「建第 30 章并写出来」
  ↓
generateChatReply（一次对话调用，system 里带 mz-edit 协议）
  ↓ mz-edit 块
parseEditBlock → ops（含 create_chapter draft:true）
  ↓ 存进消息，不落盘
点「查看并应用」→ resolveEdits(project, ops)
  ↓ 展开成 大纲节点行 + 章节行（章节行带 chapterDraft）
作者勾选确认 → onApply(kept)
  ↓
applyEditBatch(kept)          ← 纯函数部分：建大纲节点 + 建章节，一次 patchProject、一份快照
  ↓
collectDraftJobs(kept, project)  ← 按标题回查新建章的 id，得到待写清单
  ↓
逐章串行 runDraftJob(job)      ← 第二次模型调用，generateDraft（draft 预算 + 自动补写 + 流式）
  ↓ 每 ~500ms patchChapter(content)
页面上看着它长；结束后面板标「已写入 N 字」
```

**为什么写稿不放进 `applyResolved`**：`applyResolved` 是纯函数、要能在 node 里跑几百个用例。
写稿是一次几分钟、会失败、要取消的模型调用——塞进去，纯函数层就有了副作用，测试和取消都没法做。
所以建章走应用层，写稿走应用后的显式任务。

### 待写清单怎么拿到

`applyResolved` 的返回值仍是 `Project`（签名不变）。新建章在预览数据里带
`draftTarget: { title, targetWords }`；应用后用 `title` 在最新 `project.chapters` 里回查 id。
标题在建章时已去重（唯一），所以回查是准的。

## 写稿任务

新模块 `src/renderer/lib/draftJobs.ts`：

```ts
export interface DraftJob {
  chapterId: string
  title: string
  targetWords: number
  /** write_chapter 命中已有正文的章：按整章差额续写，而不是从头写 */
  continueOnly: boolean
}

export interface DraftDeps {
  channel: Channel
  model: string
  task: TaskKind
  temperature: number
  budgets: TokenBudgets
  library: StyleLibrary | null
  skillLibrary: SkillLibrary | null
  conventions: GenreConventionOverrides | undefined
  /** 取当前 project：写稿期间章节内容在变，不能闭包捕获一次 */
  getProject: () => Project | null
  patch: (chapterId: string, patch: Partial<Chapter>) => void
  onProgress: (p: { chapterId: string; title: string; written: number; target: number }) => void
  onStage: (stage: string) => void
}

runDraftJobs(jobs: DraftJob[], deps: DraftDeps): Promise<{ ok: number; failed: number; stopped: boolean }>
```

`deps` 由调用方（AIPanel）从 store 现取——模型、文风库、技法卡、预算都在 config 里，
写稿任务本身不碰 store，只通过 `patch` 与 `getProject` 与它交互，便于单测替身。

- **串行**执行，一章一次 `generateDraft`（`task: 'draft'`、`budgets: config.settings.tokenBudgets`、
  `targetWords`、`existingWords`）。复用现成的补写与截断处理。
- **流式落盘**：`onDelta` 累积到本地缓冲，每 500ms（或每新增 300 字）`patchChapter(id, { content })`，
  同时把 `activeChapterId` 切到该章、`tab` 切到 `write`，作者能看着正文长出来。
- **停止**：横幅上的「停止」调 `abortChat()`；当前章保留已写部分。
- **防手滑**：每次落盘前比对「这一章的 content 是否仍等于上次写入值」，不等说明作者自己动了笔 →
  立即停止并提示「你在这一章动手了，写稿已停」。
- **完成**：`words > 0` 时 status 由 `planning` 转 `draft`（沿用 `patchChapter` 现有规则），
  面板标「已写入 N 字」，`versions` 里有一份（空 → 成稿）快照可回退。
- **失败**：`error` 记进面板提示；章节与已写正文保留，状态「撰写中」；toast 提示
  「可以接着说『继续写第 30 章』」。

### 限额

一轮最多 **2 章**带写稿（`create_chapter draft:true` 与 `write_chapter` 合计计数）。超出的那条在
**定位层（`applyEdits`）**降级为「只建章」，并在预览行的 `note` 里注明「这一轮先建章，写稿下次再说」——
解析层（`editProtocol`）不掌握全书有多少章，判断不该放在那儿。

## 界面

- **预览行**：`新增章节「第30章 027」· 挂在 第二卷 · 目标 2500 字 · 应用后开始写初稿`；
  `为「第30章 027」写初稿 · 约 2500 字`（已应用则置灰）。
- **写作横幅**：面板顶部 `正在写第 30 章… 已写 1240 / 2500 字` + `停止`，与现有「撤销改稿」同一行区。
- **气泡**：提议时 `查看并应用 N 处修改`；写稿中 `写作中 1240/2500`；完成后 `已写入 2480 字`。
- **插中间时**：若 `after` 指定了位置，预览行加注「只改顺序，不重排后面章节的标题编号」。

## 测试

### 单元（`scripts/test-edit-protocol.mjs` / `scripts/test-apply-edits.mjs`）

- `create_chapter`：缺 title 拒收；`targetWords` 非数字拒收；`draft` 非布尔拒收。
- `write_chapter`：缺 chapter 拒收。
- 定位：标题重名 → not-found；`after` 指向不存在的章 → not-found；`parent` 卷不存在 → not-found；
  章引用有歧义 → ambiguous。
- 应用：`applyResolved` 后 `chapters` 多一章、`outline` 多一节、新章 `outlineNodeId` 指向新节点、
  `status: 'planning'`、`words: 0`、`versions: []`；原 `project` 未被就地修改；只勾大纲节点不建章时
  大纲多节点而章节数不变。

### 端到端（`scripts/e2e-chat-edit.cjs` 新增 `newchapter` 模式）

假网关两次调用（对话 1 次 + 写稿 1 次）：

1. 对话返回 `create_chapter draft:true`；
2. 预览出现「新增章节 + 新增大纲节点」两条，可应用数为 2；
3. 应用后：`chapters` 多一章、`outline` 多一节、新章 `content` 非空、`words > 0`、
   `activeChapterId` 已切到新章、编辑器里能看到新章正文、`versions` 有快照、气泡标「已写入」。

回归：`e2e:chat`（9 条）、`e2e:chatedit`（25 条）保持全绿。

## 风险

| 风险 | 处理 |
|---|---|
| 写稿期间作者在同一章打字，两边互相覆盖 | 落盘前比对上次写入值，变了就停 |
| 一次应用触发多章长跑 | 每轮最多 2 章，超出降级为只建章 |
| 初次落盘就把空章压成快照，作者回退后是空章 | 这是预期（空 → 成稿正是这次改动本身）；建章也可用 30 秒「撤销改稿」整批撤 |
| 模型把 `draft` 当成默认 true，导致「补大纲」也写稿 | 协议里明确默认 false，并在提示词规则里点明两者区别 |