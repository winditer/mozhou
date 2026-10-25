#!/usr/bin/env node
/**
 * 端到端验收：假网关 + 真 Electron，验证「续写字数不够会自动补写」。
 *
 *   node scripts/e2e-length-guard.cjs
 *
 * 为什么需要这一层：单测（test-topup-length-guard.mjs）证明的是 generate.ts 的逻辑，
 * 证明不了「写作页那个按钮真的走到了它」。这条链路中间还隔着 Workspace 的
 * existingWords 计算、GenModal 的 stage 显示、以及主进程流式解析——
 * 任何一环把 onStage 吞掉或把 delta 丢帧，用户看到的还是「字数不够」。
 *
 * 做法：起一个假 OpenAI 网关，第一次请求只吐 500 字（故意远低于目标），
 * 之后每次吐 1200 字，并记录收到了几次请求。再用 MOZHOU_SHOT_JS 驱动应用
 * 点「续写」，读回 GenModal 的最终字数与 stage 文案。
 */
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.E2E_PORT || 8802)
const OUT = path.join(ROOT, 'shots', 'e2e-length-guard.png')

/** 每段正文：约 100 字，方便按段数控制总数 */
const SEG = '雨落在瓦上，一层一层地压下去，巷子里没有人声。他推开门，潮湿的风裹着远处寺庙的钟声涌进来，桌上的铜钱被吹得轻轻一响。'

const requests = []
let planIndex = 0
/** 第 1 次给 5 段（约 500 字），之后每次给 12 段（约 1200 字） */
function planFor() {
  const i = planIndex++
  return i === 0 ? SEG.repeat(5) : SEG.repeat(12)
}

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url || '').endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-writer', object: 'model' }] }))
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
          const text = planFor()
          requests.push({
            maxTokens: payload.max_tokens ?? payload.max_completion_tokens,
            roles: (payload.messages || []).map((m) => m.role),
            contentHasText: JSON.stringify(payload.messages || []).includes('已经写出来的正文')
          })
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
          })
          const parts = text.match(/[\s\S]{1,40}/g) || []
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

/**
 * 被注入到渲染进程的脚本。
 *
 * 注意：这里不能直接 import generate.ts，只能操作界面与 window。
 * 通过点击「续写」按钮触发真实链路，然后轮询 GenModal 里的字数 chip。
 */
const DRIVE_JS = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // 打开一本测试书（seed 脚本里的 p_demo）
  const open = async () => {
    const app = window.__MZ
    if (app && app.openProject) { await app.openProject('p_demo'); return true }
    return false
  }
  await open()
  await sleep(1200)

  // 找到「续写」按钮（文本包含 续写 / 接着这半句）
  const findBtn = () => Array.from(document.querySelectorAll('button')).find((b) => /续写|接着这半句/.test(b.textContent || ''))
  const btn = findBtn()
  if (!btn) return { ok: false, error: '没找到续写按钮', buttons: Array.from(document.querySelectorAll('button')).map(b=>b.textContent).slice(0,40) }
  btn.click()

  // 轮询到生成结束：读 .chip（字数）与 footer 的 stage 文案
  const started = Date.now()
  let last = {}
  while (Date.now() - started < 60000) {
    await sleep(500)
    const chip = Array.from(document.querySelectorAll('.chip')).map((n) => n.textContent || '').find((t) => /字/.test(t))
    const footer = document.querySelector('[data-mz-modal]') ? document.querySelector('[data-mz-modal]').textContent : document.body.textContent
    const stageLine = (footer || '').match(/已收到 \\d+ 字[^。]*|篇幅不足[^。]*|正在补写第 \\d+ 轮[^。]*|已完成|生成完成/g)
    last = { chip, stage: stageLine ? stageLine.slice(-3) : null, t: Date.now() - started }
    // 「重新生成」按钮出现 = 跑完了
    const done = Array.from(document.querySelectorAll('button')).some((b) => /重新生成/.test(b.textContent || ''))
    if (done && chip) break
  }
  const modal = document.querySelector('[data-mz-modal]')
  const bodyText = modal?.textContent || ''
  // footer 里那段状态文案（stage + 字数 chip），单独抓出来方便断言
  const footerText = modal ? Array.from(modal.querySelectorAll('div')).map((d) => d.textContent || '').filter((t) => /生成完成|已完成|补写|字/.test(t)).slice(-4) : []
  return { ok: true, ...last, bodyLen: bodyText.length, footerText, tail: bodyText.slice(-400) }
})()
`

async function main() {
  const server = await startMock()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.HOME = path.join(ROOT, '.home')
  env.MOZHOU_USER_DATA = path.join(ROOT, '.testdata-e2e')
  env.MOZHOU_SHOT = OUT
  env.MOZHOU_SHOT_DELAY = '2600'
  env.MOZHOU_SHOT_JS = DRIVE_JS
  env.MOZHOU_SHOT_JS_WAIT = '1500'

  // 用独立的 userData 目录，避免污染 .testdata，并把它指向假网关
  fs.mkdirSync(env.MOZHOU_USER_DATA, { recursive: true })
  const cfgSrc = path.join(ROOT, '.testdata', 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgSrc, 'utf8'))
  // 把所有渠道都换成假网关，并把正文任务指向它
  for (const ch of cfg.channels) ch.baseUrl = `http://127.0.0.1:${PORT}/v1`
  cfg.models = [{ id: 'm_e2e', channelId: cfg.channels[0].id, model: 'e2e-writer', enabled: true, label: 'E2E' }]
  cfg.settings.taskModels = { draft: 'm_e2e', outline: 'm_e2e', polish: 'm_e2e', naming: 'm_e2e', summary: 'm_e2e', audit: 'm_e2e', chat: 'm_e2e' }
  fs.writeFileSync(path.join(env.MOZHOU_USER_DATA, 'config.json'), JSON.stringify(cfg, null, 2))
  // 复制项目与文风库
  const srcProjects = path.join(ROOT, '.testdata', 'projects')
  if (fs.existsSync(srcProjects)) {
    fs.cpSync(srcProjects, path.join(env.MOZHOU_USER_DATA, 'projects'), { recursive: true })
  }
  const libSrc = path.join(ROOT, '.testdata', 'style-library.json')
  if (fs.existsSync(libSrc)) fs.copyFileSync(libSrc, path.join(env.MOZHOU_USER_DATA, 'style-library.json'))

  const bin = path.join(ROOT, 'node_modules', '.bin', 'electron')
  const child = spawn(bin, ['out/main/index.js', '--no-sandbox', '--disable-gpu'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d.toString()))
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
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
  requests.forEach((r, i) => {
    console.log(
      `  #${i + 1} maxTokens=${r.maxTokens} roles=${r.roles.join(',')} 带已写正文=${r.contentHasText}`
    )
  })
  console.log('渲染层回报：', JSON.stringify(result, null, 2).slice(0, 1200))

  /* ── 断言 ── */
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
  check('真的发出了请求（链路走得通）', requests.length >= 1, `实际 ${requests.length} 次`)
  check('触发了补写（≥2 次请求）', requests.length >= 2, `实际 ${requests.length} 次`)
  if (requests.length >= 2) {
    check(
      '补写轮预算不大于首轮（随剩余递减）',
      requests[1].maxTokens <= requests[0].maxTokens,
      `首轮 ${requests[0].maxTokens} / 补写 ${requests[1].maxTokens}`
    )
    check('补写轮带上了「已经写出来的正文」', requests[1].contentHasText === true)
    check('补写轮没有 assistant 消息', !requests[1].roles.includes('assistant'), requests[1].roles.join(','))
  }
  check('界面报告了字数且超过首轮 500 字', Boolean(result && result.chip && parseInt(result.chip, 10) > 600), JSON.stringify(result && result.chip))
  check('过程文案里出现过补写提示', Boolean(result && result.stage && result.stage.some((s) => /补写/.test(s))), JSON.stringify(result && result.stage))

  console.log(`\n${fail === 0 ? '端到端通过' : '端到端失败'}：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})