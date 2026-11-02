/**
 * 各家搜索 API 的响应 → SearchHit。
 *
 * 各家字段名全是私货：博查 webPages.value[].name，智谱 search_result[].link，
 * Tavily results[].content，Serper organic[].link，SearXNG results[].url。
 * 全部吸收在这里，上层只见一种形状；坏形状一律返回空数组，绝不抛异常
 * ——一次解析失败不该让作者看到「网络错误」这种误导性的说法。
 */
import type { SearchHit } from '@shared/types'

type Dict = Record<string, unknown>

const asArray = (v: unknown): Dict[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Dict[]) : []

/** 各家「结果数组」可能挂在这些位置，按顺序取第一个非空的 */
function pickList(json: Dict): Dict[] {
  const data = json.data as Dict | undefined
  const webPages = data?.webPages as Dict | undefined
  const candidates = [webPages?.value, data, json.search_result, json.results, json.organic, data?.results]
  for (const c of candidates) {
    const arr = asArray(c)
    if (arr.length) return arr
  }
  return []
}

const str = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''

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
    // 没有可用链接的条目对「作者去核对」毫无价值，直接丢
    if (!url || !/^https?:\/\//i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push({
      title: title || hostOf(url),
      url,
      snippet,
      source: hostOf(url),
      publishedAt:
        str(item.datePublished) ||
        str(item.publish_date) ||
        str(item.published_date) ||
        str(item.date) ||
        undefined
    })
    if (out.length >= limit) break
  }
  return out
}

export function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>()
  const out: SearchHit[] = []
  for (const h of hits) {
    if (seen.has(h.url)) continue
    seen.add(h.url)
    out.push(h)
  }
  return out
}