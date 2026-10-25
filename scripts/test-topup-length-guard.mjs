/**
 * 长度守护（补字循环）的回归测试。
 * 运行：node scripts/test-topup-length-guard.mjs
 *
 * 为什么需要这一层：用户报的两类症状——
 *   1. 续写字数不够；
 *   2. 思考很久最后一片空白——
 * 都不在类型系统能拦住的范围里。旧实现有一次**踩过「补写越补越少」**的坑：
 * 补写轮把「还差多少字」当 targetWords 递给 resolveBudget，按字数预算的下限是 2048 token，
 * 于是越补额度越大、模型越写越铺；而早前另一版按「已写字数」算，章节写到 1 万字时
 * 直接顶到 16000 上限。这两种都是「数值算错了但编译通过」，只能靠跑真代码钉住。
 *
 * 做法与 test-generate-budgets.mjs 一致：esbuild 打包真正的 src/renderer/lib/generate.ts，
 * 用插件把 `./ai` 换成假的 sendChat，记录每次调用的 { task, maxTokens, messages }，
 * 并按预设脚本回放「这一轮吐多少字」。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { countWords } from '../src/shared/utils.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const entry = join(root, 'src/renderer/lib/generate.ts')

/** 每次 sendChat 的入参，按调用顺序 */
const CAPTURED = []
/**
 * 回放脚本：每个元素是一轮 sendChat 要吐的正文。
 * 用完了就重复最后一个（模拟「模型一直只写这么点」）。
 */
let script = ['']
let scriptIndex = 0
function setScript(list) {
  script = list.slice()
  scriptIndex = 0
}

const outdir = mkdtempSync(join(tmpdir(), 'mozhou-topup-test-'))
const outfile = join(outdir, 'generate.mjs')
await build({
  absWorkingDir: root,
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(root, 'src/shared') },
  plugins: [
    {
      name: 'stub-ai',
      setup(b) {
        b.onResolve({ filter: /^\.\/ai$/ }, () => ({ path: 'stub-ai', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `
            export async function sendChat(opts) {
              const i = globalThis.__scriptIndex++
              const plan = globalThis.__script[Math.min(i, globalThis.__script.length - 1)]
              globalThis.__captured.push({
                task: opts.task,
                maxTokens: opts.maxTokens,
                messages: opts.messages
              })
              // 首元素是字符串 = 正常吐字；对象 = 模拟异常（throw / 空正文 / 被截断）
              if (plan && typeof plan === 'object' && plan.throw) {
                throw new Error(plan.throw)
              }
              const text = (plan && plan.text) ?? (typeof plan === 'string' ? plan : '')
              // 真实实现是边流边回调，generate.ts 靠 onDelta 拼文本，这里照样回调一次
              if (text) opts.onDelta?.(text)
              return {
                text,
                thought: (plan && plan.thought) || '',
                promptTokens: 100,
                completionTokens: 100,
                ms: 1,
                finishReason: (plan && plan.finishReason) || 'stop',
                truncated: (plan && plan.finishReason) === 'length'
              }
            }
          `
        }))
      }
    }
  ]
})

globalThis.__captured = CAPTURED
globalThis.__script = script
globalThis.__scriptIndex = scriptIndex

// 上面注入的是快照，每次 setScript 后要同步写回全局，供 stub 读取
function syncGlobals() {
  globalThis.__script = script
  globalThis.__scriptIndex = scriptIndex
}

const gen = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

function reset() {
  CAPTURED.length = 0
  scriptIndex = 0
  syncGlobals()
}

/* ───────────────────────── 测试素材 ───────────────────────── */

const project = {
  id: 'p1',
  title: '雨巷',
  author: '',
  coverColor: '#000',
  sceneId: 'long-novel',
  genreId: '',
  createdAt: 0,
  updatedAt: 0,
  brief: { logline: '', premise: '', keywords: [] },
  settings: {
    targetWordsPerChapter: 2500,
    targetTotalWords: 0,
    lengthMode: 'soft', // 出厂默认值：旧实现在这个模式下完全不守护
    pov: '',
    tense: '',
    tone: [],
    audience: '',
    extraRules: '',
    context: { brief: false, characters: false, bible: false, outline: false, previous: false, style: false, genre: false },
    previousChapters: 2,
    modelOverrides: {}
  },
  bible: { characters: [], world: [], terms: [], timeline: [], threads: [] },
  outline: [],
  chapters: [],
  styleProfiles: []
}

const chapter = {
  id: 'c1',
  title: '第一章 雨',
  content: '',
  summary: '',
  status: 'draft',
  targetWords: 2500,
  words: 0,
  createdAt: 0,
  updatedAt: 0,
  versions: []
}

const channel = { id: 'ch', name: 'mock', protocol: 'openai', baseUrl: 'http://127.0.0.1:1', headers: {} }

function base(extra = {}) {
  return {
    project,
    chapter,
    channel,
    model: 'mock',
    task: 'draft',
    instruction: '接着写下去',
    targetWords: 2500,
    onDelta: () => {},
    ...extra
  }
}

/**
 * 造一段恰好 n 个中文字（countWords 的 CJK 口径）的正文。
 *
 * 注意不能写成 `拼满 n 个字符再 slice(0, n)`：单元串里还有标点，
 * 每 23 个字符只有 20 个 CJK，按字符切永远凑不满 n 个字，
 * 断言就会莫名其妙少 300 字（这是本脚本第一版踩过的坑）。
 */
function cn(n) {
  const unit = '雨落在瓦上，一层一层地压下去，巷子里没有人声。'
  const cjk = (s) => (s.match(/[\u3400-\u4DBF\u4E00-\u9FFF]/g) ?? []).length
  let out = ''
  // 逐单元累加，直到 CJK 数刚好够——然后只在单元边界上截，不切半个单元
  while (cjk(out) < n) {
    const next = out + unit
    if (cjk(next) > n) break
    out = next
  }
  return out
}

/* ───────────────────────── 1. 默认就守护（用户的病根） ───────────────────────── */

console.log('1. 不传 lengthGuard（出厂 soft 模式）也要自动补写')
{
  reset()
  setScript([cn(300), cn(2000), cn(2000)])
  syncGlobals()
  const text = await gen.generateDraft(base())
  check('触发了补写（至少 2 次请求）', CAPTURED.length >= 2, `实际 ${CAPTURED.length} 次`)
  check('首轮用 draft.generate', CAPTURED[0]?.task === 'draft', CAPTURED[0]?.task)
  check('补写轮也用 draft task', CAPTURED[1]?.task === 'draft', CAPTURED[1]?.task)
  check('最终字数达到目标 90%（守护的收工线）', countWords(text) >= 2500 * 0.9, `实际 ${countWords(text)} 字`)
  // 300 + 2000 = 2300 ≥ 2250（90%），所以补写一轮就收工，不该把 3 轮跑满
  check('达到 90% 就停，不把 3 轮跑满', CAPTURED.length === 2, `实际 ${CAPTURED.length} 次`)
}

/* ───────────────────────── 2. 补写轮预算随剩余字数递减 ───────────────────────── */

console.log('2. 补写轮的预算随「还差多少字」递减，而不是随已写字数变大')
{
  reset()
  // 首轮 1200 字（不到 85%），补写轮再给 1200 字
  setScript([cn(1200), cn(1200), cn(1200)])
  syncGlobals()
  await gen.generateDraft(base())
  const first = CAPTURED[0]?.maxTokens
  const second = CAPTURED[1]?.maxTokens
  check('确实发生了补写', CAPTURED.length >= 2, `实际 ${CAPTURED.length} 次`)
  check(
    `补写轮预算(${second}) 不大于首轮(${first})`,
    typeof second === 'number' && typeof first === 'number' && second <= first,
    '补写越补越多是旧 bug：把「剩余字数」当 targetWords 递进去会让下限 2048 反过来抬高额度'
  )
  // 剩余 1300 字：1300 × 2.2 + 1024 ≈ 3884，而按「整章 2500」算是 5500+1024
  check(
    `补写轮预算贴着剩余字数（期望 < ${5550}）`,
    typeof second === 'number' && second < 5550,
    `实际 ${second}`
  )
}

/* ───────────────────────── 3. 已写正文计入总目标 ───────────────────────── */

console.log('3. 本章已有 2000 字时，续写只需补 500 字就停，不会再写满 2500')
{
  reset()
  setScript([cn(600), cn(600), cn(600)])
  syncGlobals()
  const text = await gen.generateDraft(
    base({ targetWords: 2500, existingWords: 2000, anchorText: '她推开门，' })
  )
  // 2000 + 600 = 2600 > 2500×0.9，第一轮就该收工
  check('只发了一次请求', CAPTURED.length === 1, `实际 ${CAPTURED.length} 次`)
  check('没有为了凑整章再写一轮', countWords(text) === 600, `实际 ${countWords(text)} 字`)
}

/* ───────────────────────── 4. 空正文：重试一次，仍空则明确收尾 ───────────────────────── */

console.log('4. 首轮空正文（思考吃光额度）会重试，两次都空则停下并保留状态')
{
  reset()
  setScript([
    { text: '', thought: '想了很久……', finishReason: 'length' },
    { text: cn(2400), finishReason: 'stop' }
  ])
  syncGlobals()
  const text = await gen.generateDraft(base())
  check('空正文触发了重试', CAPTURED.length === 2, `实际 ${CAPTURED.length} 次`)
  check('重试后用 draft.generate 的预算', CAPTURED[1]?.task === 'draft', CAPTURED[1]?.task)
  check('重试拿到了正文', countWords(text) === 2400, `实际 ${countWords(text)} 字`)

  reset()
  setScript([
    { text: '', thought: '想了很久……', finishReason: 'length' },
    { text: '', thought: '又想了很久……', finishReason: 'length' }
  ])
  syncGlobals()
  const blank = await gen.generateDraft(base())
  check('两次都空就停下，不无限重试', CAPTURED.length === 2, `实际 ${CAPTURED.length} 次`)
  check('返回空串而不是抛错', blank === '', JSON.stringify(blank))
}

/* ───────────────────────── 4b. 补写必须累加，不能覆盖前几轮 ─────────────────────────
   这条钉的是一个真实回归：sendChat 返回的 text 只是**本轮增量**，而 text 已经
   在 onDelta 里累加过了。写成 `text = cont.text || text` 会把前面几轮的正文丢掉，
   症状是「补了三轮，最后只剩最后一轮那点字」——字数还是不够，且更莫名其妙。 */
console.log('4b. 补写的正文必须累加，不能把前几轮覆盖掉')
{
  reset()
  // 300 + 900 + 900 = 2100，仍不到 2250（90%），所以会再补第 4 轮
  setScript([cn(300), cn(900), cn(900), cn(900)])
  syncGlobals()
  const text = await gen.generateDraft(base())
  check('把 3 轮补写额度跑满（共 4 次请求）', CAPTURED.length === 4, `实际 ${CAPTURED.length} 次`)
  // onDelta 全程累加，最终应当是 300 + 900×3 = 3000，而不是只剩最后一轮的 900
  check('最终字数 = 各轮之和（3000）', countWords(text) === 3000, `实际 ${countWords(text)} 字`)
  check('累加后已越过 90% 线', countWords(text) >= 2500 * 0.9, `实际 ${countWords(text)} 字`)
}

/* ───────────────────────── 5. 补写轮不再把正文喂回去当 assistant ───────────────────────── */

console.log('5. 补写轮把已写正文放在 user 消息里，而不是 assistant 轮（避免自己续自己）')
{
  reset()
  setScript([cn(300), cn(2400)])
  syncGlobals()
  await gen.generateDraft(base())
  const msgs = CAPTURED[1]?.messages ?? []
  check(
    '补写轮没有 assistant 消息',
    !msgs.some((m) => m.role === 'assistant'),
    JSON.stringify(msgs.map((m) => m.role))
  )
  check(
    '已写正文出现在 user 消息里',
    msgs.some((m) => m.role === 'user' && m.content.includes('已经写出来的正文')),
    msgs.map((m) => m.role).join(',')
  )
}

/* ───────────────────────── 6. 一轮补写毫无进展就提前收尾 ───────────────────────── */

console.log('6. 补写一轮毫无进展就提前收尾，不空转三轮')
{
  reset()
  setScript([cn(300), { text: '', thought: '想了很久', finishReason: 'length' }])
  syncGlobals()
  const text = await gen.generateDraft(base())
  check('没有把 3 轮跑满', CAPTURED.length === 2, `实际 ${CAPTURED.length} 次`)
  check('首轮正文被保住', countWords(text) === 300, `实际 ${countWords(text)} 字`)
}

/* ───────────────────────── 7. 首轮就够长：一次都不用补 ───────────────────────── */

console.log('7. 首轮就达到 90% 时不补写')
{
  reset()
  setScript([cn(2400)])
  syncGlobals()
  const text = await gen.generateDraft(base())
  check('只发一次请求', CAPTURED.length === 1, `实际 ${CAPTURED.length} 次`)
  check('正文完整返回', countWords(text) === 2400, `实际 ${countWords(text)} 字`)
}

/* ───────────────────────── 8. lengthGuard:false 真的不补 ───────────────────────── */

console.log('8. lengthGuard:false（重写本段）时不做补写')
{
  reset()
  setScript([cn(200), cn(200), cn(200)])
  syncGlobals()
  await gen.generateDraft(base({ targetWords: 400, lengthGuard: false }))
  check('只发一次请求', CAPTURED.length === 1, `实际 ${CAPTURED.length} 次`)
}

/* ───────────────────────── 9. 首轮一字未得但网络报错：如实抛出 ───────────────────────── */

console.log('9. 首轮抛错且一字未得时，错误要抛给上层（用户要知道没生成成功）')
{
  reset()
  setScript([{ throw: '无法连接到 mock' }])
  syncGlobals()
  let caught = null
  try {
    await gen.generateDraft(base())
  } catch (e) {
    caught = e
  }
  check('确实抛出了原始错误', caught && /无法连接/.test(caught.message), String(caught && caught.message))
}

/* ───────────────────────── 10. 首轮有正文，补写轮报错：保住正文 ───────────────────────── */

console.log('10. 首轮有正文而补写轮报错时，已经写出来的正文不能被吞掉')
{
  reset()
  setScript([cn(500), { throw: '网关断开' }])
  syncGlobals()
  let caught = null
  let text = ''
  try {
    text = await gen.generateDraft(base())
  } catch (e) {
    caught = e
  }
  check('没有抛错', caught === null, String(caught && caught.message))
  check('首轮正文保留下来了', countWords(text) === 500, `实际 ${countWords(text)} 字`)
}

/* ───────────────────────── 11. describeTopUp 文案 ───────────────────────── */

console.log('11. describeTopUp 能把「为什么没写够」说清楚')
{
  const done = gen.describeTopUp({ stop: 'done', rounds: [], text: cn(2400) }, 2500)
  check('达标文案含「已写」和两侧数字', /已写 2400 \/ 2500/.test(done), done)
  const empty = gen.describeTopUp({ stop: 'empty', rounds: [], text: '' }, 2500)
  check('空正文文案指明了原因', /没有产出正文/.test(empty), empty)
  const maxR = gen.describeTopUp({ stop: 'maxRounds', rounds: [{}, {}], text: cn(900) }, 2500)
  check('轮数上限文案带轮数', /补写 2 轮/.test(maxR), maxR)
}

console.log(`\n${fail === 0 ? '全部通过' : '有用例失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)