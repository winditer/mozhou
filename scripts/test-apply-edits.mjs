/**
 * 对话改稿的定位与应用（纯函数）回归测试。
 * 运行：node scripts/test-apply-edits.mjs
 *
 * 要守住的是「改稿这件事的最小伤害原则」：
 *   - 定位不到 / 命中多处 → 一个字都不许改（这是本功能唯一不可逆的地方）；
 *   - 命中一处 → 只动那一段，前后段落逐字不变；
 *   - 同段被两条 op 点名 → 只认第一条，不许把段落拼坏。
 *
 * applyResolved 是纯函数，这里直接拿真正的实现（esbuild 打包后 require）跑，
 * 不用起 Electron。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outdir = mkdtempSync(join(tmpdir(), 'mozhou-apply-edits-test-'))
const outfile = join(outdir, 'applyEdits.mjs')

await build({
  entryPoints: [join(root, 'src/renderer/lib/applyEdits.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(root, 'src/shared') }
})
const { resolveEdits, applyResolved } = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

const P = (...ps) => ps.map((p) => `<p>${p}</p>`).join('')

/** 一本最小的书：三章正文 + 二层大纲 + 五类设定各一条 */
function makeProject() {
  return {
    id: 'p1',
    title: '测试书',
    chapters: [
      {
        id: 'c1',
        title: '第1章 起点',
        content: P('雨下了一夜。', '他把伞合上，转身就走。', '街角的路灯忽明忽暗。'),
        summary: '旧梗概一',
        words: 30,
        status: 'draft',
        targetWords: 2500,
        createdAt: 1,
        updatedAt: 1,
        versions: []
      },
      {
        id: 'c2',
        title: '第2章 老槐树',
        content: P('母亲说父亲是被换走的。', '父亲的抽屉里有一把钥匙。'),
        summary: '旧梗概二',
        words: 20,
        status: 'draft',
        targetWords: 2500,
        createdAt: 1,
        updatedAt: 1,
        versions: []
      },
      {
        id: 'c3',
        title: '第3章 她把最后一封信烧了',
        content: `<h1>第3章 她把最后一封信烧了</h1>${P(
          '邮局的玻璃门在身后合拢。',
          '第七十三封信寄往一个早已无人居住的地址。',
          '父亲的信封上写着自己的名字。'
        )}`,
        summary: '',
        words: 40,
        status: 'planning',
        targetWords: 2500,
        createdAt: 1,
        updatedAt: 1,
        versions: []
      }
    ],
    outline: [
      {
        id: 'v1',
        title: '第一卷',
        summary: '卷首',
        type: 'volume',
        status: 'writing',
        children: [
          { id: 'n1', title: '开端', summary: '旧情节点', type: 'chapter', status: 'planned', children: [] }
        ]
      }
    ],
    bible: {
      characters: [
        {
          id: 'ch1',
          name: '林昭',
          role: '主角',
          age: '二十七',
          identity: '',
          appearance: '',
          personality: '',
          motivation: '',
          flaw: '',
          arc: '',
          speechStyle: '',
          relations: [],
          hidden: false,
          notes: ''
        }
      ],
      world: [],
      terms: [],
      timeline: [],
      threads: []
    },
    brief: { logline: '', premise: '', keywords: [] }
  }
}

const chapterOf = (p, id) => p.chapters.find((c) => c.id === id)
const textsOf = (p, id) => chapterOf(p, id).content.replace(/<[^>]+>/g, '|')

/* ── 1. 精确命中：只动那一段 ── */
console.log('精确命中')
{
  const p = makeProject()
  const [e] = resolveEdits(p, [
    { op: 'replace_paragraph', chapter: '第1章', anchor: '他把伞合上，转身就走。', after: '他把伞合上，却没走。' }
  ])
  check('状态 found', e.status === 'found', e.status)
  check('段号是第 2 段（下标 1）', e.paragraphIndex === 1, String(e.paragraphIndex))
  check('改前是原段落', e.before === '他把伞合上，转身就走。', e.before)
  check('标签带章名与段号', e.label.includes('第1章') && e.label.includes('第 2 段'), e.label)

  const next = applyResolved(p, [e])
  check('目标段被替换', chapterOf(next, 'c1').content.includes('他把伞合上，却没走。'))
  check('前一段逐字不变', chapterOf(next, 'c1').content.includes('<p>雨下了一夜。</p>'), textsOf(next, 'c1'))
  check('后一段逐字不变', chapterOf(next, 'c1').content.includes('<p>街角的路灯忽明忽暗。</p>'))
  check('别的章没被动', chapterOf(next, 'c2').content === chapterOf(p, 'c2').content)
  check('原项目未被就地修改', chapterOf(p, 'c1').content.includes('转身就走'))
}

/* ── 2. 忽略空白与标点差异 ── */
console.log('归一化匹配')
{
  const p = makeProject()
  const [e] = resolveEdits(p, [
    { op: 'replace_paragraph', chapter: 'c2', anchor: '母亲说，父亲是被换走的', after: '母亲说，父亲是自己走的。' }
  ])
  check('标点差异仍能定位', e.status === 'found', e.status)
  check('按 id 也能找到章', e.chapterId === 'c2', String(e.chapterId))
}

/* ── 3. 找不到 / 命中多处 ── */
console.log('找不到与歧义')
{
  const p = makeProject()
  const [miss] = resolveEdits(p, [
    { op: 'replace_paragraph', chapter: '第1章', anchor: '这句话根本不在正文里', after: 'x' }
  ])
  check('找不到 → not-found', miss.status === 'not-found', miss.status)
  check('找不到时说明白', Boolean(miss.note?.includes('没找到')), miss.note)
  const after = applyResolved(p, [miss])
  check('not-found 不产生任何改动', after.chapters.every((c, i) => c.content === p.chapters[i].content))

  const dup = makeProject()
  dup.chapters[0].content = P('他走了。', '中间一段。', '他走了。')
  const [amb] = resolveEdits(dup, [{ op: 'replace_paragraph', chapter: '第1章', anchor: '他走了。', after: '他留下了。' }])
  check('命中多处 → ambiguous', amb.status === 'ambiguous', amb.status)
  check('列出所有命中段号', JSON.stringify(amb.hits) === '[1,3]', JSON.stringify(amb.hits))
  const after2 = applyResolved(dup, [amb])
  check('ambiguous 不产生任何改动', after2.chapters[0].content === dup.chapters[0].content)

  const [noChap] = resolveEdits(p, [{ op: 'replace_paragraph', chapter: '第99章', anchor: 'x', after: 'y' }])
  check('章节不存在 → not-found', noChap.status === 'not-found', noChap.status)
  check('章节不存在时给提示', Boolean(noChap.note), noChap.note)
}

/* ── 3b. 报错章节：按逐字匹配捞回来（真实用户踩到的场景） ── */
console.log('章节报错时的兜底')
{
  const p = makeProject()
  // AI 说「第 3 章」，但引的是第 2 章的原文——实际使用中最常见的一种错
  const [e] = resolveEdits(p, [
    { op: 'replace_paragraph', chapter: '第3章', anchor: '父亲的抽屉里有一把钥匙。', after: '抽屉里只有一把断掉的门闩。' }
  ])
  check('在真正的章里找到了', e.status === 'found', e.status)
  check('改到了第 2 章', e.chapterId === 'c2', String(e.chapterId))
  check('标了章节已修正', e.chapterCorrected === true, String(e.chapterCorrected))
  check('说明里讲清了章号对不上', Boolean(e.note?.includes('第2章 老槐树') && e.note.includes('第3章')), e.note)
  const n = applyResolved(p, [e])
  check('改的是第 2 章正文', chapterOf(n, 'c2').content.includes('断掉的门闩'), textsOf(n, 'c2'))
  check('报错的那一章没被动', chapterOf(n, 'c3').content === chapterOf(p, 'c3').content)

  // 全书多处都能对上 → 只标歧义，绝不挑一个
  const dup = makeProject()
  dup.chapters[0].content = P('雨下了一夜。', '他走了。')
  dup.chapters[1].content = P('他走了。')
  const [amb] = resolveEdits(dup, [{ op: 'replace_paragraph', chapter: '第3章', anchor: '他走了。', after: 'x' }])
  check('跨章多处命中 → ambiguous', amb.status === 'ambiguous', amb.status)
  check('歧义里列出了候选章', Boolean(amb.note?.includes('第1章') && amb.note?.includes('第2章')), amb.note)
  check('歧义不产生改动', applyResolved(dup, [amb]).chapters[1].content === dup.chapters[1].content)

  // 章号整个对不上（书里只有 3 章，AI 写了第 30 章），但原文唯一
  const [far] = resolveEdits(p, [{ op: 'replace_paragraph', chapter: '第30章', anchor: '雨下了一夜。', after: '雪下了一夜。' }])
  check('章号不存在但原文唯一 → 也能定位', far.status === 'found', far.status)
  check('同样标了章节已修正', far.chapterCorrected === true, String(far.chapterCorrected))
}

/* ── 3c. after 里换行应当分段 ── */
console.log('多段改写不合并')
{
  const p = makeProject()
  const [e] = resolveEdits(p, [
    { op: 'replace_paragraph', chapter: '第1章', anchor: '雨下了一夜。', after: '第一段。\n\n第二段。\n第三段。' }
  ])
  const n = applyResolved(p, [e])
  const c = chapterOf(n, 'c1').content
  check('分出三个段落', (c.match(/<p>/g) || []).length === 2 + 3, c)
  check('顺序正确', c.indexOf('第一段') < c.indexOf('第二段') && c.indexOf('第二段') < c.indexOf('第三段'))
  check('不再把换行压成空格', !c.includes('第一段。 第二段。'), c)
}

/* ── 4. 章标题不作为改写目标 ── */
console.log('标题段保护')
{
  const p = makeProject()
  const [e] = resolveEdits(p, [
    { op: 'replace_paragraph', chapter: '第3章', anchor: '第3章 她把最后一封信烧了', after: '换个标题' }
  ])
  check('章标题不会被当成正文段', e.status === 'not-found', `${e.status} ${e.paragraphIndex}`)
}

/* ── 5. 插入与删除 ── */
console.log('插入与删除')
{
  const p = makeProject()
  const [ins] = resolveEdits(p, [
    { op: 'insert_paragraph', chapter: '第1章', anchor: '雨下了一夜。', after: '屋檐还在滴水。' }
  ])
  check('插入定位到第 1 段', ins.paragraphIndex === 0, String(ins.paragraphIndex))
  check('插入的改前为空', ins.before === '', ins.before)
  const n1 = applyResolved(p, [ins])
  const order1 = n1.chapters[0].content.replace(/<\/?p>/g, '|')
  check('插入在目标段之后', order1.indexOf('雨下了一夜') < order1.indexOf('屋檐还在滴水'), order1)
  check('插入不吞掉原段', order1.includes('雨下了一夜。'))

  const [del] = resolveEdits(p, [{ op: 'delete_paragraph', chapter: '第1章', anchor: '街角的路灯忽明忽暗。' }])
  check('删除定位到第 3 段', del.paragraphIndex === 2, String(del.paragraphIndex))
  const n2 = applyResolved(p, [del])
  check('段落被删掉', !n2.chapters[0].content.includes('街角的路灯'), n2.chapters[0].content)
  check('其余两段还在', n2.chapters[0].content.includes('雨下了一夜') && n2.chapters[0].content.includes('他把伞合上'))
}

/* ── 6. 全书 / 单章纯文本替换 ── */
console.log('批量替换')
{
  const p = makeProject()
  const book = resolveEdits(p, [{ op: 'replace_literal', scope: 'book', from: '父亲', to: '大伯' }])
  check('全书命中三段', book.length === 3, `实际 ${book.length}`)
  check('跨两章', new Set(book.map((e) => e.chapterId)).size === 2, JSON.stringify(book.map((e) => e.chapterId)))
  const nb = applyResolved(p, book)
  check('第 2 章两处都换了', !chapterOf(nb, 'c2').content.includes('父亲') && chapterOf(nb, 'c2').content.includes('大伯'), textsOf(nb, 'c2'))
  check('第 3 章那一处也换了', chapterOf(nb, 'c3').content.includes('大伯的信封'), textsOf(nb, 'c3'))
  check('没命中的第 1 章逐字不变', chapterOf(nb, 'c1').content === chapterOf(p, 'c1').content)

  const one = resolveEdits(p, [{ op: 'replace_literal', scope: 'chapter', chapter: '第2章', from: '父亲', to: '大伯' }])
  check('单章范围只算这一章', one.length === 2 && one.every((e) => e.chapterId === 'c2'), JSON.stringify(one.map((e) => e.chapterId)))

  const none = resolveEdits(p, [{ op: 'replace_literal', scope: 'book', from: '不存在的人名', to: 'x' }])
  check('一处都没有 → not-found', none[0].status === 'not-found', none[0].status)
}

/* ── 7. 梗概与大纲 ── */
console.log('梗概与大纲')
{
  const p = makeProject()
  const edits = resolveEdits(p, [
    { op: 'set_chapter_summary', chapter: '第3章', after: '陈默发现钥匙对不上门。' },
    { op: 'set_outline_node', node: '开端', field: 'summary', after: '新情节点' },
    { op: 'set_outline_node', node: '第一卷', field: 'status', after: 'done' }
  ])
  check('三条都定位到', edits.every((e) => e.status === 'found'), JSON.stringify(edits.map((e) => e.status)))
  const n = applyResolved(p, edits)
  check('章节梗概被改写', chapterOf(n, 'c3').summary === '陈默发现钥匙对不上门。', chapterOf(n, 'c3').summary)
  check('子节点情节点被改写', n.outline[0].children[0].summary === '新情节点', n.outline[0].children[0].summary)
  check('卷状态被改写', n.outline[0].status === 'done', n.outline[0].status)
  check('正文一个字没动', n.chapters.every((c, i) => c.content === p.chapters[i].content))

  const [bad] = resolveEdits(p, [{ op: 'set_outline_node', node: '不存在的节点', field: 'title', after: 'x' }])
  check('节点找不到 → not-found', bad.status === 'not-found', bad.status)
}

/* ── 7b. 新增大纲节点 ── */
console.log('新增大纲节点')
{
  const p = makeProject()
  const edits = resolveEdits(p, [
    { op: 'add_outline_node', title: '第4章 灰线', summary: '陈默在灰线上看见自己的名字', status: 'planned' },
    { op: 'add_outline_node', parent: '第一卷', title: '第5章 门', summary: '钥匙对不上' }
  ])
  check('两条都能定位', edits.every((e) => e.status === 'found'), JSON.stringify(edits.map((e) => e.status)))
  check('显示为新增条目', edits.every((e) => e.display === 'new-entry'), JSON.stringify(edits.map((e) => e.display)))
  const n = applyResolved(p, edits)
  const vol = n.outline[0]
  check('挂进了第一卷', vol.children.length === 3, JSON.stringify(vol.children.map((c) => c.title)))
  check('顺序按提交顺序', vol.children[1].title === '第4章 灰线' && vol.children[2].title === '第5章 门', JSON.stringify(vol.children.map((c) => c.title)))
  check('有独立 id', Boolean(vol.children[1].id) && vol.children[1].id !== vol.children[2].id)
  check('情节点写进去了', vol.children[1].summary === '陈默在灰线上看见自己的名字', vol.children[1].summary)
  check('状态默认 planned', vol.children[2].status === 'planned', vol.children[2].status)
  check('类型是章', vol.children[1].type === 'chapter', vol.children[1].type)
  check('原大纲未被就地修改', p.outline[0].children.length === 1)

  const [dup] = resolveEdits(p, [{ op: 'add_outline_node', title: '开端', summary: 'x' }])
  check('已有同名节点 → not-found', dup.status === 'not-found', dup.status)
  check('并说明该用 set_outline_node', Boolean(dup.note?.includes('set_outline_node')), dup.note)

  const [badParent] = resolveEdits(p, [{ op: 'add_outline_node', parent: '不存在的卷', title: '第9章' }])
  check('父节点不存在 → not-found', badParent.status === 'not-found', badParent.status)
}

/* ── 8. 设定库 ── */
console.log('设定库')
{
  const p = makeProject()
  const edits = resolveEdits(p, [
    { op: 'bible_upsert', collection: 'characters', name: '林昭', fields: { motivation: '查出那封信为什么没寄出', age: '二十八', role: '主角' } },
    { op: 'bible_upsert', collection: 'characters', name: '陈默', fields: { role: '配角', motivation: '守住钥匙' } },
    { op: 'bible_upsert', collection: 'world', name: '雾港', fields: { content: '终年不散的雾', category: 'world' } }
  ])
  check('已有角色改两个字段 → 展开成两条', edits.filter((e) => e.display === 'field' && e.entryName === '林昭').length === 2, JSON.stringify(edits.map((e) => e.label)))
  check('新角色是一条新增', edits.some((e) => e.display === 'new-entry' && e.entryName === '陈默'), JSON.stringify(edits.map((e) => e.display)))
  check('role 未变的那条不算改动', !edits.some((e) => e.fieldName === 'role'), JSON.stringify(edits.filter((e) => e.entryName === '林昭').map((e) => e.fieldName)))
  check('年龄也一起改', edits.some((e) => e.fieldName === 'age'), JSON.stringify(edits.filter((e) => e.entryName === '林昭').map((e) => e.fieldName)))

  const n = applyResolved(p, edits)
  const lin = n.bible.characters.find((c) => c.name === '林昭')
  check('林昭的动机被写入', lin.motivation === '查出那封信为什么没寄出', lin.motivation)
  const chen = n.bible.characters.find((c) => c.name === '陈默')
  check('新增角色有 id', Boolean(chen?.id), JSON.stringify(chen))
  check('新增角色字段齐全', chen.role === '配角' && chen.relations.length === 0, JSON.stringify(chen))
  check('新增世界观条目', n.bible.world.length === 1 && n.bible.world[0].title === '雾港', JSON.stringify(n.bible.world))
  check('世界观 visible 默认 true', n.bible.world[0].visible === true, String(n.bible.world[0].visible))

  const [same] = resolveEdits(p, [{ op: 'bible_upsert', collection: 'characters', name: '林昭', fields: { role: '主角' } }])
  check('值没变 → not-found（不产生空改动）', same.status === 'not-found', same.status)
}

/* ── 9. 同段两条 op 只认第一条 ── */
console.log('同段冲突')
{
  const p = makeProject()
  const edits = resolveEdits(p, [
    { op: 'replace_paragraph', chapter: '第1章', anchor: '雨下了一夜。', after: '第一版' },
    { op: 'replace_paragraph', chapter: '第1章', anchor: '雨下了一夜。', after: '第二版' }
  ])
  check('两条都被定位', edits.length === 2)
  const n = applyResolved(p, edits)
  check('只应用第一条', n.chapters[0].content.includes('第一版') && !n.chapters[0].content.includes('第二版'), n.chapters[0].content)
}

/* ── 10. 多章同时改：一次算完 ── */
console.log('多章同时改')
{
  const p = makeProject()
  const edits = resolveEdits(p, [
    { op: 'replace_paragraph', chapter: '第1章', anchor: '雨下了一夜。', after: '雪下了一夜。' },
    { op: 'replace_paragraph', chapter: '第2章', anchor: '父亲的抽屉里有一把钥匙。', after: '抽屉里什么也没有。' },
    { op: 'set_chapter_summary', chapter: '第2章', after: '新的梗概' }
  ])
  const n = applyResolved(p, edits)
  check('第 1 章改了', chapterOf(n, 'c1').content.includes('雪下了一夜'))
  check('第 2 章正文改了', chapterOf(n, 'c2').content.includes('抽屉里什么也没有'))
  check('第 2 章梗概改了', chapterOf(n, 'c2').summary === '新的梗概')
  check('第 3 章没动', chapterOf(n, 'c3').content === chapterOf(p, 'c3').content)
  check('空 edits 不炸', applyResolved(p, []) === p, '返回了不同对象')
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)