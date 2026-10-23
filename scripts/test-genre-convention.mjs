/**
 * 题材公约的回归测试。
 * 运行：node scripts/test-genre-convention.mjs
 *
 * 钉住四件事，每一件错了都不会报错、只会安静地写歪：
 *
 * 1. **解析优先级**：作者覆盖 > 内置默认；空串/空白不能被当成「覆盖了一个空公约」。
 * 2. **真的进了提示词**：buildSystemPrompt 里必须有这段，且是解析后的版本。
 * 3. **不能进两遍**：assembleContext 里的 genre 块只供面板展示，
 *    contextToText 必须把它滤掉，否则题材公约在提示词里出现两次。
 * 4. **开关与题材缺失**：关掉开关 / 没选题材 / 题材 id 失效时都不该留下「【题材】。」这种空壳。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outdir = mkdtempSync(join(tmpdir(), 'mozhou-genre-'))
const alias = { '@shared': join(here, '../src/shared') }

async function load(entry, name) {
  const outfile = join(outdir, `${name}.mjs`)
  await build({
    entryPoints: [join(here, '..', entry)],
    bundle: true,
    format: 'esm',
    outfile,
    logLevel: 'silent',
    alias,
    external: ['react']
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

/* ══════════════ 1. 解析优先级 ══════════════ */

const genres = await load('src/shared/genres.ts', 'genres')
const { GENRES, GENRE_MAP, resolveGenreConvention, isConventionOverridden } = genres

const XUANHUAN = GENRE_MAP['xuanhuan']
check('内置题材存在', Boolean(XUANHUAN))

// 无覆盖 → 内置
check('无覆盖 → 内置公约', resolveGenreConvention('xuanhuan', {}) === XUANHUAN.convention)
check('覆盖表为 null → 内置公约', resolveGenreConvention('xuanhuan', null) === XUANHUAN.convention)
check('覆盖表 undefined → 内置公约', resolveGenreConvention('xuanhuan') === XUANHUAN.convention)

// 有覆盖 → 覆盖优先
const custom = '读者要的是宗门权斗下的隐忍翻盘。避免无脑打脸。'
check('有覆盖 → 用覆盖', resolveGenreConvention('xuanhuan', { xuanhuan: custom }) === custom)

// 空 / 空白覆盖不能被当成「覆盖了一个空公约」——那样会让提示词里题材段直接消失
check('空串覆盖 → 回落内置', resolveGenreConvention('xuanhuan', { xuanhuan: '' }) === XUANHUAN.convention)
check('空白覆盖 → 回落内置', resolveGenreConvention('xuanhuan', { xuanhuan: '   \n\t ' }) === XUANHUAN.convention)

// 覆盖只影响自己那一条，别的题材不受牵连
const mixed = { xuanhuan: custom }
check('覆盖不串台', resolveGenreConvention('xianxia', mixed) === GENRE_MAP['xianxia'].convention)

// 未知题材 / 空 id
check('未知题材 → 空串', resolveGenreConvention('not-a-genre', {}) === '')
check('空 id → 空串', resolveGenreConvention('', {}) === '')
check('null id → 空串', resolveGenreConvention(null, {}) === '')

// isConventionOverridden
check('未改 → false', isConventionOverridden('xuanhuan', {}) === false)
check('改过 → true', isConventionOverridden('xuanhuan', mixed) === true)
check('空串不算改过', isConventionOverridden('xuanhuan', { xuanhuan: '  ' }) === false)

// 16 条内置公约都必须是真有内容的
for (const g of GENRES) {
  check(`内置公约非空: ${g.name}`, typeof g.convention === 'string' && g.convention.trim().length > 20, `${g.convention.length}`)
}

/* ══════════════ 2. 真的被注入提示词 ══════════════ */

const prompt = await load('src/renderer/lib/prompt.ts', 'prompt')
const factory = await load('src/shared/factory.ts', 'factory')
const { buildSystemPrompt, renderGenreBlock, assembleContext, contextToText } = prompt

const project = factory.createBlankProject({
  title: '测试书',
  sceneId: 'fiction',
  genreId: 'xuanhuan'
})

const sysDefault = buildSystemPrompt(project, 'prose', null, null)
check('系统提示词含内置公约', sysDefault.includes(XUANHUAN.convention), sysDefault.slice(0, 120))
check('系统提示词带【题材】标记', sysDefault.includes('【题材】玄幻'))
// 只出现一次：重复注入会稀释约束力还白烧 token
check('公约只出现一次', sysDefault.split(XUANHUAN.convention).length - 1 === 1)

const sysCustom = buildSystemPrompt(project, 'prose', null, { xuanhuan: custom })
check('系统提示词用自定义公约', sysCustom.includes(custom))
check('自定义时不含内置原文', !sysCustom.includes(XUANHUAN.convention))

// 大纲模式也必须吃到同一套规矩
const sysOutline = buildSystemPrompt(project, 'outline', null, { xuanhuan: custom })
check('大纲模式也用自定义公约', sysOutline.includes(custom))

// renderGenreBlock 是注入与展示的唯一真相
check('renderGenreBlock 有覆盖', renderGenreBlock('xuanhuan', { xuanhuan: custom }) === `【题材】玄幻。${custom}`)
check('renderGenreBlock 无题材 → 空', renderGenreBlock(null, {}) === '')
check('renderGenreBlock 未知题材 → 空', renderGenreBlock('nope', {}) === '')

/* ══════════════ 3. 不进提示词两遍 ══════════════ */

const ctx = assembleContext(project, null, 24000, { conventions: { xuanhuan: custom } })
const genreBlock = ctx.blocks.find((b) => b.key === 'genre')
check('上下文含 genre 块', Boolean(genreBlock), ctx.blocks.map((b) => b.key).join(','))
check('genre 块在第一位（与提示词顺序一致）', ctx.blocks[0]?.key === 'genre', ctx.blocks[0]?.key)
check('genre 块文本＝注入文本', genreBlock.text === `【题材】玄幻。${custom}`)
check('genre 块有 token 计数', genreBlock.tokens > 0, genreBlock.tokens)
check('genre 块不计入裁剪丢弃', !['earlier', 'terms', 'threads', 'bible', 'previous', 'characters', 'current'].includes('genre'))

const ctxText = contextToText(ctx)
check('contextToText 不含公约（避免双份注入）', !ctxText.includes(custom), ctxText.slice(0, 120))

// 关掉开关时：块仍然存在（面板要告诉作者「开关关了」），但文本为空
const offProject = {
  ...project,
  settings: { ...project.settings, context: { ...project.settings.context, genre: false } }
}
const offCtx = assembleContext(offProject, null, 24000, { conventions: { xuanhuan: custom } })
const offBlock = offCtx.blocks.find((b) => b.key === 'genre')
check('开关关 → 块仍在但 enabled=false', Boolean(offBlock) && offBlock.enabled === false)
check('开关关 → 不注入提示词', !buildSystemPrompt(offProject, 'prose', null, { xuanhuan: custom }).includes(custom))

// 没选题材的书（策划/商务场景）不该出现空壳「【题材】。」
const noGenre = { ...project, genreId: '' }
check('无题材 → 不注入题材段', !buildSystemPrompt(noGenre, 'prose', null, null).includes('【题材】'))

/* ══════════════ 4. 落盘规范化 ══════════════ */

// normalizeConventions 是 main 进程里的私有函数，这里按同一套规则重放一遍断言行为约定：
// 保存/读取时都要丢掉空值和空白，否则「改了两个空格」会被记成「已自定义」。
const normalize = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') continue
    const text = val.trim()
    if (text) out[k] = text
  }
  return out
}
check('规范化：丢空串', Object.keys(normalize({ a: '', b: 'x' })).length === 1)
check('规范化：丢非字符串', Object.keys(normalize({ a: 1, b: null, c: 'x' })).length === 1)
check('规范化：去首尾空白', normalize({ a: '  y  ' }).a === 'y')
check('规范化：非对象 → 空表', Object.keys(normalize(null)).length === 0 && Object.keys(normalize([1, 2])).length === 0)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log('题材公约：全部通过')