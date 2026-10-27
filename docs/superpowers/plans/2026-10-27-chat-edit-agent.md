# 对话直接改稿（Chat Edit Agent）实施计划

> **For agentic workers:** 按任务顺序执行，每个任务自己带测试循环。设计见 `docs/superpowers/specs/2026-10-27-chat-edit-agent-design.md`。

**Goal:** 让右侧 AI 对话能提出精确、可校验、可预览、可回滚的作品改动，作者一次确认后落地。

**Architecture:** 模型输出受控的 `mz-edit` JSON 围栏 → `shared/editProtocol.ts` 解析校验 → `lib/applyEdits.ts` 用 anchor 回正文定位并产出改前/改后 → 新的 `ChatEditPreview` 汇总确认 → store 的 `applyEditBatch` 一次写入并按章压快照。全程不上 tool calling。

**Tech Stack:** Electron + React 19 + zustand + TypeScript；测试用 esbuild 打包纯 TS 后跑 node 断言；e2e 用现有 `scripts/shot.cjs` 驱动真 Electron + 假网关。

**版本：** 本次发布号 **1.4.0**（实施完成后统一升版）。

## Global Constraints

- `src/shared/*` 不许引 electron / react / node 内置模块。
- 不许静默失败：解析失败、定位失败、字段被丢弃都要在界面上说清。
- 定位不到 anchor 时**绝不**退化成整章重写。
- 正文改动必须走 `versions` 快照；结构化改动给 30 秒撤销。
- 单轮 op 上限 20。
- 每个新增行为都要有 `scripts/` 下的可复跑脚本。

---

### Task 1: 编辑协议与校验

**Files:**
- Create: `src/shared/editProtocol.ts`
- Test: `scripts/test-edit-protocol.mjs`

**Interfaces:**
- Produces: `EditOp`、`EditOpKind`、`BibleCollection`、`parseEditBlock(text): ParseResult`、`stripEditBlock(text)`、`renderEditPrompt(): string`、`resolveChapterRef(project, ref)`、`resolveOutlineNode(nodes, ref)`、`MAX_EDITS = 20`
  - `ParseResult = { text: string; ops: EditOp[]; errors: string[] }`

- [ ] 写 `scripts/test-edit-protocol.mjs`（先失败）
- [ ] `node scripts/test-edit-protocol.mjs` → 模块不存在
- [ ] 实现 `editProtocol.ts`
- [ ] 测试通过，commit

### Task 2: 定位与应用（纯函数）

**Files:**
- Create: `src/renderer/lib/applyEdits.ts`
- Test: `scripts/test-apply-edits.mjs`

**Interfaces:**
- Consumes: Task 1 的 `EditOp`、`resolveChapterRef`、`resolveOutlineNode`；`audit/apply.ts` 的 `splitParagraphs`
- Produces:
  - `type EditStatus = 'found' | 'ambiguous' | 'not-found'`
  - `interface ResolvedEdit { op: EditOp; status: EditStatus; chapterId?: string; chapterTitle?: string; before: string; after: string; paragraphIndex?: number; hits?: number[]; fieldLabel?: string; note?: string }`
  - `resolveEdits(project: Project, ops: EditOp[]): ResolvedEdit[]`
  - `applyResolved(project: Project, edits: ResolvedEdit[]): Project`（纯函数，只改 chapters/outline/bible/brief）

- [ ] 测试脚本（定位 4 种情况 + 应用结果 + 多章同时改）
- [ ] 实现
- [ ] 通过，commit

### Task 3: store 批量写入与会话状态

**Files:**
- Modify: `src/renderer/store/app.ts`（新增 `applyEditBatch` / `undoEditBatch` / `lastEditUndo`）
- Modify: `src/shared/types.ts`（`ChatMessage.edits` / `editsAppliedAt`；`AppSettings.allowChatEdits`）

**Interfaces:**
- Produces: `applyEditBatch(next: Project): void`、`undoLastEditBatch(): void`、`state.lastEditUndo`

- [ ] 实现（单次 `patchProject` + 每章 `pushSnapshot` + 30 秒撤销窗口）
- [ ] `npm run typecheck` 通过
- [ ] commit

### Task 4: 界面与提示词

**Files:**
- Create: `src/renderer/lib/diffText.ts`（从 `ApplyPreview.tsx` 抽出 `diffSpan`，原文件改为 import）
- Create: `src/renderer/components/ChatEditPreview.tsx`
- Modify: `src/renderer/components/AIPanel.tsx`（解析、气泡按钮、预览、应用、改稿开关）
- Modify: `src/renderer/lib/generate.ts`（`generateChatReply` 增加 `allowEdits`，为真时把 `renderEditPrompt()` 拼进 system）
- Modify: `src/shared/budgets.ts`（`chat.reply` 8192 → 12000）、`src/main/storage/mergeSettings.ts`（注释与迁移保持不变，仅旧值指向新默认）、`scripts/test-budgets.mjs`（期望值）、`src/renderer/pages/Settings/BudgetsSection.tsx`（文案）

- [ ] 实现三个界面文件 + 提示词注入
- [ ] `npm run typecheck` / `npm run build` 通过
- [ ] 截图确认（`shots/chatedit-*.png`）
- [ ] commit

### Task 5: 端到端

**Files:**
- Create: `scripts/e2e-chat-edit.cjs`；`package.json` 加 `e2e:chatedit`

三种模式：`apply`（2 处 found 改动）、`notfound`（anchor 对不上）、`malformed`（坏 JSON）。

- [ ] 写脚本 → 跑 → 断言全绿
- [ ] commit

### Task 6: 升版与打包

- [ ] `package.json` / `package-lock.json` → `1.4.0`
- [ ] `npm run typecheck && npm run build` + 全量测试 + e2e
- [ ] `npx electron-builder --mac zip/dmg --arm64 --x64`
- [ ] `release/BUILD-1.4.0.md`

## 自审

- 覆盖检查：协议的 7 个 op（T1/T2）、定位三级匹配（T2）、单次写入与快照（T3）、预览确认（T4）、失败矩阵三态（T4/T5）、预算 12000（T4）。
- 命名一致性：`applyEditBatch` / `undoLastEditBatch` / `resolveEdits` / `applyResolved` / `parseEditBlock` 全文统一。
- 无占位符步骤。