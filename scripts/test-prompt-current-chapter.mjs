/**
 * 「当前章节正文」这一块的裁剪口径。
 *
 * 真实翻车：作者那章正文 10894 字，旧实现静默截到 8000 字，
 * 模型看不到结尾，却照样给结尾段落提改动——anchor 永远对不上。
 * 现在的口径：给得多一点（14000），被截断时必须**写明白**，
 * 让模型知道自己没看到哪部分，从而不去改它。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outfile = join(mkdtempSync(join(tmpdir(), 'mozhou-prompt-')), 'prompt.mjs')
await build({
  entryPoints: [join(root, 'src/renderer/lib/prompt.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(root, 'src/shared') }
})
const { assembleContext } = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

const mkProject = (chapters) => ({
  id: 'p',
  title: '测试',
  chapters,
  outline: [],
  summaries: {},
  bible: {},
  brief: { logline: '', synopsis: '' },
  settings: { context: {} }
})

const mkChapter = (id, title, content) => ({
  id,
  title,
  content: `<p>${content}</p>`,
  summary: '',
  status: 'draft',
  targetWords: 2500,
  words: content.length,
  createdAt: 1,
  updatedAt: 1,
  versions: []
})

const para = (n) => '这是一段用来凑长度的正文，讲的都是同一件事。'.repeat(n)

console.log('短章节')
{
  const body = para(4)
  const p = mkProject([mkChapter('c1', '第1章 短', body)])
  const ctx = assembleContext(p, p.chapters[0], 24000, { includeCurrent: true })
  const cur = ctx.blocks.find((b) => b.key === 'current')
  check('有当前章节块', Boolean(cur))
  check('短章节原样给出', cur.text.includes(body), `len=${cur.text.length}`)
  check('短章节不加省略声明', !cur.text.includes('省略了本章后面的'), cur.text.slice(-80))
}

console.log('长章节（10894 字那种）')
{
  const body = para(700) + '这一段是全书最后一句，独一无二。'
  check('构造得够长', body.length > 14000, String(body.length))
  const p = mkProject([mkChapter('c1', '第30章 旁站', body)])
  const ctx = assembleContext(p, p.chapters[0], 24000, { includeCurrent: true })
  const cur = ctx.blocks.find((b) => b.key === 'current')
  const tail = '这一段是全书最后一句，独一无二。'
  check('块有上限（≤15000 字）', cur.text.length <= 15000, `len=${cur.text.length}`)
  check('被截断时写明省略了多少字', cur.text.includes(`省略了本章后面的 ${body.length - 14000} 字`), cur.text.slice(-120))
  check('省略的部分没有混进来', !cur.text.includes(tail), '尾部居然在块里')
  check('首段完整给出', cur.text.includes(body.slice(0, 200)))
  check('明确要求不要改没看到的部分', cur.text.includes('不要为省略部分') || cur.text.includes('不要为省略部分提改动') || cur.text.includes('不要为省略'), cur.text.slice(-120))
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)