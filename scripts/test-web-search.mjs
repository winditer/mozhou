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
check('默认汇总开', web.DEFAULT_WEB_SEARCH.summarize === true)

const wild = web.normalizeWebSearch({ maxResults: 99, maxQueries: 0, cacheTtlHours: -5 })
check('maxResults 夹到 8', wild.maxResults === 8, String(wild.maxResults))
check('maxQueries 夹到 1', wild.maxQueries === 1, String(wild.maxQueries))
check('ttl 夹到 0', wild.cacheTtlHours === 0, String(wild.cacheTtlHours))
check('残缺配置补全', web.normalizeWebSearch({}).enabled === false)

const ch = web.normalizeSearchChannel({ name: '', baseUrl: '  ' })
check('渠道名兜底', ch.name === '未命名搜索源', ch.name)
check('非预设渠道名兜底为 custom', ch.presetId === 'custom', String(ch.presetId))
check('预设渠道补 baseUrl', web.normalizeSearchChannel({ name: 'b', presetId: 'bocha' }).baseUrl.startsWith('https://'))

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
check('searxng 查询串已编码', !searx.url.includes('明代'), searx.url)

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

const zhipuJson = { search_result: [{ title: '明代官职', link: 'https://example.com/a', content: '正三品…', publish_date: '2023-05-01' }] }
check('zhipu 解析 link/content', norm.extractHits('zhipu', zhipuJson, 5)[0].url === 'https://example.com/a')

const tavilyJson = { results: [{ title: 'T', url: 'https://t.example/x', content: 'C', published_date: '2022-01-01' }] }
check('tavily 解析 results/content', norm.extractHits('tavily', tavilyJson, 5)[0].snippet === 'C')

const serperJson = { organic: [{ title: 'S', link: 'https://s.example/y', snippet: 'Snip' }] }
check('serper 解析 organic/link', norm.extractHits('serper', serperJson, 5)[0].title === 'S')

const searxJson = { results: [{ title: 'X', url: 'https://x.example/z', content: 'Cx' }] }
check('searxng 解析 results/url', norm.extractHits('searxng', searxJson, 5)[0].url === 'https://x.example/z')

check(
  'limit 生效',
  norm.extractHits(
    'bocha',
    { data: { webPages: { value: Array.from({ length: 10 }, (_, i) => ({ name: `n${i}`, url: `https://e.com/${i}`, snippet: 's' })) } } },
    3
  ).length === 3
)
check('坏形状不抛异常', Array.isArray(norm.extractHits('bocha', null, 5)))
check('坏值不抛异常', Array.isArray(norm.extractHits('zhipu', 'oops', 5)))

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)