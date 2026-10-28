/**
 * 输出预算（maxTokens）的回归测试。
 * 运行：node scripts/test-budgets.mjs
 *
 * 这次改动的目标是把散落在 11 个文件里硬编码的 maxTokens 收进一张表，
 * 所以最要紧的不是「新函数能用」，而是「旧的数值一个都没变」。
 * 下面第 5 节用老公式 tokensForWords 当基准，逐字逐数比对；
 * 那条断言挂了，整件事就没意义。
 *
 * 直接跑真正的实现（esbuild 打包成 ESM 再 import），不复制一份来测。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '../src/shared/budgets.ts')

const outdir = mkdtempSync(join(tmpdir(), 'mozhou-budget-test-'))
const outfile = join(outdir, 'budgets.mjs')
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile, logLevel: 'silent' })
const { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, MAX_OUTPUT_TOKENS, resolveBudget, clampBudget } = await import(
  pathToFileURL(outfile).href
)

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

/** 老的按字数估算公式，原样抄自 src/renderer/lib/prompt.ts:tokensForWords */
function legacyTokensForWords(words) {
  return Math.min(16000, Math.max(2048, Math.round(words * 2.2) + 1024))
}

/* ── 1. 固定预算的默认值 ── */
console.log('fixed 固定预算')
const FIXED_EXPECT = {
  'summary.auto': 600,
  'summary.audit': 700,
  'audit.book': 6000,
  'audit.chapter': 4000,
  'audit.thread': 3600,
  'margin.notes': 1500,
  'naming.ideas': 900,
  'style.traits': 700,
  'style.trial': 600,
  'chat.reply': 12000,
  'custom.default': 3000,
  'quickstart.title': 1200,
  'quickstart.settings': 6000,
  'quickstart.volumes': 3000,
  'quickstart.chapters': 6000
}
for (const [key, tokens] of Object.entries(FIXED_EXPECT)) {
  const b = DEFAULT_TOKEN_BUDGETS[key]
  check(`${key} 默认是 fixed/${tokens}`, b?.kind === 'fixed' && b.tokens === tokens, JSON.stringify(b))
  check(`${key} 解析为 ${tokens}`, resolveBudget(DEFAULT_TOKEN_BUDGETS, key) === tokens, resolveBudget(DEFAULT_TOKEN_BUDGETS, key))
  // 固定预算跟字数无关，传了 targetWords 也不能变
  check(`${key} 传字数也不变`, resolveBudget(DEFAULT_TOKEN_BUDGETS, key, 5000) === tokens, resolveBudget(DEFAULT_TOKEN_BUDGETS, key, 5000))
}

/* ── 2. 按字数预算的换算 ── */
console.log('perWord 按字数预算')
const P = { perWord: 2.2, thinkPad: 1024, min: 2048, max: 16000 }
const PER_WORD_KEYS = [
  'draft.generate',
  'draft.continue',
  'draft.selection',
  'outline.generate',
  'outline.chapterBrief',
  'bible.entry',
  'bible.entryShort',
  'quickstart.firstChapter'
]
for (const key of PER_WORD_KEYS) {
  const b = DEFAULT_TOKEN_BUDGETS[key]
  check(
    `${key} 默认参数`,
    b?.kind === 'perWord' &&
      b.perWord === P.perWord &&
      b.thinkPad === P.thinkPad &&
      b.min === P.min &&
      b.max === P.max,
    JSON.stringify(b)
  )
}
check('3000 字 → 7624', resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', 3000) === 7624, resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', 3000))
check('100 字顶到下限 2048', resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', 100) === 2048, resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', 100))
check('0 字也是 2048', resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', 0) === 2048, resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', 0))
check('超大字数封顶 16000', resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', 100000) === 16000, resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', 100000))
check('负数字数也算下限', resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', -500) === 2048, resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', -500))

/* ── 3. 没给字数时给下限，绝不给 0 ── */
console.log('perWord 缺省字数')
check('不给字数 → min', resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate') === 2048, resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate'))
check('undefined → min', resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', undefined) === 2048)
check('NaN → min', resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', Number.NaN) === 2048)
check('Infinity 也不炸', resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', Number.POSITIVE_INFINITY) === 2048, resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', Number.POSITIVE_INFINITY))
check('永不返回 0', resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', 0) > 0)

/* ── 4. 校验与纠偏：脏数据不许炸，也不许原样透传 ── */
console.log('clampBudget 校验')
{
  const c = clampBudget({ kind: 'fixed', tokens: 0 })
  check('tokens 0 → 1', c.kind === 'fixed' && c.tokens === 1, JSON.stringify(c))
  check('tokens 负数 → 1', clampBudget({ kind: 'fixed', tokens: -800 }).tokens === 1)
  check('tokens 999999 → MAX_OUTPUT_TOKENS', clampBudget({ kind: 'fixed', tokens: 999999 }).tokens === MAX_OUTPUT_TOKENS)
  // 老用户之前顶格填的 32768 必须照旧有效（上调上限不能顺手把存量值夹掉）
  check('tokens 32768 仍然合法', clampBudget({ kind: 'fixed', tokens: 32768 }).tokens === 32768)
  check('tokens 65536 合法（新档位）', clampBudget({ kind: 'fixed', tokens: 65536 }).tokens === 65536)
  check('tokens MAX+1 被夹回 MAX', clampBudget({ kind: 'fixed', tokens: MAX_OUTPUT_TOKENS + 1 }).tokens === MAX_OUTPUT_TOKENS)
  check('tokens 小数取整', clampBudget({ kind: 'fixed', tokens: 600.4 }).tokens === 600)
  check('tokens NaN → 1', clampBudget({ kind: 'fixed', tokens: Number.NaN }).tokens === 1)
  check('tokens 缺失 → 1', clampBudget({ kind: 'fixed' }).tokens === 1)
  check('固定预算字段只有 kind/tokens', Object.keys(clampBudget({ kind: 'fixed', tokens: 600 })).join(',') === 'kind,tokens')

  const p = clampBudget({ kind: 'perWord', perWord: 0, thinkPad: -1, min: 0, max: 0 })
  check('perWord 0 → 0.5', p.perWord === 0.5, JSON.stringify(p))
  check('perWord 99 → 8', clampBudget({ kind: 'perWord', perWord: 99, thinkPad: 0, min: 1, max: 100 }).perWord === 8)
  check('thinkPad -1 → 0', p.thinkPad === 0, JSON.stringify(p))
  check('thinkPad 小数取整', clampBudget({ kind: 'perWord', perWord: 2.2, thinkPad: 1024.6, min: 1, max: 100 }).thinkPad === 1025)
  check('thinkPad 99999 → 16384', clampBudget({ kind: 'perWord', perWord: 2.2, thinkPad: 99999, min: 1, max: 100 }).thinkPad === 16384)
  check('min 至少 1', p.min === 1, JSON.stringify(p))
  check('max 至少 1', p.max === 1, JSON.stringify(p))

  // 用户把上下限写反了，也要能拨回来
  const inverted = clampBudget({ kind: 'perWord', perWord: 2.2, thinkPad: 1024, min: 12000, max: 3000 })
  check('倒置 min/max 会被换回来', inverted.min === 3000 && inverted.max === 12000, JSON.stringify(inverted))
  check('倒置后 min <= max', inverted.min <= inverted.max)
  const both = clampBudget({ kind: 'perWord', perWord: 2.2, thinkPad: 1024, min: 99999, max: 99999 })
  check('上下限都超范围仍 min <= max', both.min <= both.max && both.max <= MAX_OUTPUT_TOKENS, JSON.stringify(both))

  // 必须是新对象，不能改到传入的那一份（设置页会拿旧值做 diff）
  const src = { kind: 'fixed', tokens: 600 }
  const out = clampBudget(src)
  check('返回新对象', out !== src)
  const srcP = { kind: 'perWord', perWord: 2.2, thinkPad: 1024, min: 2048, max: 16000 }
  check('perWord 返回新对象', clampBudget(srcP) !== srcP)

  // 文档里写死的字段顺序，UI 表单按这个顺序渲染
  check(
    'perWord 字段顺序 kind 在前',
    Object.keys(clampBudget(srcP)).join(',') === 'kind,perWord,thinkPad,min,max',
    Object.keys(clampBudget(srcP)).join(',')
  )
  check(
    '固定预算 field 顺序 kind 在前',
    Object.keys(clampBudget(src)).join(',') === 'kind,tokens',
    Object.keys(clampBudget(src)).join(',')
  )
}

console.log('resolveBudget 对脏预算也纠偏')
{
  check('固定预算 0 不走 0', resolveBudget({ 'chat.reply': { kind: 'fixed', tokens: 0 } }, 'chat.reply') === 1)
  // 用户把 min 填成 99999、max 填成 100：先各自夹到 [1,MAX_OUTPUT_TOKENS]，再排序成 [100, MAX_OUTPUT_TOKENS]，
  // 于是 300 字算出的 1684 落在区间内，原样返回——参数被修好了，结果也是合法的。
  check(
    '按字数预算参数合法化后再算',
    resolveBudget({ 'draft.generate': { kind: 'perWord', perWord: 2.2, thinkPad: 1024, min: 99999, max: 100 } }, 'draft.generate', 300) === 1684,
    resolveBudget({ 'draft.generate': { kind: 'perWord', perWord: 2.2, thinkPad: 1024, min: 99999, max: 100 } }, 'draft.generate', 300)
  )
  // 上限压低到 200 时，结果必须被压住，不能吐出比 max 还大的数
  check(
    '上限压低后结果被压住',
    resolveBudget({ 'draft.generate': { kind: 'perWord', perWord: 2.2, thinkPad: 1024, min: 100, max: 200 } }, 'draft.generate', 300) === 200,
    resolveBudget({ 'draft.generate': { kind: 'perWord', perWord: 2.2, thinkPad: 1024, min: 100, max: 200 } }, 'draft.generate', 300)
  )
}

/* ── 5. 默认表必须与老公式逐点一致：这是「零行为变化」的唯一保证 ── */
console.log('默认值与旧公式等价')
{
  const WORD_COUNTS = [0, 1, 100, 420, 800, 900, 3200, 5000, 20000]
  for (const key of PER_WORD_KEYS) {
    for (const w of WORD_COUNTS) {
      const got = resolveBudget(DEFAULT_TOKEN_BUDGETS, key, w)
      const want = legacyTokensForWords(w)
      check(`${key} @ ${w} 字 = ${want}`, got === want, `实际 ${got}`)
    }
  }

  // 再扫一遍区间，防止只在采样点上凑巧对上（零点、进位、上下限交界）
  let mismatch = null
  for (const key of PER_WORD_KEYS) {
    for (let w = 0; w <= 12000 && !mismatch; w++) {
      if (resolveBudget(DEFAULT_TOKEN_BUDGETS, key, w) !== legacyTokensForWords(w)) mismatch = `${key} @ ${w}`
    }
  }
  check('0—12000 字逐字扫描全部一致', mismatch === null, mismatch)
}

/* ── 6. key 表本身的结构 ── */
console.log('BUDGET_KEYS 结构')
{
  const names = Object.keys(BUDGET_KEYS ?? {})
  const values = Object.values(BUDGET_KEYS ?? {})
  const defaultKeys = Object.keys(DEFAULT_TOKEN_BUDGETS ?? {})

  check('BUDGET_KEYS 正好 24 项', names.length === 24, `实际 ${names.length}`)
  check('默认表正好 24 个 key', defaultKeys.length === 24, `实际 ${defaultKeys.length}`)

  const dupes = values.filter((v, i) => values.indexOf(v) !== i)
  check('BUDGET_KEYS 无重复值', dupes.length === 0, dupes.join(','))
  check('BUDGET_KEYS 的 key 不重复', new Set(names).size === names.length)
  check('camelCase 命名', names.every((n) => /^[a-z][A-Za-z]*$/.test(n)), names.filter((n) => !/^[a-z][A-Za-z]*$/.test(n)).join(','))

  for (const v of values) {
    check(`「${v}」在默认表里`, Object.prototype.hasOwnProperty.call(DEFAULT_TOKEN_BUDGETS, v), String(v))
  }
  for (const k of defaultKeys) {
    check(`「${k}」在 BUDGET_KEYS 里`, values.includes(k), k)
  }
  // 两边的集合必须完全一样
  check('两边 key 集合一致', [...values].sort().join('|') === [...defaultKeys].sort().join('|'))
  // 设置页按 BUDGET_KEYS 的顺序渲染行，所以顺序也得跟默认表一致，不能只比集合
  check(
    'BUDGET_KEYS 顺序与默认表一致',
    Object.values(BUDGET_KEYS).join('|') === Object.keys(DEFAULT_TOKEN_BUDGETS).join('|'),
    `BUDGET_KEYS: ${Object.values(BUDGET_KEYS).join('|')}\n默认表: ${Object.keys(DEFAULT_TOKEN_BUDGETS).join('|')}`
  )
  check('预算种类只有两种', defaultKeys.every((k) => ['fixed', 'perWord'].includes(DEFAULT_TOKEN_BUDGETS[k].kind)))
  check('fixed 16 个 / perWord 8 个',
    defaultKeys.filter((k) => DEFAULT_TOKEN_BUDGETS[k].kind === 'fixed').length === 16 &&
      defaultKeys.filter((k) => DEFAULT_TOKEN_BUDGETS[k].kind === 'perWord').length === 8,
    `fixed ${defaultKeys.filter((k) => DEFAULT_TOKEN_BUDGETS[k].kind === 'fixed').length}`
  )
  check('默认预算都是合法值', defaultKeys.every((k) => JSON.stringify(clampBudget(DEFAULT_TOKEN_BUDGETS[k])) === JSON.stringify(DEFAULT_TOKEN_BUDGETS[k])))
  // 设置页要用难读的 key 找中文名，camelCase 名必须能反查出字面 key
  check('BUDGET_KEYS.draftGenerate = draft.generate', BUDGET_KEYS?.draftGenerate === 'draft.generate', String(BUDGET_KEYS?.draftGenerate))
  check('BUDGET_KEYS.quickstartFirstChapter = quickstart.firstChapter', BUDGET_KEYS?.quickstartFirstChapter === 'quickstart.firstChapter', String(BUDGET_KEYS?.quickstartFirstChapter))
  check('BUDGET_KEYS.summaryAuto = summary.auto', BUDGET_KEYS?.summaryAuto === 'summary.auto', String(BUDGET_KEYS?.summaryAuto))
}

/* ── 7. 传进来的表缺条目时回落到默认值 ── */
console.log('缺条目回落到默认')
{
  check('空表 → 默认固定值', resolveBudget({}, 'chat.reply') === 12000, resolveBudget({}, 'chat.reply'))
  check('空表 → 默认按字数值', resolveBudget({}, 'draft.generate', 3000) === 7624, resolveBudget({}, 'draft.generate', 3000))
  check('null → 默认值', resolveBudget(null, 'summary.auto') === 600, resolveBudget(null, 'summary.auto'))
  check(
    '有值就用表里的值',
    resolveBudget({ 'chat.reply': { kind: 'fixed', tokens: 777 } }, 'chat.reply') === 777
  )
  check(
    '没碰过的 key 不受影响',
    resolveBudget({ 'chat.reply': { kind: 'fixed', tokens: 777 } }, 'summary.audit') === 700 &&
      resolveBudget({ 'chat.reply': { kind: 'fixed', tokens: 777 } }, 'draft.generate', 3000) === 7624
  )
  check('默认表没被解析过程改坏', resolveBudget(DEFAULT_TOKEN_BUDGETS, 'draft.generate', 3000) === 7624 &&
    JSON.stringify(DEFAULT_TOKEN_BUDGETS['draft.generate']) === JSON.stringify({ kind: 'perWord', perWord: 2.2, thinkPad: 1024, min: 2048, max: 16000 }))
}

/* ── 8. 结构坏掉但「看着像配置」的条目，必须回落默认值而不是被兜成 1 ── */
// 这些值单看都不是完整的预算：kind 大小写错、少了 kind、kind 值不认识、
// 干脆就不是对象。以前它们会被 clampBudget 兜成 { kind:'fixed', tokens:1 }，
// 于是 resolveBudget 返回 1——请求拿 1 个 token，等于静默失败。
console.log('结构坏的条目回落默认')
{
  const MALFORMED = [
    ['kind 写成 Fixed', { kind: 'Fixed', tokens: 900 }],
    ['缺 kind', { tokens: 900 }],
    ['kind 写成 perword', { kind: 'perword', perWord: 2.2, thinkPad: 1024, min: 2048, max: 16000 }],
    ['字符串垃圾', 'garbage'],
    ['数字 42', 42],
    ['null', null]
  ]
  for (const [label, value] of MALFORMED) {
    const got = resolveBudget({ 'audit.book': value }, 'audit.book')
    check(`${label} → 回落默认 6000`, got === 6000, `实际 ${got}`)
  }

  // 结构不全的 perWord（缺 max）同样回默认，而不是拼一半参数去算
  const partial = { kind: 'perWord', perWord: 2.2, thinkPad: 1024, min: 2048 }
  check('perWord 缺 max → 回落默认（固定 6000 不受字数影响）', resolveBudget({ 'audit.book': partial }, 'audit.book', 5000) === 6000, resolveBudget({ 'audit.book': partial }, 'audit.book', 5000))
  check(
    'perWord 缺 max → 按字数的 key 回落默认参数',
    resolveBudget({ 'draft.generate': partial }, 'draft.generate', 3000) === 7624,
    resolveBudget({ 'draft.generate': partial }, 'draft.generate', 3000)
  )

  // 修好之后不能矫枉过正：结构完整的用户覆盖值必须照旧生效
  check('合法的 fixed 覆盖仍然生效', resolveBudget({ 'audit.book': { kind: 'fixed', tokens: 1234 } }, 'audit.book') === 1234, resolveBudget({ 'audit.book': { kind: 'fixed', tokens: 1234 } }, 'audit.book'))
  check(
    '合法的 perWord 覆盖仍然生效',
    resolveBudget({ 'draft.generate': { kind: 'perWord', perWord: 3, thinkPad: 500, min: 100, max: 9000 } }, 'draft.generate', 1000) === 3500,
    resolveBudget({ 'draft.generate': { kind: 'perWord', perWord: 3, thinkPad: 500, min: 100, max: 9000 } }, 'draft.generate', 1000)
  )
  check('结构合法但数值越界仍走夹取，不回默认', resolveBudget({ 'audit.book': { kind: 'fixed', tokens: 999999 } }, 'audit.book') === MAX_OUTPUT_TOKENS)
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
