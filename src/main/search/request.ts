/**
 * 按搜索源预设生成一次 HTTP 请求。
 *
 * 单独成文件且保持纯函数（不碰 fetch、不碰 fs），是因为「请求长什么样」是这套功能里
 * 最容易出错的细节：key 放错位置会被 401，字段名写错会静默变成空结果。
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
      // 自定义源按博查同款字段：这是给「兼容博查格式的网关」留的入口
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