# 联网查资料（Web Search for Chat）设计

日期：2026-11-02
状态：待评审

## 背景

右侧「AI 对话」目前只能围绕当前这本书说话。这是**故意的**：它没有 tools 通道，注入的只有本书资料（简介、角色、世界观、大纲、前文、当前章正文），能动的也只有本书的正文/大纲/设定。

但作者的真实需求里有一类问题不长在书里：

- 「明代锦衣卫的品级和职能到底怎么分的？」——要**真实史料**，错一个品级就出戏
- 「景德镇青花瓷的柴窑烧成温度是多少？」——要**真实工艺参数**，编一个数字读者一眼看穿
- 「修仙小说的境界体系一般怎么排？」——这个反而是**虚构设定**，模型比搜索引擎更会编

前两类必须联网查证，否则就是让模型拿训练记忆硬猜，而这类"看起来知道"的幻觉最难被作者发现。第三类恰恰不该联网：搜到的就是别人小说的设定，用了就是雷同。

## 目标

让作者**主动**发起一次联网检索，把检索结果作为带编号与来源的【外部资料】注入这一轮对话，并让回答可以说清哪一句来自哪一条来源。

三条硬要求：

1. **不联网时，链路与今天逐字一致**——这是最容易搞坏的地方，`buildSystemPrompt` 同时服务正文生成、选中润色、大纲推演、对话四个入口（`prompt.ts:400/460/490`、`generate.ts:491`）。
2. **检索失败不阻塞对话**，但作者必须知道"这一轮没查到"，不允许模型假装查过。
3. **任何第三方中转渠道都能用**——不依赖 tool calling。

## 非目标

- **不做 tool calling / 多轮 agent 循环。** 模型不能自己决定再搜一次、也不能抓取网页正文。理由是现有用户大量走第三方中转，`tools` 不保证透传（这条约束在 `chat-edit-agent` 那次已经付过学费，见 `shared/editProtocol.ts` 头部注释）。P3 才做原生渠道适配。
- **不做自动判断要不要联网。** 由作者用开关或按钮显式发起，不偷偷花 token、不偷偷联网。
- **不把检索结果写进正文。** 只注入对话上下文；要沉淀由 P2 的「资料卡」负责。
- **不做通用网页抓取 / 爬虫。** 只用搜索 API 返回的标题 + 摘要。
- 不改正文生成、大纲、体检等任何既有链路的行为。

## 决策记录

| 议题 | 决策 | 理由 |
| --- | --- | --- |
| 技术路线 | 检索注入（先查后答），不上 tool calling | 中转渠道不保证透传 `tools`；三个协议各写一套循环成本 3–4 倍；且本机无法验证远端是否支持 |
| 触发方式 | 手动开关 + 「带着资料重答」按钮 | 作者写作时最怕自作主张；重答按钮贴合"先问、答得虚、再查"的真实心智 |
| 开关作用域 | 全局（`AppSettings`），不是每书一份 | 这是使用习惯，不是创作设定；每书一份会让作者反复切 |
| 搜索源 | 与「渠道」平级的 `SearchChannel`，key 存 keytar | 复用现有密钥基础设施，渲染进程拿不到 key |
| 检索原文 | 先用便宜模型压成摘要再注入 | 一次检索原文常 3–8k 字，直接塞会挤掉本书资料；压缩后可控制在 1–2k 字 |
| 用途 | 事实类才搜；虚构体系类不搜 | 搜到的虚构体系是别人的作品，雷同与版权风险 |
| 缓存 | 按 query 哈希，TTL 24h，全局共享 | 同一件事多本书都会问；省一半以上重复检索费 |
| 失败处理 | 降级为今天的行为，并在气泡里明说未取得资料 | 静默失败 = 作者以为查过了，这是最糟的幻觉来源 |

## 架构

```
渲染进程                              主进程
┌────────────────────────┐          ┌──────────────────────────┐
│ AIPanel                │          │ ipc: search:run          │
│  ├「联网」chip         │──IPC────▶│  ├ getSecret('search:'+id)│
│  └ lib/research.ts     │          │  ├ 按 preset 构造请求     │
│      ├ buildQueries    │◀─────────│  ├ 归一化 SearchHit      │
│      ├ 缓存判断        │          │  └ 错误分类 SearchError   │
│      └ formatExternal  │          └──────────────────────────┘
│ generateChatReply      │
└────────────────────────┘
```

- 搜索请求、key、缓存全部在主进程；渲染进程只拿归一化的 `SearchHit[]`。这与渠道密钥的处理一致，也顺手避开 CORS。
- `research.ts` 是纯逻辑（不碰 React、不碰 electron），可在 node 里直测——和 `applyEdits.ts` 的定位一致。

## 数据模型

### 搜索源

```ts
export interface SearchChannel {
  id: string
  name: string
  presetId?: 'bocha' | 'zhipu' | 'tavily' | 'serper' | 'searxng' | 'custom'
  baseUrl: string
  /** bearer: Authorization: Bearer <key>；query: ?<authParam>=<key>；header: 自定义头 */
  auth: 'bearer' | 'query' | 'header' | 'none'
  authParam?: string
  headers?: Record<string, string>
  enabled: boolean
  note?: string
}
```

密钥不落在这个结构里，走已有的 `secret:set('search:' + id, key)`（keytar），与 `channel:${id}` 同一个机制。

预设（baseUrl 与请求体在实现时按各家官方文档复核，这几家近期都改过字段名）：

| presetId | 名称 | baseUrl | auth |
| --- | --- | --- | --- |
| `bocha` | 博查 Bocha | `https://api.bochaai.com/v1/web-search` | bearer |
| `zhipu` | 智谱 Web Search | `https://open.bigmodel.cn/api/paas/v4/web_search` | bearer |
| `tavily` | Tavily | `https://api.tavily.com/search` | bearer |
| `serper` | Serper (Google) | `https://google.serper.dev/search` | header（`X-API-KEY`） |
| `searxng` | SearXNG（自建） | 自填 | none |
| `custom` | 自定义（OpenAI 风格兼容网关） | 自填 | 自选 |

默认推荐 `bocha`：国内可直连，中文史料与电商/工艺类结果质量明显好于海外源。

### 设置

```ts
export interface WebSearchSettings {
  enabled: boolean          // 设置页总闸；关掉则 UI 不出现「联网」chip
  channelId: string | null  // 默认搜索源
  maxResults: number        // 每次 3–8，默认 5
  maxQueries: number        // 每次最多几条 query，默认 2
  cacheTtlHours: number     // 默认 24
  summarize: boolean        // 是否用便宜模型压缩结果，默认 true
}
```

三处结构改动，全部是向后兼容的可选字段（老配置由 `mergeSettings` 逐键补默认）：

- `Config` 增加 `searchChannels: SearchChannel[]`
- `AppSettings` 增加 `webSearch: WebSearchSettings`
- `BUDGET_KEYS` 增加 `search.summarize`（结果压缩，默认 fixed 1200）
- `ChatMessage` 增加 `research?: { queries: string[]; hits: SearchHit[]; cached: boolean; at: number }`

`research` 必须持久化在消息上，不能只存在组件 state 里：来源卡片是这条回答的一部分，刷新页面后若消失，作者就再也核对不了那句话的出处。

query 改写**不在 P1 用模型**：P1 的 `buildQueries` 是纯规则实现（实体词 + 限定词），零额外调用、零延迟、可单测。等 P2 需要处理更绕的问法时再加 `search.plan` 预算键与一次小模型改写，届时才引入第二条成本线。

### 检索结果（归一化）

```ts
export interface SearchHit {
  title: string
  url: string
  snippet: string
  source: string        // 域名，用于界面显示
  publishedAt?: string
}

export type SearchErrorKind =
  | 'no-channel' | 'no-key' | 'auth' | 'quota'
  | 'network' | 'timeout' | 'bad-response' | 'empty'
```

各家返回结构差异全部吸收在主进程 `src/main/search/normalize.ts` 里，渲染进程只见 `SearchHit`。

## 接口

主进程新增一个 IPC，preload 挂到 `window.mz.search`：

```ts
// 'search:run'
(req: { channelId: string; queries: string[]; maxResults: number })
  => Promise<{
    hits: SearchHit[]
    queries: string[]
    error?: { kind: SearchErrorKind; message: string }
    cached: boolean
  }>
```

- 超时 8s（单条 query），失败不抛异常，一律落在 `error` 字段——渲染进程只有一条降级路径，不必写 try/catch 分叉。
- `cached: true` 时 `hits` 直接来自缓存，界面显示"缓存"。

## 数据流

```
作者点「联网」chip 后发送 / 点气泡上「带着资料重答」
  ↓
buildQueries(question, project)
  ├ 判用途：事实类问题才产生 query；纯创作请求（"帮我写一段打斗"）返回 []
  └ 抽取实体 + 限定词（人名/产品名 + "年代""工艺""参数""体系"）
  ↓
[] → 走今天完全相同的链路（不增加任何请求）
  ↓
缓存命中（key = sha1(channelId | query | maxResults)）→ 直接用
  ↓ 未命中
IPC search:run → SearchHit[] → 写缓存
  ↓
summarize（可关）→ 每条压到 ≤300 字
  ↓
formatExternal → 【外部资料】块
  ↓
generateChatReply({ ..., external })
  messages = [system, 【作品资料】, 【外部资料】, history(-8), question]
  ↓
回答落库时把 { queries, hits, cached, at } 一并写进这条 assistant 消息的 research
```

检索发生在生成之前，但 `research` 挂在回答上而不是提问上：来源卡是"这句回答的依据"，跟提问放一起会让作者以为提问本身带出处。

## 提示词注入

```
【外部资料｜联网检索于 2026-11-02 17:20，非本书设定】
[1] 明代锦衣卫的品级与职能 — https://…
锦衣卫设指挥使一人，正三品…（摘要）

[2] 飞鱼服与蟒袍的区别 — https://…
…

使用规则：
- 引用以上内容时在句末标注 [编号]；未标注的事实视为你自己的推断。
- 以上资料与本书设定冲突时，一律以本书设定为准，并明确告诉作者哪里有出入。
- 只可化用，不得整段搬运原文（有版权与雷同风险）。
```

位置定死：**紧跟【作品资料】、在 dialogue history 之前**。理由：它和本书资料同属"资料层"，模型对同一层的两块内容会给出相近的采信度；放到 history 之后会变成"临时附注"，容易被上一轮回答带跑。

不给虚构体系联网：`buildQueries` 识别出"境界/体系/流派/设定"这类词且没有真实实体时返回空，改走已有的 `bible_upsert` 存设定链路。作者若要"参考真实道教术语"，得在问题里带上可检索的实体词。

## UI

1. **「联网」chip**：挨着现有 `可改稿/只聊天` chip。三态：`联网`（关）/ `联网·开` / `正在查资料…`。默认关，全局记忆。总闸关掉时不渲染。
2. **气泡「带着资料重答」**：重跑本轮问题，新回答标「第 2 版 · 含检索」，**不覆盖旧回答**——作者常要对照"模型编的"和"查证过的"。
3. **来源卡片**：气泡下方折叠「来源 N 条」，展开为 标题 / 域名 / 抓取时间 / `[存为资料卡(P2)]`，点击走已有的 `app:open-external`。
4. **上下文页签**：新增「外部资料」块，显示本轮注入的检索 query、命中条数与是否缓存（数据来自 `project.chat` 里最近一条带 `research` 的消息）。只显示"已注入 3 条"等于把黑箱换了个位置。作者自己攒的资料卡（`notes` 开关）属 P2。
5. **设置页**：新增「搜索源」区块，与「渠道与模型」并列，做成渠道卡片的简化版（预设下拉 + baseUrl + key + 测试连接）。

## 降级矩阵

| 情况 | 行为 |
| --- | --- |
| 总闸关 | 不出现 chip，链路与今天逐字一致 |
| 未配搜索源 | 点 chip 提示并跳设置；本轮退回不联网 |
| 无 key / 401 | chip 警示色；回答照常生成，但明说未取得外部资料 |
| 超时 / 网络错误 | 同上，提示可重试 |
| 搜到 0 条 | 提示换关键词；模型收到「本次未取得外部资料」 |
| 摘要失败 | 退回原始 snippet 截断，不失败整轮 |
| 模型未标 `[n]` | 不做伪造补标；气泡标「未标注来源」，提示可重答 |
| 配额 / 限流 | 归为 `quota`，提示换源或稍后 |

原则：**最差退回今天的行为，但绝不假装查过。**

## 成本

- 不联网：**0 增量**（有测试断言）。
- 一次「查资料」= 1–2 次搜索 API + 可选 1 次摘要压缩（flash 级模型、输出约 600 tokens，`search.summarize` 可调）。
- 24h 缓存使同一天反复问同一件事只付一次；缓存上限 500 条，LRU 淘汰。

## 测试

单测（node 直跑，沿用 `scripts/test-*.mjs` 风格）：

1. `buildQueries`：事实类问题抽出正确 query；纯创作请求返回 `[]`
2. `formatExternal`：编号 / URL / 时间 / 规则段齐全；空结果产出"未取得"
3. 缓存：TTL 内命中、过期重搜、key 稳定、LRU 淘汰
4. 错误分类：401 / 超时 / 配额 / 空结果各自落到正确的 `SearchErrorKind`
5. **回归：`external` 未传时 `generateChatReply` 的 messages 与当前实现逐字一致**
6. 注入顺序：外部资料在【作品资料】之后、history 之前

E2E（指向 localhost 的 stub 搜索服务，复用 `.testdata-e2e-*` 那套）：

- 问「明代锦衣卫品级」→ 回答含 `[1]` → 来源卡出现 → **再问一次断言 stub 只被打过一次**
- 关联网 → 同样问法 → **断言 stub 零请求**

## 分期

**P1 · 能用（本次范围）**
搜索源配置与设置页 → `search:run`（归一化 + 错误分类 + 缓存）→ `buildQueries` / `formatExternal` → 联网 chip + 来源卡 + 上下文新块 → 回归与 E2E 测试。

**P2 · 好用**
「带着资料重答」→ 资料卡沉淀（`Project.notes: ResearchNote[]`，带 `sourceUrl` / `retrievedAt` / `fromMessageId`）+ `notes` 注入开关 → 一键把资料转成世界观/角色条目（复用 `bible_upsert`）→ 搜索源「测试连接」。

**P3 · 更强**
原生渠道 tool calling 适配层（按 `channel.capabilities` 显示"该渠道不支持"，不静默失效）→ `fetch_page` 抓正文与多轮深挖。

## 风险

- **`buildSystemPrompt` 波及面**：本设计不改它；外部资料只走 user 段。若实现时不得不改，必须保证三个既有调用点（正文/大纲/润色）快照测试不变。
- **搜索源可用性**：国内源可能限流、海外源需代理。因此搜索源必须可配多个、可切换，不能只硬编码一家。
- **摘要压缩失真**：压缩可能丢掉关键数字（品级、温度、年代）。摘要提示词要求"保留所有数字、专名与单位"，并保留原始 URL 供作者点开核对。
- **配置迁移**：老 `config.json` 没有 `searchChannels`，读取时必须容忍缺失，不能抛错。