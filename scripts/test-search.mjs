#!/usr/bin/env node
/**
 * 搜索逻辑的回归测试。
 *
 * 和 test-textcraft.mjs 一样，直接 esbuild 打包真实的 search.ts 再 import，
 * 而不是把逻辑抄一份到测试里——抄一份只会测到抄错的那份。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(mkdtempSync(join(tmpdir(), 'search-')), 'search.mjs')
await build({
  entryPoints: ['src/renderer/lib/search.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
  alias: { '@shared': './src/shared' }
})
const mod = await import(pathToFileURL(out).href)
const { searchInChapter, searchBook, groupByChapter, chapterToPlain, paragraphIndexAt, plainOffsetToPos, countByChapter } = mod

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`)
  }
}

/** 造一章：段落用数组给 */
const mk = (title, paras) => ({
  id: 'c_' + title,
  title,
  content: paras.map((p) => `<p>${p}</p>`).join('')
})

const ch1 = mk('第一章', ['周砚秋走进邮局。', '她把信按在胸口，手心全是汗。', '这是第七十三封。'])
const ch2 = mk('第二章', ['邮局的门在她身后合拢。', '风把信封吹得哗哗响。'])

console.log('基础命中')
{
  const hits = searchInChapter(ch1, '邮局')
  check('找到 1 处', hits.length === 1, `实际 ${hits.length}`)
  check('命中文本正确', hits[0]?.match === '邮局', hits[0]?.match)
  check('带章节标题', hits[0]?.chapterTitle === '第一章', hits[0]?.chapterTitle)
  check('前文上下文含上一句', hits[0]?.before.includes('周砚秋走进'), hits[0]?.before)
}

console.log('多处命中')
{
  // 这一章里「信」只出现一次；要测多处命中就得用真出现多次的字
  const hits = searchInChapter(ch1, '信')
  check('单次命中不重复计数', hits.length === 1, `实际 ${hits.length}`)
  const many = searchInChapter(mk('多', ['信在桌上。', '信被撕了。', '她把信烧了。']), '信')
  check('多处命中全找到', many.length === 3, `实际 ${many.length}`)
  const ids = new Set(hits.map((h) => h.id))
  check('id 各不相同', ids.size === hits.length)
}

console.log('跨章分组')
{
  const proj = { chapters: [ch1, ch2] }
  const hits = searchBook(proj, '邮局')
  check('全书找到 2 处', hits.length === 2, `实际 ${hits.length}`)
  const groups = groupByChapter(hits, proj)
  check('分成 2 组', groups.length === 2, `实际 ${groups.length}`)
  check('按书里顺序排', groups[0].chapterId === ch1.id && groups[1].chapterId === ch2.id)
  const counts = countByChapter(hits)
  check('按章计数', counts[ch1.id] === 1 && counts[ch2.id] === 1, JSON.stringify(counts))
}

console.log('空查询与空正文')
{
  check('空查询不返回全部', searchInChapter(ch1, '').length === 0)
  check('纯空格查询不返回', searchInChapter(ch1, '   ').length === 0)
  check('空正文安全', searchInChapter(mk('空', []), '信').length === 0)
  const proj = { chapters: [ch1] }
  check('全书空查询不返回', searchBook(proj, '').length === 0)
}

console.log('大小写')
{
  const c = mk('英文', ['Hello World，hello world。'])
  check('默认不区分大小写', searchInChapter(c, 'hello').length === 2, String(searchInChapter(c, 'hello').length))
  check('可开区分大小写', searchInChapter(c, 'hello', { caseSensitive: true }).length === 1, String(searchInChapter(c, 'Hello', { caseSensitive: true }).length))
}

console.log('正则元字符按字面处理')
{
  const c = mk('符号', ['价格是 3.14 元。', '他写了 a*b 当例子。', '注（见上）这里有个括号。'])
  check('点号当字面', searchInChapter(c, '3.14').length === 1, String(searchInChapter(c, '3.14').length))
  check('点号不误匹配任意字', searchInChapter(mk('x', ['3X14']), '3.14').length === 0)
  check('星号当字面', searchInChapter(c, 'a*b').length === 1, String(searchInChapter(c, 'a*b').length))
  check('全角括号当字面', searchInChapter(c, '（见上）').length === 1, String(searchInChapter(c, '（见上）').length))
  check('半角括号当字面', searchInChapter(mk('h', ['see (note) here']), '(').length === 1)
  check('不因未闭合结构崩掉', Array.isArray(searchInChapter(c, '[')))
}

console.log('偏移与段落序号')
{
  const plain = chapterToPlain(ch1.content)
  check('段落以换行相连', plain.includes('\n'), JSON.stringify(plain))
  const hits = searchInChapter(ch1, '七十三')
  const h = hits[0]
  check('偏移切出的正是命中词', plain.slice(h.start, h.end) === '七十三', plain.slice(h.start, h.end))
  // 三句话分别是第 0、1、2 段，「第七十三封」在第 2 段
  check('段落序号指向最后一段', h.paragraphIndex === 2, String(h.paragraphIndex))
  check('段落序号能区分前两段', searchInChapter(ch1, '邮局')[0].paragraphIndex === 0)
  check('paragraphIndexAt 从 0 起算', paragraphIndexAt(plain, 0) === 0)
}

console.log('偏移映射回编辑器位置')
{
  // 模拟编辑器里三段，位置编号：块起点各占 1 格
  const blocks = [
    { textStart: 0, textEnd: 4, posStart: 1 },
    { textStart: 5, textEnd: 9, posStart: 7 },
    { textStart: 10, textEnd: 15, posStart: 14 }
  ]
  check('段首映射', plainOffsetToPos(blocks, 0) === 1, String(plainOffsetToPos(blocks, 0)))
  check('第二段内偏移', plainOffsetToPos(blocks, 6) === 8, String(plainOffsetToPos(blocks, 6)))
  check('越界返回 -1', plainOffsetToPos(blocks, 99) === -1)
}

console.log('整词匹配')
{
  const c = mk('整词', ['cats and cat，cart。'])
  // "cats" 里没有独立的 cat 子串，"cat" 和 "cart" 各一处
  check('默认会匹配子串', searchInChapter(c, 'cat').length === 2, String(searchInChapter(c, 'cat').length))
  check('整词只匹配独立词', searchInChapter(c, 'cat', { wholeWord: true }).length === 1, String(searchInChapter(c, 'cat', { wholeWord: true }).length))
}

console.log('上限保护')
{
  const big = mk('长章', [('信'.repeat(5000) + '。')])
  const hits = searchInChapter(big, '信')
  check('不超过 2000 条', hits.length <= 2000, String(hits.length))
  check('确实截断而不是死循环', hits.length === 2000, String(hits.length))
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)