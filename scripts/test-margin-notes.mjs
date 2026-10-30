#!/usr/bin/env node
/**
 * 段落侧批（旁批）纯逻辑回归测试。
 *
 * 用例全部对应设计文档里点名要修的老毛病：
 *  - 只写「第 N 段」看不出哪一章 → 提示词必须带章序号与章名
 *  - 模型把 JSON 包在 ```json 里 / 前后加一段客套话 / 输出被截断
 *  - 索引越界、同一段重复批注、quote 对不上原文
 *  - 重跑一次把作者勾的「已处理」全清掉
 *  - 中途停止时把已完成的章一起丢了
 *  - 没配模型却显示「这一章很干净」
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(mkdtempSync(join(tmpdir(), 'margin-')), 'p.mjs')
await build({
  entryPoints: ['src/renderer/pages/Workspace/audit/margin.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
  alias: { '@shared': './src/shared' }
})
const M = await import(pathToFileURL(out).href)

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
function checkEq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/** 造一个只带被测字段的假章节 */
function chapter(id, title, content) {
  return {
    id,
    title,
    content,
    summary: '',
    status: 'done',
    targetWords: 0,
    words: 0,
    createdAt: 0,
    updatedAt: 0,
    versions: []
  }
}

function makeProject(chapters, marginNotes = {}) {
  return {
    id: 'p1',
    title: '测试书',
    author: '',
    chapters,
    brief: { logline: '' },
    bible: { characters: [], world: [], threads: [], groups: [] },
    summaries: {},
    marginNotes
  }
}

/* ────────────────── 1. 切段与指纹 ────────────────── */
console.log('段落切分（批注序号、跳段、指纹共用一套口径）')
{
  const c = chapter('c1', '第一章', '<p>第一段正文。</p><p>第二段正文。</p>')
  checkEq('HTML 按块切段', JSON.stringify(M.splitParagraphs(c)), JSON.stringify(['第一段正文。', '第二段正文。']))

  const multi = chapter('c2', '第二章', '甲段。\n\n\n  乙段。  \n\n')
  checkEq('多个换行与首尾空白被归一', JSON.stringify(M.splitParagraphs(multi)), JSON.stringify(['甲段。', '乙段。']))

  checkEq('空章节切出 0 段', M.splitParagraphs(chapter('c3', '空', '')).length, 0)
  checkEq('null 章节不炸', M.splitParagraphs(null).length, 0)
  checkEq(
    '只有标签与空白也切不出段落',
    M.splitParagraphs(chapter('c4', '空壳', '<p> </p><p><br/></p>')).length,
    0
  )
}

console.log('正文指纹（用来提示「批注基于旧稿」）')
{
  const a = chapter('c1', '第一章', '<p>起棺那天，雪没停。</p><p>十六个人抬不动一口棺材。</p>')
  const b = chapter('c1', '第一章', '<p>起棺那天，雪没停。</p>\n\n<p>十六个人抬不动一口棺材。</p>')
  const c = chapter('c1', '第一章', '<p>起棺那天，雪停了。</p><p>十六个人抬不动一口棺材。</p>')

  check('同样的字、不同的换行写法 → 指纹相同（不然编辑器一存就误报）', M.chapterFingerprint(a) === M.chapterFingerprint(b), M.chapterFingerprint(a))
  check('正文改过 → 指纹不同', M.chapterFingerprint(a) !== M.chapterFingerprint(c), M.chapterFingerprint(c))
  check('指纹以词数开头', M.chapterFingerprint(a).startsWith('18|'), M.chapterFingerprint(a))
  check('指纹含首尾片段', M.chapterFingerprint(a).includes('起棺那天'), M.chapterFingerprint(a))
  checkEq('null 章节指纹为空串', M.chapterFingerprint(null), '')

  const long = chapter('c2', '第二章', '<p>' + '前半段'.repeat(40) + '</p><p>' + '结尾句子'.repeat(20) + '</p>')
  const fp = M.chapterFingerprint(long)
  const parts = fp.split('|')
  checkEq('指纹是三段：词数|前30|后30', parts.length, 3)
  checkEq('前 30 字截断', parts[1].length, 30)
  checkEq('后 30 字截断', parts[2].length, 30)
}

/* ────────────────── 2. 提示词 ────────────────── */
console.log('批注提示词（必须让模型知道这是第几章）')
{
  const chapters = [
    chapter('c1', '第一章 雪夜', '开头。'),
    chapter('c2', '第二章 灰线', '<p>第一段。</p><p>第二段。</p>'),
    chapter('c3', '第三章 空棺', '内容。'),
    chapter('c4', '第四章 归途', '内容。'),
    chapter('c5', '第五章 雪停', '内容。')
  ]
  const p = makeProject(chapters)
  const msgs = M.buildMarginNoteMessages(p, chapters[1], 2, 5)
  checkEq('返回 system + user 两条', msgs.length, 2)
  checkEq('第一条是 system', msgs[0].role, 'system')
  const user = msgs[1].content
  check('写明第几章 / 共几章 / 章名', user.includes('这是第 2 章（共 5 章）〈第二章 灰线〉'), user.slice(0, 120))
  check('要求 quote 是 6–30 字连续原文', user.includes('连续 6–30 字'), '')
  check('最多 6 条', user.includes('最多 6 条'), '')
  check('六种口吻都在提示词里', ['删', '改', '慢', '快', '虚', '偏'].every((k) => user.includes(`"${k}"`)), '')
  check('输出契约用 paragraph 字段', user.includes('"paragraph":1'), '')
  check('输出契约带 quote', user.includes('"quote"'), '')
  check('分段正文带序号', user.includes('1. 第一段。') && user.includes('2. 第二段。'), '')

  const auto = M.buildMarginNoteMessages(p, chapters[1])
  check('不传序号时从项目里推断', auto[1].content.includes('这是第 2 章（共 5 章）'), auto[1].content.slice(0, 120))
}

/* ────────────────── 3. 解析容错 ────────────────── */
console.log('批注解析（真实翻车现场逐条覆盖）')
{
  const paras = ['起棺那天，雪没停。', '十六个人抬不动一口棺材。', '陈九斤蹲在墙根抽旱烟，没吭声。']

  const fenced =
    '好的，我读完了，下面是我的批注：\n```json\n[{"paragraph":1,"kind":"删","note":"这句是废话","quote":"雪没停"}]\n```\n希望有帮助。'
  const a = M.parseMarginNotes(fenced, 3, paras)
  checkEq('带围栏 + 前后废话 → 1 条', a.length, 1)
  checkEq('围栏解析出的段落号正确', a[0]?.paragraph, 1)

  const outOfRange = '[{"paragraph":9,"kind":"改","note":"越界"},{"paragraph":0,"kind":"改","note":"零"}]'
  checkEq('索引越界与 0 都丢弃', M.parseMarginNotes(outOfRange, 3, paras).length, 0)

  const dup = '[{"paragraph":1,"kind":"删","note":"第一条"},{"paragraph":1,"kind":"改","note":"第二条"}]'
  const d = M.parseMarginNotes(dup, 3, paras)
  checkEq('同段只留一条', d.length, 1)
  checkEq('同段保留靠前（更重要）的那条', d[0]?.note, '第一条')

  const badQuote = '[{"paragraph":2,"kind":"虚","note":"写手上动作","quote":"这句话原文里根本没有"}]'
  const bq = M.parseMarginNotes(badQuote, 3, paras)
  checkEq('quote 找不到也不丢批注', bq.length, 1)
  checkEq('quote 找不到时置空', bq[0]?.quote, undefined)
  checkEq('批注本身保留', bq[0]?.note, '写手上动作')

  const goodQuote = '[{"paragraph":2,"kind":"虚","note":"写手上动作","quote":"十六个人抬不动"}]'
  const gq = M.parseMarginNotes(goodQuote, 3, paras)
  checkEq('quote 在原文里 → 保留', gq[0]?.quote, '十六个人抬不动')

  const quotePunct = '[{"paragraph":2,"kind":"改","note":"换词","quote":"十六个 人，抬不动"}]'
  check('quote 只是标点/空格不同也算对上', M.parseMarginNotes(quotePunct, 3, paras)[0]?.quote !== undefined, JSON.stringify(M.parseMarginNotes(quotePunct, 3, paras)))

  const legacy = '[{"index":3,"kind":"慢","note":"这里该停"}]'
  const l = M.parseMarginNotes(legacy, 3, paras)
  checkEq('老契约的 index 字段仍然认', l[0]?.paragraph, 3)

  const weirdKind = '[{"paragraph":1,"kind":"离谱","note":"类型不认识"}]'
  checkEq('非法 kind 兜底成「改」', M.parseMarginNotes(weirdKind, 3, paras)[0]?.kind, '改')

  const emptyNote = '[{"paragraph":1,"kind":"删","note":"   "},{"paragraph":2,"kind":"删","note":"有效"}]'
  checkEq('空批注丢弃', M.parseMarginNotes(emptyNote, 3, paras).length, 1)

  const truncated =
    '[{"paragraph":1,"kind":"删","note":"第一条有效批注"},{"paragraph":2,"kind":"改","note":"第二条有效批注"},{"paragraph":3,"kind":"慢","note":"第三条被截'
  const t = M.parseMarginNotes(truncated, 3, paras)
  check('输出截断时抢救出前面完整的条目', t.length >= 2, JSON.stringify(t))

  checkEq('[] 解析成 0 条（这一章很干净）', M.parseMarginNotes('[]', 3, paras).length, 0)
  checkEq('纯垃圾解析成 0 条', M.parseMarginNotes('我看完了，没什么问题。', 3, paras).length, 0)
  checkEq('空串解析成 0 条', M.parseMarginNotes('', 3, paras).length, 0)

  const unsorted = '[{"paragraph":3,"kind":"删","note":"c"},{"paragraph":1,"kind":"删","note":"a"},{"paragraph":2,"kind":"删","note":"b"}]'
  const u = M.parseMarginNotes(unsorted, 3, paras)
  checkEq('结果按段落升序', u.map((n) => n.paragraph).join(','), '1,2,3')

  check('非数组 JSON 不算批注', M.parseMarginNotes('{"paragraph":1,"note":"不是数组"}', 3, paras).length === 0)
  checkEq('不传 paragraphs 时信任模型的 quote', M.parseMarginNotes(goodQuote, 3)[0]?.quote, '十六个人抬不动')
}

/* ────────────────── 4. resolved 合并 ────────────────── */
console.log('重跑时保留作者已标记的「已处理」')
{
  const prev = {
    at: 1,
    paragraphs: 2,
    fingerprint: 'x',
    notes: [
      { paragraph: 1, kind: '删', note: '这句多余', resolved: true },
      { paragraph: 2, kind: '改', note: '换词', resolved: false }
    ]
  }
  const next = {
    at: 2,
    model: 'm',
    paragraphs: 2,
    fingerprint: 'y',
    notes: [
      { paragraph: 1, kind: '删', note: '这句多余' },
      { paragraph: 2, kind: '改', note: '换词' },
      { paragraph: 3, kind: '慢', note: '新出现的' }
    ]
  }
  const merged = M.mergeMarginSet(prev, next)
  checkEq('段落+批注都相同 → 恢复已处理', merged.notes[0].resolved, true)
  checkEq('没勾过的不被误标', merged.notes[1].resolved, undefined)
  checkEq('新条目正常加入', merged.notes.length, 3)
  checkEq('结果时间用新的一次', merged.at, 2)

  const renamed = M.mergeMarginSet(prev, {
    at: 3,
    paragraphs: 2,
    fingerprint: 'y',
    notes: [{ paragraph: 1, kind: '删', note: '这句是多余的（改写过的措辞）' }]
  })
  checkEq('批注文字变了就不算同一条', renamed.notes[0].resolved, undefined)

  const none = M.mergeMarginSet(undefined, next)
  checkEq('没有上一次结果时原样返回', none, next)
}

/* ────────────────── 5. 批量执行器 ────────────────── */
console.log('批量执行器：成功 / 失败 / 停止 / 没配模型')

function runnerProject() {
  const chapters = [
    chapter('c1', '第一章 雪夜', '<p>甲段。</p><p>乙段。</p>'),
    chapter('c2', '第二章 灰线', '<p>丙段。</p><p>丁段。</p>')
  ]
  return makeProject(chapters)
}

{
  const p = runnerProject()
  const calls = []
  const progress = []
  const done = []
  const res = await M.runMarginForChapters({
    chapters: p.chapters,
    project: p,
    modelLabel: '测试模型',
    now: () => 1234,
    generate: async (ctx) => {
      calls.push(ctx)
      ctx.onDelta('12345')
      return '[{"paragraph":1,"kind":"删","note":"这句多余","quote":"甲段"}]'
    },
    onProgress: (x) => progress.push(x),
    onChapter: (c, set) => done.push([c.id, set.notes.length])
  })
  checkEq('两章都有结果', Object.keys(res.sets).length, 2)
  checkEq('没有失败', res.failures.length, 0)
  checkEq('没有停止标记', res.stopped, false)
  checkEq('结果时间取注入的 now', res.sets.c1.at, 1234)
  checkEq('结果带模型名', res.sets.c1.model, '测试模型')
  checkEq('结果记录段数', res.sets.c1.paragraphs, 2)
  check('结果记录正文指纹', res.sets.c1.fingerprint.length > 0, res.sets.c1.fingerprint)
  checkEq('generate 收到的是全书章节序号', calls[1].chapterIndex, 2)
  checkEq('generate 收到总章数', calls[1].chapterTotal, 2)
  check('generate 收到的提示词含章名', calls[1].user.includes('第二章 灰线'), '')
  checkEq('逐章落盘回调两章', done.length, 2)
  check('逐章落盘顺序正确', done[0][0] === 'c1' && done[1][0] === 'c2', JSON.stringify(done))
  check('进度里有 start/delta/done', ['start', 'delta', 'done'].every((s) => progress.some((x) => x.stage === s)), JSON.stringify([...new Set(progress.map((x) => x.stage))]))
  check('进度里已收到字数被累计', progress.some((x) => x.received === 5), JSON.stringify(progress.map((x) => x.received)))
}

{
  const p = runnerProject()
  const res = await M.runMarginForChapters({
    chapters: p.chapters,
    project: p,
    modelLabel: '测试模型',
    generate: async (ctx) => {
      if (ctx.chapter.id === 'c1') throw new Error('渠道 401')
      return '[]'
    }
  })
  checkEq('失败一章不影响另一章', Object.keys(res.sets).length, 1)
  checkEq('失败被记录', res.failures.length, 1)
  checkEq('失败记录章名', res.failures[0].title, '第一章 雪夜')
  checkEq('失败记录原因', res.failures[0].message, '渠道 401')
  checkEq('成功的章照常写入', res.sets.c2.notes.length, 0)
}

{
  const p = runnerProject()
  let calls = 0
  const res = await M.runMarginForChapters({
    chapters: p.chapters,
    project: p,
    modelLabel: '测试模型',
    // 第一章跑完就「点了停止」：第二章不该再发请求，第一章结果要留住
    shouldStop: () => calls >= 1,
    generate: async () => {
      calls++
      return '[{"paragraph":1,"kind":"改","note":"一条"}]'
    }
  })
  checkEq('停止后不再发请求', calls, 1)
  checkEq('停止标记为 true', res.stopped, true)
  checkEq('已完成的章保留', Object.keys(res.sets).length, 1)
  checkEq('停止不算失败', res.failures.length, 0)
}

{
  const p = runnerProject()
  let called = false
  const res = await M.runMarginForChapters({
    chapters: p.chapters,
    project: p,
    modelLabel: '一致性审校 · 未配置',
    generate: async () => {
      called = true
      return '[]'
    }
  })
  check('没配模型时不发请求', !called)
  check('没配模型时返回 blocked 原因', Boolean(res.blocked), JSON.stringify(res.blocked))
  checkEq('blocked 与常量一致', res.blocked, M.MARGIN_NO_MODEL)
  checkEq('没配模型时不产生结果', Object.keys(res.sets).length, 0)
  checkEq('没配模型不算每章失败', res.failures.length, 0)

  const emptyLabel = await M.runMarginForChapters({
    chapters: p.chapters,
    project: p,
    modelLabel: '',
    generate: async () => '[]'
  })
  check('空模型名同样 blocked', Boolean(emptyLabel.blocked), JSON.stringify(emptyLabel.blocked))
}

{
  const p = runnerProject()
  const res = await M.runMarginForChapters({
    chapters: p.chapters,
    project: p,
    modelLabel: '测试模型',
    generate: async (ctx) => (ctx.chapter.id === 'c1' ? '' : '好的，我看完了。')
  })
  checkEq('空返回记一次失败', res.failures.length, 2)
  check(
  '空返回原因明确',
  res.failures[0].message.startsWith('模型没有返回内容') && res.failures[0].message.includes('输出预算'),
  res.failures[0].message
)
  checkEq('非 JSON 返回原因明确', res.failures[1].message, '模型没有按约定返回 JSON 数组')
  check('非 JSON 时贴出原样返回', String(res.failures[1].raw).includes('我看完了'), res.failures[1].raw)
  checkEq('失败的章不写结果（不许显示成「没问题」）', Object.keys(res.sets).length, 0)
}

{
  // 重跑保留作者勾选：执行器内部要走 mergeMarginSet
  const p = runnerProject()
  p.marginNotes = {
    c1: {
      at: 1,
      model: '旧模型',
      paragraphs: 2,
      fingerprint: M.chapterFingerprint(p.chapters[0]),
      notes: [{ paragraph: 1, kind: '删', note: '这句多余', resolved: true }]
    }
  }
  const res = await M.runMarginForChapters({
    chapters: [p.chapters[0]],
    project: p,
    modelLabel: '测试模型',
    generate: async () => '[{"paragraph":1,"kind":"删","note":"这句多余"}]'
  })
  checkEq('重跑后已处理标记还在', res.sets.c1.notes[0].resolved, true)
  checkEq('重跑后模型名更新', res.sets.c1.model, '测试模型')
}

{
  // 空章不花钱：既不发请求也不进结果
  const p = makeProject([chapter('c1', '空章', '   '), chapter('c2', '有字', '<p>正文。</p>')])
  let calls = 0
  const res = await M.runMarginForChapters({
    chapters: p.chapters,
    project: p,
    modelLabel: '测试模型',
    generate: async () => {
      calls++
      return '[]'
    }
  })
  checkEq('空章不发请求', calls, 1)
  checkEq('空章不进结果', Object.keys(res.sets).length, 1)
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)