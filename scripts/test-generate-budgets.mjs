/**
 * generate.ts 是否真的把 budgets 透传到 sendChat 的回归测试。
 * 运行：node scripts/test-generate-budgets.mjs
 *
 * 为什么需要这一层：budgets.ts 的测试只能证明「算得对」，证明不了「调用点用了它」。
 * 五个生成函数里写的都是 `p.budgets ?? DEFAULT_TOKEN_BUDGETS`，只要少写一个参数、
 * 或者把预算表的 key 写错，TypeScript 照样编译通过——因为 DEFAULT_TOKEN_BUDGETS
 * 本身就是一张合法的 TokenBudgets。结果是用户在设置页改了输出预算，这里静默用回默认值，
 * 界面上没有任何报错。这种「编译得过、跑得通、就是没生效」的漏洞，只能靠
 * 「跑真正的 generate.ts，看它到底把什么数递给了 sendChat」来钉。
 *
 * 做法：esbuild 打包真正的 src/renderer/lib/generate.ts，用插件把 `./ai` 换成一个
 * 假的 sendChat——它不发请求、不碰 Electron，只把 { task, maxTokens, messages } 记下来。
 * 于是每条断言的形状是：给一份「本函数那个 key = 19001」的预算表，看 captured.maxTokens 是不是 19001。
 * 19001 不在任何默认值里（默认要么是 600/3000 之类的固定值，要么是 2048–16000 的按字数区间），
 * 所以凡是取到默认值的地方一定不等于 19001。为什么不直接照任务书建议用 4321，见下面的 DISTINCT。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const entry = join(root, 'src/renderer/lib/generate.ts')

/**
 * 区分值：必须落在 DEFAULT_TOKEN_BUDGETS 取不到的区间里。
 *
 * 任务书建议用 4321，但 4321 用不了——按字数那几个 key 的区间是 [min, max] =
 * [2048, 16000]，里面的**每一个整数**都可能被算出来，4321 恰好在内。
 * 用它做区分值，「透传了」和「回落默认（某种字数下正好算出 4321）」就无法区分。
 * 这里取 19001 > 16000（按字数预算的上限，也是旧公式的上限），
 * 而且不等于任何固定预算；同时 ≤ MAX_OUTPUT_TOKENS，保证 clampBudget 不会把它夹掉。
 * 下面的第 0 节会把这件事断言一遍，任何一边改了都会立刻报错。
 */
const DISTINCT = 19001
const DISTINCT_CONTINUE = 19002
/** 被调用的假 sendChat 把每次调用的参数按顺序记在这里 */
const CAPTURED = []
/**
 * 每次 sendChat 用什么文本回：默认给一个「短」文本。
 * 短是故意的——generateDraft 的长度守护只有在正文不足 85% 时才续写，
 * 第一轮短了才会走到 draft.continue 那个调用点。
 */
let nextReply = '他推开门。'
function setReply(text) {
  nextReply = text
}

const outdir = mkdtempSync(join(tmpdir(), 'mozhou-generate-budget-test-'))
const outfile = join(outdir, 'generate.mjs')
await build({
  absWorkingDir: root,
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
  // @shared/* 是 electron-vite 里配置的路径别名，node 不认，这里补上
  alias: { '@shared': join(root, 'src/shared') },
  plugins: [
    {
      // 只拦 `./ai` 这一个导入，其余照常打包。generate.ts 从 ./ai 只 import 了 sendChat，
      // 但 ai.ts 一被打包就会拉进 ./bridge 里的 window.mz，所以必须整个换掉。
      name: 'stub-ai',
      setup(b) {
        b.onResolve({ filter: /^\.\/ai$/ }, () => ({ path: 'stub-ai', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `
            export async function sendChat(opts) {
              globalThis.__captured.push({
                task: opts.task,
                maxTokens: opts.maxTokens,
                messages: opts.messages
              })
              const text = globalThis.__nextReply
              // 真实实现是边流边回调，generate.ts 靠 onDelta 拼文本，这里也照样回调一次，
              // 保证 first.text 与 text 两条路径都和真机一致
              opts.onDelta?.(text)
              // 返回值形状对齐 ai.ts 的 AIResult
              return { text, thought: '', promptTokens: 0, completionTokens: 0, ms: 0, finishReason: 'stop' }
            }
          `,
          loader: 'js'
        }))
      }
    }
  ]
})

globalThis.__captured = CAPTURED
Object.defineProperty(globalThis, '__nextReply', {
  get: () => nextReply,
  configurable: true
})

const gen = await import(pathToFileURL(outfile).href)

// 默认值直接读 @shared/budgets 的源码，不在这里手抄数字：
// 手抄一份，默认值一改测试就悄悄失去意义
const budgetsOut = join(outdir, 'budgets.mjs')
await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src/shared/budgets.ts')],
  bundle: true,
  format: 'esm',
  outfile: budgetsOut,
  logLevel: 'silent'
})
const { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, MAX_OUTPUT_TOKENS } = await import(pathToFileURL(budgetsOut).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
  } else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

/* ───────────────────── 夹具：够 use 就行，不追求真实 ───────────────────── */

const channel = {
  id: 'ch-1',
  name: '测试渠道',
  protocol: 'openai',
  baseUrl: 'http://127.0.0.1:1',
  enabled: true
}

const chapter = {
  id: 'c1',
  title: '第一章 雨夜',
  content: '<p>他站在门口，看着雨。</p>',
  summary: '',
  status: 'draft',
  targetWords: 3000,
  words: 12,
  createdAt: 0,
  updatedAt: 0,
  versions: []
}

const project = {
  id: 'p1',
  title: '测试书',
  author: '作者',
  coverColor: '#000',
  // getScene 对未知 id 会回退到「自由写作」，所以这里不用真去查场景表
  sceneId: 'free',
  genreId: '',
  createdAt: 0,
  updatedAt: 0,
  brief: { logline: '一句话', premise: '一个故事', keywords: ['关键词'] },
  settings: {
    targetWordsPerChapter: 3000,
    targetTotalWords: 300000,
    lengthMode: 'soft',
    pov: '第三人称',
    tense: '过去时',
    tone: [],
    audience: '',
    extraRules: '',
    context: {
      brief: true,
      bible: true,
      characters: true,
      outline: true,
      previous: true,
      style: true,
      genre: true
    },
    previousChapters: 2,
    modelOverrides: {}
  },
  bible: { characters: [], world: [], terms: [], timeline: [], threads: [] },
  outline: [],
  chapters: [chapter],
  styleProfiles: [],
  ideas: [],
  chat: [],
  usage: [],
  summaries: {}
}

/** 生成一份「指定 key 是区分值、其余全是默认值」的预算表 */
function budgetsWith(key, value = DISTINCT) {
  return { ...DEFAULT_TOKEN_BUDGETS, [key]: { kind: 'fixed', tokens: value } }
}

const baseParams = () => ({
  project,
  chapter,
  channel,
  model: 'test-model',
  task: 'draft',
  onDelta: () => {},
  budgets: undefined
})

const reset = () => {
  CAPTURED.length = 0
  setReply('他推开门。')
}

/* ── 0. 前提：区分值与所有默认值都不相同 ──
   否则「没透传」和「透传了」在断言上分不出来，整份测试就是空转。 */
console.log('前提：区分值与默认值不撞车')
{
  const defaults = new Set()
  for (const [k, b] of Object.entries(DEFAULT_TOKEN_BUDGETS)) {
    if (b.kind === 'fixed') defaults.add(b.tokens)
    else {
      // 按字数预算能取到的值：夹取后是 [min, max] 里的整数（含两端），
      // 所以这一段里的每个数都等于「回落默认」，不能当区分值
      for (let n = b.min; n <= b.max; n++) defaults.add(n)
    }
  }
  check(`${DISTINCT} 不在任何默认预算里`, !defaults.has(DISTINCT), `${DISTINCT} 与默认值重合`)
  check(`${DISTINCT_CONTINUE} 不在任何默认预算里`, !defaults.has(DISTINCT_CONTINUE), `${DISTINCT_CONTINUE} 与默认值重合`)
  check('区分值在 clampBudget 的合法区间内（不会被夹掉）', DISTINCT <= MAX_OUTPUT_TOKENS && DISTINCT_CONTINUE <= MAX_OUTPUT_TOKENS)
  check('默认表里有 summary.auto', DEFAULT_TOKEN_BUDGETS[BUDGET_KEYS.summaryAuto] !== undefined)
}

/* ── 1. generateDraft 首次调用：draft.generate ── */
console.log('generateDraft · 首轮用 draft.generate')
{
  reset()
  setReply('他推开门，雨声灌了进来，潮湿的风裹着远处寺庙的钟声，一阵一阵地涌进屋子里。') // 足够长，不会续写
  await gen.generateDraft({
    ...baseParams(),
    instruction: '写一个开头',
    targetWords: 3000,
    lengthGuard: false,
    budgets: budgetsWith(BUDGET_KEYS.draftGenerate)
  })
  check('只发了一次请求', CAPTURED.length === 1, `实际 ${CAPTURED.length} 次`)
  check(
    `首轮 maxTokens = ${DISTINCT}（取 draft.generate，不是默认值）`,
    CAPTURED[0]?.maxTokens === DISTINCT,
    `实际 ${CAPTURED[0]?.maxTokens}`
  )
}

/* ── 2. generateDraft 续写调用：draft.continue ──
   lengthGuard 打开、首轮正文远不足目标字数 → while 循环触发第二次 sendChat，
   那一次走的是 draft.continue 这个 key。这里要的是「续写那一轮的区分值也生效」，
   所以 draft.generate 与 draft.continue 给两个不同的区分值，才能看出是哪一边。 */
console.log('generateDraft · 续写轮用 draft.continue')
{
  reset()
  setReply('他推开门。') // 5 个字，远低于 3000×85%
  const budgets = {
    ...DEFAULT_TOKEN_BUDGETS,
    [BUDGET_KEYS.draftGenerate]: { kind: 'fixed', tokens: DISTINCT },
    [BUDGET_KEYS.draftContinue]: { kind: 'fixed', tokens: DISTINCT_CONTINUE }
  }
  const text = await gen.generateDraft({
    ...baseParams(),
    instruction: '写一个开头',
    targetWords: 3000,
    lengthGuard: true,
    budgets
  })
  check('lengthGuard 真的触发了续写（至少两次请求）', CAPTURED.length >= 2, `实际 ${CAPTURED.length} 次`)
  check(`首轮 maxTokens = ${DISTINCT}（draft.generate）`, CAPTURED[0]?.maxTokens === DISTINCT, `实际 ${CAPTURED[0]?.maxTokens}`)
  check(
    `续写轮 maxTokens = ${DISTINCT_CONTINUE}（draft.continue）`,
    CAPTURED[1]?.maxTokens === DISTINCT_CONTINUE,
    `实际 ${CAPTURED[1]?.maxTokens}`
  )
  // 续写请求必须带上「已经写了的内容」，否则模型会从头重写。
  //
  // 注意它现在放在 user 消息里而不是 assistant 轮：早前把已写正文作为 assistant
  // 消息喂回去，模型会顺着**自己刚写的结尾**继续「续写」，于是补写越补越水、
  // 情节反复。改成 user 消息 + 明确的「只补差额」指令后，正文只作为材料出现。
  const contMessages = CAPTURED[1]?.messages ?? []
  check(
    '续写请求里带上了首轮正文',
    contMessages.some((m) => m.role === 'user' && m.content.includes('他推开门。')),
    JSON.stringify(contMessages.map((m) => m.role))
  )
  check(
    '续写请求不再把正文塞成 assistant 轮（避免模型自己续自己）',
    !contMessages.some((m) => m.role === 'assistant'),
    JSON.stringify(contMessages.map((m) => m.role))
  )
  check('返回文本非空', typeof text === 'string' && text.length > 0)
}

/* ── 3. generateSelection：draft.selection ── */
console.log('generateSelection · 用 draft.selection')
{
  reset()
  const r = await gen.generateSelection({
    ...baseParams(),
    task: 'polish',
    selection: '他站在门口，看着雨。',
    instruction: '改得更有画面感',
    budgets: budgetsWith(BUDGET_KEYS.draftSelection)
  })
  check('只发了一次请求', CAPTURED.length === 1, `实际 ${CAPTURED.length} 次`)
  check(
    `maxTokens = ${DISTINCT}（取 draft.selection，不是默认值）`,
    CAPTURED[0]?.maxTokens === DISTINCT,
    `实际 ${CAPTURED[0]?.maxTokens}`
  )
  check('返回了 stub 的文本', r === '他推开门。', JSON.stringify(r))
}

/* ── 4. generateSummary：summary.auto ── */
console.log('generateSummary · 用 summary.auto')
{
  reset()
  setReply('  摘要正文。  ')
  const r = await gen.generateSummary({
    ...baseParams(),
    task: 'summary',
    chapter,
    budgets: budgetsWith(BUDGET_KEYS.summaryAuto)
  })
  check('只发了一次请求', CAPTURED.length === 1, `实际 ${CAPTURED.length} 次`)
  check(
    `maxTokens = ${DISTINCT}（取 summary.auto，不是默认的 600）`,
    CAPTURED[0]?.maxTokens === DISTINCT,
    `实际 ${CAPTURED[0]?.maxTokens}`
  )
  check('返回文本被 trim', r === '摘要正文。', JSON.stringify(r))
}

/* ── 5. generateChatReply：chat.reply ── */
console.log('generateChatReply · 用 chat.reply')
{
  reset()
  const r = await gen.generateChatReply({
    ...baseParams(),
    task: 'chat',
    history: [
      { role: 'user', content: '这一章的节奏怎么样？' },
      { role: 'assistant', content: '偏慢。' }
    ],
    question: '怎么改？',
    budgets: budgetsWith(BUDGET_KEYS.chatReply)
  })
  check('只发了一次请求', CAPTURED.length === 1, `实际 ${CAPTURED.length} 次`)
  check(
    `maxTokens = ${DISTINCT}（取 chat.reply，不是默认的 3000）`,
    CAPTURED[0]?.maxTokens === DISTINCT,
    `实际 ${CAPTURED[0]?.maxTokens}`
  )
  check('最后一条是作者的问题', CAPTURED[0]?.messages.at(-1)?.content === '怎么改？')
  // generateChatReply 现在返回结构化结果（正文 + 截断/空白/是否重试过），正文取 .text
  check('返回了 stub 的文本', r?.text === '他推开门。', JSON.stringify(r))
  check('正常收尾不算截断也不算空', r?.truncated === false && r?.empty === false, JSON.stringify(r))
  check('没触发重试', r?.retried === false && CAPTURED.length === 1, JSON.stringify({ retried: r?.retried, hits: CAPTURED.length }))
}

/* ── 6. generateCustom（不给显式 maxTokens）：custom.default ── */
console.log('generateCustom · 没给显式值时用 custom.default')
{
  reset()
  await gen.generateCustom({
    ...baseParams(),
    task: 'polish',
    system: '你是编辑。',
    user: '改一下这段。',
    budgets: budgetsWith(BUDGET_KEYS.customDefault)
  })
  check('只发了一次请求', CAPTURED.length === 1, `实际 ${CAPTURED.length} 次`)
  check(
    `maxTokens = ${DISTINCT}（取 custom.default，不是默认的 3000）`,
    CAPTURED[0]?.maxTokens === DISTINCT,
    `实际 ${CAPTURED[0]?.maxTokens}`
  )
}

/* ── 7. generateCustom 显式 maxTokens 优先于预算表 ──
   调用方自己写死了 maxTokens 的场合（例如某些固定格式的任务），
   不能被设置页里的 custom.default 顶掉——优先级是 maxTokens ?? resolveBudget(...)。 */
console.log('generateCustom · 显式 maxTokens 压过预算表')
{
  reset()
  await gen.generateCustom({
    ...baseParams(),
    task: 'polish',
    system: '你是编辑。',
    user: '改一下这段。',
    maxTokens: 55,
    budgets: budgetsWith(BUDGET_KEYS.customDefault)
  })
  check(
    `maxTokens 55 生效（预算表里的 ${DISTINCT} 被忽略）`,
    CAPTURED[0]?.maxTokens === 55,
    `实际 ${CAPTURED[0]?.maxTokens}`
  )
}

/* ── 8. 不传 budgets：回落到默认值 ──
   这条是「改造前行为不变」的保险：老调用点（还没接 budgets 的）必须还是老数值。 */
console.log('不传 budgets · 回落默认值')
{
  reset()
  await gen.generateSummary({ ...baseParams(), task: 'summary', chapter })
  check(
    `summary.auto 回落默认 ${DEFAULT_TOKEN_BUDGETS[BUDGET_KEYS.summaryAuto].tokens}`,
    CAPTURED[0]?.maxTokens === DEFAULT_TOKEN_BUDGETS[BUDGET_KEYS.summaryAuto].tokens,
    `实际 ${CAPTURED[0]?.maxTokens}`
  )

  reset()
  await gen.generateChatReply({
    ...baseParams(),
    task: 'chat',
    history: [],
    question: '怎么写？'
  })
  check(
    `chat.reply 回落默认 ${DEFAULT_TOKEN_BUDGETS[BUDGET_KEYS.chatReply].tokens}`,
    CAPTURED[0]?.maxTokens === DEFAULT_TOKEN_BUDGETS[BUDGET_KEYS.chatReply].tokens,
    `实际 ${CAPTURED[0]?.maxTokens}`
  )

  // 按字数的 key：不给 budgets 时仍按老公式 round(字数×2.2)+1024 夹到 [2048,16000]
  reset()
  setReply('他推开门，雨声灌了进来。')
  await gen.generateDraft({ ...baseParams(), instruction: '写', targetWords: 1000, lengthGuard: false })
  const expectDraft = Math.min(16000, Math.max(2048, Math.round(1000 * 2.2) + 1024))
  check(`draft.generate 回落默认（1000 字 → ${expectDraft}）`, CAPTURED[0]?.maxTokens === expectDraft, `实际 ${CAPTURED[0]?.maxTokens}`)
}

/* ── 9. 预算表缺条目：也回落默认，而不是变成 undefined / 0 ── */
console.log('预算表缺条目 · 回落默认')
{
  reset()
  await gen.generateSummary({ ...baseParams(), task: 'summary', chapter, budgets: {} })
  check(
    `空表 → 默认 ${DEFAULT_TOKEN_BUDGETS[BUDGET_KEYS.summaryAuto].tokens}`,
    CAPTURED[0]?.maxTokens === DEFAULT_TOKEN_BUDGETS[BUDGET_KEYS.summaryAuto].tokens,
    `实际 ${CAPTURED[0]?.maxTokens}`
  )
  check('永远不会递 undefined 给 sendChat', CAPTURED[0]?.maxTokens !== undefined)
}

/* ── 10. 每个函数都在请求里带着自己的 task，预算没串到别的 key 上 ──
   顺带确认 5 个函数都不是「把 p 原样透传」了事——它们各自解算自己的 key。 */
console.log('五个调用点的 key 互不串味')
{
  reset()
  const all = {
    ...DEFAULT_TOKEN_BUDGETS,
    [BUDGET_KEYS.draftGenerate]: { kind: 'fixed', tokens: 101 },
    [BUDGET_KEYS.draftContinue]: { kind: 'fixed', tokens: 102 },
    [BUDGET_KEYS.draftSelection]: { kind: 'fixed', tokens: 103 },
    [BUDGET_KEYS.summaryAuto]: { kind: 'fixed', tokens: 104 },
    [BUDGET_KEYS.chatReply]: { kind: 'fixed', tokens: 105 },
    [BUDGET_KEYS.customDefault]: { kind: 'fixed', tokens: 106 }
  }
  setReply('他推开门，雨声灌了进来，潮湿的风裹着远处寺庙的钟声一阵一阵涌进屋子。')

  await gen.generateDraft({ ...baseParams(), instruction: '写', targetWords: 2000, lengthGuard: false, budgets: all })
  await gen.generateSelection({ ...baseParams(), task: 'polish', selection: '原文。', instruction: '改', budgets: all })
  await gen.generateSummary({ ...baseParams(), task: 'summary', chapter, budgets: all })
  await gen.generateChatReply({ ...baseParams(), task: 'chat', history: [], question: '问', budgets: all })
  await gen.generateCustom({ ...baseParams(), task: 'polish', system: 's', user: 'u', budgets: all })

  const got = CAPTURED.map((c) => c.maxTokens)
  check('五处预算各取各的', got.join(',') === '101,103,104,105,106', got.join(','))
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
