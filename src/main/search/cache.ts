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

export function cacheKey(channelId: string, query: string, maxResults: number): string {
  return createHash('sha1').update(`${channelId}|${query.trim()}|${maxResults}`).digest('hex')
}

/**
 * 淘汰过期与超量条目。cap 用「条目数」而不是字节数：
 * 一条命中通常 4–6 个 snippet，500 条上限约 1–2MB，够用且实现简单。
 *
 * 空 hits 的条目也淘汰：它只可能是上次搜到 0 条时留下的，
 * 留着会让作者以为「缓存里明明有」，实际却什么也拿不到。
 */
export function pruneCache(file: CacheFile, nowMs: number, ttlHours: number, cap: number): CacheFile {
  const ttl = ttlHours * 3600_000
  const alive = Object.entries(file.entries ?? {}).filter(
    ([, e]) => e && nowMs - e.at < ttl && Array.isArray(e.hits) && e.hits.length > 0
  )
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
      return { v: 1, entries: {} }
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