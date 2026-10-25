#!/usr/bin/env node
/**
 * 端到端验收：假网关 + 真 Electron，验证「思考很久、最后一片空白」时用户看到什么。
 *
 *   node scripts/e2e-thought-starved.cjs
 *
 * 用户原话：「有时候思考很久，生成空白」。这里模拟最典型的那种情形：
 * 推理模型把整份 max_tokens 全花在 reasoning_content 上，正文一个字都不给。
 *
 * 断言的重点不是「能写出来」（这种模型本来就可能写不出来），而是：
 *   1. 应用**自动重试**了一次（不能试都不试就交空白）；
 *   2. 重试时把额度抬高了（否则同一份预算重试只会再空一次）；
 *   3. 两次都空时，界面**明确说明原因和怎么办**，而不是只写「生成完成」。
 */
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.E2E_PORT || 8803)
const OUT = path.join(ROOT, 'shots', 'e2e-thought-starved.png')

const requests = []

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url || '').endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-thinker', object: 'model' }] }))
        return
      }
      if (req.method === 'POST' && (req.url || '').includes('/chat/completions')) {
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
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          // 一直只吐思考，然后以 length 收尾（= 额度被思考吃光）
          let i = 0
          const tick = setInterval(() => {
            if (i < 6) {
              res.write(
                `data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: `第 ${i + 1} 步：人物的动机要和缺陷咬合，场景要能承住情绪。` }, finish_reason: null }] })}\n\n`
              )
              i++
            } else {
              res.write(
                `data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`
              )
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
  const app = window.__MZ
  if (app && app.openProject) await app.openProject('p_demo')
  await sleep(1200)
  const btn = Array.from(document.querySelectorAll('button')).find((b) => /续写|接着这半句/.test(b.textContent || ''))
  if (!btn) return { ok: false, error: '没找到续写按钮' }
  btn.click()
  const started = Date.now()
  let modalText = ''
  while (Date.now() - started < 45000) {
    await sleep(400)
    modalText = document.querySelector('[data-mz-modal]')?.textContent || ''
    const done = Array.from(document.querySelectorAll('button')).some((b) => /重新生成/.test(b.textContent || ''))
    if (done) break
  }
  return { ok: true, modalText, elapsed: Date.now() - started }
})()
`

async function main() {
  const server = await startMock()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.HOME = path.join(ROOT, '.home')
  env.MOZHOU_USER_DATA = path.join(ROOT, '.testdata-e2e-starved')
  env.MOZHOU_SHOT = OUT
  env.MOZHOU_SHOT_DELAY = '2600'
  env.MOZHOU_SHOT_JS = DRIVE_JS
  env.MOZHOU_SHOT_JS_WAIT = '1500'

  fs.mkdirSync(env.MOZHOU_USER_DATA, { recursive: true })
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.testdata', 'config.json'), 'utf8'))
  for (const ch of cfg.channels) ch.baseUrl = `http://127.0.0.1:${PORT}/v1`
  cfg.models = [{ id: 'm_e2e', channelId: cfg.channels[0].id, model: 'e2e-thinker', enabled: true, label: 'E2E-Thinker' }]
  cfg.settings.taskModels = { draft: 'm_e2e', outline: 'm_e2e', polish: 'm_e2e', naming: 'm_e2e', summary: 'm_e2e', audit: 'm_e2e', chat: 'm_e2e' }
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
  const timer = setTimeout(() => child.kill('SIGKILL'), 80_000)
  await new Promise((r) => child.on('exit', r))
  clearTimeout(timer)
  server.close()

  const jsResult = (stderr.match(/\[mz\] shot-js-result (.*)/) || [])[1]
  let result = null
  try {
    result = jsResult ? JSON.parse(jsResult) : null
  } catch {
    result = null
  }

  console.log('假网关收到的请求：', requests.length, '次')
  requests.forEach((r, i) => console.log(`  #${i + 1} maxTokens=${r.maxTokens}`))
  const text = (result && result.modalText) || ''
  console.log('弹窗文案摘录：', text.slice(-500))

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
  check('发出了请求', requests.length >= 1, `实际 ${requests.length} 次`)
  check('空正文触发了重试（≥2 次请求）', requests.length >= 2, `实际 ${requests.length} 次`)
  if (requests.length >= 2) {
    check(
      '重试时把额度抬高了（否则再空一次）',
      requests[1].maxTokens > requests[0].maxTokens,
      `首轮 ${requests[0].maxTokens} / 重试 ${requests[1].maxTokens}`
    )
  }
  check('界面说明了「额度被思考吃光」', /思考/.test(text), '文案里没提到思考')
  check('界面给出了可执行的解决办法', /非推理模型|输出预算|额度调大/.test(text), '没有给出解决办法')
  check('没有伪装成「生成完成」', !/^生成完成$/.test(text.trim()), '仍然只显示生成完成')

  console.log(`\n${fail === 0 ? '端到端通过' : '端到端失败'}：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})