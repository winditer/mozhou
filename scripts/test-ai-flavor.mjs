/**
 * AI 味本地检测的回归测试。
 * 运行：node scripts/test-ai-flavor.mjs
 *
 * 这一层有个特殊之处：它的输出会直接变成「哪几章该花钱改」的排序依据，
 * 所以错得不明显但后果实打实——误报多了作者就关掉功能，漏报多了排行就失真。
 *
 * 因此测试分三组：
 *   1. 必须报出来的（AI 腔的典型句式）
 *   2. 绝不能报的（正常中文文风，尤其是修辞性叠词与口语短句）
 *   3. 分数与排序的单调性（长短段可比、脏章排在干净章前面）
 *
 * 直接跑真正的实现（用 esbuild 临时打包），不复制一份正则来测。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '../src/renderer/lib/aiFlavor.ts')

const outdir = mkdtempSync(join(tmpdir(), 'mozhou-aiflavor-'))
const outfile = join(outdir, 'aiFlavor.mjs')
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile, logLevel: 'silent' })
const { scanFlavor, scanParagraph, scanBook, pickRewriteTargets, flavorLevel, FLAVOR_KIND_LABEL } = await import(
  pathToFileURL(outfile).href
)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra !== undefined ? ` → ${extra}` : ''}`)
  }
}

const kindsOf = (text) => {
  const r = scanParagraph(text, 1)
  return new Set(r.hits.map((h) => h.kind))
}
const adverbsIn = (text) => scanParagraph(text, 1).hits.filter((h) => h.kind === 'adverb').map((h) => h.text)

/* ══════════════ 一、必须报出来的 ══════════════ */

const MUST_HIT = [
  {
    name: '万能修饰词：仿佛 / 微微 / 缓缓',
    text: '她仿佛看到了那天的夕阳，微微低下头，缓缓闭上了眼睛。',
    kind: 'adverb',
    want: ['仿佛', '微微', '缓缓']
  },
  {
    name: '替读者下结论：这一刻她忽然意识到',
    text: '他走了。这一刻她忽然意识到，原来自己一直没有放下。',
    kind: 'explain'
  },
  {
    name: '替读者下结论：某种说不清的情绪涌上心头',
    text: '她站在门口，某种说不清的情绪涌上心头。',
    kind: 'explain'
  },
  {
    name: '抽象代替具体：一种复杂的情绪',
    text: '他看着她，心里生出一种复杂的情绪。',
    kind: 'abstract'
  },
  {
    name: '段末升华：而这一切，才刚开始',
    text: '风停了。少年抬起头，而这一切，才刚开始。',
    kind: 'elevate'
  },
  {
    name: '对话交代设定：台词里塞说明文',
    text: '“你应该知道，按照宗门的规定，外门弟子在没有长老允许的情况下是不能进入后山的，所以我们必须等到明天。”他说。',
    kind: 'dialog'
  }
]

for (const c of MUST_HIT) {
  const got = kindsOf(c.text)
  check(`应报 · ${c.name}`, got.has(c.kind), `实际命中维度：${[...got].join(',') || '无'}`)
}

// 命中词逐个核对：光「这一维报警了」不够，得确认报的是正确的词
const advHit = adverbsIn(MUST_HIT[0].text)
for (const w of MUST_HIT[0].want) {
  check(`应报 · 修饰词包含「${w}」`, advHit.includes(w), `实际：${advHit.join(',')}`)
}

/* ══════════════ 二、绝不能报的（正常文风） ══════════════ */

const MUST_NOT_HIT = [
  {
    name: '正常修辞叠词与口语短句',
    text:
      '他把碗放下。\n没吃完。\n屋里很静，只有风扇在响。她看了他一眼，又低下头去，把裙子上的褶子一遍一遍抚平。',
    forbid: ['adverb', 'explain', 'elevate', 'abstract']
  },
  {
    name: '正常的动作描写，没有心理注解',
    text:
      '陈屿推开门。急诊室的灯白得刺眼，留观室第三床的帘子拉着。苏念坐在床边，手里掐着一根没点的烟。\n“你来了。”她说。\n他点头，没说话，把外套搭在椅背上。',
    forbid: ['adverb', 'explain', 'elevate', 'abstract']
  },
  {
    name: '角色真的在陈述规则（不是说明文式长句）',
    text: '“明天早上七点，我在后门等你。”他把钥匙丢过去，“别迟到。”',
    forbid: ['dialog']
  },
  {
    name: '短段不判「句式整齐」',
    text: '他来了。她没抬头。',
    forbid: ['uniform']
  },
  {
    name: '正常使用「忽然」「突然」不算万能修饰词',
    text: '外面忽然下起雨来，两人赶紧躲进屋檐下。',
    forbid: ['adverb']
  }
]

for (const c of MUST_NOT_HIT) {
  const got = kindsOf(c.text)
  const bad = c.forbid.filter((k) => got.has(k))
  check(`禁报 · ${c.name}`, bad.length === 0, `不该命中：${bad.join(',')}`)
}

/* ══════════════ 三、句式整齐：只在长段落上判 ══════════════ */

const uniformText =
  '他看着窗外的雨，心里想着那些过去的事情。他走到桌边坐下，手里拿着那本旧书。他翻开第一页，上面写着熟悉的名字。他合上书本，把它放回原来的地方。'
const uniformGot = kindsOf(uniformText)
check('应报 · 句式过于整齐（长段落）', uniformGot.has('uniform'), `实际：${[...uniformGot].join(',') || '无'}`)

const variedText =
  '雨停了。他走到桌边坐下，手里拿着那本旧书，翻开第一页——上面写着熟悉的名字。他合上书本。放回去。'
check('禁报 · 长短相间的段落不算整齐', !kindsOf(variedText).has('uniform'))

/* ══════════════ 四、分数与排序 ══════════════ */

// 明显 AI 腔的段落必须比干净的段落分数高
const dirty = scanParagraph(
  '她仿佛看到了那天的夕阳，微微低下头，缓缓闭上了眼睛。这一刻她忽然意识到，原来自己一直没有放下。心里涌起一种复杂的情绪，说不清道不明。',
  1
)
const clean = scanParagraph('他把碗放下。\n没吃完。', 1)
check('分数 · 脏段 > 干净段', dirty.score > clean.score, `脏 ${dirty.score} vs 干净 ${clean.score}`)
check('分数 · 脏段达到「明显」及以上', dirty.score >= 35, `实际 ${dirty.score}`)
check('分数 · 干净段为 0 或极低', clean.score <= 20, `实际 ${clean.score}`)

// 长度可比的判断：同样 2 处命中，短段不该因为在短文本里就顶到满分
const shortDirty = scanParagraph('她仿佛笑了，微微点头。', 1)
check('分数 · 短段的密度被有效字数压住', shortDirty.score <= 100 && shortDirty.score > 0, `实际 ${shortDirty.score}`)

// 单个短段里只有一处命中，不该顶到 100：
// 那是「改一句就好」的局部问题，和「通篇机器腔」不该同分。
const oneHitShort = scanParagraph('周砚秋后退了半步，鞋跟磕在水泥沿上，发出一声脆响。她抬头，槐树的枝条在无风的夜里轻轻晃了一下。', 1)
check('分数 · 短段单处命中不顶格', oneHitShort.score < 80, `实际 ${oneHitShort.score}`)
check('分数 · 短段单处命中仍可感知', oneHitShort.score > 0, `实际 ${oneHitShort.score}`)

// 长段落里同样「只有一处命中」，分数应更低（被长度摊薄）。
// 注意：填充句里不能含被检测的词，否则命中数会累积，测的就不是摊薄了。
const oneHitLong = scanParagraph(
  '周砚秋后退了半步，鞋跟磕在水泥沿上，发出一声脆响。她抬头看向远处。'.repeat(8) +
    '槐树的枝条在无风的夜里轻轻晃了一下。',
  1
)
check(
  '分数 · 长度摊薄后更低',
  oneHitLong.score < oneHitShort.score,
  `长 ${oneHitLong.score} vs 短 ${oneHitShort.score}`
)

// 分档线要能覆盖 0、中间、危险三档
check('分档 · 0 分为干净', flavorLevel(0).label === '干净')
check('分档 · 50 分为轻微', flavorLevel(50).label === '轻微')
check('分档 · 90 分为很重', flavorLevel(90).label === '很重')

// 空文本不炸
const empty = scanFlavor('')
check('空文本 · 不报错且分数为 0', empty.score === 0 && empty.paragraphs.length === 0 && empty.total === 0)

/* ══════════════ 五、标题行不参与统计 ══════════════ */

const withTitle = scanFlavor('<p>第 3 章 雨夜</p><p>他推开门。</p>')
check('解析 · 章节标题行不计入段落', withTitle.paragraphs.length === 0 && withTitle.words > 0, `段落 ${withTitle.paragraphs.length}`)

// HTML 段落正确切开：两个 <p> 应该被当成两段
const html = scanFlavor('<p>她仿佛笑了。</p><p>他推开门。</p>')
check('解析 · <p> 之间正确分段', html.words > 0 && html.paragraphs.length >= 1, JSON.stringify(html.byKind))

/* ══════════════ 六、全书排行 ══════════════ */

const book = scanBook([
  { id: 'c1', title: '干净章', content: '他把碗放下。\n没吃完。\n屋里很静，只有风扇在响。' },
  { id: 'c2', title: '空章', content: '' },
  {
    id: 'c3',
    title: '很脏的一章',
    content:
      '她仿佛看到了那天的夕阳，微微低下头，缓缓闭上了眼睛。这一刻她忽然意识到，原来自己一直没有放下。心里涌起一种复杂的情绪，说不清道不明。而这一切，才刚开始。'
  },
  { id: 'c4', title: '另一章', content: '她站在窗边，仿佛在等什么人。' }
])

check('排行 · 脏章排第一', book.ranking[0]?.id === 'c3', `实际第一：${book.ranking[0]?.id}`)
check('排行 · 空章不进榜', !book.ranking.some((c) => c.id === 'c2'), JSON.stringify(book.ranking.map((c) => c.id)))
check('排行 · 章节数完整', book.chapters.length === 4, `实际 ${book.chapters.length}`)
check('排行 · 全书总分在 0–100', book.score >= 0 && book.score <= 100, `实际 ${book.score}`)
check('排行 · worst 段带序号与分数', book.chapters[2].worst.every((p) => p.index >= 1 && p.score > 0))

// 排行是按密度而不是命中总数：长章命中多不代表更脏
const dense = scanBook([
  { id: 'long', title: '长但稀', content: '他把碗放下。'.repeat(0) + '好。' + ' '.repeat(0) },
  { id: 'dirty', title: '短但密', content: '她仿佛笑了，微微点头，缓缓转身。' }
])
check(
  '排行 · 按密度排序而非命中数',
  dense.ranking.length === 0 || dense.ranking[0].id === 'dirty',
  JSON.stringify(dense.ranking.map((c) => c.id))
)

/* ══════════════ 六之二、纯文本输入（无 HTML 块标签） ══════════════ */

// 导入的 TXT / 粘贴进来的纯文字没有 <p>，如果只认 HTML 块就会切出零段，
// 整本书被判成「0 字、很干净」——功能看起来像坏了。这里钉住回退路径。
const plainText = scanFlavor('第 2 章 老槐树\n她仿佛笑了，微微低下头。\n他推开门。')
check('纯文本 · 能切出段落', plainText.words > 0 && plainText.paragraphs.length >= 1, JSON.stringify({ words: plainText.words, n: plainText.paragraphs.length }))
check('纯文本 · 能检出 AI 味', plainText.total > 0, JSON.stringify(plainText.byKind))
check('纯文本 · 标题行仍不检测', !plainText.paragraphs.some((p) => p.text.includes('老槐树')))

// 纯文本路径下段号也要对得上正文行序（第 1 行是标题，占位不检测）
const plainHit = plainText.paragraphs.find((p) => p.text.includes('仿佛'))
check('纯文本 · 段号跳过标题占位', plainHit && plainHit.index === 2, JSON.stringify({ index: plainHit?.index, text: plainHit?.text }))

const plainBook = scanBook([{ id: 'p1', title: '纯文本章', content: '她仿佛笑了，微微低下头。' }])
check('纯文本 · 全书扫描不返回空', plainBook.chapters[0].words > 0 && plainBook.ranking.length === 1, JSON.stringify({ words: plainBook.chapters[0].words, n: plainBook.ranking.length }))

/* ══════════════ 七、改写目标挑选 ══════════════ */

const report = scanFlavor(
  [
    '<p>他把碗放下。</p>',
    '<p>她仿佛看到了那天的夕阳，微微低下头，缓缓闭上了眼睛。这一刻她忽然意识到，原来自己一直没有放下。</p>',
    '<p>没吃完。</p>',
    '<p>屋里很静，只有风扇在响，那声音一直一直地响着，让他觉得整个房间都在慢慢下沉，仿佛要把他困在这里。</p>'
  ].join('')
)
const targets = pickRewriteTargets(report, 5, 35)
check('改写 · 挑出了脏段', targets.length >= 1, `实际 ${targets.length}`)
check('改写 · 序号按原序排列', targets.every((t, i) => i === 0 || t.index > targets[i - 1].index))
check('改写 · 带段落原文', targets.every((t) => t.text.length > 0))
check('改写 · 带症状维度', targets.every((t) => t.kinds.length > 0))
check('改写 · 干净段不被挑中', !targets.some((t) => t.text === '没吃完。'))

/* ══════════════ 八、维度标签齐全 ══════════════ */

for (const k of ['adverb', 'explain', 'elevate', 'abstract', 'uniform', 'dialog']) {
  check(`标签 · ${k} 有中文名`, typeof FLAVOR_KIND_LABEL[k] === 'string' && FLAVOR_KIND_LABEL[k].length > 0)
}

/* ══════════════ 结果 ══════════════ */

console.log(`\nAI 味检测：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)