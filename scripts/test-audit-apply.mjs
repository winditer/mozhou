#!/usr/bin/env node
/**
 * 「体检建议 → 落到正文」的测试（开发用，不进入产品包）。
 *
 *   node scripts/test-audit-apply.mjs
 *
 * 这一段代码的危险之处在于**它会改作者的原稿**，所以测试的重点不是「能不能改」，
 * 而是「会不会改错」：
 *   1. 定位：evidence 能准确落到它所在的那一段；
 *   2. 不越权：没被点名的段落，一个字节都不能变；
 *   3. 找不到就诚实报找不到，绝不退化成整章重写；
 *   4. 跨段摘录、标点差异、模型硬加编号/代码块这些真实情况都要能处理。
 */
import { build } from 'esbuild'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const out = path.join(os.tmpdir(), `mozhou-apply-${process.pid}.cjs`)

await build({
  entryPoints: [path.join(ROOT, 'src/renderer/pages/Workspace/audit/apply.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: out,
  logLevel: 'silent',
  plugins: [
    {
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /^@shared\// }, (a) => ({ path: a.path, namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports={}', loader: 'js' }))
      }
    }
  ]
})

const M = createRequire(import.meta.url)(out)

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

/* ── 测试正文：模拟真实章节 ── */
const HTML =
  '<h1>第 1 章 她把最后一封信烧了</h1>' +
  '<p>邮局的玻璃门在身后合拢，冷气一下子被关在外面。周砚秋把那只牛皮纸信封按在胸口，隔着两层布料还能感觉到纸角的硬度。</p>' +
  '<p>这是第七十三封。前七十二封她都寄出去了，寄到一个早已无人居住的地址，收件人写着父亲的名字。</p>' +
  '<p>她今年二十岁，父亲走了已经整整十年。</p>' +
  '<p>她走到巷口的铁皮桶边，划了根火柴。火苗舔上纸角的瞬间，她忽然想起小时候父亲教她认星星的样子——他总是先指北斗，再讲别的。</p>' +
  '<p>窗外下起了雨，巷子里很安静。</p>'

console.log('1. 切段')
const paras = M.splitParagraphs(HTML)
check('切出 6 段（1 个 h1 + 5 个 p）', paras.length === 6, `实际 ${paras.length}`)
check('段落文本去掉了标签', paras[1].text.startsWith('邮局的玻璃门'), paras[1]?.text?.slice(0, 30))
check('h1 也被识别为段落', paras[0].html.startsWith('<h1>'), paras[0]?.html?.slice(0, 20))
check('位置区间连续覆盖原文', paras.every((p) => HTML.slice(p.start, p.end) === p.html))

console.log('2. 定位 evidence')
{
  const r = M.locateEvidence(paras, '她今年二十岁，父亲走了已经整整十年。')
  check('精确定位到第 3 段（下标 3）', r.indexes.length === 1 && r.indexes[0] === 3, JSON.stringify(r))
  check('标记为精确命中', r.exact === true)
}
{
  // evidence 少了一个字、换了标点，仍应命中
  const r = M.locateEvidence(paras, '她今年二十岁 父亲走了已经整整十年')
  check('标点/空白差异仍能定位', r.indexes.length === 1 && r.indexes[0] === 3, JSON.stringify(r))
}
{
  // 跨段摘录
  const r = M.locateEvidence(paras, '这是第七十三封。前七十二封她都寄出去了，寄到一个早已无人居住的地址，收件人写着父亲的名字。她今年二十岁，父亲走了已经整整十年。')
  check('跨段摘录能定位到两段', r.indexes.length === 2 && r.indexes[0] === 2 && r.indexes[1] === 3, JSON.stringify(r))
}
{
  const r = M.locateEvidence(paras, '这段话在正文里根本不存在，完全对不上任何一处内容')
  check('完全对不上时返回「找不到」', r.indexes.length === 0, JSON.stringify(r))
}
{
  // 章名是 h1，绝不能成为改写目标——改掉就是破坏文档结构
  const r = M.locateEvidence(paras, '第 1 章 她把最后一封信烧了')
  check('精确命中标题时也不把 h1 当目标', r.indexes.length === 0, JSON.stringify(r))
}

console.log('3. 替换只动目标段落')
{
  const idx = [3]
  const next = M.applyParagraphRewrite(HTML, paras, idx, ['她今年二十五岁，父亲在她十五岁那年走的。'])
  check('目标段落被替换', next.includes('她今年二十五岁'), next.slice(0, 120))
  check('旧内容消失', !next.includes('她今年二十岁'))
  // 逐段核对：除了下标 3，其它段落的 html 必须逐字节相同
  const before = M.splitParagraphs(HTML)
  const after = M.splitParagraphs(next)
  const same =
    before.length === after.length && before.every((p, i) => (i === 3 ? true : p.html === after[i].html))
  check('其余段落逐字节未变（关键：不越权）', same, same ? '' : JSON.stringify(before.map((p) => p.html.slice(0, 20))))
  check('段落总数不变', before.length === after.length, `${before.length} vs ${after.length}`)
}

console.log('4. 多个段落同时替换')
{
  const next = M.applyParagraphRewrite(HTML, paras, [2, 4], ['这是第七十四封。', '她走到巷口，却没有点火。'])
  const after = M.splitParagraphs(next)
  check('第 2 段已改', after[2].text.startsWith('这是第七十四封'))
  check('第 4 段已改', after[4].text.startsWith('她走到巷口'))
  check('第 3 段未受影响', after[3].text === '她今年二十岁，父亲走了已经整整十年。', after[3].text)
  check('第 5 段未受影响', after[5].html === '<p>窗外下起了雨，巷子里很安静。</p>', after[5].html)
}

console.log('5. 还原模型输出的杂讯')
{
  const messy = '```\n1. 她今年二十五岁，父亲在她十五岁那年走的。\n```'
  const aligned = M.alignRewrite(messy, 1)
  check('去掉代码块与编号', aligned.length === 1 && aligned[0].startsWith('她今年二十五岁'), JSON.stringify(aligned))
}
{
  const aligned = M.alignRewrite('第一段\n第二段', 3)
  check('模型少给时补空串（保持不变）', aligned.length === 3 && aligned[2] === '', JSON.stringify(aligned))
}
{
  const aligned = M.alignRewrite('a\nb\nc', 2)
  check('模型多给时并入最后一段', aligned.length === 2 && aligned[1] === 'bc', JSON.stringify(aligned))
}

console.log('6. 空改写不破坏原文')
{
  const next = M.applyParagraphRewrite(HTML, paras, [3], [''])
  check('空串表示不改，原文保持', next === HTML, next.slice(0, 100))
}

console.log('7. HTML 转义')
{
  const next = M.applyParagraphRewrite(HTML, paras, [3], ['他说<script>alert(1)</script>是真的'])
  check('尖括号被转义，不会注入标签', next.includes('&lt;script&gt;') && !next.includes('<script>'), next.slice(next.indexOf('他说'), next.indexOf('他说') + 60))
}

console.log('8. 保留原段落的标签属性')
{
  const custom = '<p class="indent" data-x="1">原来的内容在这里。</p>'
  const p2 = M.splitParagraphs(custom)
  const next = M.applyParagraphRewrite(custom, p2, [0], ['改过的内容。'])
  check('class 等属性保留', next.includes('class="indent"') && next.includes('data-x="1"'), next)
  check('内容已替换', next.includes('改过的内容'), next)
}

console.log('9. 全书一致性：相似度候选定位')
{
  // 全书体检的 evidence 摘自章节梗概：说的是正文里的事，但措辞不同。
  // 这里用「第七十三封……父亲的地址」这一段的人工概括，应当命中下标 1。
  const r = M.candidateParagraphs(paras, '这是第七十三封信，前七十二封都寄到了父亲的老地址')
  check('梗概式证据能找到候选段落', r.indexes.length > 0, JSON.stringify(r))
  // 下标 2 是「这是第七十三封……收件人写着父亲的名字」，才是这段证据讲的正文
  check('候选包含真正相关的那一段（下标 2）', r.indexes.includes(2), JSON.stringify(r))
  check('标记为非精确命中', r.exact === false, JSON.stringify(r))
}
{
  const r = M.candidateParagraphs(paras, '完全不相关的天文物理学术语堆砌量子纠缠叙事学')
  check('完全无关时不硬凑候选', r.indexes.length === 0, JSON.stringify(r))
}
{
  // 精确命中时不应退化成候选
  const r = M.candidateParagraphs(paras, '她今年二十岁，父亲走了已经整整十年。')
  check('精确命中时 score 为 1', r.exact === true && r.score === 1, JSON.stringify(r))
}
{
  // 标题不参与候选匹配（h1 里的章节名容易误命中）
  const r = M.candidateParagraphs(paras, '她把最后一封信烧了')
  check('标题不参与候选（避免误命中 h1）', !r.indexes.includes(0), JSON.stringify(r))
}

console.log('10. 全书一致性：跨章改写消息')
{
  const msgs = M.buildCrossChapterMessages({
    groups: [
      { chapterTitle: '第一章', targets: ['她今年二十岁。'] },
      { chapterTitle: '第五章', targets: ['她已经二十五岁了。', '她记得父亲走的那年。'] }
    ],
    title: '主角年龄前后矛盾',
    detail: '第一章二十岁，第五章二十五岁',
    suggestion: '统一为二十岁'
  })
  const user = msgs[1].content
  check('两章都出现在提示词里', user.includes('第一章') && user.includes('第五章'), user.slice(0, 120))
  check('明确要求统一口径', /统一/.test(user), user.slice(0, 200))
  check('要求输出 3 段（合计）', /3 段/.test(user), user.slice(-160))
  check('段落从 1 连续编号', user.includes('1. 她今年二十岁') && user.includes('2. 她已经二十五岁') && user.includes('3. 她记得'), user.slice(0, 240))
}
{
  const aligned = M.alignRewrite('甲\n乙\n丙', 3)
  check('跨章改写结果按总数对齐', aligned.length === 3 && aligned.join('') === '甲乙丙', JSON.stringify(aligned))
}

console.log('11. 跨章替换：各章互不干扰')
{
  const chA = '<p>她今年二十岁。</p><p>窗外下雨。</p>'
  const chB = '<p>她已经二十五岁了。</p>'
  const pa = M.splitParagraphs(chA)
  const pb = M.splitParagraphs(chB)
  const nextA = M.applyParagraphRewrite(chA, pa, [0], ['她今年二十岁，刚过完生日。'])
  const nextB = M.applyParagraphRewrite(chB, pb, [0], ['她今年二十岁。'])
  check('第一章改后保留了本章其它段', nextA.includes('窗外下雨'), nextA)
  check('第一章已改', nextA.includes('刚过完生日'), nextA)
  check('第二章已改', nextB.includes('她今年二十岁') && !nextB.includes('二十五'), nextB)
}

console.log('12. 回归：只共享地名不应成为候选（截图 bug）')
{
  // 截图上「亡妻与存活冲突」这条建议去改了第8、21章，那两章只是恰好都提到「急诊留观室」
  const evidence = '陈屿在急诊留观室醒来，把苏念认作亡妻周予安'
  const ch8 = M.splitParagraphs('<h1>第8章 沈砚的抽屉</h1><p>陈屿到的时候是下午四点。门诊楼刚换班，走廊里推车咕噜咕噜往库房去。沈砚在急诊留观室门口等他，白大褂敞着，里头的刷手服领子翻出来一半。"走，楼梯间。"</p>')
  const ch21 = M.splitParagraphs('<h1>第21章 只递手</h1><p>下午三点，林昭到了医院。沈砚在急诊留观室给人清创，手上的橡胶手套没摘。林昭坐在走廊蓝椅子上等，等了三十五分钟。</p>')
  const r8 = M.candidateParagraphs(ch8, evidence)
  const r21 = M.candidateParagraphs(ch21, evidence)
  check('只共享「急诊留观室」的章节不再是候选（第8章）', r8.indexes.length === 0, JSON.stringify(r8))
  check('只共享「急诊留观室」的章节不再是候选（第21章）', r21.indexes.length === 0, JSON.stringify(r21))

  // 而真正写着这句话的章节必须命中
  const ch1 = M.splitParagraphs('<h1>第1章 泥里挣扎</h1><p>陈屿在急诊留观室醒来，把苏念认作亡妻周予安。</p><p>走廊灯管闪了一下。</p>')
  const r1 = M.candidateParagraphs(ch1, evidence)
  check('真正含该句的章节仍然命中', r1.indexes.includes(1), JSON.stringify(r1))
  check('命中的不是标题段', !r1.indexes.includes(0), JSON.stringify(r1))
}

console.log('13. 锚点提取')
{
  const t = M.keyTerms('陈屿在急诊留观室醒来，把苏念认作亡妻周予安')
  check('能提出锚点', t.length > 0, JSON.stringify(t))
  check('锚点包含人名相关片段', t.some((x) => x.includes('苏念') || x.includes('陈屿')), JSON.stringify(t))
  check('不含纯虚词锚点', !t.includes('的') && !t.includes('了'), JSON.stringify(t))
}

console.log('14. 改写是否真的动到矛盾')
{
  // 建议要「把亡妻改为妻子」，但改写只是润色 → 必须报出来
  const warn = M.checkRewriteTouchesIssue(
    ['陈屿把苏念认作亡妻周予安。'],
    ['陈屿把苏念认作亡妻周予安了。'],
    '把第1章的"亡妻"改为"妻子"，并将"她已死"限定为误记。'
  )
  check('只润色未落实替换时要警告', typeof warn === 'string' && warn.includes('亡妻'), String(warn))

  // 真正落实了替换 → 不警告
  const ok = M.checkRewriteTouchesIssue(
    ['陈屿把苏念认作亡妻周予安。'],
    ['陈屿把苏念认作妻子周予安。'],
    '把第1章的"亡妻"改为"妻子"。'
  )
  check('落实了替换就不警告', ok === null, String(ok))

  // 建议里没有明确替换指令 → 不做判断（不误报）
  const none = M.checkRewriteTouchesIssue(['甲乙丙'], ['甲乙丁'], '统一各章口径。')
  check('没有明确替换指令时不误报', none === null, String(none))
}

console.log('15. 梗概式转述必须能定位（截图 bug：大量「定位不到」）')
{
  // 全书体检的证据摘自章节梗概，梗概是转述，措辞和正文不同。
  // 上一版要求锚点整串对上，结果这类真问题几乎全被判「定位不到」。
  const html = '<h1>第1章 泥里挣扎</h1><p>陈屿在急诊留观室醒来，把苏念认作亡妻周予安。</p><p>走廊的灯管闪了一下。</p>'
  const paras = M.splitParagraphs(html)

  const variants = [
    ['完全相同的证据', '陈屿在急诊留观室醒来，把苏念认作亡妻周予安'],
    ['转述：当成了已故的妻子', '陈屿醒来后把苏念当成了已故的妻子周予安'],
    ['转述：误将…认作亡妻', '陈屿误将苏念认作亡妻'],
    ['转述：被误认作亡妻', '苏念被误认作亡妻']
  ]
  for (const [label, ev] of variants) {
    const r = M.candidateParagraphs(paras, ev)
    check(`${label} → 能定位到第 2 段`, r.indexes.includes(1), JSON.stringify(r))
  }
}

console.log('16. 收紧后的判定不能把无关章节又放进来')
{
  const ev = '陈屿在急诊留观室醒来，把苏念认作亡妻周予安'
  // 这两段只共享「急诊留观室」这个地名，曾经被误当成目标改掉
  const ch8 = M.splitParagraphs(
    '<h1>第8章 沈砚的抽屉</h1><p>陈屿到的时候是下午四点。门诊楼刚换班，走廊里推车咕噜咕噜往库房去。沈砚在急诊留观室门口等他，白大褂敞着，里头的刷手服领子翻出来一半。"走，楼梯间。"</p>'
  )
  const ch21 = M.splitParagraphs(
    '<h1>第21章 只递手</h1><p>下午三点，林昭到了医院。沈砚在急诊留观室给人清创，手上的橡胶手套没摘。林昭坐在走廊蓝椅子上等，等了三十五分钟。</p>'
  )
  const ch3 = M.splitParagraphs('<h1>第3章</h1><p>陈屿在超市排队结账，前面的人在讨价还价。</p>')
  check('只共享地名的第 8 章仍被拒绝', M.candidateParagraphs(ch8, ev).indexes.length === 0, JSON.stringify(M.candidateParagraphs(ch8, ev)))
  check('只共享地名的第 21 章仍被拒绝', M.candidateParagraphs(ch21, ev).indexes.length === 0, JSON.stringify(M.candidateParagraphs(ch21, ev)))
  check('只提到人名的无关段落被拒绝', M.candidateParagraphs(ch3, ev).indexes.length === 0, JSON.stringify(M.candidateParagraphs(ch3, ev)))
}

console.log('17. 从建议文本里读出「第 N 章」')
{
  // 建议常写着「把第 1 章的 X 改为 Y」，而 chapterIds 可能漏填或填错。
  // 这里只验证解析规则本身（抽取章序号），不依赖 UI。
  const pick = (s) => [...String(s).matchAll(/第\s*(\d{1,4})\s*章/g)].map((m) => parseInt(m[1], 10))
  check('能读出「第1章」', JSON.stringify(pick('把第1章的"亡妻"改为"妻子"')) === '[1]')
  check('能读出带空格的「第 1 章」', JSON.stringify(pick('第 1 章改为"认作重伤昏迷的妻子"')) === '[1]')
  check('能读出多个章节号', JSON.stringify(pick('第1章与第11章对不上')) === '[1,11]')
  check('没有章节号时返回空', pick('统一各章口径').length === 0)
}

console.log(`\n${fail === 0 ? '全部通过' : '有用例失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)