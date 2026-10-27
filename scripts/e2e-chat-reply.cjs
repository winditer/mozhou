#!/usr/bin/env node
/**
 * 端到端验收：右侧「AI 对话」的两种断法。
 *
 *   node scripts/e2e-chat-reply.cjs
 *
 * 用户原话：「写作页面右侧的 AI 对话，总是中断，是被限制 token 吗？」
 * 这里用假网关复现两条真实路径，断言的重点不是「模型能不能答」，而是：
 *
 *   A. starve（思考把额度吃光，正文为空）
 *      1. 请求带的 max_tokens 必须是**设置里配的对话预算**——旧实现忘了把
 *         tokenBudgets 传给 generateChatReply，导致设置页改多少都无效；
 *      2. 正文为空要**自动重试**，且重试额度要抬高（同额度重试只会再空一次）；
 *      3. 两次都空时**不许往对话里塞一个空气泡**，并且要说明原因和办法。
 *
 *   B. truncate（有正文但被 max_tokens 截断）
 *      1. 半截回答要留下来（比丢掉有用）；
 *      2. 但必须标成「已截断」，否则用户只会以为 AI 又断了。
 */
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.E2E_PORT || 8811)
const CHAT_BUDGET = 9000 // 故意设成非默认值，用来证明预算真的传下去了

/** 假网关：starve = 只吐思考后以 length 收尾；truncate = 吐半句正文后 length */
function startMock(mode, requests) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url || ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-chat', object: 'model' }] }))
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
          const maxTokens = payload.max_tokens ?? payload.max_completion_tokens
          requests.push({ maxTokens })
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
          const chunk = (delta, finish) => ({
            id: 'e2e',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason: finish ?? null }]
          })

          let i = 0
          const tick = setInterval(() => {
            if (mode === 'starve') {
              if (i < 6) {
                send(chunk({ reasoning_content: `第 ${i + 1} 步：先把人物动机和本章落点过一遍。` }))
                i++
              } else {
                send(chunk({}, 'length'))
                send({ id: 'e2e', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 900, completion_tokens: Number(maxTokens) || 0 } })
                res.write('data: [DONE]\n\n')
                res.end()
                clearInterval(tick)
              }
              return
            }
            // truncate：吐半句话就被截断
            const text = '先把这一章的落点想清楚：主角要在这里丢掉一样东西，读者才会跟着疼。建议把雨停的时间点挪到对话之后，'
            const parts = text.match(/[\s\S]{1,14}/g) || []
            if (i < parts.length) {
              send(chunk({ content: parts[i] }))
              i++
            } else {
              send(chunk({}, 'length'))
              res.write('data: [DONE]\n\n')
              res.end()
              clearInterval(tick)
            }
          }, 5)
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

const DRIVE_JS = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  await window.__MZ.openProject('p_demo')
  await sleep(1600)
  const ta = Array.from(document.querySelectorAll('textarea')).find((t) => (t.placeholder || '').includes('问问 AI'))
  if (!ta) return { ok: false, error: '没找到对话框' }
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setValue.call(ta, '帮我分析这一章的问题，并补全结尾。')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(300)
  const send = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '发送')
  if (!send) return { ok: false, error: '没找到发送按钮' }
  send.click()

  // 等到流结束：发送按钮重新出现（streaming 为 false 时按钮文案是「发送」）
  const started = Date.now()
  while (Date.now() - started < 60000) {
    await sleep(400)
    const idle = Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === '发送')
    if (idle) break
  }
  await sleep(600)

  const chat = window.__MZ.state().project.chat
  const body = document.body.innerText
  return {
    ok: true,
    msgs: chat.length,
    assistant: chat.filter((m) => m.role === 'assistant').map((m) => ({ len: (m.content || '').length, truncated: Boolean(m.truncated) })),
    hasBadge: /已截断/.test(body),
    toast: (body.match(/(额度|思考|截断|输出预算)[^\\n]{0,80}/) || [''])[0]
  }
})()
`

async function runCase(name, mode) {
  const requests = []
  const server = await startMock(mode, requests)
  const out = path.join(ROOT, 'shots', `e2e-chat-${mode}.png`)
  fs.mkdirSync(path.dirname(out), { recursive: true })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.HOME = path.join(ROOT, '.home')
  env.MOZHOU_USER_DATA = path.join(ROOT, `.testdata-e2e-chat-${mode}`)
  env.MOZHOU_SHOT = out
  env.MOZHOU_SHOT_DELAY = '2600'
  env.MOZHOU_SHOT_JS = DRIVE_JS
  env.MOZHOU_SHOT_JS_WAIT = '2000'

  fs.mkdirSync(env.MOZHOU_USER_DATA, { recursive: true })
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.testdata', 'config.json'), 'utf8'))
  cfg.channels = [
    {
      id: 'ch_e2e_chat',
      name: 'e2e-chat',
      protocol: 'openai',
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      headers: {},
      enabled: true,
      presetId: 'custom',
      models: []
    }
  ]
  cfg.models = [{ id: 'm_e2e', channelId: 'ch_e2e_chat', model: 'e2e-chat', enabled: true, label: 'E2E' }]
  cfg.settings.taskModels = { draft: 'm_e2e', outline: 'm_e2e', polish: 'm_e2e', naming: 'm_e2e', summary: 'm_e2e', audit: 'm_e2e', chat: 'm_e2e' }
  cfg.settings.tokenBudgets = { ...(cfg.settings.tokenBudgets || {}), 'chat.reply': { kind: 'fixed', tokens: CHAT_BUDGET } }
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
  return { requests, result: result || {}, screenshot: out, mode, name }
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

  /* ── A. 思考吃光额度 ── */
  console.log('A. 模型只吐思考、正文为空（starve）')
  const starve = await runCase('空正文', 'starve')
  console.log(`  请求：${starve.requests.map((r) => r.maxTokens).join(' → ') || '（无）'}`)
  console.log(`  截图：${path.relative(ROOT, starve.screenshot)}`)
  check('发出了请求', starve.requests.length >= 1, `实际 ${starve.requests.length} 次`)
  check('首轮用的是设置里的对话预算', starve.requests[0]?.maxTokens === CHAT_BUDGET, `收到 ${starve.requests[0]?.maxTokens}，配置 ${CHAT_BUDGET}`)
  check('空正文触发了重试', starve.requests.length >= 2, `实际 ${starve.requests.length} 次`)
  if (starve.requests.length >= 2) {
    check('重试时抬高了额度', starve.requests[1].maxTokens > starve.requests[0].maxTokens, `${starve.requests[0].maxTokens} → ${starve.requests[1].maxTokens}`)
  }
  check('没有把空气泡写进对话', (starve.result.assistant || []).every((m) => m.len > 0), JSON.stringify(starve.result.assistant))
  check('界面说明了原因', /思考|额度|输出预算/.test(starve.result.toast || ''), `toast=${starve.result.toast}`)

  /* ── B. 有正文但被截断 ── */
  console.log('\nB. 有正文但被 max_tokens 截断（truncate）')
  const trunc = await runCase('被截断', 'truncate')
  console.log(`  请求：${trunc.requests.map((r) => r.maxTokens).join(' → ') || '（无）'}`)
  console.log(`  截图：${path.relative(ROOT, trunc.screenshot)}`)
  const last = (trunc.result.assistant || []).at(-1)
  check('半截回答留下来', Boolean(last && last.len > 0), JSON.stringify(trunc.result.assistant))
  check('回答被标记为已截断', Boolean(last && last.truncated), JSON.stringify(last))
  check('界面上能看到「已截断」', Boolean(trunc.result.hasBadge), '没找到徽标文案')

  console.log(`\n${fail === 0 ? '端到端通过' : '端到端失败'}：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})