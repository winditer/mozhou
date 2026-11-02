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
  if (mode === 'deepseek') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        results: [
          {
            rerank_score: 2.4,
            title: '锦衣卫 - 维基百科',
            url: 'https://zh.wikipedia.org/wiki/1',
            snippet: '短',
            summary: '锦衣卫设指挥使一人，正三品。',
            content: '',
            site_name: '维基百科',
            date: '2026-06-01T00:00:00+00:00',
            authority: 3
          }
        ]
      })
    )
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
const base = { channel, apiKey: 'K', maxResults: 5, ttlHours: 24, cacheFile, timeoutMs: 2000 }

const ok1 = await runSearch({ ...base, queries: ['明代锦衣卫'] })
check('成功返回 2 条', ok1.hits.length === 2, String(ok1.hits.length))
check('无 error', !ok1.error, JSON.stringify(ok1.error))
check('首次非缓存', ok1.cached === false)
check('打了一次服务', hits === 1, String(hits))

const ok2 = await runSearch({ ...base, queries: ['明代锦衣卫'] })
check('二次命中缓存', ok2.cached === true)
check('二次不再打服务', hits === 1, String(hits))

mode = '401'
const bad = await runSearch({ ...base, queries: ['另一件事'], ttlHours: 0 })
check('401 变 auth 错误', bad.error?.kind === 'auth', JSON.stringify(bad.error))
check('401 时仍返回空结果集而非抛错', Array.isArray(bad.hits))

mode = 'empty'
const empty = await runSearch({ ...base, queries: ['第三件事'], ttlHours: 0 })
check('空结果归 empty', empty.error?.kind === 'empty', JSON.stringify(empty.error))

mode = 'slow'
const slow = await runSearch({ ...base, queries: ['第四件事'], ttlHours: 0, timeoutMs: 300 })
check('超时归 timeout', slow.error?.kind === 'timeout', JSON.stringify(slow.error))

const noKey = await runSearch({ ...base, apiKey: null, queries: ['x'], ttlHours: 0, timeoutMs: 500 })
check('无 key 归 no-key', noKey.error?.kind === 'no-key', JSON.stringify(noKey.error))

const noCh = await runSearch({ ...base, channel: null, queries: ['x'], ttlHours: 0, timeoutMs: 500 })
check('无搜索源归 no-channel', noCh.error?.kind === 'no-channel', JSON.stringify(noCh.error))

mode = 'deepseek'
const ds = await runSearch({
  ...base,
  channel: { ...channel, id: 'stub-ds', presetId: 'deepseek', baseUrl: `http://127.0.0.1:${port}/v1/tools/search` },
  queries: ['明代锦衣卫品级'],
  ttlHours: 0
})
check('deepseek 通道能拿到结果', ds.hits.length === 1, String(ds.hits.length))
check('deepseek 用 summary 当摘要', ds.hits[0]?.snippet === '锦衣卫设指挥使一人，正三品。', String(ds.hits[0]?.snippet))
check('deepseek 用 site_name 当来源', ds.hits[0]?.source === '维基百科', String(ds.hits[0]?.source))
check('deepseek 无 error', !ds.error, JSON.stringify(ds.error))

mode = 'ok'
const multi = await runSearch({ ...base, queries: ['明代锦衣卫', '飞鱼服'], ttlHours: 0 })
check('多 query 合并去重', multi.hits.length === 2, String(multi.hits.length))

server.close()
rmSync(outdir, { recursive: true, force: true })
console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)