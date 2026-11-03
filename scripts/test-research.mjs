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
const { buildQueries, formatExternal, research, planQueryPrompt, parseQueryPlan } = await import(pathToFileURL(outfile).href)

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

console.log('通用模式：不靠窄词表判该不该查')
check('通用模式认「今天有什么热榜」', buildQueries('今天有什么热榜', 2, { general: true }).queries.length > 0, JSON.stringify(buildQueries('今天有什么热榜', 2, { general: true })))
check('通用模式认「诺贝尔文学奖是谁」', buildQueries('2026 年诺贝尔文学奖是谁', 2, { general: true }).queries.length > 0)
check('通用模式 reason=general', buildQueries('今天科技圈有什么新闻', 2, { general: true }).reason === 'general')
check('通用模式仍然跳过创作指令', buildQueries('帮我写一段雪景', 2, { general: true }).queries.length === 0)
check('通用模式跳过创作指令时 reason=creative', buildQueries('帮我写一段雪景', 2, { general: true }).reason === 'creative')
check('通用模式允许查虚构体系的通用知识', buildQueries('修仙体系的境界划分有哪些', 2, { general: true }).queries.length > 0)
check('本书模式仍不认「今天有什么热榜」', buildQueries('今天有什么热榜', 2).queries.length === 0)
check('本书模式仍跳过虚构体系', buildQueries('修仙小说的境界体系一般怎么排', 2).queries.length === 0)

const genRes = await research('今天有什么热榜', {
  general: true,
  channelId: 'c',
  maxResults: 5,
  maxQueries: 2,
  run: async (req) => ({ hits: [{ title: 'T', url: 'https://e.com/1', snippet: 'S', source: 'e.com' }], queries: req.queries, cached: false })
})
check('通用模式真的发起了检索', genRes.meta !== null && genRes.meta.hits.length === 1, JSON.stringify(genRes.meta?.queries))

const genErr = await research('今天有什么热榜', {
  general: true,
  channelId: 'c',
  maxResults: 5,
  maxQueries: 2,
  run: async (req) => ({ hits: [], queries: req.queries, cached: false, error: { kind: 'auth', message: 'API Key 无效或已过期' } })
})
check('检索失败时 outcome 带 error（界面要据此提醒）', Boolean(genErr.error) && genErr.error.kind === 'auth', JSON.stringify(genErr.error))
check('检索失败时降级块仍给模型', genErr.text.includes('未取得外部资料'))

const genSkip = await research('帮我写一段打斗', { general: true, channelId: 'c', maxResults: 5, maxQueries: 2, run: async (req) => ({ hits: [], queries: req.queries, cached: false }) })
check('通用模式跳过创作指令时带 skipReason', genSkip.skipped && genSkip.skipReason === 'creative', JSON.stringify(genSkip.skipReason))

console.log('模型规划检索词')
const now = new Date(2026, 10, 3, 9, 0, 0)
const pp = planQueryPrompt('最近有什么 AI 大新闻', now, 2)
check('规划提示词带今天的绝对日期', pp.system.includes('2026 年 11 月 3 日'))
check('规划提示词说明相对时间换算', pp.system.includes('「今天」指 2026 年 11 月 3 日'))
check('规划提示词带年份', pp.system.includes('2026'))
check('规划提示词限定条数', pp.system.includes('最多 2 条'))
check('规划提示词给「无需检索」出口', pp.system.includes('无需检索'))
check('规划提示词的 user 就是原问题', pp.user === '最近有什么 AI 大新闻')

check('解析：编号与项目符号被清掉', JSON.stringify(parseQueryPlan('1. 2026 年 AI 大新闻\n- 2026 AI 发布会', 2)) === JSON.stringify(['2026 年 AI 大新闻', '2026 AI 发布会']), JSON.stringify(parseQueryPlan('1. 2026 年 AI 大新闻\n- 2026 AI 发布会', 2)))
check('解析：最多取 maxQueries 条', parseQueryPlan('a1\na2\na3\na4', 2)?.length === 2)
check('解析：去重', parseQueryPlan('今天天气\n今天天气', 3)?.length === 1)
check('解析：解释性长句被丢掉', parseQueryPlan('这是一条很长的解释'.repeat(12), 3) === null)
check('解析：模型说无需检索 → 空数组', JSON.stringify(parseQueryPlan('无需检索', 3)) === '[]')
check('解析：空输出 → null（退回规则词）', parseQueryPlan('   ', 3) === null)
check('解析：结尾标点被去掉', parseQueryPlan('明朝建立时间？', 1)?.[0] === '明朝建立时间')

const planned = await research('最近有什么 AI 大新闻', {
  general: true,
  channelId: 'c',
  maxResults: 5,
  maxQueries: 2,
  plan: async () => ['2026 年 AI 大新闻', '2026 年 11 月 AI 发布会'],
  run: async (req) => ({ hits: [], queries: req.queries, cached: false })
})
check('模型规划的查询词被真的用上', JSON.stringify(planned.meta?.queries) === JSON.stringify(['2026 年 AI 大新闻', '2026 年 11 月 AI 发布会']), JSON.stringify(planned.meta?.queries))

const planFail = await research('2026 年诺贝尔文学奖是谁', {
  general: true,
  channelId: 'c',
  maxResults: 5,
  maxQueries: 2,
  plan: async () => {
    throw new Error('plan boom')
  },
  run: async (req) => ({ hits: [], queries: req.queries, cached: false })
})
check('规划抛错退回规则词', planFail.meta !== null && planFail.meta.queries.length === 1, JSON.stringify(planFail.meta?.queries))

const planNull = await research('今天有什么热榜', {
  general: true,
  channelId: 'c',
  maxResults: 5,
  maxQueries: 2,
  plan: async () => null,
  run: async (req) => ({ hits: [], queries: req.queries, cached: false })
})
check('规划返回 null 也照查（不退化成不查）', planNull.meta !== null && planNull.meta.queries.length === 1, JSON.stringify(planNull.meta))

const planSkip = await research('今天有什么热榜', {
  general: true,
  channelId: 'c',
  maxResults: 5,
  maxQueries: 2,
  plan: async () => [],
  run: async () => {
    throw new Error('不该被调用')
  }
})
check('模型明说无需检索才跳过', planSkip.skipped === true && planSkip.text === '')

const planCreative = await research('帮我写一段打斗', {
  general: true,
  channelId: 'c',
  maxResults: 5,
  maxQueries: 2,
  plan: async () => {
    throw new Error('创作指令不该请模型规划')
  },
  run: async () => {
    throw new Error('不该被调用')
  }
})
check('创作指令不请模型规划', planCreative.skipped && planCreative.skipReason === 'creative')

console.log('外部资料块：通用模式与本书模式不同')
const genHit = { hits: [{ title: 'T', url: 'https://e.com/1', snippet: 'S', source: 'e.com' }], queries: ['q'], at: Date.now(), cached: false }
const genBlock = formatExternal(genHit, { general: true })
check('通用模式不再提「本书设定」', !genBlock.includes('本书设定'), genBlock.slice(0, 40))
check('通用模式明说这是检索结果', genBlock.includes('刚刚为你联网检索'))
check('通用模式禁止说「我没有联网」', genBlock.includes('不要再说「我没有联网」'))
check('通用模式要求标编号', genBlock.includes('[编号]'))
check('通用模式要求忽略无关条目', genBlock.includes('无关的条目直接忽略'))
const bookBlock = formatExternal(genHit)
check('本书模式仍保留本书设定优先', bookBlock.includes('以本书设定为准'))
check('本书模式仍要求标编号', bookBlock.includes('[编号]'))

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)