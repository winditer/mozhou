/**
 * 对话 messages 装配的回归测试。
 * 运行：node scripts/test-chat-external.mjs
 *
 * 核心断言只有一条：不传 external 时，装配结果必须与改造前逐字一致。
 * buildSystemPrompt 服务四个入口，任何"顺手优化"都会波及正文生成，
 * 而那种回归往往在跑一整天写作之后才会被发现。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outdir = mkdtempSync(join(tmpdir(), 'mozhou-chat-external-'))
const outfile = join(outdir, 'generate.mjs')

await build({
  entryPoints: [join(root, 'src/renderer/lib/generate.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(root, 'src/shared') }
})
const { buildChatMessages } = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

const base = {
  system: 'SYS',
  contextText: '【作品简介】\n一句话前提：测试',
  history: [
    { role: 'user', content: '上一问' },
    { role: 'assistant', content: '上一答' }
  ],
  question: '这一问'
}

const plain = buildChatMessages(base)
check('五条消息（system + 资料 + 2 历史 + 问题）', plain.length === 5, String(plain.length))
check('第 1 条是 system', plain[0].role === 'system' && plain[0].content === 'SYS')
check('第 2 条是作品资料', plain[1].content === `【作品资料】\n${base.contextText}`, JSON.stringify(plain[1].content))
check('第 3 条是上一条历史', plain[2].content === '上一问')
check('最后一条是当前问题', plain.at(-1).content === '这一问')
check('历史只保留最近 8 条', buildChatMessages({ ...base, history: Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `m${i}` })) }).length === 2 + 8 + 1)

const withExt = buildChatMessages({ ...base, external: '【外部资料】\n[1] x' })
check('有 external 时多一条', withExt.length === 6, String(withExt.length))
check('external 紧跟作品资料', withExt[2].content.startsWith('【外部资料】'), JSON.stringify(withExt[2].content))
check('external 在历史之前', withExt[3].content === '上一问')
check('external 之后消息未变', JSON.stringify(withExt.slice(3)) === JSON.stringify(plain.slice(2)))

const blank = buildChatMessages({ ...base, external: '   ' })
check('空白 external 视同没有', JSON.stringify(blank) === JSON.stringify(plain))

const empty = buildChatMessages({ ...base, external: '' })
check('空串 external 视同没有', JSON.stringify(empty) === JSON.stringify(plain))

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)