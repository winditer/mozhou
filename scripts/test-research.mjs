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
const { buildQueries, formatExternal, research } = await import(pathToFileURL(outfile).href)

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
check('闲聊不联网', buildQueries('你好', 2).queries.length === 0, JSON.stringify(buildQueries('你好', 2)))

const q = buildQueries('明代锦衣卫的品级是怎么分的？', 2)
check('query 去掉问号', !q.queries[0].includes('？'), q.queries[0])
check('query 去掉"请问"', !buildQueries('请问明代锦衣卫的品级是怎么分的', 2).queries[0].includes('请问'))
check('query 条数不超过 maxQueries', buildQueries('明代锦衣卫的品级是怎么分的，另外讲讲飞鱼服', 1).queries.length === 1)
check('query 非空', q.queries.every((x) => x.trim().length >= 2), JSON.stringify(q.queries))
check('多主题时给两条', buildQueries('明代锦衣卫的品级，以及飞鱼服的形制', 2).queries.length === 2, JSON.stringify(buildQueries('明代锦衣卫的品级，以及飞鱼服的形制', 2)))

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
check('带查询词', ok.includes('明代锦衣卫的品级'))

const cachedBlock = formatExternal({
  hits: [{ title: 'T', url: 'https://e.com/1', snippet: 's', source: 'e.com' }],
  queries: ['q'],
  at: Date.now(),
  cached: true
})
check('缓存时注明命中缓存', cachedBlock.includes('命中缓存'))

const failed = formatExternal({
  hits: [],
  queries: ['明代锦衣卫'],
  at: Date.now(),
  cached: false,
  error: { kind: 'timeout', message: '检索超时，可以重试' }
})
check('失败时明说未取得', failed.includes('未取得外部资料'))
check('失败时给出人话原因', failed.includes('检索超时'))
check('失败时要求声明是模型知识', failed.includes('自己的知识'))
check('失败时不留编号', !failed.includes('[1]'))

console.log('research 编排')
const hit = (i) => ({ title: `T${i}`, url: `https://e.com/${i}`, snippet: `S${i}`, source: 'e.com' })

const skipped = await research('帮我写一段打斗', {
  channelId: 'c',
  maxResults: 5,
  maxQueries: 2,
  run: async () => {
    throw new Error('不该被调用')
  }
})
check('创作请求根本不去检索', skipped.skipped === true && skipped.text === '')

let called = 0
const out = await research('明代锦衣卫的品级', {
  channelId: 'c',
  maxResults: 5,
  maxQueries: 2,
  run: async (req) => {
    called++
    return { hits: [hit(1)], queries: req.queries, cached: false }
  }
})
check('事实请求调用一次检索', called === 1)
check('产出外部资料块', out.text.includes('【外部资料') && out.meta?.hits.length === 1)

const sumMismatch = await research('明代锦衣卫的品级', {
  channelId: 'c',
  maxResults: 5,
  maxQueries: 2,
  run: async (req) => ({ hits: [hit(1), hit(2)], queries: req.queries, cached: false }),
  summarize: async () => '[1] 只压出一条'
})
check('摘要条数对不上时退回原文', sumMismatch.meta.hits.map((h) => h.snippet).join('|') === 'S1|S2', sumMismatch.meta.hits.map((h) => h.snippet).join('|'))

const sumOk = await research('明代锦衣卫的品级', {
  channelId: 'c',
  maxResults: 5,
  maxQueries: 2,
  run: async (req) => ({ hits: [hit(1), hit(2)], queries: req.queries, cached: false }),
  summarize: async () => '[1] 甲\n[2] 乙'
})
check('摘要条数对上时采用', sumOk.meta.hits.map((h) => h.snippet).join('|') === '甲|乙', sumOk.meta.hits.map((h) => h.snippet).join('|'))

const runThrow = await research('明代锦衣卫的品级', {
  channelId: 'c',
  maxResults: 5,
  maxQueries: 2,
  run: async () => {
    throw new Error('boom')
  }
})
check('检索抛异常也产出降级块', runThrow.text.includes('未取得外部资料') && runThrow.meta.hits.length === 0)

const emptyRes = await research('明代锦衣卫的品级', {
  channelId: 'c',
  maxResults: 5,
  maxQueries: 2,
  run: async (req) => ({ hits: [], queries: req.queries, cached: false, error: { kind: 'empty', message: '没有搜到相关结果' } })
})
check('空结果带上人话原因', emptyRes.text.includes('没有搜到相关结果'))

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)