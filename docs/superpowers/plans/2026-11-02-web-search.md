# 联网查资料（P1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让右侧「AI 对话」能由作者主动发起一次联网检索，把带编号与来源的【外部资料】注入这一轮对话，并在界面上给出可点开、可核对的来源卡片。

**Architecture:** 检索走主进程（密钥与缓存都在主进程），渲染进程只拿归一化的 `SearchHit[]`；`src/renderer/lib/research.ts` 是纯逻辑（可在 node 里直测）；注入只改 `generateChatReply` 的 messages 装配，**不碰 `buildSystemPrompt`**，从而保证不联网时链路与今天逐字一致。

**Tech Stack:** Electron + React + TypeScript；测试用 esbuild 打包真实实现后在 node 里 import（与 `scripts/test-apply-edits.mjs` 同款），不复制实现。

## Global Constraints

- **不引入新依赖**（不装搜索 SDK、不装 HTTP 库，统一用主进程全局 `fetch`）。
- **不联网时 messages 必须与当前实现逐字一致**——`external` 为 undefined 时，messages 数组的每一项都要和今天完全相同。
- 密钥一律存 keytar，引用名前缀 `search:`，渲染进程不得接触明文 key。
- 所有错误路径**不抛异常**，统一走 `SearchRunResult.error`，渲染层只有一条降级路径。
- 中文注释，风格与现有文件一致（解释「为什么」，不复述「做了什么」）。
- 阈值与默认值：`maxResults` 5（夹在 3–8），`maxQueries` 2（1–3），`cacheTtlHours` 24（0–168），单请求超时 8000ms。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/shared/types.ts` | 增加 `SearchChannel` / `WebSearchSettings` / `SearchHit` / `SearchRunResult` / `ResearchMeta`，扩展 `Config` / `AppSettings` / `ChatMessage` / `MzApi` |
| `src/shared/webSearch.ts` | 新建：搜索源预设表、默认设置、两个 normalize 函数 |
| `src/shared/budgets.ts` | 增加 `search.summarize` 预算键与默认值 |
| `src/main/search/request.ts` | 新建：`buildSearchRequest`（纯函数，按 preset 生成请求） |
| `src/main/search/normalize.ts` | 新建：`extractHits` / `hostOf` / `dedupeHits`（纯函数，吸收各家响应差异） |
| `src/main/search/cache.ts` | 新建：`cacheKey` / `pruneCache` / `SearchCache`（读写在 24h TTL 与 500 条上限内） |
| `src/main/search/index.ts` | 新建：`runSearch` 编排（缓存 → 请求 → 归一化 → 错误分类） |
| `src/main/ipc/index.ts` | 增加 `search:run` handler |
| `src/main/storage/config.ts` | 读写时归一化 `searchChannels` |
| `src/preload/index.ts` | 挂 `search.run` |
| `src/renderer/lib/research.ts` | 新建：`buildQueries` / `formatExternal` / `research()` |
| `src/renderer/lib/generate.ts` | `generateChatReply` 增加可选 `external` 参数 |
| `src/renderer/components/AIPanel.tsx` | 「联网」chip、来源卡片、上下文页的「外部资料」块 |
| `src/renderer/pages/Settings/SearchSection.tsx` | 新建：搜索源 CRUD（简化版渠道卡） |
| `src/renderer/pages/Settings/index.tsx` | 注册「联网搜索」导航项 |
| `scripts/test-web-search.mjs` | 新建：request / normalize / cache 单测 |
| `scripts/test-research.mjs` | 新建：buildQueries / formatExternal 单测 |
| `scripts/test-chat-external.mjs` | 新建：注入位置 + 不联网时逐字一致的回归断言 |
| `scripts/test-web-search-live.mjs` | 新建：本地 stub 服务器 → runSearch → 缓存命中（集成） |

---

### Task 1: 共享契约（types / presets / budgets）

**Files:**
- Modify: `src/shared/types.ts`（渠道段后、`ChatMessage`、`AppSettings`、`Config`、`MzApi`）
- Create: `src/shared/webSearch.ts`
- Modify: `src/shared/budgets.ts`
- Test: `scripts/test-web-search.mjs`（本任务先建骨架，断言默认值与夹取）

**Interfaces:**
- Produces:
  - `SearchChannel`, `WebSearchSettings`, `SearchHit`, `SearchErrorKind`, `SearchRunRequest`, `SearchRunResult`, `ResearchMeta`（都在 `@shared/types`）
  - `SEARCH_PRESETS: SearchPreset[]`、`DEFAULT_WEB_SEARCH: WebSearchSettings`、`normalizeWebSearch(v: unknown): WebSearchSettings`、`normalizeSearchChannel(c: Partial<SearchChannel>): SearchChannel`（都在 `@shared/webSearch`）
  - `BUDGET_KEYS.searchSummarize`、`DEFAULT_TOKEN_BUDGETS['search.summarize']`

- [ ] **Step 1: 写失败测试**

创建 `scripts/test-web-search.mjs`（后续任务会往后追加断言，这里先立骨架与第一组）：

```js
/**
 * 联网查资料的纯逻辑回归测试。
 * 运行：node scripts/test-web-search.mjs
 *
 * 要守住三件事：
 *   1. 默认值与夹取范围（配置坏了不能把请求打爆）；
 *   2. 各家响应格式的差异只允许存在 normalize 一处；
 *   3. 请求构造与错误分类不依赖网络，可在 node 里直测。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outdir = mkdtempSync(join(tmpdir(), 'mozhou-websearch-test-'))

async function load(entry, name) {
  const outfile = join(outdir, name + '.mjs')
  await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent',
    alias: { '@shared': join(root, 'src/shared') }
  })
  return import(pathToFileURL(outfile).href)
}

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

const web = await load('src/shared/webSearch.ts', 'webSearch')

console.log('默认值与夹取')
check('默认关闭', web.DEFAULT_WEB_SEARCH.enabled === false)
check('默认 maxResults=5', web.DEFAULT_WEB_SEARCH.maxResults === 5)
check('默认 maxQueries=2', web.DEFAULT_WEB_SEARCH.maxQueries === 2)
check('默认 ttl=24', web.DEFAULT_WEB_SEARCH.cacheTtlHours === 24)
check('默认 summar化开', web.DEFAULT_WEB_SEARCH.summarize === true)

const wild = web.normalizeWebSearch({ maxResults: 99, maxQueries: 0, cacheTtlHours: -5 })
check('maxResults 夹到 8', wild.maxResults === 8, String(wild.maxResults))
check('maxQueries 夹到 1', wild.maxQueries === 1, String(wild.maxQueries))
check('ttl 夹到 0', wild.cacheTtlHours === 0, String(wild.cacheTtlHours))
check('残缺配置补全', web.normalizeWebSearch({}).enabled === false)

const ch = web.normalizeSearchChannel({ name: '', baseUrl: '  ' })
check('渠道名兜底', ch.name === '未命名搜索源')
check('非预设渠道名兜底为 custom', ch.presetId === 'custom', String(ch.presetId))

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-web-search.mjs`
Expected: FAIL —— `Cannot find module .../src/shared/webSearch.ts`

- [ ] **Step 3: 加类型**

在 `src/shared/types.ts` 的渠道段之后（`ModelEntry` 之后）加：

```ts
/* ────────────────────────── 联网搜索 ────────────────────────── */

export type SearchErrorKind =
  | 'no-channel'
  | 'no-key'
  | 'auth'
  | 'quota'
  | 'network'
  | 'timeout'
  | 'bad-response'
  | 'empty'

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

export interface WebSearchSettings {
  /** 设置页总闸；关掉则界面不出现「联网」chip */
  enabled: boolean
  channelId: string | null
  maxResults: number
  maxQueries: number
  cacheTtlHours: number
  /** 是否用便宜模型把检索结果压成摘要再注入 */
  summarize: boolean
}

/** 各家响应归一化之后的唯一形状：界面、缓存、提示词都只认它 */
export interface SearchHit {
  title: string
  url: string
  snippet: string
  /** 域名，界面上显示「来自 zh.wikipedia.org」比一条裸 URL 可信得多 */
  source: string
  publishedAt?: string
}

export interface SearchRunRequest {
  channelId: string
  queries: string[]
  maxResults: number
}

export interface SearchRunResult {
  hits: SearchHit[]
  queries: string[]
  cached: boolean
  error?: { kind: SearchErrorKind; message: string }
}

/** 挂在 assistant 消息上的检索痕迹：刷新页面后来源卡还能重现 */
export interface ResearchMeta {
  queries: string[]
  hits: SearchHit[]
  cached: boolean
  at: number
}
```

在 `ChatMessage` 里加（放在 `editsError` 之后）：

```ts
  /** 这一轮回答所依据的外部检索结果。有值就渲染来源卡 */
  research?: ResearchMeta
```

在 `AppSettings` 里 `allowChatEdits` 之后加：

```ts
  /**
   * 联网查资料。全局设置而不是每书一份：
   * 它记的是「这个人愿不愿意联网」，不是某本书的创作设定。
   */
  webSearch: WebSearchSettings
```

在 `Config` 里 `models` 之后加：

```ts
  /** 搜索源：与模型渠道平级，key 同样存 keytar（ref 前缀 search:） */
  searchChannels: SearchChannel[]
```

在 `MzApi` 里 `ai` 之后加：

```ts
  search: {
    run(req: SearchRunRequest): Promise<SearchRunResult>
  }
```

- [ ] **Step 4: 建 `src/shared/webSearch.ts`**

```ts
/**
 * 搜索源的预设表与默认设置。
 *
 * 只有这一个文件知道「博查/智谱/Tavily 各自长什么样」，主进程按 presetId 分派请求构造。
 * 预设 URL 与字段名随时可能被各家改掉，所以它们集中在这里，改一处就够。
 */
import type { SearchChannel, WebSearchSettings } from './types'

export interface SearchPreset {
  id: NonNullable<SearchChannel['presetId']>
  name: string
  baseUrl: string
  auth: SearchChannel['auth']
  authParam?: string
  headers?: Record<string, string>
  keyHint: string
  keyUrl?: string
  note?: string
}

export const SEARCH_PRESETS: SearchPreset[] = [
  {
    id: 'bocha',
    name: '博查 Bocha',
    baseUrl: 'https://api.bochaai.com/v1/web-search',
    auth: 'bearer',
    keyHint: 'sk-...',
    keyUrl: 'https://open.bochaai.com',
    note: '国内可直连，中文史料与工艺类结果质量好，推荐首选'
  },
  {
    id: 'zhipu',
    name: '智谱 Web Search',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search',
    auth: 'bearer',
    keyHint: '智谱 API Key',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys'
  },
  {
    id: 'tavily',
    name: 'Tavily',
    baseUrl: 'https://api.tavily.com/search',
    auth: 'bearer',
    keyHint: 'tvly-...',
    keyUrl: 'https://app.tavily.com',
    note: '海外服务，国内需代理'
  },
  {
    id: 'serper',
    name: 'Serper (Google)',
    baseUrl: 'https://google.serper.dev/search',
    auth: 'header',
    authParam: 'X-API-KEY',
    keyHint: 'Serper API Key',
    keyUrl: 'https://serper.dev',
    note: '走 Google 结果，中文长尾不如博查'
  },
  {
    id: 'searxng',
    name: 'SearXNG（自建）',
    baseUrl: '',
    auth: 'none',
    keyHint: '无需 Key，填实例地址即可',
    note: '自己搭的实例，地址填到 /search 之前'
  },
  { id: 'custom', name: '自定义（兼容博查格式）', baseUrl: '', auth: 'bearer', keyHint: '按服务商要求填写' }
]

export const DEFAULT_WEB_SEARCH: WebSearchSettings = {
  enabled: false,
  channelId: null,
  maxResults: 5,
  maxQueries: 2,
  cacheTtlHours: 24,
  summarize: true
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 老配置里没有 webSearch，或作者手动改过 config.json。
 * 这里一律夹到安全范围：一个 99 条的 maxResults 会让单次检索花掉几毛钱。
 */
export function normalizeWebSearch(v: unknown): WebSearchSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<WebSearchSettings>
  return {
    enabled: o.enabled === true,
    channelId: typeof o.channelId === 'string' && o.channelId ? o.channelId : null,
    maxResults: clampInt(o.maxResults, 3, 8, DEFAULT_WEB_SEARCH.maxResults),
    maxQueries: clampInt(o.maxQueries, 1, 3, DEFAULT_WEB_SEARCH.maxQueries),
    cacheTtlHours: clampInt(o.cacheTtlHours, 0, 168, DEFAULT_WEB_SEARCH.cacheTtlHours),
    summarize: o.summarize !== false
  }
}

export function normalizeSearchChannel(c: Partial<SearchChannel>): SearchChannel {
  const presetId = SEARCH_PRESETS.some((p) => p.id === c.presetId) ? (c.presetId as SearchChannel['presetId']) : 'custom'
  const preset = SEARCH_PRESETS.find((p) => p.id === presetId)
  return {
    id: c.id || `sc_${Math.random().toString(36).slice(2, 10)}`,
    name: (c.name ?? '').trim() || '未命名搜索源',
    presetId,
    baseUrl: (c.baseUrl ?? '').trim() || preset?.baseUrl || '',
    auth: c.auth ?? preset?.auth ?? 'bearer',
    authParam: c.authParam ?? preset?.authParam,
    headers: c.headers ?? {},
    enabled: c.enabled !== false,
    note: c.note
  }
}
```

- [ ] **Step 5: 加预算键**

`src/shared/budgets.ts`：

```ts
export type BudgetKey = ... | 'search.summarize'
```

```ts
  searchSummarize: 'search.summarize',
```

`DEFAULT_TOKEN_BUDGETS` 里加 `'search.summarize': fixed(1200),`。

`mergeSettings.ts` 的 `DEFAULT_SETTINGS` 里加 `webSearch: DEFAULT_WEB_SEARCH,`（从 `@shared/webSearch` import；注意 `mergeSettings` 现有逐键合并逻辑要带上这一项，写法照 `allowChatEdits`）：

```ts
  webSearch: normalizeWebSearch((raw as Partial<AppSettings>).webSearch)
```

`config.ts` 的 `DEFAULT_CONFIG` 加 `searchChannels: []`；`loadConfig` / `saveConfig` 都补 `(raw.searchChannels ?? []).map(normalizeSearchChannel)`。

- [ ] **Step 6: 跑测试与类型检查**

Run: `node scripts/test-web-search.mjs && npx tsc --noEmit`
Expected: 测试全过；tsc 无新增错误（`MzApi.search` 会在 preload 报缺失，属正常，Task 4 补上；若 tsc 因此失败，先跳到 Task 4 再回来跑）

- [ ] **Step 7: 提交**

```bash
git add src/shared/types.ts src/shared/webSearch.ts src/shared/budgets.ts src/main/storage/config.ts src/main/storage/mergeSettings.ts scripts/test-web-search.mjs
git commit -m "feat(search): 搜索源与联网设置的数据契约"
```

---

### Task 2: 请求构造与响应归一化

**Files:**
- Create: `src/main/search/request.ts`, `src/main/search/normalize.ts`
- Test: `scripts/test-web-search.mjs`（追加）

**Interfaces:**
- Consumes: `SearchChannel`、`SearchHit`、`SEARCH_PRESETS`
- Produces:
  - `buildSearchRequest(channel, apiKey, query, maxResults): { url: string; method: 'GET' | 'POST'; headers: Record<string,string>; body?: string }`
  - `extractHits(presetId, json: unknown, limit: number): SearchHit[]`
  - `hostOf(url: string): string`

- [ ] **Step 1: 追加失败测试**

在 `scripts/test-web-search.mjs` 的 `console.log(\`\\n${pass} ...\`)` 之前插入：

```js
const req = await load('src/main/search/request.ts', 'request')
const norm = await load('src/main/search/normalize.ts', 'normalize')

console.log('请求构造')
const bocha = req.buildSearchRequest(
  { id: 'a', name: 'a', presetId: 'bocha', baseUrl: 'https://x/v1/web-search', auth: 'bearer', enabled: true },
  'KEY',
  '明代锦衣卫',
  5
)
check('bocha 用 POST', bocha.method === 'POST')
check('bocha 带 Bearer', bocha.headers.Authorization === 'Bearer KEY')
const bochaBody = JSON.parse(bocha.body)
check('bocha query 字段', bochaBody.query === '明代锦衣卫', JSON.stringify(bochaBody))
check('bocha count 字段', bochaBody.count === 5, JSON.stringify(bochaBody))

const serper = req.buildSearchRequest(
  { id: 'b', name: 'b', presetId: 'serper', baseUrl: 'https://google.serper.dev/search', auth: 'header', authParam: 'X-API-KEY', enabled: true },
  'KEY',
  'q',
  3
)
check('serper 用 X-API-KEY 头', serper.headers['X-API-KEY'] === 'KEY', JSON.stringify(serper.headers))
check('serper 不把 key 写进 body', !String(serper.body).includes('KEY'))

const searx = req.buildSearchRequest(
  { id: 'c', name: 'c', presetId: 'searxng', baseUrl: 'https://searx.local', auth: 'none', enabled: true },
  null,
  '明代 锦衣卫',
  4
)
check('searxng 用 GET', searx.method === 'GET')
check('searxng 带 format=json', searx.url.includes('format=json'), searx.url)
check('searxng 查询串已编码', searx.url.includes('%E6%98%8E%E4%BB%A3'), searx.url)

console.log('响应归一化')
const bochaJson = {
  code: 200,
  data: {
    webPages: {
      value: [
        { name: '锦衣卫 - 维基百科', url: 'https://zh.wikipedia.org/wiki/%E9%94%A6%E8%A1%A3%E5%8D%AB', snippet: '锦衣卫是明代…', siteName: '维基百科', datePublished: '2024-01-02' },
        { name: '重复项', url: 'https://zh.wikipedia.org/wiki/%E9%94%A6%E8%A1%A3%E5%8D%AB', snippet: '重复', siteName: '维基百科' },
        { name: '', url: '', snippet: '' }
      ]
    }
  }
}
const hits = norm.extractHits('bocha', bochaJson, 5)
check('bocha 取到 1 条（去重 + 丢弃空行）', hits.length === 1, String(hits.length))
check('bocha 标题', hits[0].title === '锦衣卫 - 维基百科', hits[0].title)
check('bocha 域名', hits[0].source === 'zh.wikipedia.org', hits[0].source)
check('bocha 日期', hits[0].publishedAt === '2024-01-02', String(hits[0].publishedAt))

const zhipuJson = {
  search_result: [{ title: '明代官职', link: 'https://example.com/a', content: '正三品…', publish_date: '2023-05-01' }]
}
check('zhipu 解析 link/content', norm.extractHits('zhipu', zhipuJson, 5)[0].url === 'https://example.com/a')

const tavilyJson = { results: [{ title: 'T', url: 'https://t.example/x', content: 'C', published_date: '2022-01-01' }] }
check('tavily 解析 results/content', norm.extractHits('tavily', tavilyJson, 5)[0].snippet === 'C')

const serperJson = { organic: [{ title: 'S', link: 'https://s.example/y', snippet: 'Snip' }] }
check('serper 解析 organic/link', norm.extractHits('serper', serperJson, 5)[0].title === 'S')

const searxJson = { results: [{ title: 'X', url: 'https://x.example/z', content: 'Cx' }] }
check('searxng 解析 results/url', norm.extractHits('searxng', searxJson, 5)[0].url === 'https://x.example/z')

check('limit 生效', norm.extractHits('bocha', {
  data: { webPages: { value: Array.from({ length: 10 }, (_, i) => ({ name: `n${i}`, url: `https://e.com/${i}`, snippet: 's' })) } }
}, 3).length === 3)
check('坏形状不抛异常', Array.isArray(norm.extractHits('bocha', null, 5)))
check('坏 JSON 值不抛异常', Array.isArray(norm.extractHits('zhipu', 'oops', 5)))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-web-search.mjs`
Expected: FAIL —— `Cannot find module .../src/main/search/request.ts`

- [ ] **Step 3: 建 `src/main/search/request.ts`**

```ts
/**
 * 按搜索源预设生成一次 HTTP 请求。
 *
 * 单独成文件且保持纯函数（不碰 fetch、不碰 fs），是因为「请求长什么样」是这套功能里
 * 最容易出错的细节：key 放错位置会被 401，字段名写错会被当成空结果。
 * 纯函数能在 node 里逐家断言，不用真的发请求。
 */
import type { SearchChannel } from '@shared/types'

export interface SearchHttpRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

function authHeaders(channel: SearchChannel, apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(channel.headers ?? {}) }
  if (!apiKey) return headers
  if (channel.auth === 'bearer') headers.Authorization = `Bearer ${apiKey}`
  // 自定义头模式：键名由 authParam 给，例如 Serper 的 X-API-KEY
  else if (channel.auth === 'header' && channel.authParam) headers[channel.authParam] = apiKey
  return headers
}

export function buildSearchRequest(
  channel: SearchChannel,
  apiKey: string | null,
  query: string,
  maxResults: number
): SearchHttpRequest {
  const base = channel.baseUrl.replace(/\/+$/, '')
  const headers = authHeaders(channel, apiKey)

  switch (channel.presetId) {
    case 'zhipu':
      return {
        url: base,
        method: 'POST',
        headers,
        body: JSON.stringify({ search_query: query, search_engine: 'search_std', count: maxResults })
      }
    case 'tavily':
      return {
        url: base,
        method: 'POST',
        headers,
        body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', include_answer: false })
      }
    case 'serper':
      return { url: base, method: 'POST', headers, body: JSON.stringify({ q: query, num: maxResults }) }
    case 'searxng': {
      // 自建实例用 GET + format=json；key 一般不设，给了就按 query 参数拼
      const u = new URL(base.endsWith('/search') ? base : `${base}/search`)
      u.searchParams.set('q', query)
      u.searchParams.set('format', 'json')
      u.searchParams.set('language', 'zh-CN')
      if (apiKey && channel.auth === 'query' && channel.authParam) u.searchParams.set(channel.authParam, apiKey)
      return { url: u.toString(), method: 'GET', headers }
    }
    case 'bocha':
    case 'custom':
    default: {
      // 自定义源按博查同款字段：这是给「OpenAI 风格中转网关」留的兼容位
      const u = new URL(base)
      if (apiKey && channel.auth === 'query' && channel.authParam) u.searchParams.set(channel.authParam, apiKey)
      return {
        url: u.toString(),
        method: 'POST',
        headers,
        body: JSON.stringify({ query, count: maxResults, summary: true, freshness: 'noLimit' })
      }
    }
  }
}
```

- [ ] **Step 4: 建 `src/main/search/normalize.ts`**

```ts
/**
 * 各家搜索 API 的响应 → SearchHit。
 *
 * 各家字段名全是私货：博查 webPages.value[].name，智谱 search_result[].link，
 * Tavily results[].content，Serper organic[].link，SearXNG results[].url。
 * 全部吸收在这里，上层只见一种形状；坏形状一律返回空数组，绝不抛异常
 * ——一次解析失败不该让作者看到「网络错误」。
 */
import type { SearchHit } from '@shared/types'

type Dict = Record<string, unknown>

const asArray = (v: unknown): Dict[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Dict[]) : [])

/** 各家「结果数组」可能的挂载位置，按顺序取第一个非空的 */
function pickList(json: Dict): Dict[] {
  const candidates = [
    (json.data as Dict)?.webPages && ((json.data as Dict).webPages as Dict).value,
    json.data,
    json.search_result,
    json.results,
    json.organic,
    json.data && (json.data as Dict).results
  ]
  for (const c of candidates) {
    const arr = asArray(c)
    if (arr.length) return arr
  }
  return []
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function extractHits(_presetId: string | undefined, json: unknown, limit: number): SearchHit[] {
  if (!json || typeof json !== 'object') return []
  const list = pickList(json as Dict)
  const out: SearchHit[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const url = str(item.url) || str(item.link) || str(item.href)
    const title = str(item.title) || str(item.name)
    const snippet = str(item.snippet) || str(item.summary) || str(item.content) || str(item.description)
    if (!url || !/^https?:\/\//i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push({
      title: title || hostOf(url),
      url,
      snippet,
      source: hostOf(url),
      publishedAt: str(item.datePublished) || str(item.publish_date) || str(item.published_date) || str(item.date) || undefined
    })
    if (out.length >= limit) break
  }
  return out
}

export function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>()
  return hits.filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true)))
}
```

- [ ] **Step 5: 跑测试**

Run: `node scripts/test-web-search.mjs`
Expected: PASS（PASS 数增加，0 失败）

- [ ] **Step 6: 提交**

```bash
git add src/main/search/request.ts src/main/search/normalize.ts scripts/test-web-search.mjs
git commit -m "feat(search): 请求构造与各家响应归一化"
```

---

### Task 3: 缓存

**Files:**
- Create: `src/main/search/cache.ts`
- Test: `scripts/test-web-search.mjs`（追加）

**Interfaces:**
- Consumes: `SearchHit`
- Produces: `cacheKey(channelId, query, maxResults): string`、`pruneCache(file, nowMs, ttlHours, cap): CacheFile`、`class SearchCache`（`get(key)` / `set(key, hits)` / `flush()`，文件路径由构造参数给）

- [ ] **Step 1: 追加失败测试**

```js
const cache = await load('src/main/search/cache.ts', 'cache')

console.log('缓存')
const k1 = cache.cacheKey('ch1', '明代 锦衣卫', 5)
const k2 = cache.cacheKey('ch1', '明代 锦衣卫', 5)
const k3 = cache.cacheKey('ch2', '明代 锦衣卫', 5)
check('同参同 key', k1 === k2)
check('换渠道换 key', k1 !== k3)
check('query 影响 key', k1 !== cache.cacheKey('ch1', '宋代 官制', 5))

const now = 1_700_000_000_000
const file = {
  v: 1,
  entries: {
    fresh: { at: now - 3600_000, hits: [{ title: 'a', url: 'https://a.com', snippet: 's', source: 'a.com' }] },
    stale: { at: now - 48 * 3600_000, hits: [] }
  }
}
const pruned = cache.pruneCache(file, now, 24, 500)
check('过期条目被删', !pruned.entries.stale)
check('未过期条目保留', Boolean(pruned.entries.fresh))

const many = { v: 1, entries: {} }
for (let i = 0; i < 12; i++) many.entries[`k${i}`] = { at: now - i * 1000, hits: [] }
const capped = cache.pruneCache(many, now, 24, 10)
check('超过上限按时间裁到 cap', Object.keys(capped.entries).length === 10, String(Object.keys(capped.entries).length))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-web-search.mjs`
Expected: FAIL —— 找不到 `src/main/search/cache.ts`

- [ ] **Step 3: 建 `src/main/search/cache.ts`**

```ts
/**
 * 检索结果缓存。
 *
 * 为什么要缓存：同一件事（「明代锦衣卫品级」）作者在几本书里都会问，
 * 而且同一天内会反复问。一次检索几分钱不起眼，但写作时一天问二十次就是真金白银。
 *
 * 键里带 channelId 与 maxResults：换了搜索源或改了条数，结果集本来就不同，
 * 共用缓存会让作者以为「换了源也没变」。
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { SearchHit } from '@shared/types'

export interface CacheEntry {
  at: number
  hits: SearchHit[]
}

export interface CacheFile {
  v: 1
  entries: Record<string, CacheEntry>
}

export const EMPTY_CACHE: CacheFile = { v: 1, entries: {} }

export function cacheKey(channelId: string, query: string, maxResults: number): string {
  return createHash('sha1').update(`${channelId}|${query.trim()}|${maxResults}`).digest('hex')
}

/**
 * 淘汰过期与超量条目。cap 用「条目数」而不是字节数：
 * 一条命中通常 4-6 个 snippet，500 条上限约 1–2MB，够用且实现简单。
 */
export function pruneCache(file: CacheFile, nowMs: number, ttlHours: number, cap: number): CacheFile {
  const ttl = ttlHours * 3600_000
  const alive = Object.entries(file.entries ?? {}).filter(([, e]) => e && nowMs - e.at < ttl && e.hits?.length)
  alive.sort((a, b) => b[1].at - a[1].at)
  const entries: Record<string, CacheEntry> = {}
  for (const [k, e] of alive.slice(0, cap)) entries[k] = e
  return { v: 1, entries }
}

/** 磁盘上的缓存文件。读写失败一律吞掉：缓存是优化，不该让它把检索拖挂 */
export class SearchCache {
  constructor(
    private readonly file: string,
    private readonly ttlHours: number,
    private readonly cap = 500
  ) {}

  private async load(): Promise<CacheFile> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as CacheFile
      return pruneCache(raw, Date.now(), this.ttlHours, this.cap)
    } catch {
      return { ...EMPTY_CACHE, entries: {} }
    }
  }

  async get(key: string): Promise<SearchHit[] | null> {
    const file = await this.load()
    return file.entries[key]?.hits ?? null
  }

  async set(key: string, hits: SearchHit[]): Promise<void> {
    const file = await this.load()
    file.entries[key] = { at: Date.now(), hits }
    const pruned = pruneCache(file, Date.now(), this.ttlHours, this.cap)
    try {
      await fs.writeFile(this.file, JSON.stringify(pruned), 'utf8')
    } catch {
      /* 缓存写不进去不影响这次检索 */
    }
  }
}
```

- [ ] **Step 4: 跑测试**

Run: `node scripts/test-web-search.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/search/cache.ts scripts/test-web-search.mjs
git commit -m "feat(search): 检索结果缓存（TTL + 上限）"
```

---

### Task 4: runSearch 编排 + IPC + preload

**Files:**
- Create: `src/main/search/index.ts`
- Modify: `src/main/ipc/index.ts`（`registerIpc` 里，`ai` 段之后）
- Modify: `src/preload/index.ts`（`api` 对象里 `ai` 之后）
- Modify: `src/main/paths.ts`（增加缓存文件路径）
- Test: `scripts/test-web-search-live.mjs`（新建，本地 stub 服务器）

**Interfaces:**
- Consumes: `buildSearchRequest`、`extractHits`、`dedupeHits`、`SearchCache`
- Produces: `runSearch(p: RunSearchParams): Promise<SearchRunResult>`、`classifyStatus(status: number): SearchErrorKind`

- [ ] **Step 1: 写失败测试**

创建 `scripts/test-web-search-live.mjs`：

```js
/**
 * runSearch 的集成测试：本地起一个 stub 搜索服务，跑真实实现。
 * 运行：node scripts/test-web-search-live.mjs
 *
 * 要守住的是「一次失败不该拖垮整轮对话」：超时、401、空结果都必须变成
 * 结构化 error 而不是异常；同一 query 第二次必须命中缓存、不再打服务。
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outdir = mkdtempSync(join(tmpdir(), 'mozhou-websearch-live-'))
const outfile = join(outdir, 'search.mjs')

await build({
  entryPoints: [join(root, 'src/main/search/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(root, 'src/shared') }
})
const { runSearch } = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

let mode = 'ok'
let hits = 0
const server = createServer((req, res) => {
  hits++
  if (mode === '401') {
    res.writeHead(401).end('{"error":"bad key"}')
    return
  }
  if (mode === 'slow') {
    setTimeout(() => res.end('{}'), 3000)
    return
  }
  if (mode === 'empty') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":{"webPages":{"value":[]}}}')
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      data: {
        webPages: {
          value: [
            { name: '锦衣卫 - 维基百科', url: 'https://zh.wikipedia.org/wiki/1', snippet: '明代…' },
            { name: '锦衣卫制度', url: 'https://example.com/2', snippet: '品级…' }
          ]
        }
      }
    })
  )
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const channel = {
  id: 'stub',
  name: 'stub',
  presetId: 'bocha',
  baseUrl: `http://127.0.0.1:${port}/v1/web-search`,
  auth: 'bearer',
  enabled: true
}
const cacheFile = join(outdir, 'cache.json')

const ok1 = await runSearch({
  channel,
  apiKey: 'K',
  queries: ['明代锦衣卫'],
  maxResults: 5,
  ttlHours: 24,
  cacheFile,
  timeoutMs: 2000
})
check('成功返回 2 条', ok1.hits.length === 2, String(ok1.hits.length))
check('无 error', !ok1.error)
check('首次非缓存', ok1.cached === false)
check('打了一次服务', hits === 1, String(hits))

const ok2 = await runSearch({ channel, apiKey: 'K', queries: ['明代锦衣卫'], maxResults: 5, ttlHours: 24, cacheFile, timeoutMs: 2000 })
check('二次命中缓存', ok2.cached === true)
check('二次不再打服务', hits === 1, String(hits))

mode = '401'
const bad = await runSearch({ channel, apiKey: 'K', queries: ['另一件事'], maxResults: 5, ttlHours: 0, cacheFile, timeoutMs: 2000 })
check('401 变 auth 错误', bad.error?.kind === 'auth', JSON.stringify(bad.error))
check('401 时仍在返回结果集', Array.isArray(bad.hits))

mode = 'empty'
const empty = await runSearch({ channel, apiKey: 'K', queries: ['第三件事'], maxResults: 5, ttlHours: 0, cacheFile, timeoutMs: 2000 })
check('空结果归 empty', empty.error?.kind === 'empty', JSON.stringify(empty.error))

mode = 'slow'
const slow = await runSearch({ channel, apiKey: 'K', queries: ['第四件事'], maxResults: 5, ttlHours: 0, cacheFile, timeoutMs: 300 })
check('超时归 timeout', slow.error?.kind === 'timeout', JSON.stringify(slow.error))

const noKey = await runSearch({ channel, apiKey: null, queries: ['x'], maxResults: 5, ttlHours: 0, cacheFile, timeoutMs: 500 })
check('无 key 归 no-key', noKey.error?.kind === 'no-key', JSON.stringify(noKey.error))

const noCh = await runSearch({ channel: null, apiKey: null, queries: ['x'], maxResults: 5, ttlHours: 0, cacheFile, timeoutMs: 500 })
check('无搜索源归 no-channel', noCh.error?.kind === 'no-channel', JSON.stringify(noCh.error))

server.close()
rmSync(outdir, { recursive: true, force: true })
console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-web-search-live.mjs`
Expected: FAIL —— 找不到 `src/main/search/index.ts`

- [ ] **Step 3: 建 `src/main/search/index.ts`**

```ts
/**
 * 一次联网检索的编排：缓存 → 请求 → 归一化 → 错误分类。
 *
 * 这里的所有失败都变成 SearchRunResult.error 而不是异常。
 * 理由：检索是对话的旁路，任何一条查询挂掉都不该让作者连问题都问不出去；
 * 上层只需要一条降级路径（「本轮未取得外部资料」），不需要 try/catch 分叉。
 */
import type { SearchChannel, SearchErrorKind, SearchHit, SearchRunResult } from '@shared/types'
import { buildSearchRequest } from './request'
import { dedupeHits, extractHits } from './normalize'
import { SearchCache, cacheKey } from './cache'

export interface RunSearchParams {
  channel: SearchChannel | null
  apiKey: string | null
  queries: string[]
  maxResults: number
  ttlHours: number
  cacheFile: string
  timeoutMs?: number
}

export function classifyStatus(status: number): SearchErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402 || status === 429) return 'quota'
  return 'bad-response'
}

const MESSAGES: Record<SearchErrorKind, string> = {
  'no-channel': '还没有配置搜索源，去「设置 → 联网搜索」里加一个',
  'no-key': '搜索源还没有填写 API Key',
  auth: '搜索源鉴权失败（401/403），Key 可能填错或已失效',
  quota: '搜索源额度用尽或被限流，稍后再试或换一个源',
  network: '连不上搜索服务，检查网络或代理',
  timeout: '检索超时，可以重试',
  'bad-response': '搜索服务返回了无法解析的内容',
  empty: '没有搜到相关结果，换个关键词试试'
}

export async function runSearch(p: RunSearchParams): Promise<SearchRunResult> {
  const queries = p.queries.map((q) => q.trim()).filter(Boolean)
  if (!p.channel) return { hits: [], queries, cached: false, error: { kind: 'no-channel', message: MESSAGES['no-channel'] } }
  if (!p.apiKey && p.channel.auth !== 'none') {
    return { hits: [], queries, cached: false, error: { kind: 'no-key', message: MESSAGES['no-key'] } }
  }
  if (!queries.length) return { hits: [], queries, cached: false }

  const cache = new SearchCache(p.cacheFile, p.ttlHours)
  const all: SearchHit[] = []
  let cachedHits = 0
  let failure: SearchErrorKind | null = null

  for (const q of queries) {
    const key = cacheKey(p.channel.id, q, p.maxResults)
    const hit = await cache.get(key)
    if (hit?.length) {
      all.push(...hit)
      cachedHits++
      continue
    }

    const req = buildSearchRequest(p.channel, p.apiKey, q, p.maxResults)
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(p.timeoutMs ?? 8000)
      })
      if (!res.ok) {
        failure = classifyStatus(res.status)
        continue
      }
      const json = (await res.json()) as unknown
      const hits = extractHits(p.channel.presetId, json, p.maxResults)
      if (hits.length) {
        all.push(...hits)
        await cache.set(key, hits)
      } else {
        failure = failure ?? 'empty'
      }
    } catch (e) {
      // AbortSignal.timeout 抛 TimeoutError；其余归网络错误
      failure = (e as Error).name === 'TimeoutError' ? 'timeout' : 'network'
    }
  }

  const hits = dedupeHits(all).slice(0, p.maxResults * 2)
  const result: SearchRunResult = { hits, queries, cached: cachedHits === queries.length && hits.length > 0 }
  if (!hits.length && failure) result.error = { kind: failure, message: MESSAGES[failure] }
  return result
}
```

- [ ] **Step 4: 加路径、IPC 与 preload**

`src/main/paths.ts` 加：

```ts
export function searchCacheFile(): string {
  return join(app.getPath('userData'), 'search-cache.json')
}
```

`src/main/ipc/index.ts`（`ai` 段之后）：

```ts
  ipcMain.handle('search:run', async (_e, req: SearchRunRequest): Promise<SearchRunResult> => {
    const cfg = await loadConfig()
    const ws = cfg.settings.webSearch
    const channel = (cfg.searchChannels ?? []).find((c) => c.id === req.channelId && c.enabled !== false) ?? null
    const apiKey = channel ? await getSecret(`search:${channel.id}`) : null
    return runSearch({
      channel,
      apiKey,
      queries: (req.queries ?? []).slice(0, 3),
      maxResults: Math.min(8, Math.max(3, req.maxResults || ws.maxResults)),
      ttlHours: ws.cacheTtlHours,
      cacheFile: searchCacheFile()
    })
  })
```

`src/preload/index.ts`（`ai` 之后）：

```ts
  search: {
    run: (req: unknown) => invoke('search:run', req)
  },
```

- [ ] **Step 5: 跑测试与类型检查**

Run: `node scripts/test-web-search-live.mjs && node scripts/test-web-search.mjs && npx tsc --noEmit`
Expected: 两个测试全过；tsc 通过

- [ ] **Step 6: 提交**

```bash
git add src/main/search/index.ts src/main/ipc/index.ts src/preload/index.ts src/main/paths.ts scripts/test-web-search-live.mjs
git commit -m "feat(search): runSearch 编排、search:run IPC 与桥接"
```

---

### Task 5: 渲染进程 research.ts

**Files:**
- Create: `src/renderer/lib/research.ts`
- Test: `scripts/test-research.mjs`（新建）

**Interfaces:**
- Consumes: `SearchHit`、`SearchErrorKind`、`ResearchMeta`、`MzApi`（经注入，不直接 import bridge）
- Produces:
  - `buildQueries(question: string, maxQueries: number): { queries: string[]; reason: QueryReason }`
  - `type QueryReason = 'fact' | 'creative' | 'fiction-system' | 'no-entity'`
  - `formatExternal(r: { hits: SearchHit[]; queries: string[]; at: number; cached: boolean; error?: { kind: SearchErrorKind; message: string } }): string`
  - `research(question: string, deps: ResearchDeps): Promise<{ meta: ResearchMeta | null; text: string }>`

- [ ] **Step 1: 写失败测试**

创建 `scripts/test-research.mjs`：

```js
/**
 * 联网检索的「问什么、怎么讲给模型听」纯逻辑测试。
 * 运行：node scripts/test-research.mjs
 *
 * 两条最容易搞错的边界：
 *   - 纯创作请求不该联网（"帮我写一段打斗"搜什么？）；
 *   - 虚构体系不该联网（搜到的是别人的小说设定，用了就是雷同）。
 * 这两条一旦退化，作者会看到「查了资料」的结果反而更差，然后把这个功能关掉。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outdir = mkdtempSync(join(tmpdir(), 'mozhou-research-test-'))
const outfile = join(outdir, 'research.mjs')

await build({
  entryPoints: [join(root, 'src/renderer/lib/research.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(root, 'src/shared') }
})
const { buildQueries, formatExternal } = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

console.log('该不该联网')
check('纯创作不联网', buildQueries('帮我写一段雨夜追杀', 2).queries.length === 0)
check('纯创作 reason=creative', buildQueries('帮我写一段雨夜追杀', 2).reason === 'creative')
check('虚构体系不联网', buildQueries('修仙小说的境界体系一般怎么排', 2).queries.length === 0)
check('虚构体系 reason=fiction-system', buildQueries('修仙小说的境界体系一般怎么排', 2).reason === 'fiction-system')
check('真实史料要联网', buildQueries('明代锦衣卫的品级是怎么分的', 2).queries.length > 0)
check('真实工艺要联网', buildQueries('景德镇青花瓷的烧成温度是多少', 2).queries.length > 0)
check('真实+虚构并存时以真实为准', buildQueries('修仙里的炼丹，现实中真的有炼丹术吗', 2).queries.length > 0)

const q = buildQueries('明代锦衣卫的品级是怎么分的？', 2)
check('query 去掉语气词', !q.queries[0].includes('？'), q.queries[0])
check('query 不含"请问"', !q.queries[0].includes('请问'))
check('query 条数不超过 maxQueries', buildQueries('明代锦衣卫的品级是怎么分的，另外讲讲飞鱼服', 1).queries.length === 1)
check('query 非空', q.queries.every((x) => x.trim().length >= 2), JSON.stringify(q.queries))

console.log('外部资料块')
const ok = formatExternal({
  hits: [
    { title: '锦衣卫 - 维基百科', url: 'https://zh.wikipedia.org/wiki/1', snippet: '正三品', source: 'zh.wikipedia.org' },
    { title: '飞鱼服', url: 'https://example.com/2', snippet: '赐服', source: 'example.com' }
  ],
  queries: ['明代锦衣卫的品级'],
  at: Date.UTC(2026, 10, 2, 9, 20),
  cached: false
})
check('块里有【外部资料】标题', ok.includes('【外部资料'))
check('编号从 1 开始', ok.includes('[1]') && ok.includes('[2]'))
check('带 URL', ok.includes('https://zh.wikipedia.org/wiki/1'))
check('带引用规则', ok.includes('标注') && ok.includes('[编号]'))
check('声明非本书设定', ok.includes('非本书设定'))
check('要求以本书设定为准', ok.includes('本书设定为准'))
check('禁止整段搬运', ok.includes('不得整段搬运'))

const failed = formatExternal({
  hits: [],
  queries: ['明代锦衣卫'],
  at: Date.now(),
  cached: false,
  error: { kind: 'timeout', message: '检索超时，可以重试' }
})
check('失败时明说未取得', failed.includes('未取得外部资料'))
check('失败时给出人话原因', failed.includes('检索超时'))
check('失败时要求声明是模型知识', failed.includes('你的知识'))
check('失败时不留空编号', !failed.includes('[1]'))

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-research.mjs`
Expected: FAIL —— 找不到 `src/renderer/lib/research.ts`

- [ ] **Step 3: 建 `src/renderer/lib/research.ts`**

```ts
/**
 * 联网查资料：判断该不该查、把查询拼出来、把检索结果讲给模型听。
 *
 * 全部是纯函数 + 一个注入依赖的 research()，不直接碰 window.mz、不碰 React——
 * 与 applyEdits.ts 同一条纪律：这套逻辑要能在 node 里逐条断言，
 * 因为「该不该联网」和「怎么标来源」这两件事一旦错，作者很难自己发现。
 */
import type { ResearchMeta, SearchErrorKind, SearchHit, SearchRunResult } from '@shared/types'

export type QueryReason = 'fact' | 'creative' | 'fiction-system' | 'no-entity'

export interface QueryPlan {
  queries: string[]
  reason: QueryReason
}

/** 这些词说明作者要的是事实，不是桥段 */
const FACT_HINT =
  /(历史|朝代|年代|真实|现实|史实|工艺|材质|参数|温度|尺寸|价格|品级|官职|制度|生平|人物|发明|战争|地点|坐标|在哪|什么时候|哪一年|多少|是什么|有哪些)/

/** 这些词指向虚构设定：搜到的就是别人的小说，等于雷同 */
const FICTION_SYSTEM = /(境界|体系|流派|功法|金手指|修炼|等级划分|世界观|力量体系|设定集)/

/** 创作指令本身不会因为联网变好 */
const CREATIVE_ONLY = /(帮我写|写一段|写个|续写|接着写|润色|改写|起个名|取个名|来一段|生成一段)/

/** 疑问词与语气词：留着会让搜索把句子当自然语言处理，丢掉更准 */
const NOISE =
  /(请问|帮我|能不能|可以|麻烦|我想知道|想了解|查一下|查查|查询|搜一下|找一下|关于|有关|资料|信息|详细介绍|介绍一下|是什么|是多少|是怎么|怎么回事|为什么|怎么样|如何|哪些|哪些方面|吗|呢|吧|啊|？|\?|，|。|、|；|：|,|\.)/g

function clean(question: string): string {
  return question.replace(NOISE, ' ').replace(/\s+/g, ' ').trim()
}

export function buildQueries(question: string, maxQueries: number): QueryPlan {
  const q = question.trim()
  const isFact = FACT_HINT.test(q)
  if (CREATIVE_ONLY.test(q) && !isFact) return { queries: [], reason: 'creative' }
  if (FICTION_SYSTEM.test(q) && !isFact) return { queries: [], reason: 'fiction-system' }
  if (!isFact) return { queries: [], reason: 'no-entity' }

  const core = clean(q).slice(0, 30)
  if (core.length < 2) return { queries: [], reason: 'no-entity' }

  const queries = [core]
  // 第二条查询只在 maxQueries 允许且问题里出现了两个明显主题（顿号/逗号/并且）时才加，
  // 否则两条几乎一样的查询等于白花一次钱
  if (maxQueries > 1 && /[、，,]/.test(q)) {
    const parts = q
      .split(/[、，,]/)
      .map((s) => clean(s).slice(0, 30))
      .filter((s) => s.length >= 2)
    for (const p of parts) {
      if (queries.length >= maxQueries) break
      if (!queries.includes(p)) queries.push(p)
    }
  }
  return { queries: queries.slice(0, Math.max(1, maxQueries)), reason: 'fact' }
}

const pad = (n: number): string => String(n).padStart(2, '0')
function stamp(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 检索结果 → 提示词块。有空结果与失败两种形态，都必须说人话：
 * 静默失败会让模型拿训练记忆冒充「查证过」，这是这套功能最怕的翻车方式。
 */
export function formatExternal(r: {
  hits: SearchHit[]
  queries: string[]
  at: number
  cached: boolean
  error?: { kind: SearchErrorKind; message: string }
}): string {
  if (!r.hits.length) {
    const why = r.error ? `（${r.error.message}）` : ''
    return `【外部资料｜本次未取得外部资料${why}】
你这次没有拿到任何可引用的外部资料。请只凭你自己的知识回答，并明确告诉作者这一点：
哪些内容是你不确定的、需要作者自己核实。不要假装查过，也不要编造来源或 URL。`
  }
  const head = `【外部资料｜联网检索于 ${stamp(r.at)}${r.cached ? '（命中缓存）' : ''}，非本书设定】\n查询：${r.queries.join('；')}`
  const body = r.hits
    .map((h, i) => `[${i + 1}] ${h.title} — ${h.url}\n${h.snippet || '（无摘要）'}`)
    .join('\n\n')
  return `${head}\n\n${body}\n\n使用规则：
- 引用以上内容时在句末标注 [编号]；未标注的事实视为你自己的推断。
- 以上资料与本书设定冲突时，一律以本书设定为准，并明确告诉作者哪里有出入。
- 只可化用，不得整段搬运原文（有版权与雷同风险）。`
}

export interface ResearchDeps {
  channelId: string
  maxResults: number
  maxQueries: number
  run: (req: { channelId: string; queries: string[]; maxResults: number }) => Promise<SearchRunResult>
  /** 可选：把结果压成摘要。抛错或返回空串都退回原始 snippet */
  summarize?: (text: string) => Promise<string | null>
}

export interface ResearchOutcome {
  meta: ResearchMeta | null
  text: string
  /** 没联网时是空的，上层据此决定是否显示「本轮已检索」 */
  skipped: boolean
}

export async function research(question: string, deps: ResearchDeps): Promise<ResearchOutcome> {
  const plan = buildQueries(question, deps.maxQueries)
  if (!plan.queries.length) return { meta: null, text: '', skipped: true }

  let res: SearchRunResult
  try {
    res = await deps.run({ channelId: deps.channelId, queries: plan.queries, maxResults: deps.maxResults })
  } catch (e) {
    res = { hits: [], queries: plan.queries, cached: false, error: { kind: 'network', message: (e as Error).message } }
  }

  let hits = res.hits
  if (hits.length && deps.summarize) {
    const raw = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.snippet}`).join('\n\n')
    try {
      const brief = await deps.summarize(raw)
      // 摘要只在条数对得上时才采用：模型漏掉一条就等于丢掉一个来源
      if (brief && brief.trim()) {
        const lines = brief.split(/\n(?=\[\d+\])/).map((s) => s.trim()).filter(Boolean)
        if (lines.length === hits.length) {
          hits = hits.map((h, i) => ({ ...h, snippet: lines[i].replace(/^\[\d+\]\s*/, '') }))
        }
      }
    } catch {
      /* 摘要失败用原文，不影响这轮回答 */
    }
  }

  const at = Date.now()
  const meta: ResearchMeta = { queries: res.queries, hits, cached: res.cached, at }
  return { meta, text: formatExternal({ hits, queries: res.queries, at, cached: res.cached, error: res.error }), skipped: false }
}
```

- [ ] **Step 4: 跑测试**

Run: `node scripts/test-research.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/renderer/lib/research.ts scripts/test-research.mjs
git commit -m "feat(search): 该不该联网的判断与外部资料块生成"
```

---

### Task 6: 注入 generateChatReply（带逐字一致回归断言）

**Files:**
- Modify: `src/renderer/lib/generate.ts`（`generateChatReply` 参数与 messages）
- Test: `scripts/test-chat-external.mjs`（新建）

**Interfaces:**
- Consumes: `formatExternal` 产出的文本
- Produces: `generateChatReply` 新增可选参数 `external?: string`；导出 `buildChatMessages(...)` 供测试断言（把 messages 装配抽成纯函数，避免测试去 mock 网络）

- [ ] **Step 1: 写失败测试**

创建 `scripts/test-chat-external.mjs`：

```js
/**
 * 对话 messages 装配的回归测试。
 * 运行：node scripts/test-chat-external.mjs
 *
 * 核心断言只有一条：不传 external 时，装配结果必须与改造前逐字一致。
 * buildSystemPrompt 服务四个入口，任何"顺手优化"都会波及正文生成，
 * 而那种回归在跑一整天写作之后才会被发现。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outdir = mkdtempSync(join(tmpdir(), 'mozhou-chat-external-'))
const outfile = join(outdir, 'generate.mjs')

await build({
  entryPoints: [join(root, 'src/renderer/lib/generate.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(root, 'src/shared') }
})
const { buildChatMessages } = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

const base = {
  system: 'SYS',
  contextText: '【作品简介】\n一句话前提：测试',
  history: [
    { role: 'user', content: '上一问' },
    { role: 'assistant', content: '上一答' }
  ],
  question: '这一问'
}

const plain = buildChatMessages(base)
check('四条消息（无 external）', plain.length === 4, String(plain.length))
check('第 1 条是 system', plain[0].role === 'system' && plain[0].content === 'SYS')
check('第 2 条是作品资料', plain[1].content === `【作品资料】\n${base.contextText}`, JSON.stringify(plain[1].content))
check('第 3 条是上一条历史', plain[2].content === '上一问')
check('最后一条是当前问题', plain.at(-1).content === '这一问')

const withExt = buildChatMessages({ ...base, external: '【外部资料】\n[1] x' })
check('有 external 时多一条', withExt.length === 5, String(withExt.length))
check('external 紧跟作品资料', withExt[2].content.startsWith('【外部资料】'), JSON.stringify(withExt[2].content))
check('external 在历史之前', withExt[3].content === '上一问')
check('external 之后消息未变', JSON.stringify(withExt.slice(3)) === JSON.stringify(plain.slice(2)))

const blank = buildChatMessages({ ...base, external: '   ' })
check('空白 external 视同没有', JSON.stringify(blank) === JSON.stringify(plain))

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-chat-external.mjs`
Expected: FAIL —— `buildChatMessages` is not a function

- [ ] **Step 3: 抽装配函数并接线**

在 `src/renderer/lib/generate.ts` 里新增（放在 `generateChatReply` 之前）：

```ts
/**
 * 对话 messages 的装配。
 *
 * 抽成独立纯函数有两个原因：一是它必须能被逐字断言（不联网时的装配结果
 * 不允许有任何漂移），二是「外部资料插在哪」这件事只该有一处真相。
 */
export function buildChatMessages(p: {
  system: string
  contextText: string
  history: { role: 'user' | 'assistant'; content: string }[]
  question: string
  external?: string
}): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const external = p.external?.trim()
  return [
    { role: 'system', content: p.system },
    { role: 'user', content: `【作品资料】\n${p.contextText}` },
    ...(external ? [{ role: 'user' as const, content: external }] : []),
    ...p.history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: p.question }
  ]
}
```

把 `generateChatReply` 里原来的 messages 构造替换成：

```ts
  const messages = buildChatMessages({ system, contextText: ctxText, history: p.history, question: p.question, external: p.external })
```

并在 `generateChatReply` 的参数类型里加：

```ts
    /**
     * 本轮检索到的【外部资料】块（见 lib/research.ts 的 formatExternal）。
     * 不传 = 不联网，装配结果与改造前逐字一致。
     */
    external?: string
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `node scripts/test-chat-external.mjs && npx tsc --noEmit`
Expected: PASS；tsc 通过

- [ ] **Step 5: 提交**

```bash
git add src/renderer/lib/generate.ts scripts/test-chat-external.mjs
git commit -m "feat(chat): 外部资料注入点，并锁住不联网时的装配结果"
```

---

### Task 7: AIPanel 界面（联网 chip / 来源卡 / 上下文块）

**Files:**
- Modify: `src/renderer/components/AIPanel.tsx`
- Modify: `src/renderer/lib/generate.ts`（确认 `generateCustom` 可复用做摘要；已有，无需改）
- Verify: `npm run dev` 手测 + `npm run shot`

**Interfaces:**
- Consumes: `research()`、`formatExternal`、`config.settings.webSearch`、`mz.search.run`
- Produces: 无对外接口

- [ ] **Step 1: 接上检索链路**

在 `AIPanel` 组件顶部状态区加：

```ts
  const webSearch = config?.settings.webSearch
  // 本轮是否联网：作者每次发送前显式决定，不做自动判断
  const [withSearch, setWithSearch] = useState(false)
  const [searching, setSearching] = useState('')
  const searchReady = Boolean(webSearch?.enabled && webSearch.channelId)
```

在 `send` 里，`generateChatReply` 调用之前插入：

```ts
      let external = ''
      let researchMeta: ResearchMeta | null = null
      if (withSearch && webSearch?.channelId) {
        setSearching('正在查资料…')
        const outcome = await research(q, {
          channelId: webSearch.channelId,
          maxResults: webSearch.maxResults,
          maxQueries: webSearch.maxQueries,
          run: (req) => mz.search.run(req),
          summarize: webSearch.summarize
            ? async (raw) => {
                const st = useApp.getState()
                const r2 = resolveTaskModel(st.config, st.project!, 'chat')
                if (!r2) return null
                try {
                  const out = await generateCustom({
                    project,
                    chapter,
                    channel: r2.channel,
                    model: r2.model,
                    task: 'chat',
                    temperature: 0.2,
                    budgets: st.config?.settings.tokenBudgets,
                    system: '你是资料整理员。把检索结果压成中文要点，保留所有数字、专名、单位与年代，不要评论、不要加标题。每条一段，以 [编号] 开头。',
                    user: raw,
                    onDelta: () => {}
                  })
                  return out.text
                } catch {
                  return null
                }
              }
            : undefined
        })
        external = outcome.text
        researchMeta = outcome.meta
        setSearching('')
      }
```

把 `external` 传进 `generateChatReply({ ..., external })`，并在落库那条 assistant 消息里加 `research: researchMeta ?? undefined`。

`mz` 与 `generateCustom`、`ResearchMeta` 分别从 `../lib/bridge`、`../lib/generate`、`@shared/types` import。

- [ ] **Step 2: 加「联网」chip**

在 `可改稿/只聊天` 那个 chip 之后插入（同一个 `flex` 容器内）：

```tsx
                {webSearch?.enabled && (
                  <button
                    className="chip surface-hover"
                    style={{
                      height: 18,
                      padding: '0 6px',
                      fontSize: 10,
                      color: !searchReady ? 'var(--text-faint)' : withSearch ? 'var(--accent)' : 'var(--text-dim)'
                    }}
                    title={
                      !searchReady
                        ? '还没有配置搜索源，去「设置 → 联网搜索」里加一个'
                        : withSearch
                          ? '这一轮会先联网查资料再回答。点一下关掉。'
                          : '这一轮先联网查资料再回答（会消耗搜索额度）。'
                    }
                    onClick={() => {
                      if (!searchReady) {
                        toast('还没有配置搜索源，请到「设置 → 联网搜索」里添加', 'error')
                        return
                      }
                      setWithSearch((v) => !v)
                    }}
                  >
                    {searching ? searching : withSearch ? '联网·开' : '联网'}
                  </button>
                )}
```

- [ ] **Step 3: 来源卡片**

在助手气泡的 `m.edits...` 那一段之前插入：

```tsx
                {m.research && m.research.hits.length > 0 && (
                  <details className="mt-1 rounded-lg px-2 py-1.5" style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}>
                    <summary className="text-[11px] cursor-pointer" style={{ color: 'var(--text-dim)' }}>
                      来源 {m.research.hits.length} 条{m.research.cached ? '（缓存）' : ''}
                    </summary>
                    <div className="mt-1 flex flex-col gap-1">
                      {m.research.hits.map((h, i) => (
                        <button
                          key={h.url}
                          className="text-left text-[11px] leading-relaxed"
                          style={{ color: 'var(--accent)' }}
                          title={h.url}
                          onClick={() => void mz.app.openExternal(h.url)}
                        >
                          [{i + 1}] {h.title}
                          <span style={{ color: 'var(--text-faint)' }}> · {h.source}</span>
                        </button>
                      ))}
                    </div>
                  </details>
                )}
```

- [ ] **Step 4: 上下文页的「外部资料」块**

`ContextView` 里，在 `ctx.blocks.map(...)` 之后加：

```tsx
      {(() => {
        const last = [...project.chat].reverse().find((m) => m.research?.hits.length)
        if (!last?.research) return null
        const r = last.research
        return (
          <div className="rounded-lg px-2.5 py-2" style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 mb-1">
              <Eye size={11} style={{ color: 'var(--ok)' }} />
              <span className="text-[11.5px] font-medium">外部资料</span>
              <span className="ml-auto text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                {r.hits.length} 条{r.cached ? ' · 缓存' : ''}
              </span>
            </div>
            <div className="text-[10.5px] mb-1" style={{ color: 'var(--text-faint)' }}>
              检索：{r.queries.join('；')} · {new Date(r.at).toLocaleString()}
            </div>
            <div className="text-[11px] line-clamp-3 selectable" style={{ color: 'var(--text-dim)' }}>
              {r.hits.map((h) => h.title).join(' / ')}
            </div>
          </div>
        )
      })()}
```

- [ ] **Step 5: 手测**

Run: `npm run typecheck && npm run dev`
手测清单：
1. 没配搜索源时，chip 文字为「联网」且点击有错误提示
2. 配好搜索源后点 chip 变「联网·开」，发送后气泡下方出现「来源 N 条」，展开可点击
3. 关掉 chip 再问一次，messages 里不出现 `【外部资料】`（可在「上下文」页签确认没有外部资料块）
4. 刷新页面，来源卡仍在

- [ ] **Step 6: 提交**

```bash
git add src/renderer/components/AIPanel.tsx
git commit -m "feat(chat): 联网 chip、来源卡片与上下文外部资料块"
```

---

### Task 8: 设置页「联网搜索」

**Files:**
- Create: `src/renderer/pages/Settings/SearchSection.tsx`
- Modify: `src/renderer/pages/Settings/index.tsx`（`SectionId` / `NAV` / 渲染分支）
- Verify: `npm run dev` 手测

**Interfaces:**
- Consumes: `SEARCH_PRESETS`、`normalizeSearchChannel`、`commitConfig`（`./common`）、`mz.config.secretSet`
- Produces: 无对外接口

- [ ] **Step 1: 建区块**

`SearchSection.tsx` 结构（照 `ChannelsSection` 的简化版：一个总闸 + 开关项 + 列表 + 弹窗内联表单）：

```tsx
import { useEffect, useState, type ReactNode } from 'react'
import type { SearchChannel } from '@shared/types'
import { SEARCH_PRESETS, normalizeSearchChannel } from '@shared/webSearch'
import { mz } from '../../lib/bridge'
import { Button, Switch } from '../../components/ui'
import { useApp } from '../../store/app'
import { commitConfig, PageHead } from './common'

export function SearchSection(): ReactNode {
  const config = useApp((s) => s.config)
  const toast = useApp((s) => s.toast)
  const ws = config?.settings.webSearch
  const channels = config?.searchChannels ?? []
  const [keyState, setKeyState] = useState<Record<string, boolean>>({})
  const [editing, setEditing] = useState<SearchChannel | null>(null)

  useEffect(() => {
    const list = config?.searchChannels ?? []
    void (async () => {
      const pairs = await Promise.all(
        list.map(async (c): Promise<[string, boolean]> => {
          try {
            return [c.id, await mz.config.secretHas(`search:${c.id}`)]
          } catch {
            return [c.id, false]
          }
        })
      )
      setKeyState(Object.fromEntries(pairs))
    })()
  }, [channels.map((c) => c.id).join('|')])

  const save = async (ch: SearchChannel, key: string): Promise<void> => {
    const next = channels.some((c) => c.id === ch.id)
      ? channels.map((c) => (c.id === ch.id ? ch : c))
      : [...channels, ch]
    if (key.trim()) await mz.config.secretSet(`search:${ch.id}`, key.trim())
    await commitConfig({ ...config!, searchChannels: next })
    setEditing(null)
    toast('搜索源已保存', 'ok')
  }

  return (
    <div>
      <PageHead title="联网搜索" desc="AI 对话里的「查资料」从这里取数。事实类问题（史料、工艺、参数）建议开着；纯创作不需要。" />
      <div className="card p-3 mb-4 flex items-center justify-between">
        <div className="text-[12.5px]">
          启用联网搜索
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
            关掉后对话界面不再出现「联网」按钮，一切与从前一致。
          </div>
        </div>
        <Switch
          checked={Boolean(ws?.enabled)}
          onChange={(v) => void commitConfig({ ...config!, settings: { ...config!.settings, webSearch: { ...ws!, enabled: v } } })}
        />
      </div>

      <div className="card p-3 mb-4 flex flex-col gap-2">
        <div className="text-[12px] font-medium">默认搜索源</div>
        {channels.length === 0 && (
          <div className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            还没有搜索源。推荐「博查 Bocha」：国内可直连，中文史料与工艺类结果质量好。
          </div>
        )}
        {channels.map((c) => (
          <div key={c.id} className="flex items-center gap-2 py-1">
            <Switch
              checked={ws?.channelId === c.id}
              onChange={(v) => void commitConfig({ ...config!, settings: { ...config!.settings, webSearch: { ...ws!, channelId: v ? c.id : null } } })}
            />
            <span className="text-[12px] flex-1 min-w-0 truncate">{c.name}</span>
            <span className="text-[10.5px]" style={{ color: keyState[c.id] ? 'var(--ok)' : 'var(--text-faint)' }}>
              {c.auth === 'none' ? '无需 Key' : keyState[c.id] ? '已配置 Key' : '未配置 Key'}
            </span>
            <button className="chip surface-hover" style={{ height: 20 }} onClick={() => setEditing(c)}>
              编辑
            </button>
            <button
              className="chip surface-hover"
              style={{ height: 20 }}
              onClick={() => {
                void mz.config.secretClear(`search:${c.id}`)
                void commitConfig({
                  ...config!,
                  searchChannels: channels.filter((x) => x.id !== c.id),
                  settings: { ...config!.settings, webSearch: { ...ws!, channelId: ws?.channelId === c.id ? null : ws!.channelId } }
                })
              }}
            >
              删除
            </button>
          </div>
        ))}
        <div>
          <Button size="sm" onClick={() => setEditing(normalizeSearchChannel({ name: SEARCH_PRESETS[0].name, presetId: SEARCH_PRESETS[0].id }))}>
            新增搜索源
          </Button>
        </div>
      </div>

      {editing && <SearchDialog channel={editing} onCancel={() => setEditing(null)} onSave={save} />}
    </div>
  )
}
```

`SearchDialog` 与 `SearchSection` 同文件：预设下拉（`SEARCH_PRESETS`）、名称、baseUrl（选预设时自动填）、Key 输入、保存/取消，字段写回 `SearchChannel`。Key 只在 `save` 时通过 `mz.config.secretSet('search:<id>', key)` 落库，**不进入 config.json**。

- [ ] **Step 2: 注册导航**

`index.tsx`：`SectionId` 加 `'search'`；`NAV` 在 `channels` 之后加 `{ id: 'search', label: '联网搜索', icon: Globe }`（`Globe` 从 `lucide-react` import）；渲染分支加 `{active === 'search' && <SearchSection />}`（照现有分支写法）。

- [ ] **Step 3: 手测**

Run: `npm run typecheck && npm run dev`
清单：新增博查搜索源 → Key 显示「已配置」→ 回写作页点「联网」→ 提问历史类问题 → 出现来源卡 → 设置里关总闸 → 回对话页 chip 消失。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/pages/Settings/SearchSection.tsx src/renderer/pages/Settings/index.tsx
git commit -m "feat(settings): 联网搜索源配置"
```

---

### Task 9: 文档与全量回归

**Files:**
- Modify: `README.md`（版本说明处加一段）
- Modify: `docs/使用说明.md`（「AI 对话」一节补「联网查资料」）

- [ ] **Step 1: 补文档**

两处都写清三件事：怎么配（设置 → 联网搜索 → 博查）、怎么用（对话页「联网」chip）、什么时候别用（虚构体系别查，会雷同）。

- [ ] **Step 2: 全量回归**

```bash
npm run typecheck
for f in scripts/test-*.mjs scripts/test-*.cjs; do echo "== $f"; node "$f" || break; done
```

Expected: 全部通过（含 `test-budgets.mjs`；若它因新增 `search.summarize` 报未覆盖，把 `'search.summarize': 1200` 加进 `FIXED_EXPECT`）

- [ ] **Step 3: 提交**

```bash
git add README.md docs/使用说明.md scripts/test-budgets.mjs
git commit -m "docs: 联网查资料的配置与使用说明"
```

---

## Self-Review

**Spec 覆盖检查**

| spec 小节 | 落在哪个任务 |
| --- | --- |
| 分层（主进程持 key/缓存） | Task 3 / 4 |
| 数据模型（SearchChannel / WebSearchSettings / ChatMessage.research / 预算键） | Task 1（故意去掉 `search.plan`：P1 的 buildQueries 是规则实现） |
| 接口 `search:run` | Task 4 |
| 数据流（buildQueries → 缓存 → 检索 → 摘要 → 注入 → 落库） | Task 4 / 5 / 7 |
| 提示词注入位置与格式 | Task 5（formatExternal）+ Task 6（位置断言） |
| UI：chip / 来源卡 / 上下文块 | Task 7 |
| UI：设置页搜索源 | Task 8 |
| 降级矩阵（8 种失败） | Task 4（分类）+ Task 5（未取得块）+ Task 7（提示） |
| 成本（不联网 0 增量） | Task 6（逐字一致断言） |
| 测试：单测 6 条 + 集成 | Task 1–6 + `test-web-search-live.mjs` |
| 虚假体系不联网 | Task 5（`fiction-system` 分支 + 断言） |
| 摘要失败退回原文 | Task 5（length 不匹配与异常两条兜底） |

**未覆盖 / 明确推迟**：E2E 的 Electron 级 stub（P1 用 node 集成测试 + 手测清单替代）；「带着资料重答」、资料卡沉淀、搜索源「测试连接」都属 P2，spec 已写明。

**类型一致性**：`ResearchMeta` 在 Task 1 定义、Task 5 产出、Task 7 消费，字段一致；`SearchRunResult.error` 形状在 Task 1 / 4 / 5 一致；`buildChatMessages` 只在 Task 6 定义并被测试直接引用。