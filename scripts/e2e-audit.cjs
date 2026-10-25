#!/usr/bin/env node
/**
 * 端到端验收：假网关 + 真 Electron，验证体检的两个问题。
 *
 *   node scripts/e2e-audit.cjs
 *
 * 场景 1：全书一致性体检。假网关返回一个**被 max_tokens 截断**的 JSON 数组
 *         （模拟模型写到第 2 条时额度用光）。旧版这里会解析失败 → setRaw('') →
 *         页面一片空白，用户看到的就是「执行后无结果」。现在必须：
 *           - 抢救出已写完的问题；
 *           - 若真的什么都没解析出来，必须是**看得见的错误说明**，不是空白。
 *
 * 场景 2：章节体检的「采用」。点一下必须真的调用模型改写、给出对比，
 *         并且只有点「写入正文」才改稿。
 */
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.E2E_PORT || 8806)
const OUT_A = path.join(ROOT, 'shots', 'e2e-audit-book.png')
const OUT_B = path.join(ROOT, 'shots', 'e2e-audit-apply.png')

const calls = []

/** 完整的一条问题 JSON（模拟模型输出） */
const ISSUE = {
  level: 'high',
  type: '人物',
  title: '主角年龄前后矛盾',
  detail: '第一章说二十岁，后文又说二十五岁，跨度对不上。',
  evidence: '这是第七十三封。前七十二封她都寄出去了，寄到一个早已无人居住的地址，收件人写着父亲的名字。',
  chapterIds: [],
  suggestion: '统一为二十岁，并相应调整父亲去世的年份。'
}

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url || ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-audit', object: 'model' }] }))
        return
      }
      if (req.method === 'POST' && url.includes('/chat/completions')) {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          let payload = {}
          try {
            payload = JSON.parse(body)
          } catch {
            /* 忽略 */
          }
          const sys = (payload.messages || []).map((m) => String(m.content || '')).join('\n')
          calls.push({ chars: sys.length, kind: detectKind(sys) })

          let text = ''
          if (/只输出改写后的/.test(sys)) {
            // 改写请求：返回改写后的那一段
            text = '这是第七十四封。前七十三封她都寄出去了，寄到一个早已无人居住的地址，收件人仍然写着父亲的名字。'
          } else if (/审校任务/.test(sys)) {
            // 全书体检：故意返回**被截断**的 JSON——第 1 条完整，第 2 条写一半
            text =
              '[' +
              JSON.stringify({
                ...ISSUE,
                evidence: '前七十二封她都寄出去了，寄到一个早已无人居住的地址',
                chapterIds: allChapterIds(sys)
              }) +
              ',{"level":"medium","type":"时间线","title":"季节描写前后不一致","detail":"第三章是盛夏，第七章却说窗外飘着雪，中间没有交代时'
          } else if (/章节体检|节奏|冲突/.test(sys)) {
            // 章节体检：一条可定位到正文的问题
            text = JSON.stringify({
              scores: { rhythm: 72, conflict: 65, suspense: 58, water: 30 },
              comment: '节奏尚可，中段略平。',
              issues: [
                {
                  level: 'high',
                  type: '人物',
                  title: '主角年龄前后矛盾',
                  detail: '正文写她二十岁，但父亲才走了十年，后文又提到她已二十五岁。',
                  evidence: '这是第七十三封。前七十二封她都寄出去了，寄到一个早已无人居住的地址，收件人写着父亲的名字。',
                  chapterIds: [],
                  suggestion: '统一年龄与父亲去世年份，保持一致。'
                }
              ]
            })
          } else {
            // 章节摘要
            text = '周砚秋烧掉了第七十三封寄给亡父的信，父亲已去世十年。'
          }

          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          const parts = text.match(/[\s\S]{1,50}/g) || []
          let i = 0
          const tick = setInterval(() => {
            if (i < parts.length) {
              res.write(
                `data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: parts[i] }, finish_reason: null }] })}\n\n`
              )
              i++
            } else {
              res.write(
                `data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
              )
              res.write('data: [DONE]\n\n')
              res.end()
              clearInterval(tick)
            }
          }, 3)
          res.on('close', () => clearInterval(tick))
        })
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })
}

function detectKind(sys) {
  if (/只输出改写后的/.test(sys)) return 'rewrite'
  if (/审校任务/.test(sys)) return 'book'
  if (/章节体检|节奏/.test(sys)) return 'chapter'
  return 'summary'
}

function allChapterIds(sys) {
  return [...sys.matchAll(/id=([A-Za-z0-9_-]+)/g)].map((m) => m[1])
}

const DRIVE_JS = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const app = window.__MZ
  if (app && app.openProject) await app.openProject('p_demo2')
  await sleep(1200)

  // 造第二章，让全书一致性问题能真正跨章
  try {
    const st0 = app.state()
    const proj = st0.project
    if (proj && proj.chapters.length < 2) {
      await st0.addChapter('第 2 章 她在船上')
      await sleep(400)
      const st1 = app.state()
      const ch2 = st1.project.chapters[1]
      if (ch2 && st1.patchChapter) {
        st1.patchChapter(ch2.id, {
          content: '<h1>第 2 章 她在船上</h1><p>她已经二十五岁了，站在甲板上看江面。</p><p>父亲走后第十年，她终于离开了那座城。</p>',
          words: 40
        })
      }
      await sleep(300)
    }
  } catch (e) { /* 造不出来就只测单章 */ }
  // 切到体检页
  const st = app ? app.state() : null
  if (st && st.setTab) st.setTab('audit')
  await sleep(800)

  const btnText = () => Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim())

  // ── 1. 全书一致性 ──
  const runBook = btnText().find((t) => /开始体检/.test(t))
  const bookBtn = Array.from(document.querySelectorAll('button')).find((b) => /开始体检/.test(b.textContent || ''))
  if (!bookBtn) return { ok: false, stage: 'book', err: '找不到开始体检按钮', buttons: btnText().slice(0, 30) }
  bookBtn.click()

  let bookText = ''
  const t0 = Date.now()
  while (Date.now() - t0 < 90000) {
    await sleep(500)
    bookText = document.body.textContent || ''
    if (/重新体检|再跑一次|没有拿到结果|个问题|没发现明显/.test(bookText)) break
  }
  const bookHasIssues = /个问题/.test(bookText)
  const bookHasEmpty = /没有拿到结果/.test(bookText)
  const rescued = /主角年龄前后矛盾/.test(bookText)

  // 全书一致性也要能「采用」：点第一条的采用按钮
  let bookApply = { hasBtn: false, hasPreview: false, tail: '' }
  {
    const btns = Array.from(document.querySelectorAll('button')).filter((b) => (b.textContent || '').trim() === '采用')
    bookApply.hasBtn = btns.length > 0
    if (btns.length) {
      btns[0].click()
      const tb = Date.now()
      while (Date.now() - tb < 60000) {
        await sleep(400)
        const mt = document.querySelector('[data-mz-modal]')?.textContent || ''
        if (/写入正文|定位不到|没有给出任何改动/.test(mt)) {
          bookApply.tail = mt.slice(0, 400)
          break
        }
      }
      bookApply.hasPreview = /改前/.test(bookApply.tail) && /改后/.test(bookApply.tail)
      bookApply.groups = (bookApply.tail.match(/第 \d+ 章/g) || []).slice(0, 6)
      // 先停在这里让截图落在「全书一致性的采用」上（多章分组看得见），
      // 之后再关掉继续测章节体检
      await sleep(1600)
      const closeBtn = Array.from(document.querySelectorAll('[data-mz-modal] button')).find((b) => /取消/.test(b.textContent || ''))
      if (closeBtn) closeBtn.click()
      await sleep(400)
    }
  }

  // ── 2. 章节体检 + 采用 ──
  const chapBtn = () => Array.from(document.querySelectorAll('button')).find((b) => /章节体检/.test(b.textContent || ''))
  const seg = chapBtn()
  if (seg) { seg.click(); await sleep(600) }
  // 明确把当前章切回第 1 章：章节体检针对「当前选中的章」，
  // 建第 2 章时它变成了选中章，而测试的 evidence 来自第 1 章。
  try {
    const st1 = app.state()
    const first = st1.project.chapters[0]
    if (first && st1.setActiveChapter) { st1.setActiveChapter(first.id); await sleep(400) }
    // setActiveChapter 会同时把视图切到写作台，必须切回体检页，
    // 否则后面的「章节体检」按钮根本不在 DOM 里（这一步踩过）。
    const st2 = app.state()
    if (st2.setTab) st2.setTab('audit')
    await sleep(700)
    const seg2 = Array.from(document.querySelectorAll('button')).find((b) => /章节体检/.test(b.textContent || ''))
    if (seg2) { seg2.click(); await sleep(600) }
  } catch (e) {}

  const startChap = Array.from(document.querySelectorAll('button')).find((b) => /开始体检|体检这一章|开始章节体检/.test(b.textContent || ''))
  if (startChap) startChap.click()
  let chapText = ''
  const t1 = Date.now()
  while (Date.now() - t1 < 60000) {
    await sleep(400)
    chapText = document.body.textContent || ''
    if (/采用/.test(chapText)) break
  }
  const hasApplyBtn = Array.from(document.querySelectorAll('button')).some((b) => /采用/.test(b.textContent || ''))

  // 点「采用」，看是否出现对比弹窗
  const applyBtn = Array.from(document.querySelectorAll('button')).find((b) => /采用/.test(b.textContent || ''))
  let modalText = ''
  let hasPreview = false
  if (applyBtn) {
    applyBtn.click()
    const t2 = Date.now()
    while (Date.now() - t2 < 60000) {
      await sleep(400)
      modalText = document.querySelector('[data-mz-modal]')?.textContent || ''
      if (/写入正文|定位不到|没有给出任何改动/.test(modalText)) break
    }
    hasPreview = /改前/.test(modalText) && /改后/.test(modalText)
  }

  const allBtns = Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean)
  const bodyNow = (document.body.textContent || '').slice(0, 1800)
  return {
    ok: true,
    allBtns: allBtns.slice(0, 40),
    bodyNow,
    book: { hasIssues: bookHasIssues, hasEmpty: bookHasEmpty, rescued, bookApply, sample: (bookText.match(/没有拿到结果[^。]*/) || [''])[0] },
    chapter: { hasApplyBtn, hasPreview, modalTail: modalText.slice(0, 500) }
  }
})()
`

async function run(js, out, label) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.HOME = path.join(ROOT, '.home')
  env.MOZHOU_USER_DATA = path.join(ROOT, '.testdata-audit-e2e')
  env.MOZHOU_SHOT = out
  env.MOZHOU_SHOT_DELAY = '2500'
  env.MOZHOU_SHOT_JS = js
  env.MOZHOU_SHOT_JS_WAIT = '1500'

  const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'electron'), ['out/main/index.js', '--no-sandbox', '--disable-gpu'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d.toString()))
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  await new Promise((r) => child.on('exit', r))
  clearTimeout(timer)
  const m = stderr.match(/\[mz\] shot-js-result (.*)/)
  try {
    return m ? JSON.parse(m[1]) : null
  } catch {
    return null
  }
}

async function main() {
  fs.mkdirSync(path.dirname(OUT_A), { recursive: true })
  const server = await startMock()

  // 独立数据目录，并指向假网关
  const dir = path.join(ROOT, '.testdata-audit-e2e')
  fs.mkdirSync(dir, { recursive: true })
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.testdata', 'config.json'), 'utf8'))
  for (const ch of cfg.channels) ch.baseUrl = `http://127.0.0.1:${PORT}/v1`
  cfg.models = [{ id: 'm_a', channelId: cfg.channels[0].id, model: 'e2e-audit', enabled: true, label: 'E2E-Audit' }]
  cfg.settings.taskModels = { draft: 'm_a', outline: 'm_a', polish: 'm_a', naming: 'm_a', summary: 'm_a', audit: 'm_a', chat: 'm_a' }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2))
  const proj = path.join(ROOT, '.testdata', 'projects')
  if (fs.existsSync(proj)) fs.cpSync(proj, path.join(dir, 'projects'), { recursive: true })
  const lib = path.join(ROOT, '.testdata', 'style-library.json')
  if (fs.existsSync(lib)) fs.copyFileSync(lib, path.join(dir, 'style-library.json'))

  const result = await run(DRIVE_JS, OUT_A, 'audit')
  server.close()

  console.log('假网关收到的调用：', calls.length, '次 →', calls.map((c) => c.kind).join(', '))
  console.log('渲染层回报：', JSON.stringify(result, null, 2).slice(0, 1400))

  let pass = 0
  let fail = 0
  const check = (name, ok, detail = '') => {
    if (ok) {
      pass++
      console.log(`  ✓ ${name}`)
    } else {
      fail++
      console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    }
  }

  console.log('\n断言：')
  check('体检确实调用了模型', calls.some((c) => c.kind === 'book' || c.kind === 'summary'), JSON.stringify(calls.map((c) => c.kind)))
  if (result && result.ok) {
    // 问题 1：截断的 JSON 必须能被抢救，而不是「无结果」
    check('全书体检有结果（不再是空白）', result.book.hasIssues || result.book.hasEmpty, JSON.stringify(result.book))
    check('被截断的 JSON 里已写完的问题被抢救出来', result.book.rescued === true, '没找到「主角年龄前后矛盾」')
    // 问题 2：章节体检有可用的「采用」按钮，且能看到对比
    check('章节体检出现「采用」按钮', result.chapter.hasApplyBtn === true)
    check('点采用后出现改前/改后对比', result.chapter.hasPreview === true, result.chapter.modalTail)
    // 全书一致性也要有采用
    check('全书一致性问题也有「采用」按钮', result.book.bookApply?.hasBtn === true, JSON.stringify(result.book.bookApply))
    check('全书一致性的采用能给出对比', result.book.bookApply?.hasPreview === true, result.book.bookApply?.tail)
  } else {
    check('驱动脚本跑通', false, JSON.stringify(result))
  }

  console.log(`\n${fail === 0 ? '端到端通过' : '端到端失败'}：${pass} 通过 / ${fail} 失败`)
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})