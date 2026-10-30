#!/usr/bin/env node
/**
 * AI 评书的纯逻辑回归测试：提示词、字数换算、评书稿解析、朗读切句。
 *
 * 这里的用例来自这一页真正会踩的坑，不是凭空想的：
 *  - 模型不写【正文】/【定场诗】，或者干脆一个标记都不写
 *  - 模型热情地在前面加「好的，以下是评书稿：」，或者包一层 ``` 围栏
 *  - 空稿被当成成功落盘（作者点开一片空白）
 *  - 两千字不切句直接丢给 speechSynthesis：高亮不了、暂停失效
 *  - 长句没有逗号，切句函数在里面死循环 / 一个超长 utterance 卡住
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'recital-'))
async function load(entry, name) {
  const out = join(dir, name)
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile: out,
    logLevel: 'silent',
    alias: { '@shared': './src/shared' }
  })
  return import(pathToFileURL(out).href)
}

const P = await load('src/renderer/pages/Workspace/recital/prompt.ts', 'prompt.mjs')
const R = await load('src/renderer/pages/Workspace/recital/parse.ts', 'parse.mjs')
const T = await load('src/renderer/pages/Workspace/recital/tts.ts', 'tts.mjs')

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail !== undefined ? ' → ' + detail : ''}`)
  }
}

const project = {
  id: 'p1',
  title: '抬棺人',
  author: '',
  brief: { logline: '十六个人抬不动一口棺材。', premise: '', keywords: [] },
  chapters: [
    { id: 'c1', title: '第1章 起棺', content: '<p>十六个人抬不动一口棺材。</p>', words: 14 },
    { id: 'c2', title: '第2章 一斤都不能少', content: '<p>陈默测重发现棺内多出四十斤。</p>', words: 16 },
    { id: 'c3', title: '第3章 十六人抬棺', content: '<p>杠子断了。</p>', words: 5 }
  ]
}

console.log('风格表：五种，各有可执行的关键词')
{
  const ids = P.RECITAL_STYLES.map((s) => s.id)
  check('五种风格齐全', ids.length === 5, JSON.stringify(ids))
  check('风格 id 与约定一致', ['classic', 'beijing', 'fast', 'suspense', 'kids'].every((k) => ids.includes(k)), JSON.stringify(ids))
  check('每种风格都有一句说明', P.RECITAL_STYLES.every((s) => s.desc.length >= 4))
  check('每种风格都带约束', P.RECITAL_STYLES.every((s) => s.constraints.length >= 2))
  check('未知 id 回落到第一种（不崩）', P.findRecitalStyle('nope').id === P.RECITAL_STYLES[0].id)
}

console.log('字数换算：每分钟 260 字')
check('1 分钟 = 260 字', P.targetWordsForMinutes(1) === 260, String(P.targetWordsForMinutes(1)))
check('3 分钟 = 780 字', P.targetWordsForMinutes(3) === 780, String(P.targetWordsForMinutes(3)))
check('5 分钟 = 1300 字', P.targetWordsForMinutes(5) === 1300, String(P.targetWordsForMinutes(5)))
check('非法时长回落 3 分钟', P.targetWordsForMinutes(Number.NaN) === 780, String(P.targetWordsForMinutes(Number.NaN)))

console.log('提示词：包含章名/章序号/目标字数/输出契约/禁止复述')
{
  const ch = project.chapters[1]
  const msgs = P.buildRecitalMessages(project, ch, P.findRecitalStyle('classic'), 780)
  const all = `${msgs.system}\n${msgs.user}`
  check('含章名', all.includes('一斤都不能少'), all.slice(0, 40))
  check('含章序号与总章数', all.includes('第 2 章') && all.includes('共 3 章'), '')
  check('含目标字数', all.includes('780'), '')
  check('输出契约四个标记齐全', ['【回目】', '【定场诗】', '【正文】', '【收尾】'].every((m) => all.includes(m)))
  check('明确禁止逐字复述', all.includes('禁止逐字复述'))
  check('带上书名', all.includes('抬棺人'))
  check('章节原文进了 user（去掉 HTML 标签）', msgs.user.includes('测重发现棺内多出四十斤') && !msgs.user.includes('<p>'))
}

console.log('提示词：每种风格都还认得自己（不许五档说一样的话）')
{
  const ch = project.chapters[0]
  const textOf = (id) => {
    const m = P.buildRecitalMessages(project, ch, P.findRecitalStyle(id), 260)
    return `${m.system}\n${m.user}`
  }
  const classic = textOf('classic')
  check('classic 提到单田芳', classic.includes('单田芳'))
  check('classic 带上「话说」「且说」', classic.includes('话说') && classic.includes('且说'))

  const beijing = textOf('beijing')
  check('beijing 是京腔', beijing.includes('京腔'))
  check('beijing 提到儿化与「您」', beijing.includes('儿化') && beijing.includes('您'))

  const fast = textOf('fast')
  check('fast 强调转折与动作', fast.includes('转折') && fast.includes('动作'))
  check('fast 要求少描写', fast.includes('少描写'))

  const suspense = textOf('suspense')
  check('suspense 压低嗓子', suspense.includes('压低'))
  check('suspense 会在关键处停', suspense.includes('停'))

  const kids = textOf('kids')
  check('kids 强调短句与解释', kids.includes('短句') && kids.includes('解释'))
  check('kids 不用生僻词', kids.includes('生僻'))

  // 反过来钉住「互相别抄」：每段风格提示都只在自己的稿子里出现
  check('五种风格提示互不相同', new Set([classic, beijing, fast, suspense, kids]).size === 5)
  check('kids 的约束不出现在 classic 里', !classic.includes('生僻'))
  check('suspense 的约束不出现在 fast 里', !fast.includes('压低嗓子'))
}

console.log('解析：标准四段')
{
  const raw = `【回目】第七回 灰线尽头
【定场诗】一张图纸千条线，线线都通鬼门关。
【正文】
话说这雪下了三天三夜。
这棺材里头，多出四十斤。
【收尾】欲知后事如何，且听下回分解。`
  const r = R.parseRecital(raw, '第7章 灰线')
  check('回目取到', r.title === '第七回 灰线尽头', r.title)
  check('无告警', r.warnings.length === 0, JSON.stringify(r.warnings))
  check('正文在稿子里', r.script.includes('雪下了三天三夜'))
  check('定场诗留下来了（要念给听众）', r.script.includes('一张图纸千条线'))
  check('收尾留下来了', r.script.includes('且听下回分解'))
  check('标记本身不残留在稿子里', !r.script.includes('【正文】') && !r.script.includes('【回目】'))
}

console.log('解析：围栏 + 前后废话')
{
  const raw = `好的，以下是这一章的评书稿：

\`\`\`text
【回目】第三回 一斤都不能少
【定场诗】棺材过秤，秤砣不认人。
【正文】
话说陈九斤把秤一压，脸上的肉都抖。
【收尾】欲知后事如何，且听下回分解。
\`\`\`
希望您喜欢！`
  const r = R.parseRecital(raw, '第3章 一斤都不能少')
  check('围栏里的回目取到', r.title === '第三回 一斤都不能少', r.title)
  check('围栏没留进稿子', !r.script.includes('```'), r.script.slice(0, 30))
  check('前言被丢掉并告警', r.warnings.some((w) => w.includes('之前')), JSON.stringify(r.warnings))
  check('正文正常', r.script.includes('把秤一压'))
  check('围栏后的客套话没进正文', !r.script.includes('希望您喜欢'), r.script)
}

console.log('解析：缺回目 → 用章名')
{
  const raw = `【定场诗】雪夜无人，只有棺材响。
【正文】
话说那口棺材自己挪了半尺。
【收尾】欲知后事如何，且听下回分解。`
  const r = R.parseRecital(raw, '第9章 半夜挪棺')
  check('回目回落到章名', r.title === '第9章 半夜挪棺', r.title)
  check('缺回目有告警', r.warnings.some((w) => w.includes('回目')), JSON.stringify(r.warnings))
  check('正文还在', r.script.includes('棺材自己挪了半尺'))
}

console.log('解析：缺定场诗不算失败')
{
  const raw = `【回目】第五回 抬不动
【正文】
话说十六个人抬一口棺材，杠子咔嚓就断了。
【收尾】欲知后事如何，且听下回分解。`
  const r = R.parseRecital(raw, '第5章 抬不动')
  check('没有抛错', Boolean(r.script))
  check('回目正常', r.title === '第五回 抬不动', r.title)
  check('缺定场诗有提示', r.warnings.some((w) => w.includes('定场诗')), JSON.stringify(r.warnings))
  check('正文完整', r.script.includes('杠子咔嚓就断了'))
}

console.log('解析：缺【正文】标记 → 剩余文字当正文')
{
  const raw = `【回目】第二回 多出四十斤
【定场诗】秤上多了四十斤，人少了十六个。
话说陈默把秤一提，多了四十斤。
众人脸都白了。
【收尾】欲知后事如何，且听下回分解。`
  const r = R.parseRecital(raw, '第2章 多出四十斤')
  check('稿子没丢内容', r.script.includes('众人脸都白了'), r.script)
  check('正文里带上定场诗之后的那句', r.script.includes('把秤一提'))
  check('缺正文有提示', r.warnings.some((w) => w.includes('正文')), JSON.stringify(r.warnings))
}

console.log('解析：一个标记都没有 → 整篇当正文（不丢内容）')
{
  const raw = `话说这雪下了三天，路上一个人没有。
棺材停在门口，谁也不敢开。`
  const r = R.parseRecital(raw, '第4章 雪夜')
  check('整篇都在稿子里', r.script.includes('路上一个人没有') && r.script.includes('谁也不敢开'))
  check('标题用章名', r.title === '第4章 雪夜', r.title)
  check('有告警说明没按格式分段', r.warnings.some((w) => w.includes("分段")), JSON.stringify(r.warnings))
}

console.log('解析：空稿必须报错（不许当成成功落盘）')
{
  for (const junk of ['', '   ', '\n\n\n', '```\n```']) {
    let threw = ''
    try {
      R.parseRecital(junk, '第1章')
    } catch (e) {
      threw = e.message
    }
    check(`「${junk.replace(/\n/g, '\\n')}」报错`, threw === R.EMPTY_RECITAL_MESSAGE, threw)
  }

  let threw = ''
  try {
    R.parseRecital('【回目】第七回 只有回目\n【定场诗】\n【正文】\n【收尾】', '第7章')
  } catch (e) {
    threw = e.message
  }
  check('只有标记没有内容也报错', threw === R.EMPTY_RECITAL_MESSAGE, threw)
}

console.log('解析：行首「回目：」这种退化写法也能认')
{
  const raw = `回目：第八回 断杠
定场诗：杠子一断，人心就散。
正文：话说那杠子咔嚓一声，从中间断开。
收尾：欲知后事如何，且听下回分解。`
  const r = R.parseRecital(raw, '第8章 断杠')
  check('回目取到', r.title === '第八回 断杠', r.title)
  check('正文取到', r.script.includes('从中间断开'), r.script)
  check('定场诗取到', r.script.includes('人心就散'))
}

console.log('切句：基本边界')
{
  check('空稿 → 0 句', T.splitForSpeech('').length === 0)
  check('纯空白 → 0 句', T.splitForSpeech('   \n\n\t ').length === 0)

  const s = T.splitForSpeech('话说天下大势，分久必合。且说这一年，雪下得早！你猜怎么着？')
  check('按句号/感叹号/问号切成三句', s.length === 3, JSON.stringify(s))
  check('标点跟着句子走', s[0].endsWith('。') && s[1].endsWith('！') && s[2].endsWith('？'), JSON.stringify(s))
  check('切句不丢字', s.join('') === '话说天下大势，分久必合。且说这一年，雪下得早！你猜怎么着？')

  const nl = T.splitForSpeech('第一句\n第二句\n\n第三句')
  check('换行也算边界', nl.length === 3, JSON.stringify(nl))
  check('空行不产生空句', nl.every((x) => x.trim().length > 0), JSON.stringify(nl))

  const semi = T.splitForSpeech('他说了一件事；然后就走了。')
  check('分号是边界', semi.length === 2, JSON.stringify(semi))

  const dots = T.splitForSpeech('他走了……再没回来。')
  check('省略号不拆成两句', dots.length === 2, JSON.stringify(dots))
  check('省略号整段保留在前句', dots[0].includes('……'), JSON.stringify(dots))

  const pure = T.splitForSpeech('……')
  check('纯标点不生成句子', pure.length === 0, JSON.stringify(pure))
}

console.log('切句：长句按逗号再切，且不超过上限')
{
  const clause = '话说那年冬天雪下得极大，'
  const long = clause.repeat(14) + '棺材停在院里。' // 明显超过 100 字
  const s = T.splitForSpeech(long)
  check('长句被切成多句', s.length > 1, String(s.length))
  check('每句都不超过上限', s.every((x) => x.length <= T.LONG_SENTENCE), JSON.stringify(s.map((x) => x.length)))
  check('长句切完不丢字', s.join('') === long, `${s.join('').length} vs ${long.length}`)

  const noPunct = '雪'.repeat(250)
  const hard = T.splitForSpeech(noPunct)
  check('无标点超长文本也能切', hard.length > 1, String(hard.length))
  check('无标点切完不丢字', hard.join('') === noPunct, String(hard.join('').length))
  check('无标点每句不超过上限', hard.every((x) => x.length <= T.LONG_SENTENCE), JSON.stringify(hard.map((x) => x.length)))

  const short = T.splitForSpeech('很短的一句。')
  check('短句保持一整句', short.length === 1 && short[0] === '很短的一句。', JSON.stringify(short))
}

console.log('切句：整篇稿子跑一遍')
{
  const raw = `【回目】第七回 灰线
一张图纸千条线，线线都通鬼门关。
话说这雪下了三天三夜。棺材里头，多出四十斤！
欲知后事如何，且听下回分解。`
  const r = R.parseRecital(raw, '第7章')
  const chunks = T.splitForSpeech(r.script)
  check('整篇能切成多句', chunks.length >= 4, String(chunks.length))
  check('没有空句', chunks.every((c) => c.trim().length > 0))
  check('每句都在稿子里', chunks.every((c) => r.script.includes(c.trim())), '')
}

console.log('播放器：没有系统语音时明确报告「不支持」，而不是报错')
{
  const p = new T.SpeechPlayer()
  const st = p.state()
  check('node 环境判为不支持', st.supported === false, JSON.stringify(st.supported))
  check('给出可读文案', st.hint === T.TTS_UNSUPPORTED_HINT, st.hint)
  check('load 之后仍然不崩', (() => {
    p.load('话说……', 'c1')
    return p.state().total === 1
  })(), JSON.stringify(p.state()))
  p.play(0)
  p.pause()
  p.resume()
  p.destroy()
  check('不支持时调用各方法都不抛错', true)
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)