/**
 * 对话改稿协议（mz-edit）的回归测试。
 * 运行：node scripts/test-edit-protocol.mjs
 *
 * 要守住的是**校验器的宽严分寸**：
 *   - 宽：模型常在一轮里写对五条、写坏一条，坏的那条不许牵连其他五条；
 *   - 严：超量、非法的 op、缺字段、状态值写错，一律不许溜进应用层。
 * 另外要守住「取最后一个 mz-edit」——模型爱先给示例再给真指令，
 * 取错一个就是照着示例改了作者的稿子。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '../src/shared/editProtocol.ts')

const outdir = mkdtempSync(join(tmpdir(), 'mozhou-edit-protocol-test-'))
const outfile = join(outdir, 'editProtocol.mjs')
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile, logLevel: 'silent' })
const {
  MAX_EDITS,
  parseEditBlock,
  stripEditBlock,
  splitEditBlocks,
  validateOp,
  cnToNumber,
  chapterNumber,
  resolveChapterRef,
  resolveOutlineNode,
  renderEditPrompt,
  BIBLE_SCHEMA
} = await import(pathToFileURL(outfile).href)

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

const fence = (json) => '```mz-edit\n' + JSON.stringify(json) + '\n```'

/* ── 1. 正常解析 ── */
console.log('正常解析')
{
  const text = `这几处可以这样改：\n\n${fence({
    edits: [
      {
        op: 'replace_paragraph',
        chapter: '第3章',
        anchor: '他把伞合上，转身就走。',
        after: '他把伞合上，却没走。'
      }
    ]
  })}\n`
  const r = parseEditBlock(text)
  check('取出 1 条修改', r.ops.length === 1, `实际 ${r.ops.length}`)
  check('没有错误', r.errors.length === 0, r.errors.join(' | '))
  check('op 正确', r.ops[0]?.op === 'replace_paragraph', r.ops[0]?.op)
  check('anchor 原样保留', r.ops[0]?.anchor === '他把伞合上，转身就走。', r.ops[0]?.anchor)
  check('自然语言保留且不含围栏', r.text.includes('这几处可以这样改') && !r.text.includes('```'), r.text)
}

/* ── 2. 坏块与缺块 ── */
console.log('坏块与缺块')
{
  const broken = parseEditBlock('看这里\n```mz-edit\n{"edits":[{"op":"replace_paragraph"\n```\n')
  check('坏 JSON 有错误', broken.errors.length === 1, JSON.stringify(broken.errors))
  check('坏 JSON 不产出 op', broken.ops.length === 0)
  check('坏 JSON 仍保留自然语言', broken.text.includes('看这里'), broken.text)

  const noBlocks = parseEditBlock('只是聊了聊节奏问题，没有要改的东西。')
  check('没有围栏 → 0 op 0 error', noBlocks.ops.length === 0 && noBlocks.errors.length === 0)
  check('没有围栏 → 文本原样', noBlocks.text === '只是聊了聊节奏问题，没有要改的东西。', noBlocks.text)

  const noArray = parseEditBlock('```mz-edit\n{"foo":1}\n```')
  check('缺 edits 数组报错', noArray.errors.some((e) => e.includes('edits')), JSON.stringify(noArray.errors))
}

/* ── 3. 多围栏取最后一个 mz-edit ── */
console.log('多围栏取最后一个')
{
  const example = fence({ edits: [{ op: 'delete_paragraph', chapter: '第1章', anchor: '示例句' }] })
  const real = fence({
    edits: [{ op: 'replace_paragraph', chapter: '第2章', anchor: '真句子', after: '新的真句子' }]
  })
  const r = parseEditBlock(`先给你个格式示例：\n${example}\n\n按这个改：\n${real}`)
  check('只取一条', r.ops.length === 1, `实际 ${r.ops.length}`)
  check('取的是最后一个（真指令）', r.ops[0]?.chapter === '第2章', r.ops[0]?.chapter)
  const two = splitEditBlocks(`${example}\n${real}`)
  check('摘出的 json 是最后一块', two.json.includes('真句子'), two.json?.slice(0, 40))
}

/* ── 4. 逐条校验：坏一条不牵连其他 ── */
console.log('坏一条不牵连其他')
{
  const r = parseEditBlock(
    fence({
      edits: [
        { op: 'replace_paragraph', chapter: '第1章', anchor: 'a', after: 'b' },
        { op: 'replace_paragraph', chapter: '第1章' },
        { op: 'nonsense_op', chapter: '第1章' },
        { op: 'set_chapter_summary', chapter: '第1章', after: '新梗概' }
      ]
    })
  )
  check('留下 2 条合法 op', r.ops.length === 2, `实际 ${r.ops.length}`)
  check('报出 2 条错误', r.errors.length === 2, JSON.stringify(r.errors))
  check('错误带序号', r.errors[0].startsWith('第 2 条'), r.errors[0])
}

/* ── 5. 超量整轮拒收 ── */
console.log('超量整轮拒收')
{
  const many = Array.from({ length: MAX_EDITS + 1 }, (_, i) => ({
    op: 'delete_paragraph',
    chapter: '第1章',
    anchor: `第${i}句`
  }))
  const r = parseEditBlock(fence({ edits: many }))
  check('超量时 0 条落地', r.ops.length === 0, `实际 ${r.ops.length}`)
  check('超量有明确错误', r.errors.length === 1 && r.errors[0].includes(String(MAX_EDITS)), JSON.stringify(r.errors))

  const ok = parseEditBlock(fence({ edits: many.slice(0, MAX_EDITS) }))
  check(`刚好 ${MAX_EDITS} 条可通过`, ok.ops.length === MAX_EDITS, `实际 ${ok.ops.length}`)
}

/* ── 6. 各 op 的必填校验 ── */
console.log('必填校验')
{
  const cases = [
    [{ op: 'replace_paragraph', chapter: '第1章', anchor: 'a', after: 'b' }, true],
    [{ op: 'replace_paragraph', chapter: '第1章', anchor: 'a' }, false],
    [{ op: 'insert_paragraph', chapter: '第1章', anchor: 'a', after: 'b' }, true],
    [{ op: 'delete_paragraph', chapter: '第1章', anchor: 'a' }, true],
    [{ op: 'delete_paragraph', chapter: '第1章' }, false],
    [{ op: 'replace_literal', scope: 'book', from: '父亲', to: '大伯' }, true],
    [{ op: 'replace_literal', scope: 'book', from: '父亲' }, false],
    [{ op: 'replace_literal', scope: 'chapter', from: '父亲', to: '大伯' }, false],
    [{ op: 'replace_literal', scope: 'book', from: '父亲', to: '' }, true],
    [{ op: 'set_chapter_summary', chapter: '第1章', after: 'x' }, true],
    [{ op: 'set_chapter_summary', chapter: '第1章' }, false],
    [{ op: 'set_outline_node', node: '开端', field: 'summary', after: 'x' }, true],
    [{ op: 'set_outline_node', node: '开端', field: 'children', after: 'x' }, false],
    [{ op: 'set_outline_node', node: '开端', field: 'status', after: 'writing' }, true],
    [{ op: 'set_outline_node', node: '开端', field: 'status', after: 'finished' }, false],
    [{ op: 'add_outline_node', title: '第4章 灰线', summary: 'x' }, true],
    [{ op: 'add_outline_node', title: '第4章 灰线', parent: '第一卷', status: 'planned' }, true],
    [{ op: 'add_outline_node', title: '第4章 灰线', status: 'finished' }, false],
    [{ op: 'add_outline_node', summary: '没有标题' }, false],
    [{ op: 'create_chapter', title: '第30章 027', summary: '陈屿追编号', draft: true }, true],
    [{ op: 'create_chapter', title: '第30章 027', targetWords: 2400 }, true],
    [{ op: 'create_chapter', summary: '没有标题' }, false],
    [{ op: 'create_chapter', title: '第30章', targetWords: 40 }, false],
    [{ op: 'create_chapter', title: '第30章', draft: 'yes' }, false],
    [{ op: 'write_chapter', chapter: '第30章' }, true],
    [{ op: 'write_chapter' }, false],
    [{ op: 'bible_upsert', collection: 'characters', name: '林昭', fields: { motivation: 'x' } }, true],
    [{ op: 'bible_upsert', collection: 'characters', name: '林昭', fields: { unknownField: 'x' } }, false],
    [{ op: 'bible_upsert', collection: 'nope', name: '林昭', fields: { motivation: 'x' } }, false],
    [{ op: 'bible_upsert', collection: 'world', name: '雾港', fields: { content: 'x' } }, true]
  ]
  for (const [op, expectOk] of cases) {
    const r = validateOp(op, 0)
    check(`${op.op} ${JSON.stringify(op).slice(0, 46)} → ${expectOk ? '通过' : '拒绝'}`, Boolean(r.op) === expectOk, JSON.stringify(r))
  }
}

/* ── 7. 设定字段白名单：未知字段被丢弃但要报出来 ── */
console.log('设定字段白名单')
{
  const r = validateOp(
    { op: 'bible_upsert', collection: 'characters', name: '林昭', fields: { motivation: '查信', age: '二十七', 血型: 'O' } },
    0
  )
  check('合法字段留下', r.op?.fields?.motivation === '查信' && r.op?.fields?.age === '二十七', JSON.stringify(r.op?.fields))
  check('未知字段被丢弃', r.op?.fields?.血型 === undefined, JSON.stringify(r.op?.fields))
  check('丢弃有提示', Boolean(r.error?.includes('血型')), r.error)
  check('布尔字段用字符串传', Boolean(validateOp({ op: 'bible_upsert', collection: 'world', name: '雾港', fields: { visible: 'false' } }, 0).op), 'visible 被拒')
  check('characters 允许 hidden', Boolean(validateOp({ op: 'bible_upsert', collection: 'characters', name: '甲', fields: { hidden: 'true' } }, 0).op))
  check('BIBLE_SCHEMA 五个集合齐全', Object.keys(BIBLE_SCHEMA).length === 5, Object.keys(BIBLE_SCHEMA).join(','))
}

/* ── 8. 中文数字与章号 ── */
console.log('章号解析')
{
  const nums = [
    ['3', 3],
    ['三', 3],
    ['十', 10],
    ['十三', 13],
    ['二十', 20],
    ['二十五', 25],
    ['一百零三', 103],
    ['３', 3],
    ['abc', null]
  ]
  for (const [s, want] of nums) {
    check(`cnToNumber(${s}) = ${want}`, cnToNumber(s) === want, String(cnToNumber(s)))
  }
  check('第3章 → 3', chapterNumber('第3章 她把最后一封信烧了') === 3, String(chapterNumber('第3章 她把最后一封信烧了')))
  check('第三章 → 3', chapterNumber('第三章') === 3, String(chapterNumber('第三章')))
  check('无章号 → null', chapterNumber('序章') === null, String(chapterNumber('序章')))
}

/* ── 9. 章节引用解析 ── */
console.log('章节引用解析')
{
  const project = {
    chapters: [
      { id: 'c1', title: '第1章 起点' },
      { id: 'c2', title: '第2章 老槐树' },
      { id: 'c3', title: '第3章 她把最后一封信烧了' },
      { id: 'c4', title: '第3章 同名' }
    ]
  }
  check('按 id', resolveChapterRef(project, 'c2').chapterId === 'c2')
  check('按完整标题', resolveChapterRef(project, '第2章 老槐树').chapterId === 'c2')
  check('按章号唯一时', resolveChapterRef(project, '第2章').chapterId === 'c2')
  check('章号多解给候选', resolveChapterRef(project, '第3章').candidates.length === 2, JSON.stringify(resolveChapterRef(project, '第3章')))
  check('标题唯一子串', resolveChapterRef(project, '老槐树').chapterId === 'c2')
  check('找不到给空候选', resolveChapterRef(project, '第99章').candidates.length === 0)
  check('空引用不炸', resolveChapterRef(project, '').candidates.length === 0)
}

/* ── 10. 大纲节点解析 ── */
console.log('大纲节点解析')
{
  const outline = [
    {
      id: 'v1',
      title: '第一卷',
      children: [
        { id: 'n1', title: '开端', children: [] },
        { id: 'n2', title: '转折', children: [] }
      ]
    }
  ]
  check('按 id', resolveOutlineNode(outline, 'n2').node?.id === 'n2')
  check('按标题', resolveOutlineNode(outline, '开端').node?.id === 'n1')
  check('带路径', resolveOutlineNode(outline, '开端').path.join('›') === '第一卷›开端', resolveOutlineNode(outline, '开端').path.join('›'))
  check('找不到给候选', resolveOutlineNode(outline, '不存在的节点').candidates.length === 0)
  const dup = [
    { id: 'a', title: '开端', children: [] },
    { id: 'b', title: '开端', children: [] }
  ]
  check('重名给候选', resolveOutlineNode(dup, '开端').candidates.length === 2, JSON.stringify(resolveOutlineNode(dup, '开端')))
}

/* ── 11. 提示词 ── */
console.log('提示词')
{
  const p = renderEditPrompt()
  check('包含围栏名', p.includes('mz-edit'))
  check(
    '十种 op 全列出',
    [
      'replace_paragraph',
      'insert_paragraph',
      'delete_paragraph',
      'replace_literal',
      'set_chapter_summary',
      'set_outline_node',
      'add_outline_node',
      'create_chapter',
      'write_chapter',
      'bible_upsert'
    ].every((k) => p.includes(k))
  )
  check('提到 anchor 要逐字', p.includes('逐字'))
  check('提到上限', p.includes(String(MAX_EDITS)))
  check('说明了什么时候不用输出', p.includes('不要输出'))
}

/* ── 12. 显示用：stripEditBlock ── */
console.log('stripEditBlock')
{
  const t = stripEditBlock(`先说结论。\n\n${fence({ edits: [{ op: 'delete_paragraph', chapter: '第1章', anchor: 'x' }] })}\n\n完。`)
  check('围栏被去掉', !t.includes('mz-edit') && !t.includes('delete_paragraph'), t)
  check('保留前后文字', t.includes('先说结论') && t.includes('完。'), t)
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)