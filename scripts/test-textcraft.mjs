/**
 * 校读与快照的回归测试。
 * 运行：node scripts/test-textcraft.mjs
 *
 * 这两块逻辑有个共同点：错得不明显，但作者会反复撞上。
 * 所以用表驱动的方式把「应该报」和「绝不能报」两种情况都钉住。
 *
 * 校读部分直接跑真正的实现（用 esbuild 临时打包成 ESM），
 * 不复制一份正则来测——测另一份实现等于没测。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '../src/renderer/lib/textcraft.ts')

const outdir = mkdtempSync(join(tmpdir(), 'mozhou-test-'))
const outfile = join(outdir, 'textcraft.mjs')
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile, logLevel: 'silent' })
const { proofread, summarizeProof } = await import(pathToFileURL(outfile).href)

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

const repeats = (t) => proofread(t).filter((i) => i.kind === 'repeat')

/* ── 正常叠词：一个都不许报 ──
   之前用"叠词白名单"判断，结果家家户户/一遍一遍/马马虎虎全被指为错误。
   这里用一整段真实文风的文字当回归基线，任何一条误报都算失败。 */
console.log('叠词 · 绝不误报')
const REDUPLICATION_PROSE = [
  '他一步一步地走着，风一阵一阵地吹。孩子们高高兴兴地笑，家家户户都亮着灯。',
  '她一遍一遍擦着桌子，灯光一盏一盏熄灭。雪一片一片落下来，他远远地望着。',
  '红红的脸蛋，胖胖的小手，大大的眼睛。他马马虎虎地写完，匆匆忙忙地走了。',
  '夜很静，静静的山，黑黑的天。人人都说好，个个都笑了。',
  '他看了看我，摆了摆手，点点头。你想想，试试看。',
  '水汪汪的眼睛，亮晶晶的星，绿油油的草。他笑眯眯地看着她。',
  '明明白白的话，清清楚楚的账，干干净净的屋子。',
  '她慢慢地走过去，微微点头，深深地吸了一口气。教她认星星的样子。',
  '一个个都走了，一件件被拿走，一次次失败。他想了想，又改了一改。',
  '柔柔的光，暖暖的风，细细的雨，高高的树，长长的路，短短的裙。',
  '周砚秋把信按在胸口。她一步一步走回家，路灯一盏一盏亮起来。',
  '母亲总说，人这一辈子，干干净净来，干干净净走。他心里空落落的。',
  '风凉凉地吹着，夜悄悄的。他慢慢地说：别急。天亮亮的时候，他醒了过来。',
  '一条条街，一盏盏灯。门口那棵老槐树，叶子黄黄的了。'
].join('')
{
  const fp = repeats(REDUPLICATION_PROSE)
  check(
    `整段正常叠词零误报（${REDUPLICATION_PROSE.length} 字）`,
    fp.length === 0,
    fp.map((i) => `${i.message}「${i.snippet}」`).join('；')
  )
}

console.log('重复词 · 必须报')
for (const bad of ['他的的心里', '已经已经来不及', '我我走了', '在在说他', '的的的', '是是這樣']) {
  check(`「${bad}」`, repeats(bad).length > 0)
}

console.log('三连优先于叠词')
{
  const hits = repeats('的的的')
  check('三连报一条', hits.length === 1, `实际 ${hits.length}`)
  check('三连提示说清是三次', !!hits[0]?.message.includes('三次'), hits[0]?.message)
}

console.log('忽略用的指纹要稳定')
{
  // 作者在上面补一句、删个词，同一处问题的 id 不能变，否则"忽略"会失效
  const a = proofread('他说,这不行。').find((i) => i.kind === 'punct')
  const b = proofread('他停了停，又说,这不行。').find((i) => i.kind === 'punct')
  check('前面插了字，问题 id 不变', !!a && !!b && a.id === b.id, `${a?.id} vs ${b?.id}`)

  const r1 = repeats('他的的心里').map((i) => i.id)
  const r2 = repeats('夜深了，他的的心里').map((i) => i.id)
  check('重复词 id 也不受前文影响', r1[0] === r2[0], `${r1[0]} vs ${r2[0]}`)

  // 同一段里出现两处相同问题时，id 必须区分得开
  const two = repeats('她的的心里，我的的心里')
  check('两处相同问题 id 不重复', new Set(two.map((i) => i.id)).size === two.length, JSON.stringify(two.map((i) => i.id)))
}

console.log('半角标点')
for (const s of ['他说,这不行', '走吧!快走', '真的吗?', '第一:开始']) {
  check(`应报「${s}」`, proofread(s).some((i) => i.kind === 'punct'))
}
for (const s of ['他说，「这不行」。', '她问：好吗？']) {
  check(`不应误报「${s}」`, proofread(s).some((i) => i.kind === 'punct') === false)
}

console.log('多余空格与引号')
check('中文字间空格要报', proofread('他 走了').some((i) => i.kind === 'space'))
check('引号不配对要报', proofread('他说「走吧').some((i) => i.kind === 'quote'))
check('引号配对不报', proofread('他说「走吧」。').some((i) => i.kind === 'quote') === false)
check('干净文本零问题', summarizeProof('他推开门，屋里没有人。').total === 0)

console.log('建议可执行')
{
  const issue = proofread('他说,这不行').find((i) => i.kind === 'punct')
  check('半角逗号有替换建议', !!issue?.suggestion?.includes('，'), JSON.stringify(issue))
  const rep = repeats('她的的心里')[0]
  check('重复词建议只留一个', !!rep?.suggestion && !rep.suggestion.includes('的的'), JSON.stringify(rep))
}
check('空文本不炸', proofread('').length === 0)
check('超长文本有上限', proofread(','.repeat(3000) + '的的'.repeat(200)).length <= 200)

console.log('替换区间必须切中问题本身')
{
  /** 按 range 真改一遍，验证结果 */
  function applyAll(plain) {
    let text = plain
    for (const i of proofread(plain)) {
      if (!i.range) continue
      text = text.slice(0, i.range.start) + i.suggestion + text.slice(i.range.end)
    }
    return text
  }

  check('半角逗号只换标点', applyAll('他说,这不行。') === '他说，这不行。', applyAll('他说,这不行。'))
  check('重复词只压一遍', applyAll('他的的心里') === '他的心里', applyAll('他的的心里'))
  check('字间空格只删空格', applyAll('他 走了。') === '他走了。', applyAll('他 走了。'))
  check('正常叠词一个都不动', applyAll(REDUPLICATION_PROSE) === REDUPLICATION_PROSE)
  check('三连压成一遍', applyAll('的的的') === '的', applyAll('的的的'))

  // 区间必须真的落在问题文本上，而不是旁边的字
  const p1 = proofread('他说,这不行。').find((i) => i.kind === 'punct')
  check('逗号区间切出的是逗号', '他说,这不行。'.slice(p1.range.start, p1.range.end) === ',', JSON.stringify(p1.range))
  const r1 = proofread('他的的心里').find((i) => i.kind === 'repeat')
  check('重复区间切出的是「的的」', '他的的心里'.slice(r1.range.start, r1.range.end) === '的的', JSON.stringify(r1.range))
}

/* ────────── 快照：镜像 store 里的实现，钉住边界 ────────── */
console.log('章节快照')
const MAX = 20
const GAP = 60_000
function pushSnapshot(prev, before, after, now) {
  const b = (before ?? '').trim()
  const a = (after ?? '').trim()
  const list = prev ?? []
  if (!b || b === a) return list
  const last = list[list.length - 1]
  if (last && now - last.at < GAP) {
    return [...list.slice(0, -1), { id: last.id, at: now, content: b, words: b.length }]
  }
  const next = [...list, { id: `v${now}`, at: now, content: b, words: b.length }]
  return next.length > MAX ? next.slice(next.length - MAX) : next
}

let v = []
check('内容没变不留快照', pushSnapshot(v, 'abc', 'abc', 1000).length === 0)
check('空白内容不留快照', pushSnapshot(v, '', 'abc', 1000).length === 0)
v = pushSnapshot(v, '第一版', '第二版', 1000)
check('内容变了留一份', v.length === 1 && v[0].content === '第一版')
v = pushSnapshot(v, '第二版', '第三版', 1000 + 30_000)
check('一分钟内合并，不新增', v.length === 1 && v[0].content === '第二版')
v = pushSnapshot(v, '第三版', '第四版', 1000 + 120_000)
check('超过一分钟新增', v.length === 2, `实际 ${v.length}`)

let many = []
for (let i = 0; i < 40; i++) many = pushSnapshot(many, `第${i}版`, `第${i + 1}版`, i * 120_000)
check('上限 20 份', many.length === 20, `实际 ${many.length}`)
check('丢的是最旧的', many[0].content === '第20版', `实际 ${many[0]?.content}`)

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)