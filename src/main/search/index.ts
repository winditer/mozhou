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
  if (!p.channel) {
    return { hits: [], queries, cached: false, error: { kind: 'no-channel', message: MESSAGES['no-channel'] } }
  }
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
      // AbortSignal.timeout 抛 TimeoutError；其余（DNS/连接失败）归网络错误
      failure = (e as Error).name === 'TimeoutError' ? 'timeout' : 'network'
    }
  }

  const hits = dedupeHits(all).slice(0, p.maxResults * 2)
  const result: SearchRunResult = { hits, queries, cached: cachedHits === queries.length && hits.length > 0 }
  if (!hits.length && failure) result.error = { kind: failure, message: MESSAGES[failure] }
  return result
}