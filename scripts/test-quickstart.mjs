#!/usr/bin/env node
/**
 * AI 一键开书的解析回归测试。
 *
 * 这里的用例全部来自**真实踩过的坑**，不是凭空想的：
 *  - 模型只回「OK」，被当成书名（步骤 1 假装成功）
 *  - 推理模型的思考吃光 max_tokens，正文为空 → 界面一片空白
 *  - 输出被截断，JSON 到一半就断了
 *  - 模型不守 JSON 纪律，改用 markdown / 「标题：内容」
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(mkdtempSync(join(tmpdir(), 'qs-')), 'p.mjs')
await build({
  entryPoints: ['src/renderer/pages/Bookshelf/quickstart/pipeline.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
  alias: { '@shared': './src/shared' }
})
const P = await import(pathToFileURL(out).href)

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

console.log('离谱返回必须被判失败（这是之前"假装成功"的根源）')
for (const junk of ['OK', '好的', 'ok', '', '   ', '以下是书名：', 'Sure, here you go']) {
  const t = P.parseTitleOutput(junk)
  check(`「${junk}」不当作书名`, !t.title, JSON.stringify(t))
}
check('正常的书名能通过', P.parseTitleOutput('{"title":"抬棺人","intro":"一个抬棺的故事。"}').title === '抬棺人')
check('中文书名不带 JSON 也能取到', P.parseTitleOutput('书名：抬棺人\n简介：一个抬棺的故事。').title === '抬棺人')

console.log('设定：四种真实输出形态都要解析出来')
{
  const json = '[{"kind":"world","title":"雪原契约","content":"三十年前立下契约，用记忆换生存，每死一人树少一圈年轮。"}]'
  const a = P.parseSettingsOutput(json)
  check('标准 JSON', a.length === 1 && a[0].title === '雪原契约', JSON.stringify(a.length))
  check('kind 被识别为 world', a[0]?.kind === 'world', a[0]?.kind)

  const fenced = '好的，如下：\n```json\n[{"kind":"character","title":"周砚秋","content":"二十三岁，邮局代办，想找父亲。"}]\n```'
  const b = P.parseSettingsOutput(fenced)
  check('带围栏与前言', b.length === 1 && b[0].kind === 'character', JSON.stringify(b))

  const md = '## 世界观：雪原契约\n三十年前立下契约，用记忆换生存。\n## 角色：周砚秋\n二十三岁，邮局代办，想找父亲。'
  const c = P.parseSettingsOutput(md)
  check('markdown 小标题', c.length === 2, JSON.stringify(c.length))

  const colon = '世界观：三十年前立下契约，用记忆换生存。\n周砚秋：二十三岁，邮局代办，想找父亲。'
  const d = P.parseSettingsOutput(colon)
  check('「标题：内容」逐行', d.length === 2, JSON.stringify(d.length))
}

console.log('截断的输出要尽量抢救（而不是整步失败）')
{
  const truncated =
    '[{"kind":"world","title":"雪原契约","content":"三十年前雪原上的人与雪灵立下契约，用记忆换生存。契约刻在树上，每死一人树就少一圈年轮。"},{"kind":"character","title":"周砚秋","content":"二十三岁，邮局临时代办，想找父亲失踪'
  const got = P.parseSettingsOutput(truncated)
  check('半截 JSON 也能捞出至少一条', got.length >= 1, String(got.length))
  check('捞出的那条内容完整可用', (got[0]?.content ?? '').length > 10, got[0]?.content)

  const chTrunc = '[{"title":"第1章 一斤都不能少","summary":"陈默测重发现棺内多出四十斤，逼陈九斤改口停棺。"},{"title":"第2章 十六人抬棺","summ'
  const chs = P.parseChaptersOutput(chTrunc)
  check('章纲截断也能捞出', chs.length >= 1, String(chs.length))
}

console.log('空壳内容要被识别出来')
{
  const empty = P.parseSettingsOutput('[]')
  check('空数组 → 0 条', empty.length === 0)
  check('空壳不算有内容', !P.looksSubstantial([{ title: '标题', content: '' }]))
  check('只有标点也不算', !P.looksSubstantial([{ title: '。', content: '，' }]))
  check('真内容算有内容', P.looksSubstantial([{ title: '雪原契约', content: '用记忆换生存。' }]))
  check('章纲的 summary 字段也算内容', P.looksSubstantial([{ title: '第1章', summary: '陈默发现棺内多出四十斤。' }]))
}

console.log('空返回')
{
  check('空字符串 → 0 条', P.parseSettingsOutput('').length === 0)
  check('纯空白 → 0 条', P.parseSettingsOutput('   \n\n  ').length === 0)
}

console.log('章纲与分卷')
{
  const chs = P.parseChaptersOutput('[{"title":"第1章 起棺","summary":"十六人抬棺，杠子断了。"},{"title":"第2章 一斤都不能少","summary":"陈默测重发现多出四十斤。"}]')
  check('章纲两条都解析', chs.length === 2, String(chs.length))
  check('章纲标题正确', chs[0]?.title === '第1章 起棺', chs[0]?.title)
  check('章纲内容正确', chs[1]?.summary.includes('四十斤'), chs[1]?.summary)

  const vols = P.parseVolumesOutput('[{"title":"第一卷 十六人抬不动一口棺","summary":"立足与结仇。"}]')
  check('分卷解析', vols.length === 1 && vols[0].title.includes('第一卷'), JSON.stringify(vols))
}

console.log('装配成 Project')
{
  const product = {
    idea: '抬棺',
    sceneId: 'novel',
    genreId: 'xianxia',
    perChapter: 2500,
    title: { title: '抬棺人', intro: '一个抬棺的故事。' },
    settings: [
      { id: 's1', kind: 'world', title: '雪原契约', content: '用记忆换生存。' },
      { id: 's2', kind: 'character', title: '周砚秋', content: '二十三岁，邮局代办。' }
    ],
    volumes: [{ id: 'v1', title: '第一卷 起棺', summary: '立足与结仇。' }],
    chapters: [
      { id: 'c1', title: '第1章 起棺', summary: '十六人抬棺。' },
      { id: 'c2', title: '第2章 一斤都不能少', summary: '多出四十斤。' }
    ],
    firstChapter: '十六个人抬不动一口棺材。'
  }
  const proj = P.assembleProject(product)
  check('书名正确', proj.title === '抬棺人', proj.title)
  check('世界观条目进设定库', proj.bible.world.length === 1, String(proj.bible.world.length))
  check('角色进角色档案', proj.bible.characters.length === 1, String(proj.bible.characters.length))
  check('章节数与章纲一致', proj.chapters.length === 2, String(proj.chapters.length))
  check('第一章带正文', proj.chapters[0].content.length > 10)
  check('第二章还没正文', proj.chapters[1].content === '')
  check('大纲第一卷挂上章纲', proj.outline[0]?.children?.length === 2, String(proj.outline[0]?.children?.length))
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)