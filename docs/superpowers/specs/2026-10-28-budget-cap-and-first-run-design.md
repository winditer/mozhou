# 输出上限提高 + 结构化任务关思考 + 首次使用路径 + 渠道弹窗内配模型

日期：2026-10-28
状态：已实现

## 背景

1. 用户把「体检 → 全书一致性」顶到设置页的上限 32768 后，仍然被提示「Token 耗尽」。
   排查结论：**卡住的不是模型，而是思考 token**。DeepSeek V4 系列默认开思考
   （`thinking.type` 默认 `enabled`，`reasoning_effort` 默认 `high`），reasoning token 与正文
   共用同一份 `max_tokens`；全书体检的输入是角色卡 + 世界观 + 时间线 + 伏笔台账 + 全部章节梗概，
   思考轻易吃掉 2–4 万 token，剩下的额度写不完 3–12 条 JSON。
   而 32768 只是应用自设的夹取上限，DeepSeek 官方 `max_tokens` 允许到 393216，上下文 1M。
2. 第一次打开会直接落在设置页（见 `store.init`），但设置页里没有任何「去书架」的出口，
   只有标题栏的「墨舟」logo 能点——用户配完 Key 就不知道下一步该去哪儿。
3. 渠道的模型列表藏在卡片的「模型 N」展开面板里，默认收起。用户配完 Key 保存后
   以为完事，实际模型为空，生成时才报「没有可用模型」。

## 决策

### 一、输出上限 32768 → 131072，结构化任务关思考

- 上限取 `MAX_OUTPUT_TOKENS = 131072`（128K），理由：DeepSeek 默认思考档位就是 64K，
  `reasoning_effort=max` 才到 128K；写作类调用单章最多几万字，128K 足够覆盖体检、
  整卷摘要这些最大项。再高只会让误设的数值把等待时间与费用顶穿。
- 上限只有一个来源：`budgets.ts` 导出常量，设置页输入框与 `CHAT_RETRY_CEIL` 都引用它，
  不再各写一个数字。
- 关思考是**逐调用点**的可选项，不是全局开关：`ChatRequest.thinking?: 'off'` →
  `registry` → `streamOpenAI`。适配器只在 DeepSeek 渠道（`presetId === 'deepseek'`
  或 baseUrl 含 deepseek）才真的发 `thinking: { type: 'disabled' }`，
  其他渠道忽略——把不认识的字段发给 OpenAI / Anthropic 兼容网关会直接 400。
- 网关 400 且报文提到 thinking / reasoning 时，自动摘掉该字段重试一次（与现有
  `max_tokens` → `max_completion_tokens` 的兼容重试同一套写法），优化项失败不能拖垮请求。
- 只在体检三件套（全书 / 章节 / 伏笔）传 `thinking: 'off'`。正文生成、续写、对话不动：
  那些任务要从思考里拿质量。

### 二、第一次使用能清楚回到书架

- 标题栏在非书架页显示**「书架」按钮**（BookOpen 图标 + 文字），不再只靠 logo。
- 设置页顶部在「一本书都没有」时显示引导条：配好模型 → 点「去书架」。
  文案随是否已配置渠道变化（未配置时给路径，已配置时直接说下一步）。
- 不改启动落点：首启仍进设置页，引导条负责把路指出来。

### 三、模型列表迁入渠道新增/编辑弹窗

- `ChannelCard` 只保留状态与操作：Key 状态、`N 个模型 · M 个启用`、测试连接 / 编辑 / 删除。
  没有模型时卡片直接标红提示「点『编辑』进去添加」。
- `ChannelDialog` 内嵌 `ChannelModels`：启用开关、显示名/上下文/单价行内编辑、移除、
  手填模型 ID、从接口拉取（用表单里的 BaseURL + 本次输入的 Key；编辑已有渠道且 Key
  留空时回落到钥匙串）。
- 模型与渠道**一次原子提交**：弹窗内所有增删改都是内存态，取消即丢弃。
- 提交逻辑抽成纯函数 `commitChannelAndModels`（`channelCommit.ts`）：
  渠道 upsert、该渠道模型整组替换、被删模型 id 从 `taskModels` 清空
  （`clearTaskRefs` 移到 `@shared/taskModels`，渠道删除与弹窗共用同一份口径）。
- 预设的常用模型改为**预填到弹窗模型列表**，不再保存时静默并入。

### 四、标题栏红绿灯与右侧按钮对齐

标题栏高 42px，右侧图标按钮 30px 垂直居中 → 中线 21px。系统红绿灯直径 12px，
`trafficLightPosition.y` 应为 `21 - 6 = 15`；原值 20 让灯心落在 26，比右侧按钮低 5px。

## 测试

- `test:budgets` 补三条边界：32768 仍合法、65536 合法、`MAX+1` 被夹回。
- `test:thinking`（新增，假网关 + 真 registry）：DeepSeek 带 `thinking:{type:'disabled'}`、
  非 DeepSeek 不带、普通生成不带、网关 400 后摘字段重试成功。
- `test:channel-commit`（新增）：编辑/新增/清空/换 id 四种场景，钉住模型整组替换与
  任务分配清理、以及不误伤其他渠道。
- 端到端：`e2e:audit`、`e2e:thought-starved`、`e2e:length-guard`、`test-empty-completion`、
  `test-ai-timeouts` 全绿；弹窗保存与「从接口拉取」用真 Electron + 假网关手工验收
  （截图 `shots/channel-dialog.png`、`shots/channel-pull.png`、`shots/settings-first-run.png`）。