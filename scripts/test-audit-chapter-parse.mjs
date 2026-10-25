#!/usr/bin/env node
/**
 * 章节体检解析的回归测试。
 *
 *   node scripts/test-audit-chapter-parse.mjs
 *
 * 重点：模型经常无视「只输出 JSON」的要求，直接回一段分析文字。
 * 早先这种情况会整份结果作废，界面上只显示「没能解析成结构化结果」，
 * 作者什么也拿不到。现在要求：能从文字里还原的就要还原，还原不了才报失败。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const outdir = mkdtempSync(join(tmpdir(), 'mozhou-chapter-parse-'))
const outfile = join(outdir, 'parse.cjs')

/** @shared/utils 在渲染层是浏览器实现，这里给个最小桩，只补齐解析用到的函数 */
const UTILS_STUB = {
  contents: [
    'module.exports = {',
    "  uid: (p = '') => p + Math.random().toString(36).slice(2, 10),",
    '  stripHtml: (s) => String(s || "").replace(/<[^>]*>/g, ""),',
    '  escapeHtml: (s) => String(s || ""),',
    '  countWords: (s) => String(s || "").replace(/\\s/g, "").length,',
    '  cn: (n) => String(n)',
    '}'
  ].join('\n'),
  loader: 'js'
}

await build({
  entryPoints: [join(here, '../src/renderer/pages/Workspace/audit/parse.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  logLevel: 'silent',
  plugins: [
    {
      name: 'shared-stub',
      setup(b) {
        b.onResolve({ filter: /^@shared\/utils$/ }, () => ({ path: 'utils', namespace: 'stub' }))
        b.onResolve({ filter: /^@shared\// }, (a) => ({ path: a.path, namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => UTILS_STUB)
      }
    }
  ]
})

const M = createRequire(import.meta.url)(outfile)

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

const PROJ = {
  id: 'p1',
  title: 'test',
  chapters: [{ id: 'c1', title: '第 1 章', content: '<p>x</p>', words: 100, summary: '' }],
  bible: { characters: [], world: {}, timeline: [], threads: [] },
  brief: { logline: '' }
}

/** 正常 JSON 返回 */
const GOOD = {
  rhythm: 72,
  conflict: 65,
  suspense: 58,
  water: 30,
  comment: '节奏尚可，中段略平。',
  issues: [
    {
      level: 'high',
      title: '年龄矛盾',
      detail: '正文写她二十岁。',
      evidence: '她今年二十岁',
      suggestion: '统一年龄。'
    }
  ]
}

console.log('1. 格式规整的返回必须照常解析')
{
  const r = M.parseChapterReport(JSON.stringify(GOOD), PROJ, 'c1')
  check('纯净 JSON 可解析', r.ok === true, r.note)
  check('四个分数都对', r.ok && r.value.scores.rhythm === 72 && r.value.scores.water === 30, JSON.stringify(r.value?.scores))
  check('问题条目被解析出来', r.ok && r.value.issues.length === 1, JSON.stringify(r.value?.issues?.length))
  check('不产生「已还原」提示', r.ok && !r.note, String(r.note))
}
{
  const r = M.parseChapterReport('```json\n' + JSON.stringify(GOOD) + '\n```', PROJ, 'c1')
  check('代码块包裹也能解析', r.ok === true, r.note)
}
{
  const r = M.parseChapterReport('好的，分析如下：\n' + JSON.stringify(GOOD) + '\n希望有帮助。', PROJ, 'c1')
  check('前后夹着解释文字也能解析', r.ok === true, r.note)
}
{
  // 流式输出被截断
  const cut = JSON.stringify(GOOD).slice(0, -10)
  const r = M.parseChapterReport(cut, PROJ, 'c1')
  check('被截断的 JSON 仍能救出分数', r.ok === true, r.note)
}

console.log('2. 模型不按格式、只回散文时要从文字里还原')
{
  // 这是实际遇到的返回：完全没有 JSON，纯分析文字
  const prose =
    '这一章的节奏整体偏慢，前半段环境描写过多，读者容易失去耐心。冲突方面，主角的动机不够明确。建议压缩开头的景物描写，让矛盾更早出现。'
  const r = M.parseChapterReport(prose, PROJ, 'c1')
  check('散文也能给出结果（不再整份作废）', r.ok === true, r.note)
  check('识别出节奏偏弱', r.ok && r.value.scores.rhythm > 0 && r.value.scores.rhythm < 50, JSON.stringify(r.value?.scores))
  check('识别出冲突偏弱', r.ok && r.value.scores.conflict > 0 && r.value.scores.conflict < 50, JSON.stringify(r.value?.scores))
  check('文字被当作评语保留', r.ok && r.value.comment.includes('节奏'), r.value?.comment?.slice(0, 40))
  check('明确提示结果是从文字还原的', typeof r.note === 'string' && r.note.includes('还原'), String(r.note))
}
{
  const r = M.parseChapterReport('这一章节奏紧凑有力，冲突清晰，悬念钩子到位。', PROJ, 'c1')
  check('正面评价被判为高分', r.ok && r.value.scores.rhythm >= 60, JSON.stringify(r.value?.scores))
}

console.log('3. 注水是反向指标，不能把「不注水」算成高注水')
{
  const r = M.parseChapterReport('这一章几乎不注水，写得很干净。', PROJ, 'c1')
  check('「不注水」给低分而不是高分', r.ok && r.value.scores.water < 50, JSON.stringify(r.value?.scores))
}
{
  const r = M.parseChapterReport('这一章明显在注水凑字数，大段重复心理描写。', PROJ, 'c1')
  check('「明显注水」给高分（越差越高的反向指标）', r.ok && r.value.scores.water > 50, JSON.stringify(r.value?.scores))
}

console.log('4. 没有信息量时不许瞎编分数')
{
  const r = M.parseChapterReport('今天天气不错，我想出去走走看看。', PROJ, 'c1')
  check('完全无关的话不编造分数', r.ok === false, JSON.stringify(r))
}
{
  const r = M.parseChapterReport('嗯', PROJ, 'c1')
  check('过短的回复判为失败', r.ok === false, JSON.stringify(r))
}
{
  const r = M.parseChapterReport('   ', PROJ, 'c1')
  check('纯空白判为失败', r.ok === false, JSON.stringify(r))
}
{
  // 只提到节奏、没提其他三项：其余应当是「未评」（0），不是瞎给分
  const r = M.parseChapterReport('节奏太拖沓了，中段几乎没有事件推进。', PROJ, 'c1')
  check('只提到一项时，其他项保持未评(0)', r.ok && r.value.scores.suspense === 0 && r.value.scores.water === 0, JSON.stringify(r.value?.scores))
}

console.log('5. 中文键名与字符串分数')
{
  const r = M.parseChapterReport(JSON.stringify({ 节奏: 70, 冲突: 60, 悬念: 50, 注水: 20, 评语: '还行', issues: [] }), PROJ, 'c1')
  check('中文键名可解析', r.ok && r.value.scores.rhythm === 70, JSON.stringify(r.value?.scores))
}
{
  const r = M.parseChapterReport(JSON.stringify({ rhythm: '72', conflict: '65', suspense: '58', water: '30', comment: '好' }), PROJ, 'c1')
  check('字符串形式的分数也能转成数字', r.ok && r.value.scores.rhythm === 72, JSON.stringify(r.value?.scores))
}

console.log(`\n${fail === 0 ? '全部通过' : '有用例失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)