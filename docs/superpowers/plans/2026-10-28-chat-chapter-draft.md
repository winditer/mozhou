# 对话建章与写稿（Chat Chapter Authoring）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让右侧 AI 对话能把大纲里的计划推成真实章节：新建章节（并补大纲节点），并在作者确认后当场按目标字数写出初稿。

**Architecture:** 沿用 1.4.x 的 mz-edit 补丁协议，加两个 op（`create_chapter` / `write_chapter`）。建章走定位层 + 应用层（纯函数，立刻落盘）；写稿是应用之后的一个显式任务（`lib/draftJobs.ts`），复用 `generateDraft` 的 draft 预算、自动补写与流式输出，把正文分段写进新章。

**Tech Stack:** TypeScript、React 19、zustand、TipTap、electron-vite；测试用 esbuild 把真实实现打包成 ESM 后直接 `import`（`scripts/test-*.mjs`），端到端用假网关 + 真 Electron（`scripts/e2e-*.cjs`）。

**规格：** `docs/superpowers/specs/2026-10-28-chat-chapter-draft-design.md`

## Global Constraints

- 版本：本次发布 **1.5.0**（`package.json` 与 `package-lock.json` 同步）。
- `src/shared/**` 是纯 TS：不许 import electron / react / node 内置模块。
- `src/shared/types.ts` 与 `src/shared/editProtocol.ts` 互相引用只能用 `import type`（编译后被抹掉，不留运行时循环依赖）。
- 一圈最多 **2 章**带写稿；超出的降级为「只建章」，并在该条 `note` 里说明。
- 写稿失败/取消：**保留章节与已写正文**，状态记 `draft`（撰写中），提示可「继续写第 N 章」。
- 写稿期间作者在同一章动手打字 → 立即停止写稿并提示，不许两边互相覆盖。
- 建章与大纲节点：标题去重（书名内唯一）；章节的 `outlineNodeId` 必须指向本次新建的那个节点（不靠标题兜底匹配）。
- 不重排章节标题编号：`after` 只决定插入顺序。
- 注释与界面文案一律中文；注释写「为什么」，不写「做了什么」。
- 每个任务结束都要 `npm run typecheck` 干净后再提交。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/shared/editProtocol.ts` | 两个新 op 的类型、校验、提示词规则 | 改 |
| `src/renderer/lib/applyEdits.ts` | 定位（展开成大纲节点行 + 章节行、去重、限额降级）与应用（真建章） | 改 |
| `src/renderer/lib/draftJobs.ts` | 写稿任务：串行、节流落盘、停止、手滑检测 | 新建 |
| `src/renderer/components/AIPanel.tsx` | 应用后收集待写清单、启动作业、横幅与停止、toast | 改 |
| `src/renderer/components/ChatEditPreview.tsx` | 新增章节 / 写稿两类行的文案与状态标签 | 改 |
| `scripts/test-edit-protocol.mjs` | 两个 op 的校验用例 | 改 |
| `scripts/test-apply-edits.mjs` | 建章定位与应用用例 | 改 |
| `scripts/test-draft-jobs.mjs` | 写稿任务用例（假生成器） | 新建 |
| `scripts/e2e-chat-edit.cjs` | 新增 `newchapter` 模式（对话 + 写稿两次调用） | 改 |

---

### Task 1: 协议层两个 op

**Files:**
- Modify: `src/shared/editProtocol.ts`（`EditOpKind`、`EDIT_OP_KINDS`、`EditOp`、`validateOp`、`renderEditPrompt`）
- Test: `scripts/test-edit-protocol.mjs`

**Interfaces:**
- Produces：`EditOp` 新增可选字段 `targetWords?: number`、`draft?: boolean`；`EditOpKind` 新增 `'create_chapter' | 'write_chapter'`。

- [ ] **Step 1: 写失败用例**

在 `scripts/test-edit-protocol.mjs` 的校验表里（`set_outline_node` 那几行之后）追加：

```js
    [{ op: 'create_chapter', title: '第30章 027', summary: '陈屿追编号', draft: true }, true],
    [{ op: 'create_chapter', title: '第30章 027', targetWords: 2400 }, true],
    [{ op: 'create_chapter', summary: '没有标题' }, false],
    [{ op: 'create_chapter', title: '第30章', targetWords: 40 }, false],
    [{ op: 'create_chapter', title: '第30章', draft: 'yes' }, false],
    [{ op: 'write_chapter', chapter: '第30章' }, true],
    [{ op: 'write_chapter' }, false],
```

并把「八种 op 全列出」那条改成九种：

```js
  check(
    '九种 op 全列出',
    [
      'replace_paragraph',
      'insert_paragraph',
      'delete_paragraph',
      'replace_literal',
      'set_chapter_summary',
      'set_outline_node',
      'add_outline_node',
      'create_chapter',
      'write_chapter',
      'bible_upsert'
    ].every((k) => p.includes(k))
  )
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `node scripts/test-edit-protocol.mjs`
Expected: FAIL（`不认识的 op「create_chapter」` 若干条）

- [ ] **Step 3: 加类型与校验**

`EditOpKind` 与 `EDIT_OP_KINDS`：

```ts
export type EditOpKind =
  | 'replace_paragraph'
  | 'insert_paragraph'
  | 'delete_paragraph'
  | 'replace_literal'
  | 'set_chapter_summary'
  | 'set_outline_node'
  | 'add_outline_node'
  | 'create_chapter'
  | 'write_chapter'
  | 'bible_upsert'

export const EDIT_OP_KINDS: EditOpKind[] = [
  'replace_paragraph',
  'insert_paragraph',
  'delete_paragraph',
  'replace_literal',
  'set_chapter_summary',
  'set_outline_node',
  'add_outline_node',
  'create_chapter',
  'write_chapter',
  'bible_upsert'
]
```

`EditOp` 追加两个字段（放在 `status?: OutlineNode['status']` 之后）：

```ts
  /** create_chapter：新章目标字数，缺省取本书 settings.targetWordsPerChapter */
  targetWords?: number
  /** create_chapter：应用后是否当场写初稿。默认 false——「补大纲」不该顺手写两章正文 */
  draft?: boolean
```

`validateOp` 里，在 `case 'bible_upsert'` 之前插入：

```ts
    case 'create_chapter': {
      if (!need(o.title)) return { error: `${at}：缺少 title（章节标题）` }
      let targetWords: number | undefined
      if (o.targetWords !== undefined && o.targetWords !== null) {
        const n = Number(o.targetWords)
        // 300 字以下不像一章，20000 以上一次生成必然跑很久：两头都挡掉，比事后解释便宜
        if (!Number.isFinite(n) || n < 300 || n > 20000) return { error: `${at}：targetWords 需在 300–20000 之间` }
        targetWords = Math.round(n)
      }
      if (o.draft !== undefined && typeof o.draft !== 'boolean') return { error: `${at}：draft 只能是 true / false` }
      return {
        op: {
          op: 'create_chapter',
          title: (o.title as string).trim(),
          summary: isText(o.summary) ? o.summary : undefined,
          targetWords,
          draft: o.draft === true,
          after: isText(o.after) && o.after.trim() ? o.after : undefined,
          parent: isText(o.parent) && o.parent.trim() ? o.parent : undefined
        }
      }
    }
    case 'write_chapter': {
      if (!need(o.chapter)) return { error: `${at}：缺少 chapter（要写哪一章）` }
      return { op: { op: 'write_chapter', chapter: o.chapter as string } }
    }
```

- [ ] **Step 4: 补提示词**

`renderEditPrompt()` 的「可用操作」列表里，`add_outline_node` 之后追加两行：

```
- create_chapter：新建一章。字段 title / summary（章梗概）/ targetWords / draft（true=建完就写初稿，默认 false）/ after（插在哪一章之后，省略=书尾）/ parent（大纲节点挂哪一卷）
- write_chapter：给**已存在**的章写初稿或接着写。字段 chapter
```

规则段追加两条（接在原来的第 6、7 条之后，编号顺延）：

```
8. 作者说「建第 30 章」但没说写稿时，draft 给 false；说「建第 30 章并写出来 / 补完这章」时给 true。一轮最多 2 章带 draft。
9. 只补大纲不建章时用 add_outline_node，不要用 create_chapter。
```

- [ ] **Step 5: 跑测试**

Run: `node scripts/test-edit-protocol.mjs`
Expected: `80 通过 / 0 失败` 之上的全绿（新增 7 条用例）

- [ ] **Step 6: 提交**

```bash
git add src/shared/editProtocol.ts scripts/test-edit-protocol.mjs
git commit -m "feat(chat-edit): 协议支持 create_chapter / write_chapter"
```

---

### Task 2: 定位层——建章展开成两条改动

**Files:**
- Modify: `src/renderer/lib/applyEdits.ts:26-60`（`ResolvedEdit` 接口）、`resolveOne`（新增两个 case）、`resolveEdits`（限额计数）
- Test: `scripts/test-apply-edits.mjs`

**Interfaces:**
- Consumes：Task 1 的 `EditOp` 新字段。
- Produces：
  - `ResolvedEdit` 新增 `draftTarget?: { title: string; targetWords: number }`、`writeTarget?: { chapterId: string; targetWords: number; continueOnly: boolean }`
  - `resolveEdits(project, ops)` 对 `create_chapter` 返回**两条**编辑（大纲节点 + 章节），对 `write_chapter` 返回一条。

- [ ] **Step 1: 写失败用例**

在 `scripts/test-apply-edits.mjs` 的「设定库」段之前插入：

```js
/* ── 7c. 新建章节 ── */
console.log('新建章节')
{
  const p = makeProject()
  const edits = resolveEdits(p, [{ op: 'create_chapter', title: '第4章 灰线', summary: '陈默在灰线上看见名字', draft: true }])
  check('展开成两条', edits.length === 2, `实际 ${edits.length}`)
  const outlineRow = edits.find((e) => e.op.op === 'add_outline_node')
  const chapterRow = edits.find((e) => e.op.op === 'create_chapter')
  check('一条是大纲节点', Boolean(outlineRow), JSON.stringify(edits.map((e) => e.op.op)))
  check('一条是章节', Boolean(chapterRow))
  check('两条都能应用', edits.every((e) => e.status === 'found'), JSON.stringify(edits.map((e) => e.status)))
  check('章节行带写稿目标', chapterRow.draftTarget?.title === '第4章 灰线' && chapterRow.draftTarget.targetWords === 2500, JSON.stringify(chapterRow.draftTarget))
  check('大纲行挂在第一卷', outlineRow.op.parent === '第一卷' || outlineRow.note?.includes('最后一卷'), String(outlineRow.note))

  const n = applyResolved(p, edits)
  check('章节多了一章', n.chapters.length === 4, String(n.chapters.length))
  check('大纲多了一节', n.outline[0].children.length === 2, String(n.outline[0].children.length))
  const fresh = n.chapters[3]
  check('新章标题正确', fresh.title === '第4章 灰线', fresh.title)
  check('新章是待写、0 字', fresh.status === 'planning' && fresh.words === 0 && fresh.content === '', JSON.stringify({ s: fresh.status, w: fresh.words }))
  check('新章挂到了新节点', fresh.outlineNodeId === n.outline[0].children[1].id, `${fresh.outlineNodeId} vs ${n.outline[0].children[1].id}`)
  check('梗概写进章和大纲', fresh.summary === '陈默在灰线上看见名字' && n.outline[0].children[1].summary === '陈默在灰线上看见名字')
  check('原项目没被就地改', p.chapters.length === 3)

  const [dup] = resolveEdits(p, [{ op: 'create_chapter', title: '第2章 老槐树' }])
  check('重名 → not-found（只报一条）', dup.status === 'not-found', dup.status)
  check('并说明重名', Boolean(dup.note?.includes('已经有')), dup.note)

  const after = resolveEdits(p, [{ op: 'create_chapter', title: '插叙', after: '第1章' }])
  const nn = applyResolved(p, after)
  check('after 决定插入位置', nn.chapters[1].title === '插叙', JSON.stringify(nn.chapters.map((c) => c.title)))
  check('后面的章顺序后移', nn.chapters[2].title === '第2章 老槐树')
  check('标题编号不被重排', nn.chapters[3].title === '第3章 她把最后一封信烧了')
}

/* ── 7d. 给已有章写稿 ── */
console.log('给已有章写稿')
{
  const p = makeProject()
  const [e] = resolveEdits(p, [{ op: 'write_chapter', chapter: '第1章' }])
  check('定位到第 1 章', e.status === 'found' && e.chapterId === 'c1', `${e.status} ${e.chapterId}`)
  check('已有正文 → 接着写', e.writeTarget?.continueOnly === true, JSON.stringify(e.writeTarget))
  check('标签说「接着写」', e.label.includes('接着写'), e.label)

  const empty = makeProject()
  empty.chapters[0].content = ''
  const [e2] = resolveEdits(empty, [{ op: 'write_chapter', chapter: '第1章' }])
  check('空章 → 写初稿', e2.writeTarget?.continueOnly === false && e2.label.includes('写初稿'), e2.label)

  const [miss] = resolveEdits(p, [{ op: 'write_chapter', chapter: '第99章' }])
  check('章不存在 → not-found', miss.status === 'not-found', miss.status)
}

/* ── 7e. 一轮最多 2 章写稿 ── */
console.log('写稿限额')
{
  const p = makeProject()
  const edits = resolveEdits(p, [
    { op: 'create_chapter', title: '第4章 A', draft: true },
    { op: 'create_chapter', title: '第5章 B', draft: true },
    { op: 'create_chapter', title: '第6章 C', draft: true }
  ])
  const withDraft = edits.filter((e) => e.draftTarget)
  check('只保留前两章写稿', withDraft.length === 2, String(withDraft.length))
  check('第三条降级为只建章', edits.some((e) => e.op.op === 'create_chapter' && e.op.title === '第6章 C' && !e.draftTarget))
  check('降级那条说明了原因', Boolean(edits.find((e) => e.op.title === '第6章 C')?.note?.includes('下一轮')), edits.find((e) => e.op.title === '第6章 C')?.note)
}
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `node scripts/test-apply-edits.mjs`
Expected: FAIL（`create_chapter` 落到 `default` 分支返回 undefined / 抛出）

- [ ] **Step 3: 加接口字段**

`ResolvedEdit` 里，`outlineNode` 之后加：

```ts
  /** create_chapter 建完之后要不要写稿：有值就是写，targetWords 用于预算 */
  draftTarget?: { title: string; targetWords: number }
  /** write_chapter 的目标：已有正文的章按差额接着写 */
  writeTarget?: { chapterId: string; targetWords: number; continueOnly: boolean }
```

- [ ] **Step 4: 限额计数 + 两个新 case**

`resolveEdits` 改成带计数（`maxDraft = 2`）：

```ts
export function resolveEdits(project: Project, ops: EditOp[]): ResolvedEdit[] {
  // 一轮最多 2 章写稿：一次点应用就长跑十分钟是这一功能最容易失控的地方
  const budget = { draftLeft: 2 }
  return ops.flatMap((op) => {
    const r = resolveOne(project, op, budget)
    return Array.isArray(r) ? r : [r]
  })
}
```

`resolveOne` 签名加 `budget: { draftLeft: number }`，并在 `case 'bible_upsert'` 之后加两个 case：

```ts
    case 'create_chapter': {
      const title = (op.title ?? '').trim()
      const key = outlineTitleKey(title)
      const clashChapter = project.chapters.find((c) => outlineTitleKey(c.title) === key)
      const clashNode = flattenOutlineTitles(project.outline).find((t) => outlineTitleKey(t.title) === key)
      if (clashChapter || clashNode) {
        return {
          op,
          status: 'not-found',
          display: 'new-entry',
          label: `新建章节「${title}」`,
          before: '',
          after: '',
          note: clashChapter
            ? `书里已经有「${clashChapter.title}」这一章了，要改它请用 set_chapter_summary / replace_paragraph`
            : `大纲里已经有「${clashNode?.title}」这个节点了，要建章请让作者先在章节列表里建，或换个标题`
        }
      }
      const parentRef = op.parent ? resolveOutlineNode(project.outline, op.parent) : null
      if (op.parent && !parentRef?.node) {
        return {
          op,
          status: 'not-found',
          display: 'new-entry',
          label: `新建章节「${title}」`,
          before: '',
          after: '',
          note: `大纲里没有「${op.parent}」这个节点，请换用卷标题或省略 parent`
        }
      }
      let afterIndex: number | undefined
      if (op.after) {
        const ref = resolveChapterRef(project, op.after)
        if (!ref.chapterId) {
          return {
            op,
            status: 'not-found',
            display: 'new-entry',
            label: `新建章节「${title}」`,
            before: '',
            after: '',
            note: `找不到要插在后面的章节「${op.after}」`
          }
        }
        afterIndex = project.chapters.findIndex((c) => c.id === ref.chapterId)
      }
      const targetWords =
        op.targetWords ?? Math.max(300, Math.round(project.settings?.targetWordsPerChapter || 2500))
      const parent = parentRef?.node
      const outlineRow: ResolvedEdit = {
        op: {
          op: 'add_outline_node',
          parent: op.parent,
          title,
          summary: op.summary ?? '',
          status: 'planned'
        },
        status: 'found',
        display: 'new-entry',
        label: `新增大纲节点「${title}」`,
        before: '',
        after: [title, op.summary ?? '', OUTLINE_STATUS_LABEL.planned].filter(Boolean).join('　'),
        outlineNode: { parentId: parent?.id, title, summary: op.summary ?? '', status: 'planned' },
        note: parent ? `挂在 ${parentRef?.path.join(' › ')}` : '挂在最后一卷'
      }
      // 限额：前两章写稿，其余只建章
      const wantsDraft = op.draft === true
      const allowDraft = wantsDraft && budget.draftLeft > 0
      if (allowDraft) budget.draftLeft -= 1
      const chapterRow: ResolvedEdit = {
        op,
        status: 'found',
        display: 'new-entry',
        label: `新增章节「${title}」`,
        before: '',
        after: [
          `目标 ${targetWords} 字`,
          op.after ? `插在「${op.after}」之后` : '加在书尾',
          allowDraft ? '应用后开始写初稿' : ''
        ]
          .filter(Boolean)
          .join('　'),
        chapterCreate: { title, summary: op.summary ?? '', targetWords, afterIndex, parentId: parent?.id },
        draftTarget: allowDraft ? { title, targetWords } : undefined,
        note:
          wantsDraft && !allowDraft
            ? '这一轮先建章，写稿下一轮再说（一次最多 2 章）'
            : op.after
              ? '只改顺序，不重排后面章节的标题编号'
              : undefined
      }
      return [outlineRow, chapterRow]
    }

    case 'write_chapter': {
      const ref = resolveChapterRef(project, op.chapter ?? '')
      if (!ref.chapterId) {
        return {
          op,
          status: 'not-found',
          display: 'new-entry',
          label: `为「${op.chapter ?? ''}」写稿`,
          before: '',
          after: '',
          note: ref.candidates.length
            ? `这本书里有 ${ref.candidates.length} 章对得上：${ref.candidates.map((c) => c.title).join('、')}`
            : '书里找不到这一章'
        }
      }
      const chapter = project.chapters.find((c) => c.id === ref.chapterId) as Chapter
      const hasText = chapter.content.replace(/<[^>]+>/g, '').trim().length > 0
      const targetWords = Math.max(300, Math.round(chapter.targetWords || 2500))
      if (budget.draftLeft <= 0) {
        return {
          op,
          status: 'not-found',
          display: 'new-entry',
          label: `为「${chapter.title}」写稿`,
          before: '',
          after: '',
          note: '这一轮已经排了 2 章写稿了，下一轮再写这一章'
        }
      }
      budget.draftLeft -= 1
      return {
        op,
        status: 'found',
        display: 'new-entry',
        label: `为「${chapter.title}」${hasText ? '接着写' : '写初稿'}`,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        before: '',
        after: `约 ${targetWords} 字`,
        writeTarget: { chapterId: chapter.id, targetWords, continueOnly: hasText }
      }
    }
```

`ResolvedEdit` 再加一个字段（供应用层建章）：

```ts
  /** create_chapter 建章所需的一切 */
  chapterCreate?: { title: string; summary: string; targetWords: number; afterIndex?: number; parentId?: string }
```

文件顶部 import 补 `outlineTitleKey`：

```ts
import { uid, outlineTitleKey } from '@shared/utils'
```

- [ ] **Step 5: 应用层建章**

`applyResolved` 里，在「新增大纲节点」那个循环之后加：

```ts
  // 新建章节：大纲先加完再建章，才能把 outlineNodeId 直接指到**本次新建**的节点上，
  // 而不是回头靠标题兜底匹配（那会在同名时挂错）
  for (const e of usable) {
    if (e.op.op !== 'create_chapter' || !e.chapterCreate) continue
    const info = e.chapterCreate
    const node = flattenOutlineTitles(next.outline).find((t) => outlineTitleKey(t.title) === outlineTitleKey(info.title))
    const chapter: Chapter = {
      id: uid('c'),
      title: info.title,
      content: '',
      summary: info.summary,
      status: 'planning',
      targetWords: info.targetWords,
      words: 0,
      outlineNodeId: node?.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      versions: []
    }
    const chapters = [...next.chapters]
    const at = info.afterIndex === undefined ? chapters.length : Math.min(info.afterIndex + 1, chapters.length)
    chapters.splice(at, 0, chapter)
    next = { ...next, chapters }
  }
```

- [ ] **Step 6: 跑测试**

Run: `node scripts/test-apply-edits.mjs && npm run typecheck`
Expected: 全绿（原 83 条 + 新增约 20 条）

- [ ] **Step 7: 提交**

```bash
git add src/renderer/lib/applyEdits.ts scripts/test-apply-edits.mjs
git commit -m "feat(chat-edit): create_chapter / write_chapter 的定位与应用"
```

---

### Task 3: 写稿任务

**Files:**
- Create: `src/renderer/lib/draftJobs.ts`
- Test: `scripts/test-draft-jobs.mjs`

**Interfaces:**
- Produces：
  - `DraftJob = { chapterId: string; title: string; targetWords: number; continueOnly: boolean }`
  - `DraftDeps = { generate; getProject; patch; focus?; onProgress?; onStage?; shouldStop?; flushMs? }`
  - `runDraftJobs(jobs: DraftJob[], deps: DraftDeps): Promise<{ ok: number; failed: number; stopped: boolean }>`
- 生成器通过 `deps.generate` 注入（真实实现是 `generateDraft`），单测用假函数——写稿任务不直接 import 模型层。

- [ ] **Step 1: 写失败用例**

新建 `scripts/test-draft-jobs.mjs`：

```js
/**
 * 写稿任务的回归测试：串行、节流落盘、停止、手滑检测。
 *
 * 这个模块不碰模型层（生成器从 deps 注入），所以能在 node 里直接跑：
 * 一个假生成器分几段吐字，看它写进 store 的 content 是不是逐步变长、
 * 中途被叫停时是不是保留已写部分。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outfile = join(mkdtempSync(join(tmpdir(), 'mozhou-draft-jobs-')), 'draftJobs.mjs')
await build({
  entryPoints: [join(root, 'src/renderer/lib/draftJobs.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(root, 'src/shared') }
})
const { runDraftJobs } = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

const mkChapter = (id, title, content = '') => ({
  id,
  title,
  content,
  summary: '',
  status: 'planning',
  targetWords: 2500,
  words: 0,
  createdAt: 1,
  updatedAt: 1,
  versions: []
})
const mkProject = (chapters) => ({ id: 'p', title: 't', chapters, outline: [], bible: {}, brief: {} })

/** 假生成器：分 n 段吐字，每段之间让事件循环走一步（让 flush 定时器有机会跑） */
function fakeGen(paras, opts = {}) {
  return async ({ onDelta, onStage }) => {
    onStage?.('正在写…')
    for (const p of paras) {
      onDelta(p + '\n\n')
      await new Promise((r) => setTimeout(r, opts.gap ?? 5))
      if (opts.onEach) opts.onEach()
    }
    return paras.join('\n\n')
  }
}

console.log('写初稿')
{
  const ch = mkChapter('c1', '第4章 灰线')
  const project = mkProject([ch])
  const writes = []
  const r = await runDraftJobs([{ chapterId: 'c1', title: ch.title, targetWords: 2500, continueOnly: false }], {
    generate: fakeGen(['第一段字。', '第二段字。', '第三段字。']),
    getProject: () => project,
    patch: (id, p) => {
      writes.push(p.content)
      project.chapters[0] = { ...project.chapters[0], ...p }
    },
    flushMs: 0
  })
  check('成功 1 章', r.ok === 1 && r.failed === 0 && r.stopped === false, JSON.stringify(r))
  check('落盘是逐步的', writes.length >= 2, String(writes.length))
  check('最终正文分了三段', (project.chapters[0].content.match(/<p>/g) || []).length === 3, project.chapters[0].content)
  check('有正文', project.chapters[0].content.includes('第二段字'))
}

console.log('接着写')
{
  const ch = mkChapter('c2', '第5章 门', '<p>原来的开头。</p>')
  const project = mkProject([ch])
  await runDraftJobs([{ chapterId: 'c2', title: ch.title, targetWords: 2500, continueOnly: true }], {
    generate: fakeGen(['接下去。']),
    getProject: () => project,
    patch: (id, p) => {
      project.chapters[0] = { ...project.chapters[0], ...p }
    },
    flushMs: 0
  })
  check('旧正文保留', project.chapters[0].content.includes('原来的开头'), project.chapters[0].content)
  check('新内容接在后面', project.chapters[0].content.includes('接下去'), project.chapters[0].content)
  check('顺序正确', project.chapters[0].content.indexOf('原来的开头') < project.chapters[0].content.indexOf('接下去'))
}

console.log('停止')
{
  const ch = mkChapter('c3', '第6章 停')
  const project = mkProject([ch])
  let stop = false
  const r = await runDraftJobs([{ chapterId: 'c3', title: ch.title, targetWords: 2500, continueOnly: false }], {
    generate: fakeGen(['一。', '二。', '三。', '四。'], { gap: 5, onEach: () => (stop = true) }),
    getProject: () => project,
    patch: (id, p) => {
      project.chapters[0] = { ...project.chapters[0], ...p }
    },
    flushMs: 0,
    shouldStop: () => stop
  })
  check('报告已停止', r.stopped === true, JSON.stringify(r))
  check('已写部分留着', (project.chapters[0].content || '').length > 0, project.chapters[0].content)
  check('没写全', !project.chapters[0].content.includes('四。'), project.chapters[0].content)
}

console.log('作者自己动手了')
{
  const ch = mkChapter('c4', '第7章 手滑')
  const project = mkProject([ch])
  const r = await runDraftJobs([{ chapterId: 'c4', title: ch.title, targetWords: 2500, continueOnly: false }], {
    generate: fakeGen(['一。', '二。', '三。'], {
      gap: 5,
      onEach: () => {
        // 模拟作者在编辑器里打字：store 里的正文被改成别的内容
        project.chapters[0] = { ...project.chapters[0], content: '<p>我自己写的。</p>' }
      }
    }),
    getProject: () => project,
    patch: (id, p) => {
      project.chapters[0] = { ...project.chapters[0], ...p }
    },
    flushMs: 0
  })
  check('停下来了', r.stopped === true, JSON.stringify(r))
  check('没有覆盖作者的字', project.chapters[0].content.includes('我自己写的'), project.chapters[0].content)
}

console.log('章节不在了')
{
  const r = await runDraftJobs([{ chapterId: 'gone', title: '第9章', targetWords: 2500, continueOnly: false }], {
    generate: fakeGen(['一。']),
    getProject: () => mkProject([]),
    patch: () => {},
    flushMs: 0
  })
  check('算失败但整个任务不炸', r.failed === 1 && r.ok === 0, JSON.stringify(r))
}

console.log('生成器抛错')
{
  const ch = mkChapter('c5', '第8章 炸')
  const project = mkProject([ch])
  const r = await runDraftJobs([{ chapterId: 'c5', title: ch.title, targetWords: 2500, continueOnly: false }], {
    generate: async ({ onDelta }) => {
      onDelta('先写了半句')
      await new Promise((rr) => setTimeout(rr, 5))
      throw new Error('网络断了')
    },
    getProject: () => project,
    patch: (id, p) => {
      project.chapters[0] = { ...project.chapters[0], ...p }
    },
    flushMs: 0
  })
  check('算失败', r.failed === 1, JSON.stringify(r))
  check('半句留着', (project.chapters[0].content || '').length > 0, project.chapters[0].content)
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `node scripts/test-draft-jobs.mjs`
Expected: FAIL（`Cannot find module .../draftJobs.ts`）

- [ ] **Step 3: 写实现**

新建 `src/renderer/lib/draftJobs.ts`：

```ts
/**
 * 对话里的「建章并写稿」：应用完之后真正去写那一章。
 *
 * 为什么单独一个模块、而不是塞进 applyResolved：
 * 这里要调一次模型、跑几分钟、会失败、要能取消。纯函数层有副作用就没法在 node 里测，
 * 而改稿这条链最需要测的恰恰是「出错时稿子还在不在」。
 *
 * 生成器从 deps 注入（真实实现是 generateDraft），任务本身不 import 模型层。
 */
import type { Chapter, Project } from '@shared/types'
import { textToParagraph } from './paragraphs'

export interface DraftJob {
  chapterId: string
  title: string
  targetWords: number
  /** 已有正文的章：接着写而不是从头写 */
  continueOnly: boolean
}

export interface DraftProgress {
  chapterId: string
  title: string
  written: number
  target: number
  index: number
  total: number
}

export interface DraftGenArgs {
  project: Project
  chapter: Chapter
  targetWords: number
  existingWords: number
  instruction: string
  onDelta: (d: string) => void
  onStage?: (stage: string) => void
  onThought?: (t: string) => void
}

export interface DraftDeps {
  generate: (a: DraftGenArgs) => Promise<string>
  /** 每次都现取：写稿期间正文一直在变，闭包捕获的那份早就过期了 */
  getProject: () => Project | null
  patch: (chapterId: string, patch: Partial<Chapter>) => void
  /** 把界面切到这一章，让作者看着它长 */
  focus?: (chapterId: string) => void
  onProgress?: (p: DraftProgress) => void
  onStage?: (stage: string) => void
  /** 作者点了停止 */
  shouldStop?: () => boolean
  /** 落盘节流，默认 500ms；测试里传 0 每段都落 */
  flushMs?: number
}

export interface DraftResult {
  ok: number
  failed: number
  stopped: boolean
}

const plain = (html: string): string => html.replace(/<[^>]+>/g, '')
const chars = (s: string): number => plain(s).replace(/\s/g, '').length

/**
 * 串行写稿。
 *
 * 串行是刻意的：并发写三章会把渠道的并发打满、失败重试彼此干扰，
 * 而作者看的是「一章一章写出来」，慢一点但可预期。
 */
export async function runDraftJobs(jobs: DraftJob[], deps: DraftDeps): Promise<DraftResult> {
  const flushMs = deps.flushMs ?? 500
  let ok = 0
  let failed = 0
  let stopped = false

  for (const [index, job] of jobs.entries()) {
    if (deps.shouldStop?.()) {
      stopped = true
      break
    }
    const project = deps.getProject()
    const chapter = project?.chapters.find((c) => c.id === job.chapterId)
    if (!project || !chapter) {
      failed++
      continue
    }

    const baseHtml = job.continueOnly ? chapter.content : ''
    // 「上次我们写进去的值」：落盘前比对这个，能立刻发现作者自己动了笔
    let lastWritten = chapter.content
    let buffer = ''
    let lastFlush = 0
    let conflict = false

    const write = (final: boolean): void => {
      const live = deps.getProject()?.chapters.find((c) => c.id === job.chapterId)
      if (!live) return
      if (live.content !== lastWritten) {
        // 作者在这一章动手了：停下来，别把他的字冲掉
        conflict = true
        return
      }
      const html = baseHtml + textToParagraph(buffer)
      if (html === lastWritten && !final) return
      lastWritten = html
      deps.patch(job.chapterId, { content: html, words: chars(html) })
      deps.onProgress?.({
        chapterId: job.chapterId,
        title: job.title,
        written: chars(html),
        target: job.targetWords,
        index,
        total: jobs.length
      })
    }

    deps.focus?.(job.chapterId)
    deps.onStage?.(`正在写「${job.title}」…`)

    try {
      await deps.generate({
        project,
        chapter: { ...chapter, content: baseHtml },
        targetWords: job.targetWords,
        existingWords: chars(baseHtml),
        instruction: job.continueOnly
          ? '接着这一章往下写，接上已有结尾，不要重写前面写过的内容。'
          : '写出这一章的初稿。',
        onDelta: (d) => {
          buffer += d
          const now = Date.now()
          if (flushMs === 0 || now - lastFlush >= flushMs) {
            lastFlush = now
            write(false)
          }
        },
        onStage: deps.onStage
      })
      write(true)
      if (conflict) {
        stopped = true
        break
      }
      ok++
    } catch {
      // 失败也把已写部分落盘：半章比空章有用，作者可以接着说「继续写」
      write(true)
      if (conflict) {
        stopped = true
        break
      }
      failed++
    }
    if (deps.shouldStop?.()) {
      stopped = true
      break
    }
  }

  return { ok, failed, stopped }
}
```

- [ ] **Step 4: 跑测试**

Run: `node scripts/test-draft-jobs.mjs && npm run typecheck`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/renderer/lib/draftJobs.ts scripts/test-draft-jobs.mjs
git commit -m "feat(chat-edit): 写稿任务（串行、节流落盘、停止、防手滑）"
```

---

### Task 4: 界面接线

**Files:**
- Modify: `src/renderer/components/AIPanel.tsx`（应用回调、横幅、停止、toast）
- Modify: `src/renderer/components/ChatEditPreview.tsx`（写稿目标行文案）

**Interfaces:**
- Consumes：Task 2 的 `draftTarget` / `writeTarget` / `chapterCreate`，Task 3 的 `runDraftJobs`。

- [ ] **Step 1: 预览里标出「应用后会写稿」**

`ChatEditPreview.tsx` 的 `EditRow` 里，章节行标题后加一个标签：

```tsx
        {edit.draftTarget && (
          <span
            className="chip shrink-0"
            style={{ height: 16, padding: '0 6px', fontSize: 10, color: 'var(--accent)' }}
            title="确认后会用「起草」预算写这一章的初稿，进度在右侧面板顶部显示"
          >
            写稿
          </span>
        )}
```

- [ ] **Step 2: AIPanel 收待写清单并起任务**

文件顶部 import：

```ts
import { runDraftJobs, type DraftJob, type DraftProgress } from '../lib/draftJobs'
import { generateDraft } from '../lib/generate'
```

组件里加状态：

```ts
  const [drafting, setDrafting] = useState<DraftProgress | null>(null)
  const stopDraftRef = useRef(false)
```

`onApply` 回调改成（替换现有 `<ChatEditPreview onApply={...}>` 里的函数体）：

```tsx
        onApply={(kept) => {
          const msgId = preview?.msgId
          applyEditBatch(kept)
          if (msgId) {
            patchProject((p) => ({
              ...p,
              chat: p.chat.map((m) => (m.id === msgId ? { ...m, editsAppliedAt: Date.now() } : m))
            }))
          }
          setPreview(null)
          setNow(Date.now())
          toast(`已应用 ${kept.length} 处修改，正文可在章节版本历史里回退。`, 'ok')
          void startDrafts(kept)
        }}
```

新增 `startDrafts`：

```tsx
  /**
   * 应用完建章之后去写稿。
   *
   * 章节 id 不能从改动里拿（建章是 applyEditBatch 里现生成的），所以按标题回查——
   * 标题在定位层已经去过重，回查是准的。
   */
  const startDrafts = async (kept: ResolvedEdit[]): Promise<void> => {
    const st = useApp.getState()
    const project = st.project
    if (!project) return
    const jobs: DraftJob[] = []
    for (const e of kept) {
      if (e.draftTarget) {
        const ch = project.chapters.find((c) => c.title === e.draftTarget?.title)
        if (ch) jobs.push({ chapterId: ch.id, title: ch.title, targetWords: e.draftTarget.targetWords, continueOnly: false })
      } else if (e.writeTarget) {
        jobs.push({
          chapterId: e.writeTarget.chapterId,
          title: st.project?.chapters.find((c) => c.id === e.writeTarget?.chapterId)?.title ?? '这一章',
          targetWords: e.writeTarget.targetWords,
          continueOnly: e.writeTarget.continueOnly
        })
      }
    }
    if (!jobs.length) return

    const picked = resolveTaskModel(st.config, project, 'draft')
    if (!picked) {
      toast('没有配置起草模型，已建章但没有写稿。去设置里选一个模型，再说「写第 N 章」即可。', 'error')
      return
    }
    stopDraftRef.current = false
    const res = await runDraftJobs(jobs, {
      generate: (a) =>
        generateDraft({
          project: a.project,
          chapter: a.chapter,
          channel: picked.channel,
          model: picked.model,
          task: 'draft',
          temperature: st.config?.settings.temperature ?? 0.85,
          library: st.styleLibrary,
          skillLibrary: st.skillLibrary,
          conventions: st.config?.settings.genreConventions,
          budgets: st.config?.settings.tokenBudgets,
          instruction: a.instruction,
          targetWords: a.targetWords,
          existingWords: a.existingWords,
          onDelta: a.onDelta,
          onStage: a.onStage,
          onThought: a.onThought
        }),
      getProject: () => useApp.getState().project,
      patch: (id, patch) => useApp.getState().patchChapter(id, patch),
      focus: (id) => useApp.getState().setActiveChapter(id),
      onProgress: (p) => setDrafting(p),
      onStage: (s) => setDrafting((d) => (d ? { ...d, title: s } : d)),
      shouldStop: () => stopDraftRef.current,
      flushMs: 500
    })
    setDrafting(null)
    if (res.stopped) toast('写稿已停止，已写的部分留在正文里；可以说「继续写这一章」接着写。', 'error')
    else if (res.failed && !res.ok) toast('写稿失败，已建章但正文是空的。可以说「写第 N 章」重试。', 'error')
    else if (res.ok) toast(`写完了 ${res.ok} 章初稿，可在章节版本历史里回退。`, 'ok')
  }
```

import 补：`import { resolveTaskModel, useApp } from '../store/app'`（若已 import 过 `useApp` 就只补 `resolveTaskModel`）。

- [ ] **Step 3: 横幅与停止**

面板顶部（「撤销改稿」那块旁边）加：

```tsx
        {drafting && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10.5px] tabular-nums" style={{ color: 'var(--accent)' }}>
              写作中 {drafting.written}/{drafting.target}
            </span>
            <button
              className="chip surface-hover"
              style={{ height: 20, padding: '0 6px', fontSize: 10.5 }}
              onClick={() => {
                stopDraftRef.current = true
                abortChat()
              }}
            >
              停止
            </button>
          </div>
        )}
```

import 补 `abortChat`：`import { abortChat } from '../lib/ai'`。

- [ ] **Step 4: 编译与手测**

Run: `npm run typecheck && npm run build`
Expected: 无错误。构建后用 `node scripts/e2e-chat-edit.cjs` 看旧用例不受影响（Task 5 才加新用例）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/components/AIPanel.tsx src/renderer/components/ChatEditPreview.tsx
git commit -m "feat(chat-edit): 应用后建章并当场写稿（横幅与停止）"
```

---

### Task 5: 端到端验收

**Files:**
- Modify: `scripts/e2e-chat-edit.cjs`（新增 `newchapter` 模式与断言）

- [ ] **Step 1: 假网关支持两次调用**

`startMock` 里按「第几次请求」分流：第一次返回 mz-edit 建章块，之后返回正文。

```js
          const isDraftCall = requests.length > 1
          let text = ''
          if (isDraftCall) {
            // 写稿那一次：直接吐一段正文，不用流式块
            requests[requests.length - 1].kind = 'draft'
            text = '灰线在图纸上从东墙角拉到配电房。\n\n陈默蹲下去，指尖顺着那条线走。\n\n线到头，是一个被水泥盖住的接线盒。'
          } else if (mode === 'newchapter') {
            requests[requests.length - 1].kind = 'edit'
            const ops = {
              edits: [
                {
                  op: 'create_chapter',
                  title: '第 4 章 灰线',
                  summary: '陈默在灰线上看见自己的名字',
                  draft: true
                }
              ]
            }
            text = `这一章该建出去了，我把大纲和章一起补上：\n\n\`\`\`mz-edit\n${JSON.stringify(ops)}\n\`\`\`\n`
          } else if (mode === 'apply') {
```

（其余分支保持原样，注意把原来的 `let text = ''` 删掉，避免重复声明。）

- [ ] **Step 2: DRIVE 等待写稿完成**

在 `driveJs` 里，`apply` 分支之后（写稿是异步的），把等待逻辑改成轮询：

```js
  if (${mode === 'apply' ? 'true' : 'false'} && applyBtn && !applyBtn.disabled) {
    applyBtn.click()
    await sleep(1200)
    // 建章 + 写稿：等新章出现且有正文（最多 45 秒）
    const t0 = Date.now()
    let fresh = null
    while (Date.now() - t0 < 45000) {
      const pj = window.__MZ.state().project
      fresh = pj.chapters.find((c) => c.title.includes('灰线'))
      if (fresh && (fresh.content || '').length > 0) break
      await sleep(500)
    }
    const after = window.__MZ.state().project
    out.chapterCount = after.chapters.length
    out.outlineChildren = (after.outline[0]?.children || []).length
    out.freshTitle = fresh?.title || null
    out.freshWords = fresh?.words || 0
    out.freshVersions = (fresh?.versions || []).length
    out.activeId = window.__MZ.state().activeChapterId
    out.freshId = fresh?.id || null
    out.editorText = (document.querySelector('.ProseMirror')?.innerText || '').slice(0, 600)
    out.body = document.body.innerText.slice(0, 1200)
  }
```

- [ ] **Step 3: 断言**

`main()` 里，`B2` 段之后加：

```js
  /* ── D. 建章 + 写稿 ── */
  console.log('\nD. 对话建章并当场写稿（newchapter）')
  const nc = await runCase('newchapter')
  console.log(`  截图：${path.relative(ROOT, nc.screenshot)}`)
  check('两次模型调用（对话 + 写稿）', nc.requests.length >= 2, `实际 ${nc.requests.length}`)
  check('第二次是写稿', nc.requests[1]?.kind === 'draft', String(nc.requests[1]?.kind))
  check('章节多了一章', nc.result.chapterCount === 4, String(nc.result.chapterCount))
  check('大纲多了一节', nc.result.outlineChildren === 3, String(nc.result.outlineChildren))
  check('新章有正文', (nc.result.freshWords || 0) > 0, `words=${nc.result.freshWords}`)
  check('新章留了快照', (nc.result.freshVersions || 0) >= 1, String(nc.result.freshVersions))
  check('界面切到了新章', nc.result.activeId === nc.result.freshId)
  check('编辑器里能看到新章正文', /灰线在图纸上/.test(nc.result.editorText || ''), (nc.result.editorText || '').slice(0, 80))
```

（《听风者》原本 3 章、第一卷 2 个节点。）

- [ ] **Step 4: 跑端到端**

Run: `npm run build && node scripts/e2e-chat-edit.cjs`
Expected: 25 条旧断言 + 新增 8 条全绿

- [ ] **Step 5: 提交**

```bash
git add scripts/e2e-chat-edit.cjs
git commit -m "test(e2e): 对话建章并写稿"
```

---

### Task 6: 1.5.0 发布

**Files:**
- Modify: `package.json`、`package-lock.json`
- Create: `release/BUILD-1.5.0.md`
- Modify: `docs/使用说明.md`

- [ ] **Step 1: 升版本号**

```bash
node -e "const fs=require('fs');for(const p of ['package.json','package-lock.json']){const d=JSON.parse(fs.readFileSync(p));d.version='1.5.0';if(p==='package-lock.json'&&d.packages?.['']){d.packages[''].version='1.5.0'}fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n')}"
```

- [ ] **Step 2: 全量测试**

```bash
npm run typecheck
for t in test-edit-protocol test-apply-edits test-draft-jobs test-budgets test-config-merge test-generate-budgets test-audit-apply test-ai-flavor-rewrite; do node scripts/$t.mjs | tail -1; done
npm run build && node scripts/e2e-chat-edit.cjs | tail -3 && node scripts/e2e-chat-reply.cjs | tail -1
```

Expected: 全部 `0 失败`。

- [ ] **Step 3: 打包**

```bash
npx electron-builder --mac zip --arm64 --x64
npx electron-builder --mac dmg --arm64
npx electron-builder --mac dmg --x64
shasum -a 256 release/Mozhou-1.5.0-*.dmg release/Mozhou-1.5.0-*.zip
```

- [ ] **Step 4: 写构建说明并提交**

```bash
git add package.json package-lock.json docs/使用说明.md
git commit -m "chore(release): 版本号升至 1.5.0"
```

`release/BUILD-1.5.0.md` 按 1.4.1 那份的结构写：本版新增（两个 op、限额、失败保留）、验证结果、产物表与 sha256、遗留（插中间不重排编号；Windows 包未构建）。

---

## 自审

- **规格覆盖**：两个 op（Task 1、2）、建章并补大纲节点（Task 2）、写稿任务与失败保留（Task 3）、限额 2 章（Task 2 的 `budget.draftLeft`）、防手滑（Task 3）、界面横幅与停止（Task 4）、e2e 验收（Task 5）、1.5.0 发布（Task 6）。规格里的「写稿不进 applyResolved」「draftTarget 回查 chapterId」「插中间不重排编号」都有对应步骤。
- **类型一致性**：`DraftJob`/`DraftProgress`/`DraftDeps`/`runDraftJobs` 在 Task 3 定义，Task 4 按同一签名使用；`draftTarget`/`writeTarget`/`chapterCreate` 在 Task 2 定义，Task 4 消费。
- **规格与计划的差异**：规格的 `DraftDeps` 没写 `generate`，计划把它列为注入点（不直接 import 模型层，单测才好做替身）。其余一致。