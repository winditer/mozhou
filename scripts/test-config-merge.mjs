/**
 * 设置合并（老配置升级）的回归测试。
 * 运行：node scripts/test-config-merge.mjs
 *
 * 要守住的两件事：
 * 一、老配置（根本没有 tokenBudgets）打开后必须能用，27 个 key 一个不少；
 * 二、脏数据不许炸，但也不许「一坏就回默认」——结构坏的回默认，
 *     结构对、数值越界的只夹取。前者等于把预设悄悄清掉，后者把用户填的 999999
 *     悄悄换成 2600，两种都看不出痕迹，所以必须分开钉住。
 *
 * 合并逻辑单独放在 src/main/storage/mergeSettings.ts，就是为了这里能直接
 * esbuild 打包真正的实现再 import（config.ts 引了 electron，跑不起来）。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '../src/main/storage/mergeSettings.ts')

const outdir = mkdtempSync(join(tmpdir(), 'mozhou-config-merge-test-'))
const outfile = join(outdir, 'mergeSettings.mjs')
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile, logLevel: 'silent' })
const { DEFAULT_SETTINGS, mergeSettings } = await import(pathToFileURL(outfile).href)

// 上限从实现里读，别在测试里另抄一个数字——上限调整时这里必须跟着变，抄一份就会悄悄过期
const budgetsOut = join(outdir, 'budgets.mjs')
await build({ entryPoints: [join(here, '../src/shared/budgets.ts')], bundle: true, format: 'esm', outfile: budgetsOut, logLevel: 'silent' })
const { MAX_OUTPUT_TOKENS } = await import(pathToFileURL(budgetsOut).href)

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

/**
 * audit.book 的出厂额度。
 *
 * 从默认表里现取而不是写死数字：这个值会随需求调整（体检输出是 JSON，
 * 条数多，2600 装不下），写死的话每次调预算都要回来改一遍测试，
 * 而测试真正要钉住的是「坏配置落回默认」，不是某个具体数字。
 */
const AUDIT_BOOK = DEFAULT_SETTINGS.tokenBudgets['audit.book'].tokens

const keysOf = (b) => (b && typeof b === 'object' ? Object.keys(b) : [])
const budgetOf = (s, key) => s?.tokenBudgets?.[key]

/* ── 1. 用户改过的设置要留住，预算表同时补齐 ── */
console.log('保留用户设置并补齐预算表')
{
  const s = mergeSettings({ themeId: 'ink', temperature: 0.5 })
  check('themeId 保留', s.themeId === 'ink', s.themeId)
  check('temperature 保留', s.temperature === 0.5, String(s.temperature))
  check('tokenBudgets 正好 27 个 key', keysOf(s.tokenBudgets).length === 27, `实际 ${keysOf(s.tokenBudgets).length}`)
  check('summary.auto 默认 600', budgetOf(s, 'summary.auto')?.tokens === 600, JSON.stringify(budgetOf(s, 'summary.auto')))

  // 其余字段也得是完整默认值，不能因为合并丢了字段
  check('dailyGoal 用默认值', s.dailyGoal === DEFAULT_SETTINGS.dailyGoal, String(s.dailyGoal))
  check('typewriter 用默认值', s.typewriter === DEFAULT_SETTINGS.typewriter, String(s.typewriter))
  check('firstRunDone 用默认值', s.firstRunDone === DEFAULT_SETTINGS.firstRunDone, String(s.firstRunDone))
  check('lastProjectId 默认 null', s.lastProjectId === null, String(s.lastProjectId))
  check('shelfCoverSize 默认 m', s.shelfCoverSize === 'm', String(s.shelfCoverSize))
  check('预算表 27 个 key 与默认表同集合',
    [...keysOf(s.tokenBudgets)].sort().join('|') === keysOf(DEFAULT_SETTINGS.tokenBudgets).sort().join('|'))
  check('预算表 key 顺序与默认表一致',
    keysOf(s.tokenBudgets).join('|') === keysOf(DEFAULT_SETTINGS.tokenBudgets).join('|'),
    keysOf(s.tokenBudgets).join('|'))
}

/* ── 2. 只改了一个 key，别的 key 不能跟着变 ── */
console.log('单点覆盖不影响其它 key')
{
  const s = mergeSettings({ tokenBudgets: { 'summary.auto': { kind: 'fixed', tokens: 1234 } } })
  check('summary.auto 用用户值 1234', budgetOf(s, 'summary.auto')?.tokens === 1234, JSON.stringify(budgetOf(s, 'summary.auto')))
  check('summary.auto 仍是 fixed', budgetOf(s, 'summary.auto')?.kind === 'fixed', budgetOf(s, 'summary.auto')?.kind)
  check('audit.book 仍默认 6000', budgetOf(s, 'audit.book')?.tokens === 6000, JSON.stringify(budgetOf(s, 'audit.book')))
  check('按字数的 key 仍默认参数',
    JSON.stringify(budgetOf(s, 'draft.generate')) === JSON.stringify({ kind: 'perWord', perWord: 2.2, thinkPad: 1024, min: 2048, max: 16000 }),
    JSON.stringify(budgetOf(s, 'draft.generate')))
  check('仍是 27 个 key', keysOf(s.tokenBudgets).length === 27, `实际 ${keysOf(s.tokenBudgets).length}`)

  const p = mergeSettings({ tokenBudgets: { 'draft.generate': { kind: 'perWord', perWord: 3, thinkPad: 500, min: 100, max: 9000 } } })
  check('perWord 覆盖生效',
    budgetOf(p, 'draft.generate')?.perWord === 3 && budgetOf(p, 'draft.generate')?.max === 9000,
    JSON.stringify(budgetOf(p, 'draft.generate')))
  check('perWord 覆盖后字段顺序不变',
    keysOf(budgetOf(p, 'draft.generate')).join(',') === 'kind,perWord,thinkPad,min,max',
    keysOf(budgetOf(p, 'draft.generate')).join(','))
}

/* ── 2.5 对话额度的旧默认迁移 ── */
console.log('对话额度旧默认迁移')
{
  // 旧出厂值 3000 对思考类模型不够（推理 token 也算在里面），升级后要自动抬到新默认，
  // 否则用户升级完症状照旧，还得自己去设置页翻。
  const legacy = mergeSettings({ tokenBudgets: { 'chat.reply': { kind: 'fixed', tokens: 3000 } } })
  check(
    '旧默认 3000 迁到新默认',
    budgetOf(legacy, 'chat.reply')?.tokens === DEFAULT_SETTINGS.tokenBudgets['chat.reply'].tokens,
    JSON.stringify(budgetOf(legacy, 'chat.reply'))
  )
  check(
    '迁移后不引用默认表对象',
    budgetOf(legacy, 'chat.reply') !== DEFAULT_SETTINGS.tokenBudgets['chat.reply'],
    '拿到的是同一个对象，就地改会污染默认表'
  )

  // 作者自己调过的值不许动：5000 不是旧默认，原样保留
  const custom = mergeSettings({ tokenBudgets: { 'chat.reply': { kind: 'fixed', tokens: 5000 } } })
  check('自定义值 5000 原样保留', budgetOf(custom, 'chat.reply')?.tokens === 5000, JSON.stringify(budgetOf(custom, 'chat.reply')))
}

/* ── 3. 老配置：根本没有 settings / 没有 tokenBudgets ── */
console.log('老配置自动补齐')
{
  const fromUndefined = mergeSettings(undefined)
  check('undefined → 27 个 key', keysOf(fromUndefined.tokenBudgets).length === 27, `实际 ${keysOf(fromUndefined.tokenBudgets).length}`)
  check('undefined → 完整设置',
    fromUndefined.themeId === DEFAULT_SETTINGS.themeId && fromUndefined.dailyGoal === DEFAULT_SETTINGS.dailyGoal)
  check('undefined → 排版为默认', fromUndefined.typography.fontSize === DEFAULT_SETTINGS.typography.fontSize)

  const fromEmpty = mergeSettings({})
  check('{} → 27 个 key', keysOf(fromEmpty.tokenBudgets).length === 27, `实际 ${keysOf(fromEmpty.tokenBudgets).length}`)
  check('{} 与 undefined 结果一致', JSON.stringify(fromEmpty) === JSON.stringify(fromUndefined))

  // 完全照抄 JSON 走一遍，模拟真实读盘（老配置里没有这个字段）
  const legacy = JSON.parse(JSON.stringify({ themeId: 'ink', shelfCoverSize: 'sl', temperature: 0.7 }))
  const migrated = mergeSettings(legacy)
  check('老配置 sl 档位落到 s', migrated.shelfCoverSize === 's', String(migrated.shelfCoverSize))
  check('老配置补齐 27 个 key', keysOf(migrated.tokenBudgets).length === 27, `实际 ${keysOf(migrated.tokenBudgets).length}`)
  check('老配置 themeId 保留', migrated.themeId === 'ink', migrated.themeId)
  check('老配置 temperature 保留', migrated.temperature === 0.7, String(migrated.temperature))
  check('老配置没漏字段', Object.keys(migrated).sort().join('|') === Object.keys(DEFAULT_SETTINGS).sort().join('|'),
    Object.keys(migrated).sort().join('|'))
}

/* ── 4. 结构坏的条目：回该 key 的默认值，而不是被兜成 tokens:1 ── */
console.log('结构坏的条目回落默认')
{
  const MALFORMED = [
    ['kind 写成 Fixed', { kind: 'Fixed', tokens: 900 }],
    ['字符串垃圾', 'garbage'],
    ['数字 42', 42],
    ['null', null],
    ['缺 kind', { tokens: 900 }],
    ['kind 不认识', { kind: 'toggle', tokens: 900 }],
    ['fixed 缺 tokens', { kind: 'fixed' }],
    ['tokens 不是数', { kind: 'fixed', tokens: '900' }],
    ['tokens 是 NaN', { kind: 'fixed', tokens: Number.NaN }],
    ['perWord 缺 max', { kind: 'perWord', perWord: 2.2, thinkPad: 1024, min: 2048 }],
    ['数组', [{ kind: 'fixed', tokens: 900 }]]
  ]
  for (const [label, value] of MALFORMED) {
    const s = mergeSettings({ tokenBudgets: { 'audit.book': value } })
    check(`${label} → 回落默认 6000`, budgetOf(s, 'audit.book')?.tokens === 6000, JSON.stringify(budgetOf(s, 'audit.book')))
    check(`${label} → 仍是 fixed`, budgetOf(s, 'audit.book')?.kind === 'fixed', JSON.stringify(budgetOf(s, 'audit.book')))
  }
  // 脏数据连累不到邻居
  const s = mergeSettings({ tokenBudgets: { 'audit.book': 'garbage', 'summary.auto': { kind: 'fixed', tokens: 800 } } })
  check('脏条目只影响自己', budgetOf(s, 'summary.auto')?.tokens === 800, JSON.stringify(budgetOf(s, 'summary.auto')))
  check('脏条目仍凑满 27 个 key', keysOf(s.tokenBudgets).length === 27, `实际 ${keysOf(s.tokenBudgets).length}`)

  // tokenBudgets 整个坏掉时也不能炸
  for (const bad of [null, 'garbage', 42, []]) {
    const r = mergeSettings({ tokenBudgets: bad })
    check(`tokenBudgets 是 ${JSON.stringify(bad)} 也补齐 27 个`, keysOf(r.tokenBudgets).length === 27, `实际 ${keysOf(r.tokenBudgets).length}`)
    check(`tokenBudgets 是 ${JSON.stringify(bad)} 时 audit.book 默认`, budgetOf(r, 'audit.book')?.tokens === AUDIT_BOOK)
  }
}

/* ── 5. 结构对、数值越界：夹取，不回默认 ──
   用户的 999999 是「填错了」，改成上限（MAX_OUTPUT_TOKENS）他还能看出被改过；
   悄悄换成默认的 2600，他会以为自己的设置根本没生效。 */
console.log('越界只夹取，不换默认值')
{
  const s = mergeSettings({ tokenBudgets: { 'audit.book': { kind: 'fixed', tokens: 999999 } } })
  check('999999 → 夹到上限', budgetOf(s, 'audit.book')?.tokens === MAX_OUTPUT_TOKENS, JSON.stringify(budgetOf(s, 'audit.book')))
  check('没被换成默认值', budgetOf(s, 'audit.book')?.tokens !== AUDIT_BOOK, JSON.stringify(budgetOf(s, 'audit.book')))

  const zero = mergeSettings({ tokenBudgets: { 'audit.book': { kind: 'fixed', tokens: 0 } } })
  check('0 → 夹到 1', budgetOf(zero, 'audit.book')?.tokens === 1, JSON.stringify(budgetOf(zero, 'audit.book')))

  const neg = mergeSettings({ tokenBudgets: { 'audit.book': { kind: 'fixed', tokens: -5 } } })
  check('负数 → 夹到 1', budgetOf(neg, 'audit.book')?.tokens === 1, JSON.stringify(budgetOf(neg, 'audit.book')))

  const frac = mergeSettings({ tokenBudgets: { 'audit.book': { kind: 'fixed', tokens: 600.6 } } })
  check('小数取整', budgetOf(frac, 'audit.book')?.tokens === 601, JSON.stringify(budgetOf(frac, 'audit.book')))

  const pw = mergeSettings({ tokenBudgets: { 'draft.generate': { kind: 'perWord', perWord: 99, thinkPad: 99999, min: 12000, max: 3000 } } })
  check('perWord 倍率夹到 8', budgetOf(pw, 'draft.generate')?.perWord === 8, JSON.stringify(budgetOf(pw, 'draft.generate')))
  check('thinkPad 夹到 16384', budgetOf(pw, 'draft.generate')?.thinkPad === 16384, JSON.stringify(budgetOf(pw, 'draft.generate')))
  check('min/max 倒置被拨回',
    budgetOf(pw, 'draft.generate')?.min === 3000 && budgetOf(pw, 'draft.generate')?.max === 12000,
    JSON.stringify(budgetOf(pw, 'draft.generate')))
  check('越界后没回默认参数', budgetOf(pw, 'draft.generate')?.perWord !== 2.2, JSON.stringify(budgetOf(pw, 'draft.generate')))

  // 合法值必须原样活着
  const ok = mergeSettings({ tokenBudgets: { 'audit.book': { kind: 'fixed', tokens: 1234 } } })
  check('合法值原样保留', budgetOf(ok, 'audit.book')?.tokens === 1234, JSON.stringify(budgetOf(ok, 'audit.book')))
  check('合法值字段只有 kind/tokens', keysOf(budgetOf(ok, 'audit.book')).join(',') === 'kind,tokens')
}

/* ── 6. 多余 key 不许漏进结果；默认对象不许被改坏 ── */
console.log('脏键与副作用')
{
  const s = mergeSettings({
    tokenBudgets: { 'audit.book': { kind: 'fixed', tokens: 900 }, 'no.such.key': { kind: 'fixed', tokens: 10 } }
  })
  check('未知 key 不会出现在结果里', !Object.prototype.hasOwnProperty.call(s.tokenBudgets, 'no.such.key'))
  check('结果仍正好 27 个 key', keysOf(s.tokenBudgets).length === 27, `实际 ${keysOf(s.tokenBudgets).length}`)
  check('未知 key 存在过也不影响 audit.book', budgetOf(s, 'audit.book')?.tokens === 900)

  const before = JSON.stringify(DEFAULT_SETTINGS)
  mergeSettings({ tokenBudgets: { 'audit.book': { kind: 'fixed', tokens: 999999 } }, themeId: 'ink' })
  check('DEFAULT_SETTINGS 没被合并过程改坏', JSON.stringify(DEFAULT_SETTINGS) === before)

  const a = mergeSettings({})
  a.tokenBudgets['audit.book'] = { kind: 'fixed', tokens: 111 }
  a.typography.fontSize = 99
  check('两次合并的结果互不影响',
    mergeSettings({}).tokenBudgets['audit.book'].tokens === AUDIT_BOOK && mergeSettings({}).typography.fontSize === 17)
  // 也不能直接引用默认表，否则改一份设置会污染全局默认
  check('预算表不是默认表的同一个对象', mergeSettings({}).tokenBudgets !== DEFAULT_SETTINGS.tokenBudgets)
  check('排版不是默认表的同一个对象', mergeSettings({}).typography !== DEFAULT_SETTINGS.typography)

  /* 只查「容器不是同一个对象」是不够的：上面那条用的是整体赋值 a.tokenBudgets[k] = {...}，
     浅拷贝也能过。真正的坑是默认分支把 DEFAULT_TOKEN_BUDGETS[key] 的引用直接塞进结果，
     调用方就地改一个字段（budget.tokens = 5）就会把进程级默认表永久改坏，
     之后每次 mergeSettings 都读到污染值。所以必须就地改嵌套字段来验。 */
  const polluted = mergeSettings({})
  const beforeDefault = JSON.stringify(DEFAULT_SETTINGS.tokenBudgets['audit.book'])
  const beforePerWord = JSON.stringify(DEFAULT_SETTINGS.tokenBudgets['draft.generate'])

  polluted.tokenBudgets['audit.book'].tokens = 5
  polluted.tokenBudgets['draft.generate'].perWord = 99

  check('就地改嵌套字段不污染默认表(fixed)',
    JSON.stringify(DEFAULT_SETTINGS.tokenBudgets['audit.book']) === beforeDefault,
    JSON.stringify(DEFAULT_SETTINGS.tokenBudgets['audit.book']))
  check('就地改嵌套字段不污染默认表(perWord)',
    JSON.stringify(DEFAULT_SETTINGS.tokenBudgets['draft.generate']) === beforePerWord,
    JSON.stringify(DEFAULT_SETTINGS.tokenBudgets['draft.generate']))
  check('污染后再次 mergeSettings 仍得默认值',
    mergeSettings({}).tokenBudgets['audit.book'].tokens === AUDIT_BOOK,
    mergeSettings({}).tokenBudgets['audit.book'].tokens)
  check('污染后 perWord 预设仍是 2.2',
    mergeSettings({}).tokenBudgets['draft.generate'].perWord === 2.2,
    mergeSettings({}).tokenBudgets['draft.generate'].perWord)

  // 结构坏的条目走的是同一条默认分支，也必须给新对象
  const malformed = mergeSettings({ tokenBudgets: { 'audit.book': 'garbage' } })
  malformed.tokenBudgets['audit.book'].tokens = 7
  check('坏数据回落的对象也不与默认表同引用',
    DEFAULT_SETTINGS.tokenBudgets['audit.book'].tokens === AUDIT_BOOK,
    JSON.stringify(DEFAULT_SETTINGS.tokenBudgets['audit.book']))

  const fresh = mergeSettings({})
  check('返回的预算对象不与默认表同一引用',
    Object.keys(DEFAULT_SETTINGS.tokenBudgets).every(
      (k) => fresh.tokenBudgets[k] !== DEFAULT_SETTINGS.tokenBudgets[k]
    ),
    Object.keys(DEFAULT_SETTINGS.tokenBudgets)
      .filter((k) => fresh.tokenBudgets[k] === DEFAULT_SETTINGS.tokenBudgets[k])
      .join('|'))
}

/* ── 7. 原有深合并行为一点没变：排版 / 任务模型 / 封面档位 ── */
console.log('排版与任务模型深合并')
{
  const s = mergeSettings({ typography: { fontSize: 22 } })
  check('fontSize 用用户的 22', s.typography.fontSize === 22, String(s.typography.fontSize))
  check('fontFamily 保留默认', s.typography.fontFamily === DEFAULT_SETTINGS.typography.fontFamily, s.typography.fontFamily)
  check('lineHeight 保留默认', s.typography.lineHeight === DEFAULT_SETTINGS.typography.lineHeight, String(s.typography.lineHeight))
  check('pageWidth 保留默认', s.typography.pageWidth === DEFAULT_SETTINGS.typography.pageWidth, String(s.typography.pageWidth))
  check('indent 保留默认', s.typography.indent === DEFAULT_SETTINGS.typography.indent, String(s.typography.indent))
  check('paragraphSpacing 保留默认', s.typography.paragraphSpacing === DEFAULT_SETTINGS.typography.paragraphSpacing)
  check('dimUnfocused 保留默认', s.typography.dimUnfocused === DEFAULT_SETTINGS.typography.dimUnfocused)

  const t = mergeSettings({ taskModels: { draft: 'm1' } })
  check('taskModels.draft 用用户的 m1', t.taskModels.draft === 'm1', String(t.taskModels.draft))
  check('taskModels.outline 仍 null', t.taskModels.outline === null, String(t.taskModels.outline))
  check('taskModels.polish 仍 null', t.taskModels.polish === null, String(t.taskModels.polish))
  check('taskModels.chat 仍 null', t.taskModels.chat === null, String(t.taskModels.chat))
  check('taskModels 仍是 7 项', keysOf(t.taskModels).length === 7, `实际 ${keysOf(t.taskModels).length}`)

  // 老配置 'sl' 档位是真实历史数据：必须落到 's'，不能丢回 'm'
  check('sl → s', mergeSettings({ shelfCoverSize: 'sl' }).shelfCoverSize === 's', String(mergeSettings({ shelfCoverSize: 'sl' }).shelfCoverSize))
  check('l 保留', mergeSettings({ shelfCoverSize: 'l' }).shelfCoverSize === 'l')
  check('s 保留', mergeSettings({ shelfCoverSize: 's' }).shelfCoverSize === 's')
  check('不认识的值 → m', mergeSettings({ shelfCoverSize: 'xxl' }).shelfCoverSize === 'm', String(mergeSettings({ shelfCoverSize: 'xxl' }).shelfCoverSize))
  check('没给值 → m', mergeSettings({}).shelfCoverSize === 'm')
  check('显式 false 不被默认值盖掉', mergeSettings({ typewriter: true }).typewriter === true && mergeSettings({ showWordCountBar: false }).showWordCountBar === false)
  check('temperature 0 也能保留', mergeSettings({ temperature: 0 }).temperature === 0, String(mergeSettings({ temperature: 0 }).temperature))
}

/* ── 8. 默认设置本身的值（改造前逐项对齐，零行为变化） ── */
console.log('默认设置与改造前一致')
{
  check('themeId paper', DEFAULT_SETTINGS.themeId === 'paper', DEFAULT_SETTINGS.themeId)
  check('fontSize 17', DEFAULT_SETTINGS.typography.fontSize === 17, String(DEFAULT_SETTINGS.typography.fontSize))
  check('dailyGoal 3000', DEFAULT_SETTINGS.dailyGoal === 3000, String(DEFAULT_SETTINGS.dailyGoal))
  check('temperature 0.85', DEFAULT_SETTINGS.temperature === 0.85, String(DEFAULT_SETTINGS.temperature))
  check('showWordCountBar true', DEFAULT_SETTINGS.showWordCountBar === true)
  check('firstRunDone false', DEFAULT_SETTINGS.firstRunDone === false)
  check('默认带 27 个预算', keysOf(DEFAULT_SETTINGS.tokenBudgets).length === 27, `实际 ${keysOf(DEFAULT_SETTINGS.tokenBudgets).length}`)
  check('默认预算就是 DEFAULT_TOKEN_BUDGETS', DEFAULT_SETTINGS.tokenBudgets === undefined ? false : DEFAULT_SETTINGS.tokenBudgets['audit.book'].tokens === AUDIT_BOOK)
}

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
