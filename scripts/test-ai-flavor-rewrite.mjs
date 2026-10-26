/**
 * 去 AI 味改写链路的测试。
 * 运行：node scripts/test-ai-flavor-rewrite.mjs
 *
 * 这条链路真正危险的地方不是「改得不好看」，是**改错段落**：
 * 本地扫描给出的是「第 N 段」，回写时按这个序号去正文里替换。
 * 一旦两边对段落的切法不一致，或者模型少给多给了一行，就会把 A 段的内容
 * 写进 B 段——而且不报错，作者看到的是「这段莫名其妙变了」。
 *
 * 所以这里重点钉三件事：
 *   1. 序号对得上（扫描的段落序号 → 正文下标）
 *   2. 模型输出错位时宁可留空保留原文，也不许串段
 *   3. 只替换被点名的段落，其余字节完全不动
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outdir = mkdtempSync(join(tmpdir(), 'mozhou-aiflavor-rw-'))
const outfile = join(outdir, 'bundle.mjs')

// 把真正用到的三个模块一起打包（它们互相引用）
await build({
  entryPoints: [join(here, '../src/renderer/pages/Workspace/audit/aiFlavorPrompt.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
  external: ['react', 'react-dom']
})

const { alignFlavorRewrite, flavorRewriteWarning, toFlavorTargets, buildFlavorRewriteMessages } = await import(
  pathToFileURL(outfile).href
)

const flavorOut = join(outdir, 'flavor.mjs')
await build({
  entryPoints: [join(here, '../src/renderer/lib/aiFlavor.ts')],
  bundle: true,
  format: 'esm',
  outfile: flavorOut,
  logLevel: 'silent'
})
const { scanFlavor, pickRewriteTargets, splitBodyParagraphs } = await import(pathToFileURL(flavorOut).href)

const applyOut = join(outdir, 'apply.mjs')
await build({
  entryPoints: [join(here, '../src/renderer/pages/Workspace/audit/apply.ts')],
  bundle: true,
  format: 'esm',
  outfile: applyOut,
  logLevel: 'silent'
})
const { splitParagraphs, applyParagraphRewrite } = await import(pathToFileURL(applyOut).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra !== undefined ? ` → ${extra}` : ''}`)
  }
}

/* ══════════════ 一、段落编号必须与回写侧一致 ══════════════ */

// 这是整条链路的地基，也是真实踩过的坑：
// 扫描侧如果丢掉 `<h1>第 2 章</h1>` 这个标题块，编号会整体前移一位，
// 于是扫描说「第 4 段」，回写却按第 4 个 HTML 块去替换——改的是第 5 段。
// 下面用「带标题块」的真 HTML 直接钉住这一条。

const htmlWithHeading = [
  '<h1>第 2 章 老槐树</h1>',
  '<p>第一段。</p>',
  '<p>第二段，她仿佛笑了，微微低下头。</p>',
  '<p>第三段。</p>'
].join('')

const scan = scanFlavor(htmlWithHeading)
const applyParas = splitParagraphs(htmlWithHeading)

// 标题不参与检测，也不该出现在结果里
check('编号 · 标题块不被检测', !scan.paragraphs.some((p) => p.text.includes('老槐树')), JSON.stringify(scan.paragraphs.map((p) => p.index)))

// 关键断言：命中的段号，必须指到 apply 侧同一个块
const hitP = scan.paragraphs.find((p) => p.text.includes('仿佛'))
check('编号 · 命中段存在', Boolean(hitP))
check(
  '编号 · 扫描段号与回写下标对得上',
  hitP && applyParas[hitP.index - 1] && applyParas[hitP.index - 1].text === hitP.text,
  JSON.stringify({ 扫描段号: hitP?.index, 扫描文本: hitP?.text, 回写侧同号: applyParas[(hitP?.index ?? 1) - 1]?.text })
)

// 反向确认：如果按「过滤掉标题、段号前移」的旧算法，会指到错误的那一段
const naive = scan.paragraphs.filter((p) => p.hits.length > 0).map((p) => p.text)
const wrongIndexText = applyParas[scan.paragraphs.find((p) => p.text.includes('仿佛')).index - 2]?.text
check(
  '编号 · 前移一位会指错段（回归保护）',
  wrongIndexText !== hitP?.text,
  JSON.stringify({ 正确: hitP?.text, 前移一位: wrongIndexText })
)

// 无标题的普通 HTML 也该一致
const plainHtml = '<p>第一段。</p><p>她仿佛笑了。</p><p>第三段。</p>'
const scanPlain = scanFlavor(plainHtml)
const applyPlain = splitParagraphs(plainHtml)
const hitPlain = scanPlain.paragraphs[0]
check(
  '编号 · 无标题时同样一致',
  hitPlain && applyPlain[hitPlain.index - 1].text === hitPlain.text,
  JSON.stringify({ 扫描段号: hitPlain?.index, 回写侧同号: applyPlain[(hitPlain?.index ?? 1) - 1]?.text })
)

// 空块（纯 <br>）不应让编号塌缩：它占位但不检测
const withEmpty = '<p>第一段。</p><p></p><p>她仿佛笑了。</p>'
const scanEmpty = scanFlavor(withEmpty)
const applyEmpty = splitParagraphs(withEmpty)
const hitEmpty = scanEmpty.paragraphs.find((p) => p.text.includes('仿佛'))
check(
  '编号 · 空块占位不塌缩',
  hitEmpty && applyEmpty[hitEmpty.index - 1].text === hitEmpty.text,
  JSON.stringify({ 扫描段号: hitEmpty?.index, 回写侧同号: applyEmpty[(hitEmpty?.index ?? 1) - 1]?.text })
)

/* ══════════════ 二、模型输出对齐 ══════════════ */

check('对齐 · 数量正好时不改', JSON.stringify(alignFlavorRewrite('甲\n乙\n丙', 3)) === JSON.stringify(['甲', '乙', '丙']))
check('对齐 · 少给时补空串保留原文', JSON.stringify(alignFlavorRewrite('甲\n乙', 3)) === JSON.stringify(['甲', '乙', '']))
check(
  '对齐 · 多给时丢弃多余，不合并段落',
  JSON.stringify(alignFlavorRewrite('甲\n乙\n丙\n丁', 2)) === JSON.stringify(['甲', '乙']),
  JSON.stringify(alignFlavorRewrite('甲\n乙\n丙\n丁', 2))
)
check(
  '对齐 · 去掉模型自作主张的序号前缀',
  JSON.stringify(alignFlavorRewrite('1. 甲\n2. 乙', 2)) === JSON.stringify(['甲', '乙']),
  JSON.stringify(alignFlavorRewrite('1. 甲\n2. 乙', 2))
)
check(
  '对齐 · 去掉「第 1 段：」前缀',
  JSON.stringify(alignFlavorRewrite('第 1 段：甲\n第 2 段：乙', 2)) === JSON.stringify(['甲', '乙']),
  JSON.stringify(alignFlavorRewrite('第 1 段：甲\n第 2 段：乙', 2))
)
check(
  '对齐 · 剥掉 markdown 代码块围栏',
  JSON.stringify(alignFlavorRewrite('```\n甲\n乙\n```', 2)) === JSON.stringify(['甲', '乙']),
  JSON.stringify(alignFlavorRewrite('```\n甲\n乙\n```', 2))
)
check('对齐 · 空输出时全空（保留原文）', JSON.stringify(alignFlavorRewrite('', 2)) === JSON.stringify(['', '']))
check('对齐 · 全空行不产生幽灵段', alignFlavorRewrite('\n\n\n', 2).every((s) => s === ''))

/* ══════════════ 三、改写失控的兜底检查 ══════════════ */

check('兜底 · 正常改写不报警', flavorRewriteWarning('她仿佛笑了，微微点头。', '她笑了，点了下头。') === null)
check('兜底 · 空返回报警', (flavorRewriteWarning('原文', '') ?? '').includes('保留原文'))
check('兜底 · 大幅扩写报警', (flavorRewriteWarning('她笑了。', '她笑了，笑声在空荡的走廊里回荡了很久，像是要把这些年积压的东西一次吐出来，又像是终于松了口气。') ?? '').includes('扩写'))
check('兜底 · 大幅压缩报警', (flavorRewriteWarning('她笑了，笑声在空荡的走廊里回荡了很久很久。', '她笑了。') ?? '').includes('压缩'))

/* ══════════════ 四、端到端：扫描 → 改写 → 回写 ══════════════ */

const realHtml = [
  '<p>他把碗放下。</p>',
  '<p>她仿佛看到了那天的夕阳，微微低下头，缓缓闭上了眼睛。这一刻她忽然意识到，原来自己一直没有放下。</p>',
  '<p>没吃完。</p>',
  '<p>屋里很静。</p>'
].join('')

const chapterContent = realHtml
const report = scanFlavor(chapterContent)
const targets = pickRewriteTargets(report, 5, 35)
check('端到端 · 挑出了第 2 段', targets.length === 1 && targets[0].index === 2, JSON.stringify(targets.map((t) => t.index)))

const paragraphs = splitParagraphs(chapterContent)
const indexes = targets.map((t) => t.index - 1)
check('端到端 · 序号减一得到正确下标', indexes.length === 1 && indexes[0] === 1, JSON.stringify(indexes))
check('端到端 · 下标对应的正是脏段', paragraphs[indexes[0]].text.includes('仿佛'), paragraphs[indexes[0]].text)

// 模拟模型只回改好的那一段
const rewritten = ['她抬头，看着窗外的天色。天色正在往下沉。她把手放回膝盖上。']
const next = applyParagraphRewrite(chapterContent, paragraphs, indexes, rewritten)

check('端到端 · 脏段被替换', next.includes('她抬头，看着窗外的天色。'), next)
check('端到端 · 脏段原文已消失', !next.includes('仿佛'), next)
check('端到端 · 其余段落逐字不变', next.includes('<p>他把碗放下。</p>') && next.includes('<p>没吃完。</p>') && next.includes('<p>屋里很静。</p>'), next)
check('端到端 · 段落数不变', splitParagraphs(next).length === splitParagraphs(chapterContent).length)

/* ══════════════ 四之二、带标题的端到端回写（真实事故复现） ══════════════ */

// 复现线上那次的真实形态：正文以 <h1>第 2 章 …</h1> 开头。
// 旧实现会把命中的第 5 段报成「第 4 段」，回写时改坏第 4 段。
const buggy = [
  '<h1>第 2 章 老槐树</h1>',
  '<p>小区花坛里那棵老槐树有一百年了，树干中空。</p>',
  '<p>现在她站在树下，听见有人在树里说话。</p>',
  '<p>声音很轻，像有人用指甲刮玻璃。</p>',
  '<p>周砚秋后退了半步，槐树的枝条在无风的夜里轻轻晃了一下。</p>'
].join('')

const buggyScan = scanFlavor(buggy)
const buggyTargets = pickRewriteTargets(buggyScan, 5, 0).filter((t) => t.text.includes('轻轻晃'))
check('事故复现 · 命中段确实被挑出', buggyTargets.length === 1, JSON.stringify(buggyTargets.map((t) => [t.index, t.text.slice(0, 12)])))

const buggyParas = splitParagraphs(buggy)
const buggyIdx = buggyTargets.map((t) => t.index - 1)
check(
  '事故复现 · 下标指向的正是含「轻轻晃」的段',
  buggyParas[buggyIdx[0]]?.text.includes('轻轻晃'),
  JSON.stringify({ 下标: buggyIdx[0], 实际指向: buggyParas[buggyIdx[0]]?.text.slice(0, 20) })
)

const buggyNext = applyParagraphRewrite(buggy, buggyParas, buggyIdx, ['她退了半步。槐树枝晃了一下。'])
check('事故复现 · 标题块原样保留', buggyNext.includes('<h1>第 2 章 老槐树</h1>'), buggyNext.slice(0, 40))
check('事故复现 · 被选中的段已改写', buggyNext.includes('她退了半步。槐树枝晃了一下。'))
check('事故复现 · 其余正文段逐字不变', buggyNext.includes('树干中空') && buggyNext.includes('有人在树里说话') && buggyNext.includes('指甲刮玻璃'))
check('事故复现 · 「轻轻晃」已从原文消失', !buggyNext.includes('轻轻晃'))
check('事故复现 · 块数不变', splitParagraphs(buggyNext).length === buggyParas.length)

/* ══════════════ 五、提示词内容 ══════════════ */

const msgs = buildFlavorRewriteMessages(
  { brief: { logline: '一句话前提测试', premise: '', keywords: [] } },
  { title: '测试章' },
  toFlavorTargets(report.paragraphs),
  { before: ['他把碗放下。'], after: ['没吃完。'] }
)
const sys = msgs[0].content
const user = msgs[1].content

check('提示词 · 复用统一的去 AI 味标准', sys.includes('删掉所有替读者下结论的句子'), sys.slice(0, 80))
check('提示词 · 要求段落数一致', sys.includes('段落数量和顺序与输入完全一致'))
check('提示词 · 要求不增删情节', sys.includes('不得增删任何情节信息'))
check('提示词 · 要求长度相当', sys.includes('±15%'))
check('提示词 · 用户消息带原文', user.includes('仿佛'))
check('提示词 · 用户消息带症状说明', user.includes('症状：'))
check('提示词 · 用户消息带改法提示', user.includes('改法：'))
check('提示词 · 上下文标了不要输出', user.includes('不要改、不要输出'))
check('提示词 · 带上作品前提', user.includes('一句话前提测试'))

/* ══════════════ 结果 ══════════════ */

console.log(`\n去 AI 味改写链路：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)