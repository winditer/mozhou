#!/usr/bin/env node
/**
 * 「结构化任务关思考」的回归测试（开发用，不进入产品包）。
 *
 * 背景：体检这类任务的输出是固定结构的 JSON，不需要深推理；而 DeepSeek 系模型默认开思考，
 * reasoning token 和正文共用 max_tokens，思考先吃掉大半额度后 JSON 只能写一半甚至为空。
 * 修法是给请求加 `thinking: 'off'`，只在支持该开关的渠道（DeepSeek）实际发出去。
 *
 *   node scripts/test-thinking-switch.cjs
 *
 * 钉住四件事：
 *   1. DeepSeek 渠道 + thinking:'off' → 请求体里是 thinking:{type:'disabled'}
 *   2. 非 DeepSeek 渠道 + thinking:'off' → 请求体里**没有** thinking（发了会 400）
 *   3. 不传 thinking（普通生成）→ 请求体里也没有 thinking，行为不变
 *   4. 网关 400 说不认识 thinking → 自动摘掉重试一次，请求最终成功
 *
 * 做法与 test-empty-completion.cjs 一致：起假网关 + esbuild 打包真 registry.ts。
 */
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.AI_THINKING_TEST_PORT || 8813)

let assertions = 0
function check(problems, cond, message) {
  assertions += 1
  if (!cond) problems.push(message)
}

function loadRegistry() {
  const outfile = path.join(os.tmpdir(), `mozhou-thinking-ai-${process.pid}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src/main/ai/registry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    logLevel: 'silent'
  })
  return require(outfile)
}

/* ─────────────────────────── 假网关 ─────────────────────────── */

/** 这次运行收到的全部请求体，按到达顺序 */
let bodies = []

function startServer() {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(raw)
      } catch {
        /* ignore */
      }
      bodies.push({ url: req.url, body: payload })

      // /reject/ 前缀的渠道「不认识」thinking 这个字段
      if ((req.url || '').startsWith('/reject/') && payload.thinking !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unknown parameter: thinking' } }))
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      if (typeof res.flushHeaders === 'function') res.flushHeaders()
      const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '[]' }, finish_reason: null }] })
      chunk({
        id: 'mock',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 2 }
      })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)))
}

/* ─────────────────────────── 场景 ─────────────────────────── */

function channel(presetId, basePath) {
  return {
    id: `ch_${presetId}`,
    name: presetId,
    protocol: 'openai',
    presetId,
    baseUrl: `http://127.0.0.1:${PORT}${basePath}`,
    headers: {},
    enabled: true
  }
}

const scenarios = [
  {
    name: 'deepseek-off',
    channel: channel('deepseek', '/v1'),
    thinking: 'off',
    why: 'DeepSeek 渠道关思考：请求体必须带 thinking:{type:"disabled"}',
    expect({ problems, body, error, text }) {
      check(problems, !error, `不该报错：${error && error.message}`)
      const t = body && body.thinking
      check(problems, Boolean(t) && t.type === 'disabled', `thinking 应为 {type:'disabled'}，实际 ${JSON.stringify(t)}`)
      check(problems, text === '[]', `正文应完整收到，实际 ${JSON.stringify(text)}`)
    }
  },
  {
    name: 'deepseek-default',
    channel: channel('deepseek', '/v1'),
    thinking: undefined,
    why: '不传 thinking 时行为不变：DeepSeek 也不该收到该字段',
    expect({ problems, body, error }) {
      check(problems, !error, `不该报错：${error && error.message}`)
      check(problems, body && body.thinking === undefined, `普通生成不该带 thinking，实际 ${JSON.stringify(body && body.thinking)}`)
    }
  },
  {
    name: 'other-off',
    channel: channel('openai', '/v1'),
    thinking: 'off',
    why: '非 DeepSeek 渠道即使请求关思考也不发该字段（发了会 400）',
    expect({ problems, body, error }) {
      check(problems, !error, `不该报错：${error && error.message}`)
      check(problems, body && body.thinking === undefined, `不该把 thinking 发给非 DeepSeek 渠道，实际 ${JSON.stringify(body && body.thinking)}`)
    }
  },
  {
    name: 'reject-retry',
    channel: channel('deepseek', '/reject/v1'),
    thinking: 'off',
    why: '网关不认 thinking：自动摘掉重试一次并成功',
    expect({ problems, requests, error, text }) {
      check(problems, !error, `不该报错：${error && error.message}`)
      check(problems, requests.length === 2, `应重试一次，实际 ${requests.length} 次请求`)
      check(problems, requests[0] && requests[0].body.thinking !== undefined, '第一次请求应带着 thinking')
      check(problems, requests[1] && requests[1].body.thinking === undefined, '重试应摘掉 thinking')
      check(problems, text === '[]', `重试后正文应完整，实际 ${JSON.stringify(text)}`)
    }
  }
]

function withWatchdog(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('测试自身看门狗超时')), ms))])
}

async function runScenario(registry, s) {
  bodies = []
  let text = ''
  let error = null
  try {
    await withWatchdog(
      registry.streamChat(
        {
          streamId: `s_${s.name}`,
          channel: s.channel,
          apiKey: 'mock-key',
          model: 'mock-json',
          messages: [{ role: 'user', content: '体检' }],
          temperature: 0.2,
          maxTokens: 4096,
          task: 'audit',
          ...(s.thinking ? { thinking: s.thinking } : {})
        },
        (d) => {
          text += d
        }
      ),
      20_000
    )
  } catch (e) {
    error = e
  }
  const chat = bodies.filter((b) => (b.url || '').includes('/chat/completions'))
  const problems = []
  s.expect({ problems, body: chat[0] && chat[0].body, requests: chat, error, text })
  return { name: s.name, ok: problems.length === 0, problems, requests: chat.length }
}

/* ─────────────────────────── main ─────────────────────────── */

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const picked = only.length ? scenarios.filter((s) => only.includes(s.name)) : scenarios
  if (!picked.length) {
    console.error(`没有匹配的场景。可选：${scenarios.map((s) => s.name).join(', ')}`)
    process.exit(2)
  }

  const registry = loadRegistry()
  const server = await startServer()
  console.log(`假网关已启动 http://127.0.0.1:${PORT}`)

  const results = []
  for (const s of picked) {
    const r = await runScenario(registry, s)
    results.push(r)
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(15)} ${String(r.requests).padStart(2)} 次请求  ${s.why}`)
    for (const p of r.problems) console.error(`      ✗ ${p}`)
  }

  server.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 场景通过 · ${assertions} 条断言`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})