# 墨舟 Mozhou — 产品与技术设计书

> 一款 macOS / Windows 双平台的本地优先 AI 写作应用。
> 核心命题：**不同场景、不同主题、不同篇幅，配任意模型与自定义渠道。**

版本：v1.0 · 2026-10-22

---

## 1. 定位

竞品把 AI 写作做成了"云端订阅制的内容工厂"：蛙蛙做小说→剧本→漫剧的 IP 流水线，马良做长篇网文的项目管理 + 多 Agent 工程化，FeelFish 做桌面优先的 Human-in-the-loop 写作 Agent。三家共同短板是**形态**（蛙蛙/马良纯 Web）、**计费**（积分制不透明）、**数据主权**（资产锁定在云上）、**场景广度**（都只服务小说作者）。

墨舟的定位：**本地优先、自带模型、全场景覆盖的桌面写作工坊。**
不卖算力，不卖积分，只做工具。稿子在你硬盘上，模型用你自己的 Key。

一句话：**一叶墨舟，渡你过万卷长文。**

---

## 2. 三个"不同"如何落地

需求里的三个"不同"，是产品的三条主干道，每一条都对应一个可配置的抽象层。

### 2.1 不同场景 → 场景模板（Scene Preset）

场景不是皮肤，是**一整套写作契约**：角色设定、结构骨架、篇幅默认值、快捷动作、可用题材。

每个场景定义：

| 字段 | 作用 |
|---|---|
| `systemPrompt` | 该场景的专业写作规则（编辑器/编辑角色设定） |
| `structure` | 结构模板（大纲层级骨架，如"三幕/卷-章/场次"） |
| `lengthProfile` | 默认目标字数区间、篇幅档位 |
| `actions` | 场景专属快捷动作（如网文的"加章末钩子"、剧本的"转场"） |
| `tonePresets` | 语气词表（冷峻/热血/克制/幽默…） |
| `themeTags` | 关联的题材标签 |

内置 12 个场景：

1. 长篇小说（网文连载） 2. 短篇小说 3. 短剧 / 剧本 4. 同人 / 二创
5. 公众号 / 新媒体 6. 小红书 / 种草 7. 短视频脚本 8. 品牌文案 / 广告
9. 职场商务（周报/邮件/方案） 10. 学术论文 11. 童话 / 儿童文学 12. 自由写作

场景可扩展：用户可复制内置场景、改提示词、另存为自定义场景。

### 2.2 不同主题 → 双层主题系统

"主题"在写作软件里有两个意思，我们两个都做：

**A. 视觉主题（UI/排版）**

- 5 套配色皮肤：纸白 Paper / 墨黑 Midnight / 护眼米黄 Sepia / 雾蓝 Mist / 森林 Forest
- 排版可调：字体（系统衬线 / 黑体 / 霞鹜文楷等，可自填字体名）、字号 14–24、行距 1.4–2.2、页宽 560–1100px、首行缩进、段间距、聚焦段落变暗
- 编辑器支持"打字机滚动"与"专注模式"（仅高亮当前段落）

**B. 内容主题（题材）**

16 个题材标签：玄幻 / 仙侠 / 都市 / 悬疑 / 科幻 / 言情 / 历史 / 军事 / 游戏 / 末世 / 无限流 / 系统流 / 现实 / 青春 / 奇幻 / 恐怖。
题材影响：提示词注入的题材公约、设定库的默认分组（如玄幻自动出现"力量体系"）、命名风格建议。

### 2.3 不同篇幅 → 字数引擎（Length Engine）

这是最容易做烂、也最容易做出差异的部分。竞品普遍只给"大约 2000 字"。

我们做**目标字数约束 + 长度守护（Length Guard）**：

| 能力 | 说明 |
|---|---|
| 精确目标 | 每章可设 300–20000 字目标，滑杆 + 数字输入 |
| 篇幅档位 | 微文案(<300) / 短篇(300–3000) / 中篇(3000–2万) / 长篇(2万–50万) / 超长篇(50万+) |
| 生成预算 | 按目标字数反推 max_tokens，避免半截话 |
| 长度守护 | 生成结束统计中文字数：低于目标 85% → 自动追加"继续"直到达标（最多 3 轮）；高于 115% → 自动请求收束 |
| 全书目标 | 设定全书目标字数，自动推算需多少章、每章多少字 |
| 实时度量 | 编辑器底部实时字数 / 目标进度 / 距目标差值 / 预计还需几章 |

---

## 3. 模型与自定义渠道

### 3.1 渠道（Channel）

一条渠道 = 一个接入点。字段：

```
id, name, protocol('openai'|'anthropic'|'gemini'), baseUrl,
apiKey(加密存储), headers{}, queryParams{}, proxy, enabled,
models[]  // 手工填写或从 /models 拉取
```

内置预设（一键填入 BaseURL，只需填 Key）：

| 预设 | BaseURL | 协议 |
|---|---|---|
| OpenAI | https://api.openai.com/v1 | openai |
| Anthropic | https://api.anthropic.com | anthropic |
| Google Gemini | https://generativelanguage.googleapis.com/v1beta | gemini |
| DeepSeek | https://api.deepseek.com/v1 | openai |
| 通义千问 DashScope | https://dashscope.aliyuncs.com/compatible-mode/v1 | openai |
| Kimi Moonshot | https://api.moonshot.cn/v1 | openai |
| 智谱 GLM | https://open.bigmodel.cn/api/paas/v4 | openai |
| 硅基流动 | https://api.siliconflow.cn/v1 | openai |
| OpenRouter | https://openrouter.ai/api/v1 | openai |
| 火山方舟 | https://ark.cn-beijing.volces.com/api/v3 | openai |
| 本地 Ollama | http://127.0.0.1:11434/v1 | openai |
| 自定义 | 任意 | 三选一 |

### 3.2 模型条目与任务级路由

模型条目 = `{ id, channelId, modelName, displayName, tags[], contextWindow, priceIn, priceOut }`。

**任务级路由**：不同写作任务绑不同模型，兼顾质量与成本。

| 任务 | 建议 |
|---|---|
| 正文生成 draft | 长文能力强的主力模型 |
| 大纲推演 outline | 推理型模型 |
| 润色改写 polish | 文笔好的模型 |
| 起名命名 naming | 便宜快模型 |
| 摘要压缩 summary | 便宜快模型 |
| 一致性审校 audit | 强推理 + 长上下文 |
| 对话 chat | 默认模型 |

### 3.3 其他能力

- 连接测试（发一条 1 token 请求，回显延迟与模型真实名）
- 拉取模型列表（GET /models）
- 流式 SSE 输出 + 随时中断
- 超时按「有没有进展」判断，而不是「首字多快」：响应头、SSE 事件、心跳注释、思考增量（`reasoning_content`）都算进展，连续 180 秒毫无进展才中止。这样思考类模型先想两分钟、网关排队只发心跳，都不会被误判成超时
- 思考增量单独走 `ai:thought` 通道：界面显示「模型正在思考…（已 N 字）」和已等待秒数，正文只写 `ai:chunk`
- 网关无视 `stream: true`（返回整段 JSON）时自动回退成非流式解析，不必换渠道
- 所有 AI 调用点（正文生成、润色、梗概、对话、大纲、设定补全、全书体检、章节体检、伏笔猎手、一键开书、文风提炼、试写对比、灵感抽卡）统一透出进度：`模型正在思考…（已 N 字）` / `已收到 N 字 · 已等待 N 秒`，任意一步都能随时停止
- 用户主动停止（`已中止`）按普通提示收尾，不当错误弹红；renderer 侧不设任何硬超时
- 用量账本：每本书 / 每次调用记录 tokens 与估算费用（按用户填的单价，或内置常见价目）
- Key 用 Electron `safeStorage` 加密落盘（AES via OS keychain）

---

## 4. 写作工作台

### 4.1 信息架构

```
书架 Bookshelf        （封面四档 50/100/150/196px；⋯ → 编辑信息：书名/作者/题材/简介/梗概/封面色）
  └─ 作品工作区 Workspace
       ├─ 写作 Editor      （中：编辑器 / 右：AI 面板 / 左：章节树）
       ├─ 大纲 Outline     （卷 → 章 树，拖拽、AI 生成/推演）
       ├─ 设定 Bible       （角色 / 世界观 / 地点 / 术语 / 时间线 / 伏笔）
       ├─ 灵感 Ideas       （碎片、抽卡、剧情分支）
       ├─ 统计 Stats       （字数曲线、连续天数、用量与费用）
       └─ 设置 Project Settings
全局设置 Settings（主题 / 排版 / 渠道 / 模型路由 / 快捷键 / 数据）
首屏路由：firstRunDone=false 且没有任何作品 → 设置页（同时写入 firstRunDone=true）；否则一律书架
```

### 4.2 编辑器

- 富文本（Tiptap 3），Markdown 快捷输入，章节标题层级
- 沉浸写作（⌘⇧F）：隐藏左栏/章节树/动作条/字数条并进入系统全屏；Esc 退出，⌘J 时 AI 面板切换为右侧浮层
- 选区动作：续写 / 扩写 / 改写 / 润色 / 精简 / 去 AI 味 / 换语气 / 翻译 / 生成对话
- 生成方式二选一：**替换选区** / **插入到下方** / **对比视图（原 vs 新，逐段接受）**
- 自动保存（防抖 800ms）+ 原子写 + 快照（每章保留最近 20 个版本，可回滚）
- 快捷命令面板（⌘K）

### 4.3 上下文装配器（Context Builder）

长篇写作的核心。按 token 预算装配上下文，每一项可单独开关并显示预估 token：

1. 场景 systemPrompt + 题材公约
2. 本书 brief（一句话前提 / 关键词）
3. 设定库（全量 / 仅名称 / 关闭 —— 三档）
4. 角色卡（全量 / 仅出场角色 / 关闭）
5. 大纲（总纲 / 当前卷 / 当前章 / 关闭）
6. 前文：最近 N 章全文 + 更早章节的 AI 摘要（滚动摘要，自动维护）
7. 文风分身特征卡 + 样本
8. 当前章已写内容（续写时）
9. 用户指令

预算超出时按优先级裁剪（先裁远期摘要，再裁设定全量，最后裁角色全量），并在 UI 上明示"已裁剪"。

### 4.4 一键开书（Wizard Pipeline）

对标马良的 5 步流水线，但**全部产物可编辑、可重跑单步、可断点续跑**：

灵感/设定输入 → ① 书名 + 简介 → ② 核心设定（6–10 条，落库为设定条目）→ ③ 分卷大纲 → ④ 首卷章纲 → ⑤ 首章正文

每步一张产物卡，可「重新生成 / 手工编辑 / 采纳」。断点续跑不重复调用已完成的步骤。

### 4.5 文风分身（Style Profile）

两套东西，**引用而非拷贝**：

**A. 系统文风分身库**（`src/shared/styleLibrary.ts` + `main/storage/styleLibrary.ts`）

- 全局共享，存在 `userData/style-library.json`（独立文件，不塞进 config——100 位作者 + 用户自建轻松几百 KB，而 config 每次改主题都要整体重写）
- 内置 **100 位作者 / 6 大流派**：传统文学 18、网文金牌 18、言情女性向 16、悬疑科幻 17、历史武侠 16、新类型 15
- 每位 = 6–8 条**可执行**特征 + 40–70 字风格摘要 + 标签 + 代表作 + 可选的用户补样本
- **不内置名家原文样本**（版权）；种子只放特征卡，用户需要时自己补
- 首次启动自动播种；`seedVersion` 控制补种，**升级不覆盖用户改动**；删掉的内置分身记进 `deletedBuiltin` 墓碑，不会被补种"复活"
- 设置页支持：搜索（名字/标签/摘要/特征/代表作，空格分词全命中）、分类筛选、标签筛选、新建/编辑/删除/复制、**AI 辅助**（按描述生成 或 按样本提炼）、恢复内置

**B. 书内分身**（`StyleProfile`）

- 两种形态：`sourceRef` 存在 = **引用系统库**；不存在 = **书内自建**
- 引用态生成时按 `sourceId` 回库取当前值（实时跟随），库里删了则回落 `snapshotName` + 引用时快照，并标 `missing`
- 自建态仍走原流程：2–5 段样本（≤5000 字）→ 提炼 3–6 条特征 → 试写对比

**注入格式**（`lib/prompt.ts` 的 `renderStyleBlock`，试写页 `styleBlock` 同源）：

```
【文风要求 —— 必须严格遵守】
本分身取法：<summary>
1. <trait>
...
〈样本 N〉<前 1600 字>
```

所有生成路径（正文 / 改写 / 大纲 / 对话 / 一键开书）都透传 `library`，漏传一处会退回旧快照——
因此 `library` 放在 `GenParams` 基类上而不是逐处传。

### 4.6 一致性与救急

- **剧情推演抽卡**：同一上下文并发调 3 个模型/3 次采样，出 3 个后续分支，可单独重生成、一键写入章纲
- **一致性体检**：扫描全书，输出人设冲突 / 时间线冲突 / 未回收伏笔清单（分级：高/中/低）
- **章节体检**：节奏、冲突强度、悬念、注水风险四项评分 + 建议

### 4.7 导入导出

- 导出：Markdown、TXT（整本/分章）、HTML、DOCX（真实 docx，非伪扩展名）、PDF（打印引擎）
- 导入：md/txt 自动分章（按 `第N章` / `#` 标题切分），可预览后确认
- 备份：整库导出 `.mzbak`（zip），可完整还原 —— **数据主权是卖点，不是功能**

---

## 5. 技术架构

### 5.1 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | Electron 43 | 双平台打包成熟，无原生依赖；43 是最后支持 macOS 12 Monterey 的大版本，`LSMinimumSystemVersion` 固定 12.0 |
| 构建 | electron-vite 6 | main/preload/renderer 三端一体，渲染层 HMR |
| UI | React 19 + TypeScript 5 + Tailwind CSS 4 | 生态与可维护性 |
| 状态 | Zustand 5 | 轻、无样板代码 |
| 编辑器 | Tiptap 3 | 富文本 + 可扩展 + 成熟 |
| 打包 | electron-builder 26 | dmg（arm64+x64）与 nsis（win）一套配置 |
| 存储 | 本地 JSON + 原子写 | 零原生模块 → 安装成功率 100%；可读、可备份、可 git |
| 加密 | Electron safeStorage | Key 走系统钥匙串 |

**刻意不用**：SQLite（原生模块要 electron-rebuild，跨平台易翻车）、云服务、账号体系。

### 5.2 进程与安全边界

```
┌─────────────── Renderer (React) ───────────────┐
│ 纯 UI + 状态。不碰文件系统、不发网络请求。      │
└───────────────┬────────────────────────────────┘
                │ contextBridge: window.mz (typed)
┌───────────────┴────────────────────────────────┐
│                  Preload                         │
│ 仅暴露白名单 IPC 通道                            │
└───────────────┬────────────────────────────────┘
┌───────────────┴────────────────────────────────┐
│                   Main                           │
│ ├ storage/  JSON 项目库（原子写 + 备份）         │
│ ├ ai/       Provider 适配器 + SSE 流式 + 中止    │
│ ├ config/   渠道与设置（Key 加密）               │
│ ├ export/   md/txt/html/docx/pdf                 │
│ └ ipc/      处理器注册                           │
└──────────────────────────────────────────────────┘
```

安全要点：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、禁止 `webSecurity: false`、外链走 `shell.openExternal` 且校验协议。

### 5.3 目录结构

```
AIWriter/
├─ electron.vite.config.ts
├─ package.json
├─ electron-builder.yml
├─ src/
│  ├─ main/
│  │  ├─ index.ts              入口、窗口、菜单、生命周期
│  │  ├─ paths.ts              userData 路径与开发期覆盖
│  │  ├─ storage/
│  │  │  ├─ jsonStore.ts       原子读写 + 备份
│  │  │  ├─ projects.ts        项目 CRUD
│  │  │  └─ config.ts          渠道/设置/Key
│  │  ├─ ai/
│  │  │  ├─ types.ts
│  │  │  ├─ openai.ts          OpenAI 兼容适配器
│  │  │  ├─ anthropic.ts
│  │  │  ├─ gemini.ts
│  │  │  ├─ registry.ts        按协议分发 + 中止管理
│  │  │  └─ sse.ts             SSE 解析
│  │  ├─ export/{markdown,txt,html,docx,pdf}.ts
│  │  └─ ipc/index.ts
│  ├─ preload/index.ts
│  ├─ shared/                  主/渲染共用：类型、场景、主题、提示词
│  │  ├─ types.ts
│  │  ├─ scenes.ts
│  │  ├─ genres.ts
│  │  ├─ themes.ts
│  │  ├─ providers.ts
│  │  └─ prompts.ts
│  └─ renderer/
│     ├─ index.html
│     ├─ main.tsx
│     ├─ App.tsx
│     ├─ styles/
│     ├─ store/                zustand slices
│     ├─ components/
│     └─ pages/{Bookshelf,Workspace,Settings}
└─ docs/
```

### 5.4 数据模型（节选）

```ts
type Project = {
  id: string; title: string; author: string; coverColor: string;
  sceneId: string; genreId: string;
  createdAt: number; updatedAt: number;
  brief: { logline: string; premise: string; keywords: string[] };
  settings: {
    targetWordsPerChapter: number;
    targetTotalWords: number;
    lengthMode: 'strict' | 'soft';
    pov: string; tense: string; tone: string[]; audience: string;
    extraRules: string; modelOverrides: Partial<Record<TaskKind, string>>;
  };
  bible: {
    characters: Character[]; world: WorldEntry[]; places: Place[];
    terms: Term[]; timeline: TimelineEvent[]; threads: Thread[]; // 伏笔
  };
  outline: OutlineNode[];          // 树：volume → chapter
  chapters: Chapter[];
  styleProfile?: StyleProfile;
  ideas: Idea[];
  usage: UsageRecord[];
};
```

### 5.5 IPC 契约（白名单）

```
invoke: app:info · app:openExternal
        config:get · config:save · secret:set/has/clear
        project:list · create · get · save · remove · duplicate · import · backup
        ai:chat (流式) · ai:abort · ai:test · ai:models
        export:docx · export:pdf · export:file
        dialog:open · dialog:save
event : ai:chunk · ai:done · ai:error
```

---

## 6. 视觉设计

- 三栏式工作台：左栏（章节树/设定树）· 中栏（编辑器）· 右栏（AI 面板）
- 无边框标题栏（macOS `titleBarStyle: hiddenInset`），自绘顶栏
- 全部颜色走 CSS 变量，切主题只换变量表
- 字体：中文正文字体可切换（系统 / 思源宋体 / 思源黑体 / 霞鹜文楷）
- 动效克制：只做面板开合与生成光标闪烁

---

## 7. 里程碑

| M | 内容 | 验收 |
|---|---|---|
| M1 | 工程骨架、构建链路、窗口、主题变量 | `pnpm dev` 起窗口 |
| M2 | 存储层 + 配置层 + 渠道管理页 | 建书、存稿、配渠道、测连接 |
| M3 | AI 层（三协议 + SSE + 中止 + 用量） | 真实 Key 能流式生成 |
| M4 | 编辑器 + 场景 + 篇幅引擎 + 选区动作 | 写作全流程可用 |
| M5 | 大纲 / 设定库 / 上下文装配 / 一键开书 / 文风 | 长篇可写 |
| M6 | 导出 / 导入 / 统计 / 一致性体检 | 成稿可交付 |
| M7 | 打包 dmg + 文档 | 安装包可安装可运行 |

---

## 8. 不做什么（v1 明确排除）

- 云同步与账号体系（本地优先，v1 不做，留接口）
- 多人协作
- AI 绘图封面 / 插画
- 语音朗读与语音输入
- 移动端
- 内置模型额度售卖（只 BYOK）

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 用户没有 API Key，开箱即空 | 首次启动引导页手把手教取 Key；提供"本地 Ollama"零成本路径 |
| 长篇上下文超限 | 滚动摘要 + 预算裁剪 + 明示已裁剪 |
| 生成内容跑偏 | 场景提示词 + 文风分身 + 逐段对比接受 |
| 数据损坏 | 原子写 + 每次保存前 `.bak` + 每章 20 个快照 |
| Windows 打包无法在本机验证 | electron-builder 配置齐备 + 文档说明在 Windows/CI 上执行 |