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
    // 排第一：作者多半已经在用它写稿，Key 能直接复用，等于零新增成本
    id: 'deepseek',
    name: 'DeepSeek 搜索',
    baseUrl: 'https://api.deepseek.com/v1/tools/search',
    auth: 'bearer',
    keyHint: 'DeepSeek API Key（可与模型渠道共用，可留空自动复用）',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '官方自研搜索引擎，按成功请求计费（约 0.005 元/次，空结果不计费）；Key 与 DeepSeek 模型渠道共用'
  },
  {
    id: 'bocha',
    name: '博查 Bocha',
    baseUrl: 'https://api.bochaai.com/v1/web-search',
    auth: 'bearer',
    keyHint: 'sk-...',
    keyUrl: 'https://open.bochaai.com',
    note: '国内可直连，中文史料与工艺类结果质量好'
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

/**
 * 某个接口地址是不是 DeepSeek 官方端点。
 *
 * 放在 shared 里：主进程用它决定「能不能借模型渠道的 Key」，
 * 渲染进程用它决定设置页显示「复用模型 Key」还是「未配置 Key」。
 * 两边各写一份正则的后果是界面说复用了、实际没复用——踩过一次。
 *
 * 只认 hostname 恰好匹配，别用「字符串里包含」：`api.deepseek.com.evil.cn` 这种假冒域名
 * 一旦被当成官方端点，就会把别人的 token 发出去。
 */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function isDeepSeekEndpoint(baseUrl: string): boolean {
  const host = hostOfUrl(baseUrl)
  return host === 'api.deepseek.com' || host.endsWith('.api.deepseek.com')
}

/** 这个搜索源是否允许「留空 Key，复用模型渠道那一个」 */
export function canReuseModelKey(channel: Pick<SearchChannel, 'presetId'>): boolean {
  return channel.presetId === 'deepseek'
}

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
 * 这里一律夹到安全范围：一个 99 条的 maxResults 会让单次检索花掉几毛钱，
 * 而作者多半只是手滑多按了一个键。
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
  const presetId = SEARCH_PRESETS.some((p) => p.id === c.presetId)
    ? (c.presetId as SearchChannel['presetId'])
    : 'custom'
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