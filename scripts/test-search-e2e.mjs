#!/usr/bin/env node
/**
 * 搜索功能的端到端验收（真实 Electron 界面 + 真实渲染进程）。
 *
 * 与 test-search.mjs 的分工：
 *   test-search.mjs  纯逻辑，快，跑在 Node 里，测算法本身
 *   本脚本          真实界面，慢，测「点了之后到底有没有跳对地方」
 *
 * 两者都要跑：逻辑对但接线错，纯逻辑测试是发现不了的——
 * 之前校读的「采用建议」点了没反应就是这种情况。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'mz-search-e2e-'))

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail !== undefined ? ' → ' + detail : ''}`)
  }
}

/** 跑一次截图脚本，返回 shot-js-result 里的 JSON */
function shot(name, js) {
  const png = join(work, `${name}.png`)
  const r = spawnSync('node', ['scripts/shot.cjs', png, js, '--delay=3300', '--wait=2600'], {
    encoding: 'utf8',
    cwd: process.cwd()
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const m = out.match(/shot-js-result "(.*)"/)
  if (!m) return { ok: false, raw: out.slice(-400), png: existsSync(png) ? png : null }
  let value = m[1]
  // shot.cjs 对结果做了 JSON 转义后再打印
  try {
    value = JSON.parse(`"${value}"`)
  } catch {
    /* 保持原样 */
  }
  let data = null
  try {
    data = JSON.parse(value)
  } catch {
    data = value
  }
  return { ok: true, data, png }
}

const OPEN = `__MZ.openProject('p_demo')`
const wait = (ms) => `new Promise(z=>setTimeout(z,${ms}))`

console.log('本章搜索')
{
  const r = shot(
    'chapter',
    `(__MZ.openProject('p_demo'), ${wait(1200)}.then(()=>{
      __MZ.state().setActiveChapter('ch_2')
      return ${wait(900)}
    }).then(()=>{
      __MZ.clickByText('搜索')
      return ${wait(700)}
    }).then(()=>{
      __MZ.typeInto('[data-mz-search] input:not([type])','槐树')
      return ${wait(800)}
    }).then(()=>{
      const t=document.body.innerText
      return JSON.stringify({count:t.match(/共 \\d+ 处/)?.[0], hasGroup:t.includes('第 2 章')})
    }))`
  )
  check('搜索面板能打开', r.ok, r.raw)
  if (r.ok && typeof r.data === 'object') {
    check('本章能搜到结果', /共 \d+ 处/.test(r.data.count ?? ''), JSON.stringify(r.data))
  }
}

console.log('全书搜索')
{
  const r = shot(
    'book',
    `(__MZ.openProject('p_demo'), ${wait(1200)}.then(()=>{
      __MZ.clickByText('搜索')
      return ${wait(700)}
    }).then(()=>{
      __MZ.typeInto('[data-mz-search] input:not([type])','老槐树')
      return ${wait(700)}
    }).then(()=>{
      __MZ.clickByText('全书')
      return ${wait(900)}
    }).then(()=>{
      const t=document.body.innerText
      return JSON.stringify({count:t.match(/共 \\d+ 处[^\\n]*/)?.[0]})
    }))`
  )
  check('全书搜索返回分组统计', r.ok && /共 \d+ 处 · 分布在 \d+ 章/.test(r.data?.count ?? ''), JSON.stringify(r.data))
}

console.log('跨章跳转定位')
{
  const r = shot(
    'jump',
    `(__MZ.openProject('p_demo'), ${wait(1200)}.then(()=>{
      __MZ.clickByText('搜索')
      return ${wait(700)}
    }).then(()=>{
      __MZ.typeInto('[data-mz-search] input:not([type])','老槐树')
      return ${wait(700)}
    }).then(()=>{
      __MZ.clickByText('全书')
      return ${wait(900)}
    }).then(()=>{
      const hits=[...document.querySelectorAll('[data-mz-search] button')].filter(b=>b.title==='跳到这一处')
      // 点第二条：这条在第 2 章，能与当前章节区分开，正好验证跨章跳转
      hits[Math.min(1, hits.length-1)].click()
      return ${wait(900)}
    }).then(()=>{
      return JSON.stringify({
        chapter: __MZ.state().activeChapterId,
        selected: window.getSelection()?.toString()
      })
    }))`
  )
  check('跳转切换到了正确的章节', r.ok && r.data?.chapter === 'ch_2', JSON.stringify(r.data))
  check('选中的正是命中的词', r.ok && r.data?.selected === '老槐树', JSON.stringify(r.data))
}

console.log('空结果提示')
{
  const r = shot(
    'empty',
    `(__MZ.openProject('p_demo'), ${wait(1200)}.then(()=>{
      __MZ.clickByText('搜索')
      return ${wait(700)}
    }).then(()=>{
      __MZ.typeInto('[data-mz-search] input:not([type])','不存在的词汇zzz')
      return ${wait(800)}
    }).then(()=>{
      return JSON.stringify({hint: document.body.innerText.includes('没有找到')})
    }))`
  )
  check('搜索无结果时给出提示', r.ok && r.data?.hint === true, JSON.stringify(r.data))
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
console.log(`截图留在 ${work}`)
process.exit(fail === 0 ? 0 : 1)