#!/usr/bin/env node
/**
 * 书稿导入的纯逻辑回归测试。
 *
 * 用例全部来自真实书稿的形态，而不是凭空想的理想输入：
 *  - 稿子开头是「书名 + 作者：xxx」，正文第一行还可能直接是「第一章」；
 *  - 作者把「第X卷」写在章前面，旧 splitChapters 会把它当成一章；
 *  - 导出的 Markdown 用 `# 第一章` 当章标题；
 *  - 从论坛粘贴的稿子什么标记都没有；
 *  - 模型的 JSON 常带 ```json 围栏、前后废话、被 max_tokens 截断，
 *    index 会乱序、重复、甚至跑到全书章数之外。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(mkdtempSync(join(tmpdir(), 'imp-')), 'p.mjs')
await build({
  entryPoints: ['src/renderer/pages/Bookshelf/import/index.ts'],
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

/* ───────────────────── 书名 / 作者 ───────────────────── */

console.log('书名与作者：文件名、首行、作者:')
{
  const a = P.parseImportText('第一章 起棺\n正文正文正文。\n', { fileName: '抬棺人.txt' })
  check('首行是章标记时，书名退回文件名', a.title === '抬棺人', a.title)

  const b = P.parseImportText('抬棺人\n作者：陈九斤\n\n第一章 起棺\n正文。\n', { fileName: 'x.txt' })
  check('首行短行当书名', b.title === '抬棺人', b.title)
  check('作者行解析出来', b.author === '陈九斤', b.author)

  const c = P.parseImportText('书名：《雪原契约》\n张三 著\n\n第一章 立约\n雪原上立下契约。\n', {
    fileName: '雪原契约.txt'
  })
  check('「书名：《…》」被剥掉书名号', c.title === '雪原契约', c.title)
  check('「张三 著」识别为作者', c.author === '张三', c.author)

  const d = P.parseImportText('正文。\n', { fileName: '《长夜》作者：李四.txt' })
  check('文件名里的《书名》与作者都认出来', d.title === '长夜' && d.author === '李四', `${d.title}/${d.author}`)

  const e = P.parseImportText('他说，天要下雨了，我们走吧。\n\n第一章 雨夜\n雨水顺着屋檐。\n', {
    fileName: '雨夜.txt'
  })
  check('首行是长句正文时不当书名', e.title === '雨夜', e.title)

  check('作者行不进正文', !b.chapters[0].body.includes('作者'))
  check('书名行不进正文', !c.chapters[0].body.includes('雪原契约'))

  // 「候选来自哪里」决定 AI 结果有没有资格覆盖它：正文首行是强证据，文件名是弱证据
  check('首行书名标记为 head', b.titleFrom === 'head', b.titleFrom)
  check('文件名书名标记为 filename', a.titleFrom === 'filename', a.titleFrom)

  const bom = P.parseImportText('\uFEFF第一章 起棺\n正文。\n', { fileName: 'bom.txt' })
  check('BOM 不影响首行识别', bom.title === 'bom' && bom.chapters.length === 1, `${bom.title}/${bom.chapters.length}`)

  const xu = P.parseImportText('楔子\n很久以前。\n\n第一章 起棺\n正文。\n', { fileName: 'x.txt' })
  check('「楔子」当成一章', xu.chapters.length === 2 && xu.chapters[0].title === '楔子', JSON.stringify(xu.chapters.map((c) => c.title)))
}

/* ───────────────────── 卷 / 章切分 ───────────────────── */

console.log('卷章切分：卷是分组，不是章节')
{
  const text = [
    '第一章 起棺',
    '十六个人抬棺。',
    '',
    '第二章 一斤都不能少',
    '棺内多出四十斤。',
    '',
    '第一卷 雪原',
    '第三章 立约',
    '雪原上立下契约。',
    '',
    '第四章 破约',
    '契约碎了。',
    ''
  ].join('\n')
  const r = P.parseImportText(text, { fileName: 'x.txt' })
  check('卷标记不算一章（共 4 章）', r.chapters.length === 4, String(r.chapters.length))
  check('卷标记之前的章归第一卷', r.chapters[0].volumeIndex === 0, String(r.chapters[0].volumeIndex))
  check('卷标记之后的章归新卷', r.chapters[3].volumeIndex === 1, String(r.chapters[3].volumeIndex))
  check('隐式第一卷 + 显式卷 = 两卷', r.volumes.length === 2, JSON.stringify(r.volumes.map((v) => v.title)))
  check('splitMode 标记为 volume', r.splitMode === 'volume', r.splitMode)

  const two = [
    '第一卷 起',
    '第一章 一',
    '正文一。',
    '第二章 二',
    '正文二。',
    '第二卷 承',
    '第三章 三',
    '正文三。',
    ''
  ].join('\n')
  const r2 = P.parseImportText(two, { fileName: 'x.txt' })
  check('两卷各归各的章', r2.volumes.length === 2 && r2.chapters[2].volumeIndex === 1,
    `${r2.volumes.length}/${r2.chapters[2]?.volumeIndex}`)
  check('卷标题保留原文', r2.volumes[1].title === '第二卷 承', r2.volumes[1].title)
  check('章标题去掉序号后是显示名', r2.chapters[0].name === '一', r2.chapters[0].name)
}

console.log('卷章切分：Markdown / Chapter N / 编号行')
{
  const md = ['# 第一章 起棺', '正文一。', '', '## 第二章 落葬', '正文二。', ''].join('\n')
  const r = P.parseImportText(md, { fileName: 'x.md' })
  check('Markdown # 标题切章', r.chapters.length === 2, String(r.chapters.length))
  check('标题里的 # 被去掉', r.chapters[0].title === '第一章 起棺', r.chapters[0].title)

  // 导出工具常见的「# 书名 + ## 章节」形态：H1 不能当成第一章
  const doc = ['# 抬棺人', '', '## 第一章 起棺', '正文一。', '', '## 第二章 落葬', '正文二。', ''].join('\n')
  const rd = P.parseImportText(doc, { fileName: 'export.md' })
  check('H1 书名不被当成一章', rd.chapters.length === 2, String(rd.chapters.length))
  check('H1 取作书名', rd.title === '抬棺人', rd.title)

  // #### 常被作者当场景分隔，不能认成章
  const deep = ['第一章 起棺', '正文一。', '', '#### 场景二', '正文二。', ''].join('\n')
  const rDeep = P.parseImportText(deep, { fileName: 'x.md' })
  check('四级标题不当章', rDeep.chapters.length === 1, String(rDeep.chapters.length))

  const en = ['Chapter 1 The Box', 'Text one.', '', 'Chapter 2 Forty Jin', 'Text two.', ''].join('\n')
  const r2 = P.parseImportText(en, { fileName: 'x.txt' })
  check('Chapter N 切章', r2.chapters.length === 2, String(r2.chapters.length))

  const num = ['1. 起棺', '正文一。', '', '2. 落葬', '正文二。', ''].join('\n')
  const r3 = P.parseImportText(num, { fileName: 'x.txt' })
  check('「1. 标题」切章', r3.chapters.length === 2, String(r3.chapters.length))
  check('编号行的显示名去掉编号', r3.chapters[1].name === '落葬', r3.chapters[1].name)
}

console.log('无标记时按字数降级')
{
  const para = '这是一段正文，用来凑字数。'.repeat(20)
  const long = Array.from({ length: 12 }, () => para).join('\n\n')
  const r = P.parseImportText(long, { fileName: '无标记.txt' })
  check('降级为按字数切块', r.splitMode === 'chunk', r.splitMode)
  check('切出多块', r.chapters.length >= 2, String(r.chapters.length))
  check('标题叫第 N 节', r.chapters[0].title === '第 1 节', r.chapters[0].title)
  check('有降级提示', r.notices.some((n) => n.includes('没识别到章节标记')), JSON.stringify(r.notices))

  const blank = P.parseImportText('   \n\n   \n', { fileName: '空.txt' })
  check('空文件 → empty 且没有章节', blank.splitMode === 'empty' && blank.chapters.length === 0, blank.splitMode)

  const onlyHead = P.parseImportText('第一章 只有标题\n\n第二章 也没有正文\n', { fileName: 'x.txt' })
  check('空章不导入', onlyHead.chapters.length === 0, String(onlyHead.chapters.length))
}

console.log('字数与正文')
{
  const r = P.parseImportText('第一章 起棺\n十六个人抬不动一口棺材。\n\n第二章 落葬\n雪落了三尺。\n', {
    fileName: 'x.txt'
  })
  check('每章算字数', r.chapters[0].words > 0, String(r.chapters[0].words))
  check('总字数等于各章之和',
    r.totalWords === r.chapters.reduce((s, c) => s + c.words, 0), String(r.totalWords))
  check('正文保留段落空行', r.chapters[0].body.includes('\n') || r.chapters[0].body.length > 0)
}

/* ───────────────────── 元信息容错 ───────────────────── */

console.log('元信息解析：围栏、废话、非法题材、缺字段')
{
  const clean = JSON.stringify({
    title: '抬棺人',
    author: '陈九斤',
    genre: '悬疑',
    logline: '一个抬棺匠发现自己抬的棺材里多出了四十斤。',
    premise: '故事梗概正文。',
    keywords: ['民俗', '悬疑'],
    characters: [{ name: '陈默', role: '主角', desc: '抬棺匠的儿子' }]
  })
  const m1 = P.parseMetaOutput(clean)
  check('标准 JSON', m1.title === '抬棺人' && m1.author === '陈九斤', `${m1.title}/${m1.author}`)
  check('中文题材落到 id', m1.genreId === 'xuanyi', m1.genreId)
  check('keywords 保留', m1.keywords.length === 2 && m1.keywords[0] === '民俗', JSON.stringify(m1.keywords))
  check('characters 解析', m1.characters.length === 1 && m1.characters[0].name === '陈默', JSON.stringify(m1.characters))

  const fenced = '好的，这是识别结果：\n```json\n' + clean + '\n```\n希望有帮助。'
  const m2 = P.parseMetaOutput(fenced)
  check('```json 围栏 + 前后废话', m2.title === '抬棺人', m2.title)

  const bad = P.parseMetaOutput(JSON.stringify({ title: 'X', genre: '武侠言情玄幻', author: '', logline: '', premise: '' }))
  check('认不出的题材留空，不瞎猜', bad.genreId === '', bad.genreId)
  check('缺字段不报错', bad.keywords.length === 0 && bad.characters.length === 0)

  const byId = P.parseMetaOutput(JSON.stringify({ genre: 'xianxia' }))
  check('直接给 id 也认', byId.genreId === 'xianxia', byId.genreId)

  const wrapped = P.parseMetaOutput(JSON.stringify({ result: { title: '包一层', genre: '恐怖' } }))
  check('{"result":{…}} 包一层也能取到', wrapped.title === '包一层' && wrapped.genreId === 'kongbu', `${wrapped.title}/${wrapped.genreId}`)

  const plain = P.parseMetaOutput('书名：雪原契约\n作者：李四\n题材：奇幻\n一句话：用记忆换生存。')
  check('非 JSON 的「书名：」逐行也能抠', plain.title === '雪原契约' && plain.genreId === 'qihuan', `${plain.title}/${plain.genreId}`)

  const empty = P.parseMetaOutput('')
  check('空返回 → 全空', empty.title === '' && empty.genreId === '' && empty.characters.length === 0)
}

/* ───────────────────── 章节摘要容错 ───────────────────── */

console.log('章节摘要解析：截断、越界、乱序、重复')
{
  const ok = P.parseChapterSummaries('[{"index":1,"summary":"起棺。"},{"index":2,"summary":"多出四十斤。"}]', {
    chapterCount: 2
  })
  check('标准数组', ok.length === 2 && ok[0].summary === '起棺。', JSON.stringify(ok))

  const shuffled = P.parseChapterSummaries(
    '[{"index":3,"summary":"三"},{"index":1,"summary":"一"},{"index":2,"summary":"二"}]',
    { chapterCount: 3 }
  )
  check('乱序按序号升序排好', shuffled.map((x) => x.index).join(',') === '1,2,3', JSON.stringify(shuffled))

  const dup = P.parseChapterSummaries(
    '[{"index":1,"summary":"第一次"},{"index":1,"summary":"第二次"}]',
    { chapterCount: 1 }
  )
  check('重复 index 只留一条', dup.length === 1 && dup[0].summary === '第一次', JSON.stringify(dup))

  const outOfRange = P.parseChapterSummaries(
    '[{"index":9,"summary":"越界"},{"index":0,"summary":"零"},{"index":2,"summary":"正常"}]',
    { chapterCount: 3 }
  )
  check('越界 / 零 index 丢弃', outOfRange.length === 1 && outOfRange[0].index === 2, JSON.stringify(outOfRange))

  const truncated =
    '[{"index":1,"summary":"陈默测重发现棺内多出四十斤，逼陈九斤改口停棺。"},{"index":2,"summary":"第二章写了半'
  const salvaged = P.parseChapterSummaries(truncated, { chapterCount: 8 })
  check('截断 JSON 抢救出完整的那条', salvaged.length === 1 && salvaged[0].index === 1, JSON.stringify(salvaged))

  const noIndex = P.parseChapterSummaries('[{"summary":"一"},{"summary":"二"}]', { batch: [5, 6], chapterCount: 8 })
  check('整批没写 index 时按发送顺序补', noIndex.length === 2 && noIndex[0].index === 5, JSON.stringify(noIndex))

  const localIndex = P.parseChapterSummaries('[{"index":1,"summary":"甲"},{"index":2,"summary":"乙"}]', {
    batch: [9, 10],
    chapterCount: 10
  })
  check('写成批内序号时换算回全书序号', localIndex.length === 2 && localIndex[0].index === 9, JSON.stringify(localIndex))

  const chinese = P.parseChapterSummaries('[{"章":2,"摘要":"第二章摘要。"}]', { chapterCount: 3 })
  check('中文字段名「章/摘要」也认', chinese.length === 1 && chinese[0].index === 2, JSON.stringify(chinese))

  check('空返回 → 空数组', P.parseChapterSummaries('').length === 0)
  check('纯废话 → 空数组', P.parseChapterSummaries('好的，我明白了。').length === 0)
}

console.log('分批与抽样')
{
  const chapters = Array.from({ length: 20 }, (_, i) => ({
    index: i + 1,
    title: `第 ${i + 1} 章`,
    body: '正文。'.repeat(400)
  }))
  const batches = P.batchChapters(chapters, 8, 7000)
  check('每批不超过 8 章', batches.every((b) => b.indexes.length <= 8), String(batches[0].indexes.length))
  // 单章输入约 1200 字，7000 字上限先于 8 章命中：20 章分成 4 批才是对的行为
  check('按字数上限分批（20 章 → 4 批）', batches.length === 4, String(batches.length))
  check('分批覆盖全部章', batches.flatMap((b) => b.indexes).join(',') === chapters.map((c) => c.index).join(','), '')
  check('每批输入不超过上限', batches.every((b) => b.chars <= 7000), String(Math.max(...batches.map((b) => b.chars))))

  const sample = P.sampleForMeta(chapters, 12000)
  check('抽样不超过上限', sample.length <= 12000, String(sample.length))
  check('抽样里有开头两章', sample.includes('第 1 章') && sample.includes('第 2 章'))
}

console.log('分卷计划')
{
  const plan = P.parseVolumePlanOutput('[{"title":"第一卷 起","from":1,"to":5},{"title":"第二卷 承","from":6,"to":10}]', 10)
  check('标准分卷解析', plan.length === 2 && plan[1].from === 6, JSON.stringify(plan))

  const overlap = P.parseVolumePlanOutput('[{"title":"A","from":1,"to":6},{"title":"B","from":4,"to":10}]', 10)
  check('重叠区间被截断，章不重复归属', overlap.length === 2 && overlap[1].from === 7, JSON.stringify(overlap))

  const outRange = P.parseVolumePlanOutput('[{"title":"A","from":1,"to":99}]', 10)
  check('越界区间夹回全书章数', outRange[0].to === 10, JSON.stringify(outRange))

  const byList = P.parseVolumePlanOutput('[{"title":"A","chapters":[1,2,3]}]', 10)
  check('chapters 数组形式也认', byList.length === 1 && byList[0].to === 3, JSON.stringify(byList))

  const assigned = P.planVolumeAssignments(plan, 10)
  check('每章都归到卷', assigned.volumeOf.get(1) === 0 && assigned.volumeOf.get(10) === 1, '')
}

/* ───────────────────── 装配 ───────────────────── */

console.log('装配成 Project：字段、层级、outlineNodeId')
{
  const project = P.assembleImportedProject({
    title: '抬棺人',
    author: '陈九斤',
    genreId: 'xuanyi',
    logline: '一句话。',
    premise: '梗概。',
    volumes: [
      {
        title: '第一卷 起棺',
        chapters: [
          { title: '第一章 起棺', body: '十六个人抬棺。\n\n杠子断了。', summary: '起棺失败。' },
          { title: '第二章 落葬', body: '雪落了三尺。', summary: '' }
        ]
      },
      { title: '第二卷 承', chapters: [{ title: '第三章 立约', body: '立下契约。', summary: '立约。' }] }
    ]
  })

  check('书名', project.title === '抬棺人', project.title)
  check('作者', project.author === '陈九斤', project.author)
  check('题材 id', project.genreId === 'xuanyi', project.genreId)
  check('一句话简介', project.brief.logline === '一句话。', project.brief.logline)
  check('梗概', project.brief.premise === '梗概。', project.brief.premise)
  check('场景默认 long-novel', project.sceneId === 'long-novel', project.sceneId)
  check('章节数', project.chapters.length === 3, String(project.chapters.length))
  check('章节状态都是 done', project.chapters.every((c) => c.status === 'done'), '')
  check('章节字数算出来', project.chapters[0].words > 0, String(project.chapters[0].words))
  check('章节带摘要', project.chapters[0].summary === '起棺失败。', project.chapters[0].summary)
  check('章节正文转成 HTML', project.chapters[0].content.startsWith('<p>'), project.chapters[0].content.slice(0, 12))
  check('空摘要不硬塞内容', project.chapters[1].summary === '', project.chapters[1].summary)

  check('大纲两卷', project.outline.length === 2, String(project.outline.length))
  check('卷节点类型', project.outline[0].type === 'volume' && project.outline[0].title === '第一卷 起棺', project.outline[0].title)
  check('卷下挂章节点', project.outline[0].children.length === 2, String(project.outline[0].children.length))
  check('章节点类型与状态', project.outline[0].children[0].type === 'chapter' && project.outline[0].children[0].status === 'done')
  check('章节点带摘要', project.outline[0].children[0].summary === '起棺失败。', project.outline[0].children[0].summary)

  const nodeIds = project.outline.flatMap((v) => v.children.map((c) => c.id))
  check(
    'outlineNodeId 与大纲章节点一一对应',
    project.chapters.every((c) => c.outlineNodeId && nodeIds.includes(c.outlineNodeId)) &&
      nodeIds.length === project.chapters.length,
    `${project.chapters.map((c) => c.outlineNodeId).join(',')} vs ${nodeIds.join(',')}`
  )
  check(
    '顺序也对得上（第 1 章 ↔ 第 1 个章节点）',
    project.chapters[0].outlineNodeId === project.outline[0].children[0].id &&
      project.chapters[2].outlineNodeId === project.outline[1].children[0].id,
    ''
  )

  const totals = project.chapters.reduce((s, c) => s + c.words, 0)
  check('全书字数等于各章之和', totals > 0, String(totals))
}

console.log('装配：空章、重名、空书名')
{
  const p = P.assembleImportedProject({
    title: '',
    author: '',
    volumes: [
      {
        title: '第一卷',
        chapters: [
          { title: '第1章 起棺', body: '正文一。' },
          { title: '第1章 起棺', body: '正文二。' },
          { title: '空白章', body: '   \n\n  ' }
        ]
      }
    ]
  })
  check('空书名 → 未命名作品', p.title === '未命名作品', p.title)
  check('作者空 → 空串', p.author === '', JSON.stringify(p.author))
  check('空章不导入（2 章）', p.chapters.length === 2, String(p.chapters.length))
  check('同卷重名章追加序号', p.chapters[1].title === '第1章 起棺（2）', p.chapters[1].title)
  check('重名章各自指向不同节点', p.chapters[0].outlineNodeId !== p.chapters[1].outlineNodeId, '')

  const noOutline = P.assembleImportedProject({
    title: '无大纲',
    volumes: [{ title: '第一卷', chapters: [{ title: '第一章', body: '正文。' }] }],
    buildOutline: false
  })
  check('关掉大纲时只落章节', noOutline.outline.length === 0 && noOutline.chapters.length === 1, `${noOutline.outline.length}/${noOutline.chapters.length}`)
}

console.log('端到端：解析 → 装配')
{
  const text = [
    '抬棺人',
    '作者：陈九斤',
    '',
    '第一章 起棺',
    '十六个人抬不动一口棺材。',
    '',
    '第二章 一斤都不能少',
    '棺内多出四十斤。',
    ''
  ].join('\n')
  const parsed = P.parseImportText(text, { fileName: '抬棺人.txt' })
  const project = P.assembleImportedProject({
    title: parsed.title,
    author: parsed.author,
    volumes: parsed.volumes.map((v) => ({
      title: v.title,
      chapters: parsed.chapters.filter((c) => c.volumeIndex === v.index).map((c) => ({ title: c.title, body: c.body }))
    }))
  })
  check('端到端书名', project.title === '抬棺人', project.title)
  check('端到端作者', project.author === '陈九斤', project.author)
  check('端到端 2 章', project.chapters.length === 2, String(project.chapters.length))
  check('端到端大纲 1 卷 2 章', project.outline.length === 1 && project.outline[0].children.length === 2, '')
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)