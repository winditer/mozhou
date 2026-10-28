#!/usr/bin/env node
/**
 * 端到端验收：对话直接改稿（mz-edit）。
 *
 *   node scripts/e2e-chat-edit.cjs
 *
 * 三件事必须成立，缺一条这个功能就不该发：
 *
 *   A. apply（能落地）
 *      AI 在回答里附 mz-edit → 气泡出现「查看并应用 2 处修改」→ 预览 → 应用后
 *      正文真的变了、梗概真的变了、章节版本多了一份快照（可回退）、气泡标「已应用」。
 *
 *   B. notfound（定位不到就不许动）
 *      anchor 对不上时，预览里必须红字说「找不到原文」，且一个字节都不许改——
 *      这条挂了，等于模型瞎编一句话就能改坏作者的稿子。
 *
 *   C. malformed（格式坏了要说人话）
 *      JSON 坏了：自然语言回答照常留下，同时明说「改稿块没读懂」，
 *      绝不静默丢弃（静默会让作者以为 AI 没听懂）。
 */
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.E2E_PORT || 8813)

const ANCHOR = '信封烧到一半时，她发现自己记住了上面的每一个字。'
const REWRITE = '信封烧到一半时，她忽然想起父亲说过：记住的从来不是字，是那天的风。'
const NEW_SUMMARY = '周砚秋烧掉第七十三封信，发现自己记住的不是字，而是那天的风。'

/** 假网关：按 mode 返回带改稿块 / 坏块 / 假 anchor 的回答 */
function startMock(mode, requests) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url || ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-edit', object: 'model' }] }))
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
          requests.push({ maxTokens: payload.max_tokens ?? payload.max_completion_tokens })
          const systemMsg = (payload.messages || []).find((m) => m.role === 'system')?.content || ''
          requests[requests.length - 1].hasEditPrompt = systemMsg.includes('mz-edit')

          const isDraftCall = mode === 'newchapter' && !requests[requests.length - 1].hasEditPrompt
          let text = ''
          if (isDraftCall) {
            // 写稿那一次：吐一段够长的正文（约 2600 字），免得长度守护反复补写把用例拖长
            requests[requests.length - 1].kind = 'draft'
            const para =
              '灰线在图纸上从东墙角一直拉到配电房，笔迹很淡，像是有人用左手画的。陈默蹲下去，指尖顺着那条线走，水泥地面上有一层细灰，蹭一下就露出底下的划痕。\n\n'
            text = (para + '线到头，是一个被水泥盖住的接线盒。' + para).repeat(9)
          } else if (mode === 'newchapter') {
            requests[requests.length - 1].kind = 'edit'
            const ops = {
              edits: [
                {
                  op: 'create_chapter',
                  title: '第4章 灰线',
                  summary: '陈默在灰线上看见自己的名字',
                  draft: true
                }
              ]
            }
            text = `这一章该建出去了，大纲和章我一起补上：\n\n\`\`\`mz-edit\n${JSON.stringify(ops)}\n\`\`\`\n`
          } else if (mode === 'apply') {
            const ops = {
              edits: [
                { op: 'replace_paragraph', chapter: '第 1 章', anchor: ANCHOR, after: REWRITE },
                { op: 'set_chapter_summary', chapter: '第 1 章', after: NEW_SUMMARY }
              ]
            }
            text = `结尾那句可以再落一下，我改了两处：\n\n\`\`\`mz-edit\n${JSON.stringify(ops)}\n\`\`\`\n`
          } else if (mode === 'wrongchapter') {
            // 真实用户踩到的场景：AI 报「第 2 章」，引的却是第 1 章的原文
            const ops = {
              edits: [
                {
                  op: 'replace_paragraph',
                  chapter: '第 2 章',
                  anchor: ANCHOR,
                  after: '信封烧到一半时，她把火按灭了，把信收进内兜。'
                }
              ]
            }
            text = `这一处我按你说的改了：\n\n\`\`\`mz-edit\n${JSON.stringify(ops)}\n\`\`\`\n`
          } else if (mode === 'notfound') {
            const ops = { edits: [{ op: 'replace_paragraph', chapter: '第 1 章', anchor: '这句话根本不在正文里。', after: 'x' }] }
            text = `我试着改一下：\n\n\`\`\`mz-edit\n${JSON.stringify(ops)}\n\`\`\`\n`
          } else {
            text = `我这就改：\n\n\`\`\`mz-edit\n{"edits":[{"op":"replace_paragraph","chapter":"第 1 章","anchor":"${ANCHOR}"\n\`\`\`\n`
          }

          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
          const chunk = (delta, finish) => ({
            id: 'e2e',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason: finish ?? null }]
          })
          const parts = text.match(/[\s\S]{1,16}/g) || []
          let i = 0
          const tick = setInterval(() => {
            if (i < parts.length) {
              send(chunk({ content: parts[i] }))
              i++
            } else {
              send(chunk({}, 'stop'))
              res.write('data: [DONE]\n\n')
              res.end()
              clearInterval(tick)
            }
          }, 4)
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

/** 浏览器里跑：发问 → 等流结束 → （可选）预览 → （可选）应用 → 收集状态 */
function driveJs(mode) {
  return `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const btn = (re) => Array.from(document.querySelectorAll('button')).find((b) => re.test(b.textContent.trim()))
  await window.__MZ.openProject('p_demo')
  await sleep(1600)

  const before = window.__MZ.state().project
  const ch1Before = before.chapters[0]
  const snapshot = {
    content: ch1Before.content,
    summary: ch1Before.summary,
    versions: (ch1Before.versions || []).length
  }

  const ta = Array.from(document.querySelectorAll('textarea')).find((t) => (t.placeholder || '').includes('问问 AI'))
  if (!ta) return { ok: false, error: '没找到对话框' }
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setValue.call(ta, '帮我把最后一句改得更有余味，顺手更新一下梗概。')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(250)
  btn(/^发送$/).click()

  const started = Date.now()
  while (Date.now() - started < 60000) {
    await sleep(300)
    if (btn(/^发送$/)) break
  }
  await sleep(700)

  const chat = window.__MZ.state().project.chat
  const last = chat.filter((m) => m.role === 'assistant').at(-1)
  const out = {
    ok: true,
    msgs: chat.length,
    assistantLen: (last?.content || '').length,
    edits: (last?.edits || []).length,
    editsError: last?.editsError || null,
    appliedAt: last?.editsAppliedAt || null,
    rawHasFence: (last?.content || '').includes('mz-edit')
  }

  const openBtn = btn(/查看并应用/)
  out.hasOpenButton = Boolean(openBtn)
  if (!openBtn) {
    out.body = document.body.innerText.slice(0, 1200)
    return out
  }
  openBtn.click()
  await sleep(700)

  out.modalText = (document.querySelector('[role="dialog"]')?.innerText || document.body.innerText).slice(0, 1200)
  const applyBtn = btn(/^应用选中/)
  out.applyLabel = applyBtn ? applyBtn.textContent.trim() : null
  out.applyDisabled = applyBtn ? applyBtn.disabled : null

  if (${mode === 'apply' || mode === 'newchapter' ? 'true' : 'false'} && applyBtn && !applyBtn.disabled) {
    applyBtn.click()
    await sleep(1200)
    const after = window.__MZ.state().project
    const ch1After = after.chapters.find((c) => c.id === '${'ch_1'}')
    out.ch2Content = after.chapters.find((c) => c.id === 'ch_2')?.content || ''
    const chat2 = after.chat
    const last2 = chat2.filter((m) => m.role === 'assistant').at(-1)
    out.changed = ch1After.content !== snapshot.content
    out.contentAfter = ch1After.content
    out.summaryAfter = ch1After.summary
    out.versionsAfter = (ch1After.versions || []).length
    out.appliedAt2 = last2?.editsAppliedAt || null

    if (${mode === 'newchapter' ? 'true' : 'false'}) {
      // 建章 + 写稿：等新章出现且有正文（最多 60 秒）
      const t0 = Date.now()
      let fresh = null
      while (Date.now() - t0 < 60000) {
        const pj = window.__MZ.state().project
        fresh = pj.chapters.find((c) => (c.title || '').includes('灰线'))
        if (fresh && (fresh.content || '').length > 0) break
        await sleep(400)
      }
      const fin = window.__MZ.state().project
      out.chapterTitles = fin.chapters.map((c) => c.title)
      out.outlineChildren = (fin.outline[0]?.children || []).length
      out.outlineHasNode = (fin.outline[0]?.children || []).some((n) => (n.title || '').includes('灰线'))
      out.freshId = fresh?.id || null
      out.freshTitle = fresh?.title || null
      out.freshWords = fresh?.words || 0
      out.freshVersions = (fresh?.versions || []).length
      out.freshLinked = Boolean(fresh?.outlineNodeId)
      out.activeId = window.__MZ.state().activeChapterId
      out.banner = document.body.innerText.includes('写作中') || (last2?.editsAppliedAt || 0) > 0
      // 关键：作者看到的是编辑器里的字。数据里有正文而编辑器是空的，等于这功能不能用。
      const pmsNc = Array.from(document.querySelectorAll('.ProseMirror'))
      out.editorLen = (pmsNc[0]?.innerText || '').length
      const lastNc = window.__MZ.state().project.chat.filter((m) => m.role === 'assistant').at(-1)
      out.draftWords = lastNc?.draftWords || 0
      await sleep(600)
    }
    out.body = document.body.innerText.slice(0, 1200)
  } else {
    out.contentUnchanged = window.__MZ.state().project.chapters[0].content === snapshot.content
    out.versionsAfter = (window.__MZ.state().project.chapters[0].versions || []).length
  }
  // 关键：不能只断言 store。作者看到的是**编辑器里的字**，
  // 数据改了而编辑器没刷新，等于这个功能不能用。
  const pms = Array.from(document.querySelectorAll('.ProseMirror'))
  out.editorText = (pms[0]?.innerText || '').slice(0, 2000)
  out.snapshot = snapshot
  return out
})()
`
}

async function runCase(mode) {
  const requests = []
  const server = await startMock(mode, requests)
  const out = path.join(ROOT, 'shots', `e2e-chatedit-${mode}.png`)
  fs.mkdirSync(path.dirname(out), { recursive: true })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.HOME = path.join(ROOT, '.home')
  env.MOZHOU_USER_DATA = path.join(ROOT, `.testdata-e2e-chatedit-${mode}`)
  env.MOZHOU_SHOT = out
  env.MOZHOU_SHOT_DELAY = '2600'
  env.MOZHOU_SHOT_JS = driveJs(mode)
  env.MOZHOU_SHOT_JS_WAIT = '3000'

  fs.mkdirSync(env.MOZHOU_USER_DATA, { recursive: true })
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.testdata', 'config.json'), 'utf8'))
  cfg.channels = [
    {
      id: 'ch_e2e_edit',
      name: 'e2e-edit',
      protocol: 'openai',
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      headers: {},
      enabled: true,
      presetId: 'custom',
      models: []
    }
  ]
  cfg.models = [{ id: 'm_e2e', channelId: 'ch_e2e_edit', model: 'e2e-edit', enabled: true, label: 'E2E' }]
  cfg.settings.taskModels = { draft: 'm_e2e', outline: 'm_e2e', polish: 'm_e2e', naming: 'm_e2e', summary: 'm_e2e', audit: 'm_e2e', chat: 'm_e2e' }
  cfg.settings.tokenBudgets = { ...(cfg.settings.tokenBudgets || {}), 'chat.reply': { kind: 'fixed', tokens: 12000 } }
  cfg.settings.allowChatEdits = true
  fs.writeFileSync(path.join(env.MOZHOU_USER_DATA, 'config.json'), JSON.stringify(cfg, null, 2))
  const srcProjects = path.join(ROOT, '.testdata', 'projects')
  if (fs.existsSync(srcProjects)) fs.cpSync(srcProjects, path.join(env.MOZHOU_USER_DATA, 'projects'), { recursive: true })
  const libSrc = path.join(ROOT, '.testdata', 'style-library.json')
  if (fs.existsSync(libSrc)) fs.copyFileSync(libSrc, path.join(env.MOZHOU_USER_DATA, 'style-library.json'))

  const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'electron'), ['out/main/index.js', '--no-sandbox', '--disable-gpu'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d.toString()))
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  await new Promise((r) => child.on('exit', r))
  clearTimeout(timer)
  server.close()

  const raw = (stderr.match(/\[mz\] shot-js-result (.*)/) || [])[1]
  let result = null
  try {
    result = raw ? JSON.parse(raw) : null
  } catch {
    result = null
  }
  return { requests, result: result || {}, screenshot: out, mode, stderr }
}

async function main() {
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

  /* ── A. 提了改动 → 预览 → 应用 ── */
  console.log('A. AI 提出 2 处改动并应用')
  const a = await runCase('apply')
  console.log(`  请求：${a.requests.map((r) => r.maxTokens).join(' → ') || '（无）'}`)
  console.log(`  截图：${path.relative(ROOT, a.screenshot)}`)
  check('发出了请求', a.requests.length >= 1, `实际 ${a.requests.length} 次`)
  check('提示词里带了改稿协议', Boolean(a.requests[0]?.hasEditPrompt), 'system 里没有 mz-edit 说明')
  check('解析出 2 处改动', a.result.edits === 2, `实际 ${a.result.edits}`)
  check('回答正文里不留 mz-edit 原文', a.result.rawHasFence === false, '气泡里出现了围栏')
  check('气泡上有「查看并应用」', Boolean(a.result.hasOpenButton))
  check('正文真的改了', a.result.changed === true && String(a.result.contentAfter || '').includes('那天的风'), String(a.result.contentAfter || '').slice(0, 80))
  check('梗概也改了', a.result.summaryAfter === NEW_SUMMARY, a.result.summaryAfter)
  check('章节版本多了一份快照', (a.result.versionsAfter || 0) === (a.result.snapshot?.versions || 0) + 1, `${a.result.snapshot?.versions} → ${a.result.versionsAfter}`)
  check('气泡标成「已应用」', Boolean(a.result.appliedAt2))
  check('编辑器里也真的换了字（不是只改数据）', String(a.result.editorText || '').includes('那天的风'), String(a.result.editorText || '').slice(0, 80))

  /* ── B. anchor 对不上 ── */
  console.log('\nB. anchor 对不上（不许改任何东西）')
  const b = await runCase('notfound')
  console.log(`  截图：${path.relative(ROOT, b.screenshot)}`)
  check('解析出 1 处改动', b.result.edits === 1, `实际 ${b.result.edits}`)
  check('气泡上有「查看并应用」', Boolean(b.result.hasOpenButton))
  check('预览里说找不到原文', /找不到原文/.test(b.result.modalText || ''), (b.result.modalText || '').slice(0, 120))
  check('应用按钮是禁用的', b.result.applyDisabled === true, `applyDisabled=${b.result.applyDisabled}`)
  check('正文一个字没改', b.result.contentUnchanged === true)
  check('没产生版本快照', (b.result.versionsAfter || 0) === (b.result.snapshot?.versions || 0), `${b.result.snapshot?.versions} → ${b.result.versionsAfter}`)

  /* ── B2. AI 报错章节（真实场景） ── */
  console.log('\nB2. AI 把章节号写错，但引文是逐字的（章节已修正）')
  const w = await runCase('wrongchapter')
  if (process.env.E2E_DEBUG) console.log('  stderr:', (w.stderr || '').slice(-1500))
  console.log(`  截图：${path.relative(ROOT, w.screenshot)}`)
  check('解析出 1 处改动', w.result.edits === 1, `实际 ${w.result.edits}`)
  check('预览里标出「章节已修正」', /章节已修正/.test(w.result.modalText || ''), (w.result.modalText || '').slice(0, 120))
  check('预览里指到了真正的章', /第 1 章/.test(w.result.modalText || ''), (w.result.modalText || '').slice(0, 120))
  check('可以应用（不是 0 处）', w.result.applyDisabled === false, `applyDisabled=${w.result.applyDisabled}`)
  check('这一轮不动稿子（只在预览里确认）', w.result.contentUnchanged === true)
  check('没有任何章被改动', (w.result.versionsAfter || 0) === (w.result.snapshot?.versions || 0))

  /* ── D. 建章 + 写稿 ── */
  console.log('\nD. 对话建章并当场写稿（newchapter）')
  const nc = await runCase('newchapter')
  if (process.env.E2E_DEBUG) console.log('  stderr:', (nc.stderr || '').slice(-2000))
  console.log(`  截图：${path.relative(ROOT, nc.screenshot)}`)
  console.log(`  请求：${(nc.requests || []).map((r) => r.kind || '-').join(' → ') || '（无）'}`)
  check('两次模型调用（对话 + 写稿）', (nc.requests || []).length >= 2, `实际 ${(nc.requests || []).length}`)
  check('第一次是对话、第二次是写稿', nc.requests[0]?.kind === 'edit' && nc.requests[1]?.kind === 'draft', (nc.requests || []).map((r) => r.kind).join(','))
  check('预览里出现「新增章节」', /新增章节/.test(nc.result.modalText || ''), (nc.result.modalText || '').slice(0, 160))
  check('预览里同时给出大纲节点', /新增大纲节点/.test(nc.result.modalText || ''), (nc.result.modalText || '').slice(0, 160))
  check('应用后书里多了一章', (nc.result.chapterTitles || []).length === 4, JSON.stringify(nc.result.chapterTitles))
  check('新章标题是第4章 灰线', nc.result.freshTitle === '第4章 灰线', String(nc.result.freshTitle))
  check('大纲里多了对应节点', nc.result.outlineHasNode === true, `children=${nc.result.outlineChildren}`)
  check('新章挂到了大纲节点上', nc.result.freshLinked === true)
  check('写稿写出了正文', (nc.result.freshWords || 0) > 0, `words=${nc.result.freshWords}`)
  check('新章留了版本快照', (nc.result.freshVersions || 0) >= 1, String(nc.result.freshVersions))
  check('界面切到了新章', nc.result.activeId === nc.result.freshId, `${nc.result.activeId} vs ${nc.result.freshId}`)
  check('编辑器里真的显示了新章正文', (nc.result.editorLen || 0) > 200, `editorLen=${nc.result.editorLen}`)
  check('气泡标了「已写入 N 字」', (nc.result.draftWords || 0) > 0, `draftWords=${nc.result.draftWords}`)

  /* ── C. 格式坏了 ── */
  console.log('\nC. 改稿块 JSON 坏了（要说人话）')
  const c = await runCase('malformed')
  console.log(`  截图：${path.relative(ROOT, c.screenshot)}`)
  check('自然语言回答保留下来', (c.result.assistantLen || 0) > 0, `len=${c.result.assistantLen}`)
  check('记下了错误原因', Boolean(c.result.editsError), String(c.result.editsError))
  check('没有产生可应用的改动', (c.result.edits || 0) === 0, `edits=${c.result.edits}`)

  console.log(`\n${fail === 0 ? '端到端通过' : '端到端失败'}：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})