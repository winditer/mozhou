# 对话直接改稿（Chat Edit Agent）设计

日期：2026-10-27
状态：待评审

## 背景

写作页右侧的「AI 对话」目前只能聊天。它知道当前章、前文、设定与大纲（`assembleContext` 已经把这些装进上下文），能说清「这一段哪里松了」，但说完就断了：作者要自己回到正文里找那句、自己想怎么改、自己敲进去。真正耗时的不是想，是「把想法落成文字」这一步。

与之对照，应用里已经有两条**会真的动稿子**的链路，它们各自把「AI 提议 → 作者确认 → 落地」做对了一半：

- **体检 → 采用建议**（`Workspace/audit/`）：`apply.ts` 拿 `evidence` 回正文里定位段落，只把被点名的段落交给 AI 重写，绝不退化成整章重写；`ApplyPreview.tsx` 把改前/改后并排摆出来，作者看过才点确认。
- **章节正文的 `versions` 快照**（`store/app.ts` 的 `pushSnapshot`）：每次改正文自动压一份「改之前」，最多 20 份、一分钟内合并。

缺的是把这两块接起来，并给对话一条「说得出精确修改」的通道。

## 目标

让作者在对话里说「把第三段结尾那句改掉」「全书『父亲』改成『大伯』」「把第三章梗概重写、顺便给林昭补一条角色卡」，AI 能给出**可校验、可预览、可回滚**的具体修改，作者一次确认后落地。

## 非目标

- **不碰磁盘上的任意文件。** 不外挂 markdown、不导出 docx、不做通用文件 Agent。可改的只有作品数据：`chapters[].content/title/summary`、`outline`、`bible`、`brief`。
- **不做 tool calling / 多轮 Agent 循环。** 模型这一轮只能提出修改，不能自己再去读别的章节。真需要「改第 5 章前先翻第 4 章」时再升级（见「分期」）。
- **不做字符级 diff。** 修改粒度到段落，理由见「决策记录」。
- 不改正文生成链路（`generateDraft` / 润色 / 体检）的任何行为。
- 不做全量 undo 栈，只保证「撤销上一次批量应用」。

## 决策记录

| 议题 | 决策 | 理由 |
| --- | --- | --- |
| 技术路线 | 结构化补丁协议（JSON 块），不上 tool calling | 用户走第三方中转（`llm.prana.chat`），不保证透传 `tools`；三套适配器加 tool 解析成本是 3–4 倍，且没法在本机验证远端是否支持 |
| 修改粒度 | 段落级，不给字符偏移 | 字符偏移要模型算位置，算错就改到别处且**看不出来**；段落级有 `anchor` 兜底，定位失败能如实报告 |
| 定位方式 | `anchor` 必须是正文原话，精确 → 归一化 → 唯一子串 | 与 `audit/apply.ts` 的 `locateEvidence` 同源纪律：找不到就报找不到，绝不退化 |
| 落地方式 | 一次性汇总确认（扩展 `ApplyPreview`） | 作者已在体检链路里习惯这套；逐条弹窗会把对话打碎 |
| 写入方式 | 新增 `applyEditBatch`，单次 `patchProject` | `patchChapter` 内部各自 `patchProject`，改 5 章 = 5 次落盘 |
| 正文回滚 | 复用 `versions` 快照 | 已有基础设施，界面里已有版本历史入口 |
| 结构化字段回滚 | 只保留「撤销上一次批量改动」的 inverse patch | 大纲/设定做全量快照会让 `project.json` 无声膨胀 |
| 单轮上限 | 20 条 op | 防模型跑飞，也防作者审不过来 |
| 解析失败 | 保留自然语言回答 + 明说「格式坏了」，可一键重发 | 静默丢弃等于让作者以为 AI 没听懂 |
| op 持久化 | 存进 `ChatMessage.edits` + `editsAppliedAt` | 确认前刷新页面不丢；已应用的按钮置灰，避免重复应用 |

## 协议

### 模型侧

对话 system prompt 追加一段说明 + op 白名单。回答照常是自然语言，只有真要动手时才追加一个受控代码块：

````
```mz-edit
{"edits":[
  {"op":"replace_paragraph","chapter":"第3章","anchor":"他把伞合上，转身就走。","after":"他把伞合上，却没走——屋檐下还有一个人在等。"},
  {"op":"set_chapter_summary","chapter":"第3章","after":"陈默发现母亲留下的钥匙对不上门。"},
  {"op":"bible_upsert","kind":"characters","name":"林昭","fields":{"motivation":"查出那封信为什么没寄出"}}
]}
```
````

规则（写进 prompt，也写进校验器，两侧同源）：

1. `anchor` 必须逐字摘自正文，不要概括、不要改标点；
2. 一次只提**确实需要改**的地方，不要为了显得勤奋而重写整章；
3. 拿不准就说明白，不要猜原文；
4. 不输出除 `mz-edit` 之外的其他围栏，自然语言部分照常写给作者看。

### op 白名单（第一版 7 个）

| op | 作用 | 必填字段 | 落地对象 |
| --- | --- | --- | --- |
| `replace_paragraph` | 换掉一整段 | `chapter` `anchor` `after` | `chapters[].content` |
| `insert_paragraph` | 在某段之后插入 | `chapter` `anchor` `after` | `chapters[].content` |
| `delete_paragraph` | 删掉某段 | `chapter` `anchor` | `chapters[].content` |
| `replace_literal` | 纯文本批量替换 | `scope`(`book`\|`chapter`) `from` `to`（+`chapter`） | `chapters[].content` |
| `set_chapter_summary` | 改章节梗概 | `chapter` `after` | `chapters[].summary` |
| `set_outline_node` | 改大纲节点 | `node` `field`(`title`\|`summary`\|`status`) `after` | `outline`（递归查找 `id`/`title`） |
| `bible_upsert` | 新增或更新设定条目 | `kind`(`characters`\|`world`\|`terms`\|`timeline`\|`threads`) `name`（+`fields`） | `bible[kind]` |

`set_outline_node.field` 只允许 `title` / `summary` / `status`：大纲节点的 `children` 结构、`type` 都不许 AI 动——重排大纲是作者的权力，AI 猜错一次整本书的结构就乱了。

`bible_upsert` 的 `fields` 只接受该条目已存在的字段名（`Character` 的 `role/age/identity/appearance/personality/motivation/flaw/arc/speechStyle/notes/hidden`，`WorldEntry` 的 `category/title/content/visible`，`Term` 的 `definition`，`TimelineEvent` 的 `time/title/desc`，`Thread` 的 `setup/payoff/status/level`）。未知字段丢弃并在预览里列出，不静默写入。

### 校验

`parseEditBlock(text)` → `{ ops: EditOp[], errors: string[] }`：

- 找 ```mz-edit 围栏，取最后一个（模型可能先给示例）；
- `JSON.parse` 失败 / 不是对象 / `edits` 不是数组 → 整块记一条错误，`ops` 为空；
- 逐条校验 op 名与必填字段，非法条目**单独丢弃并记错误**，不牵连其他条目；
- 超过 20 条 → 整轮拒收（`ops` 清空 + 一条错误），不静默截断；
- `chapter` 解析顺序：`id` → 标题全等 → 「第N章」序号 → 标题包含；多解算歧义。

## 定位

`resolveEdits(project, ops)` 逐条产出 `ResolvedEdit`：

```
{ op, ok: 'found' | 'ambiguous' | 'not-found', chapterId, chapterTitle,
  index?, before, after, hits?: number[], note? }
```

段落切分与 `audit/apply.ts` 的 `BodyParagraph` 保持同一套（按 `<p>` 切、带原始起止位置）。定位顺序：

1. 归一化后（去空白、全半角统一）在段落里找 `anchor`；
2. 命中 1 段 → `found`；
3. 命中多段 → `ambiguous`，记下所有段号；
4. 完全没命中 → `not-found`。

**任何一种非 `found` 都不许自动改写**，也不许降级成「整章重写」。

`replace_literal` 不走段落定位，直接统计 `from` 在范围内的出现次数并在预览里报数（0 次也算 not-found）。

## 链路

```
提问 ─► assembleContext（现有：当前章 + 前文 + 设定 + 大纲）
     ─► 模型返回（自然语言 + 可选 mz-edit）
     ─► parseEditBlock      ─ 解析失败 ─► 气泡保留正文 + 「格式坏了，重发」按钮
     ─► resolveEdits        ─ 逐条 found / ambiguous / not-found
     ─► 气泡「本轮提出 4 处修改 · 查看并应用」
     ─► 预览弹窗（扩展 ApplyPreview：按章分组、逐条勾选、状态色）
     ─► 确认 ─► applyEditBatch(edits) ─► 单次 patchProject + 每章压快照
     ─► toast「已改 4 处，可在章节版本历史里回退」
```

## 代码落点

| 文件 | 职责 | 性质 |
| --- | --- | --- |
| `src/shared/editProtocol.ts` | op 类型、校验、`parseEditBlock`、`renderEditPrompt`、章节/节点名解析 | 新增，纯 TS，无依赖（`shared` 纪律） |
| `src/renderer/lib/applyEdits.ts` | `resolveEdits` / `applyResolved`（纯函数，输入输出都是 `Project`） | 新增 |
| `src/renderer/store/app.ts` | 新增 `applyEditBatch(edits)`：一次 `patchProject` 内改完所有章并压快照 | 改 |
| `src/renderer/components/AIPanel.tsx` | 解析 op、存 `ChatMessage.edits`、气泡按钮、调预览弹窗 | 改 |
| `src/renderer/pages/Workspace/audit/ApplyPreview.tsx` | 加 `not-found` / `ambiguous` 两种状态色与「已应用」态；props 向后兼容 | 改 |
| `src/shared/types.ts` | `ChatMessage.edits?`、`ChatMessage.editsAppliedAt?` | 改 |
| `src/shared/budgets.ts` | `chat.reply` 默认 8192 → 12000（编辑块是额外输出） | 改 |
| `src/renderer/pages/Settings/BudgetsSection.tsx` | 说明补一句「允许改稿时建议 12000 以上」 | 改 |

`pushSnapshot` 目前是 `app.ts` 里的私有函数，`applyEditBatch` 与它同文件，直接复用，不导出。

## 界面

- **不改聊天布局。** 有 op 时气泡底部多一行「本轮提出 4 处修改 · 查看并应用」，没有 op 时和现在完全一样。
- **预览弹窗**沿用 `ApplyPreview` 的分组与 diff 呈现（按章分组、段号、变化区间高亮），新增：
  - 每条左侧复选框，`not-found` 置灰不可选并标红说明；
  - `ambiguous` 标黄并列出所有命中段号（第一版只标出、不改）；
  - 底部「应用选中 N 处」，旁边一行小字写明「正文改动可在章节版本历史里回退」。
- **应用后**：弹窗关闭、气泡按钮变「已应用」置灰。
- **结构化改动**（大纲/设定/梗概）在预览里按「字段名: 旧 → 新」单行展示，不做字符 diff。

## 失败矩阵

| 情况 | 处理 |
| --- | --- |
| JSON 坏了 | 自然语言回答照常显示 + 「这段修改我读不懂，重发一次」按钮（只请求 JSON） |
| 找不到 anchor | 该条标红、不可勾选，写明「第 3 章里没找到这句话」 |
| anchor 命中多处 | 标黄、列出段号；第一版不改，提示作者在对话里指明「第几段」 |
| op 超 20 条 | 整轮拒收，提示分批 |
| 章节名对不上 | 同 not-found，列出书名下所有章节标题 |
| 模型只聊天 | 与现状零差异 |
| 应用抛错 | 先算完再写（`applyResolved` 纯函数先跑通），整批不落地，不出现改了一半 |

## 回滚

- 正文：每章一份「改之前」快照进入 `versions`（已有界面入口）。
- 结构化字段：`applyEditBatch` 同时把 inverse patch 放进 store 的内存字段 `lastEditUndo`，界面给一个「撤销本次改动」（应用后 30 秒内）。不做持久化，重启即失效——这类改动本来就该当场看着不对就撤。

## 预算

编辑块是额外输出，且 JSON 比自然语言更啰嗦（一遍 anchor 要把原文抄回来）。`chat.reply` 默认提到 **12000**；被 `max_tokens` 截断时半截 JSON 走「坏块」分支，提示调额度或重试。

## 测试

| 脚本 | 覆盖 |
| --- | --- |
| `scripts/test-edit-protocol.mjs` | 正常块 / 坏 JSON / 超 20 条 / 非法 op / 缺字段 / 无围栏 / 多围栏取最后一个 / 章节名三种解析 |
| `scripts/test-apply-edits.mjs` | 精确命中 / 忽略空白 / 多命中 / 找不到 / 批量应用后正文正确 / 快照份数 / 结构化字段写入 / 未知字段被丢弃 |
| `scripts/e2e-chat-edit.cjs` | 假网关返回带 mz-edit 的回答 → 预览弹窗出现且条目数正确 → 应用 → 正文变化、`versions` 增加、气泡标「已应用」、落盘后重开仍在 |

三个脚本都能脱离 Electron 跑（前两个）、或复用现有 `scripts/shot.cjs` 的 Electron 驱动（第三个）。

## 分期

**第一版（本设计）**：7 个 op、一次性确认、快照回滚、`replace_literal` 跨章批量、歧义只标不改。

**第二版（不在本次范围）**：
- 歧义时人工选目标段；
- 让模型自己来查（tool calling 化）：同一份 op 语义换成 tool schema，落地层零改动；
- 多轮「改完再检查」的闭环。

## 风险

| 风险 | 缓解 |
| --- | --- |
| 模型输出格式不稳定（思考模型尤其容易跑偏） | 校验器逐条丢弃 + 明确提示；prompt 里给一个正例一个反例 |
| `anchor` 抄错一个标点就定位失败 | 三级匹配（精确 → 归一化 → 唯一子串）；失败如实报告，作者一句话就能补正 |
| 作者不看预览直接点应用 | 按钮文案写清改了几处、动了几章；结构化改动逐行展示 |
| 一次改太多章后悔 | 单轮 20 条上限 + 每章快照 + 30 秒撤销 |

## 开放问题

1. **`replace_literal` 要不要限制范围？**「全书『父亲』改成『大伯』」是本设计里最有用的 op，也是最容易误伤的（角色名碰撞）。第一版靠预览里的命中数 + 逐条 diff 兜底，是否需要限制「只替换出现在对白之外的」留待实测。
2. **对话历史里已应用的 op 要不要重放？** 当前设计只置灰按钮，不提供「重新应用」。若实测常用，再补。
3. **换模型后格式兼容性。** 不同模型对 JSON 的服从度差别很大，第一版靠校验器兜底；若 `deepseek-v4.1-flash` 实测服从度低，需要在设置里加「允许对话改稿」总开关，默认关闭。