/**
 * 写稿任务的回归测试：串行、节流落盘、停止、手滑检测。
 *
 * 这个模块不碰模型层（生成器从 deps 注入），所以能在 node 里直接跑：
 * 一个假生成器分几段吐字，看它写进 store 的 content 是不是逐步变长、
 * 中途被叫停时是不是保留已写部分。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outfile = join(mkdtempSync(join(tmpdir(), 'mozhou-draft-jobs-')), 'draftJobs.mjs')
await build({
  entryPoints: [join(root, 'src/renderer/lib/draftJobs.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(root, 'src/shared') }
})
const { runDraftJobs } = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

const mkChapter = (id, title, content = '') => ({
  id,
  title,
  content,
  summary: '',
  status: 'planning',
  targetWords: 2500,
  words: 0,
  createdAt: 1,
  updatedAt: 1,
  versions: []
})
const mkProject = (chapters) => ({ id: 'p', title: 't', chapters, outline: [], bible: {}, brief: {} })

/** 假生成器：分 n 段吐字，每段之间让事件循环走一步（让节流器有机会落盘） */
function fakeGen(paras, opts = {}) {
  return async ({ onDelta, onStage }) => {
    onStage?.('正在写…')
    for (const p of paras) {
      onDelta(p + '\n\n')
      await new Promise((r) => setTimeout(r, opts.gap ?? 5))
      if (opts.onEach) opts.onEach()
    }
    return paras.join('\n\n')
  }
}

console.log('写初稿')
{
  const ch = mkChapter('c1', '第4章 灰线')
  const project = mkProject([ch])
  const writes = []
  const r = await runDraftJobs([{ chapterId: 'c1', title: ch.title, targetWords: 2500, continueOnly: false }], {
    generate: fakeGen(['第一段字。', '第二段字。', '第三段字。']),
    getProject: () => project,
    patch: (id, p) => {
      writes.push(p.content)
      project.chapters[0] = { ...project.chapters[0], ...p }
    },
    flushMs: 0
  })
  check('成功 1 章', r.ok === 1 && r.failed === 0 && r.stopped === false, JSON.stringify(r))
  check('落盘是逐步的', writes.length >= 2, String(writes.length))
  check('最终正文分了三段', (project.chapters[0].content.match(/<p>/g) || []).length === 3, project.chapters[0].content)
  check('有正文', project.chapters[0].content.includes('第二段字'))
}

console.log('接着写')
{
  const ch = mkChapter('c2', '第5章 门', '<p>原来的开头。</p>')
  const project = mkProject([ch])
  await runDraftJobs([{ chapterId: 'c2', title: ch.title, targetWords: 2500, continueOnly: true }], {
    generate: fakeGen(['接下去。']),
    getProject: () => project,
    patch: (id, p) => {
      project.chapters[0] = { ...project.chapters[0], ...p }
    },
    flushMs: 0
  })
  check('旧正文保留', project.chapters[0].content.includes('原来的开头'), project.chapters[0].content)
  check('新内容接在后面', project.chapters[0].content.includes('接下去'), project.chapters[0].content)
  check('顺序正确', project.chapters[0].content.indexOf('原来的开头') < project.chapters[0].content.indexOf('接下去'))
}

console.log('停止')
{
  const ch = mkChapter('c3', '第6章 停')
  const project = mkProject([ch])
  let stop = false
  const r = await runDraftJobs([{ chapterId: 'c3', title: ch.title, targetWords: 2500, continueOnly: false }], {
    generate: fakeGen(['一。', '二。', '三。', '四。'], { gap: 5, onEach: () => (stop = true) }),
    getProject: () => project,
    patch: (id, p) => {
      project.chapters[0] = { ...project.chapters[0], ...p }
    },
    flushMs: 0,
    shouldStop: () => stop
  })
  check('报告已停止', r.stopped === true, JSON.stringify(r))
  check('已写部分留着', (project.chapters[0].content || '').length > 0, project.chapters[0].content)
  check('没写全', !project.chapters[0].content.includes('四。'), project.chapters[0].content)
}

console.log('作者自己动手了')
{
  const ch = mkChapter('c4', '第7章 手滑')
  const project = mkProject([ch])
  const r = await runDraftJobs([{ chapterId: 'c4', title: ch.title, targetWords: 2500, continueOnly: false }], {
    generate: fakeGen(['一。', '二。', '三。'], {
      gap: 5,
      onEach: () => {
        // 模拟作者在编辑器里打字：store 里的正文被改成别的内容
        project.chapters[0] = { ...project.chapters[0], content: '<p>我自己写的。</p>' }
      }
    }),
    getProject: () => project,
    patch: (id, p) => {
      project.chapters[0] = { ...project.chapters[0], ...p }
    },
    flushMs: 0
  })
  check('停下来了', r.stopped === true, JSON.stringify(r))
  check('没有覆盖作者的字', project.chapters[0].content.includes('我自己写的'), project.chapters[0].content)
}

console.log('章节不在了')
{
  const r = await runDraftJobs([{ chapterId: 'gone', title: '第9章', targetWords: 2500, continueOnly: false }], {
    generate: fakeGen(['一。']),
    getProject: () => mkProject([]),
    patch: () => {},
    flushMs: 0
  })
  check('算失败但整个任务不炸', r.failed === 1 && r.ok === 0, JSON.stringify(r))
}

console.log('生成器抛错')
{
  const ch = mkChapter('c5', '第8章 炸')
  const project = mkProject([ch])
  const r = await runDraftJobs([{ chapterId: 'c5', title: ch.title, targetWords: 2500, continueOnly: false }], {
    generate: async ({ onDelta }) => {
      onDelta('先写了半句')
      await new Promise((rr) => setTimeout(rr, 5))
      throw new Error('网络断了')
    },
    getProject: () => project,
    patch: (id, p) => {
      project.chapters[0] = { ...project.chapters[0], ...p }
    },
    flushMs: 0
  })
  check('算失败', r.failed === 1, JSON.stringify(r))
  check('半句留着', (project.chapters[0].content || '').length > 0, project.chapters[0].content)
}

console.log('两章串行')
{
  const project = mkProject([mkChapter('c6', '第10章 A'), mkChapter('c7', '第11章 B')])
  const order = []
  const r = await runDraftJobs(
    [
      { chapterId: 'c6', title: '第10章 A', targetWords: 2500, continueOnly: false },
      { chapterId: 'c7', title: '第11章 B', targetWords: 2500, continueOnly: false }
    ],
    {
      generate: async ({ chapter, onDelta }) => {
        order.push(chapter.id)
        onDelta('一段。')
        return '一段。'
      },
      getProject: () => project,
      patch: (id, p) => {
        const i = project.chapters.findIndex((c) => c.id === id)
        project.chapters[i] = { ...project.chapters[i], ...p }
      },
      flushMs: 0
    }
  )
  check('两章都写了', r.ok === 2, JSON.stringify(r))
  check('按顺序串行', JSON.stringify(order) === '["c6","c7"]', JSON.stringify(order))
  check('两章都有正文', project.chapters.every((c) => c.content.length > 0))
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)