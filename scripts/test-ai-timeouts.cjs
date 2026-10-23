#!/usr/bin/env node
/**
 * AI 流式超时回归测试（开发用，不进入产品包）。
 *
 * 覆盖「模型确实在思考 / 网关只在心跳 / 网关忽略 stream」等慢响应场景，
 * 确认它们不会被误判成超时；同时确认真的断流的请求仍然会及时中止。
 *
 *   node scripts/test-ai-timeouts.cjs                # 跑全部场景
 *   node scripts/test-ai-timeouts.cjs thinking       # 只跑某个场景
 *
 * 判定用的空闲上限默认 1200ms，可用 AI_TEST_IDLE_MS 覆盖；
 * 脚本会在 require 之前注入 MOZHOU_AI_IDLE_TIMEOUT_MS，让 registry 使用同一数值。
 */
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.AI_TEST_PORT || 8799)
const IDLE_MS = Number(process.env.AI_TEST_IDLE_MS || 1200)

// registry 在模块加载时读取该变量，必须先设好再 require
process.env['MOZHOU_AI_IDLE_TIMEOUT_MS'] = String(IDLE_MS)

/* ─────────────────────────── 编译被测模块 ─────────────────────────── */

function loadRegistry() {
  const outfile = path.join(os.tmpdir(), `mozhou-ai-${process.pid}.cjs`)
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

const CONTENT = ['周砚秋|主角|27|旧城修表匠|', '左手虎口有一道旧疤|', '寡言，认死理|', '想赎回被抵押的铺子|', '不肯求人|', '从自保到替人挡刀|', '短句，急了才多说']

function openStream(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
}

function sendDelta(res, delta) {
  res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
}

function finishStream(res) {
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 每个模型名对应一种网关行为，方便按场景切换 */
const behaviours = {
  /** 先长时间吐 reasoning_content（思考），正文要等到思考结束 */
  'mock-thinking'(res) {
    openStream(res)
    sendDelta(res, { role: 'assistant' })
    let i = 0
    const timer = setInterval(() => {
      if (i < 15) {
        sendDelta(res, { reasoning_content: `想一想第 ${i + 1} 步：人物的动机要和缺陷咬合。` })
        i += 1
      } else {
        clearInterval(timer)
        for (const part of CONTENT) sendDelta(res, { content: part })
        finishStream(res)
      }
    }, 60)
    res.on('close', () => clearInterval(timer))
  },

  /** 只发 SSE 注释心跳，正文要等上游排队结束 */
  'mock-heartbeat'(res) {
    openStream(res)
    let i = 0
    const timer = setInterval(() => {
      if (i < 9) {
        res.write(': keep-alive\n\n')
        i += 1
      } else {
        clearInterval(timer)
        for (const part of CONTENT) sendDelta(res, { content: part })
        finishStream(res)
      }
    }, 100)
    res.on('close', () => clearInterval(timer))
  },

  /** 网关忽略 stream:true，等整段生成完再一次性返回 JSON */
  'mock-buffered'(res) {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: CONTENT.join('') }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 88, completion_tokens: 66 }
        })
      )
    }, 700)
  },

  /** 连接建立后一个字都不给 */
  'mock-dead'(res) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    // 什么都不写，保持连接直到客户端超时中止
  },

  /** 先给一段正文，然后断流（不再有任何事件） */
  'mock-idle'(res) {
    openStream(res)
    sendDelta(res, { content: '周砚秋' })
    // 之后保持沉默
  },

  /** 正常流式 */
  'mock-normal'(res) {
    openStream(res)
    for (const part of CONTENT) sendDelta(res, { content: part })
    finishStream(res)
  }
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: Object.keys(behaviours).map((id) => ({ id, object: 'model' })) }))
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        /* ignore */
      }
      const behave = behaviours[payload.model]
      if (!behave) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `unknown mock model: ${payload.model}` } }))
        return
      }
      behave(res)
    })
  })
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)))
}

/* ─────────────────────────── 场景与断言 ─────────────────────────── */

const channel = {
  id: 'ch_mock',
  name: 'Mock',
  protocol: 'openai',
  baseUrl: `http://127.0.0.1:${PORT}/v1`,
  headers: {},
  enabled: true
}

const scenarios = [
  {
    name: 'thinking',
    model: 'mock-thinking',
    expect: 'ok',
    why: '模型在吐 reasoning_content，不能当成没响应'
  },
  {
    name: 'heartbeat',
    model: 'mock-heartbeat',
    expect: 'ok',
    why: '网关只发心跳注释，连接是活的'
  },
  {
    name: 'buffered',
    model: 'mock-buffered',
    expect: 'ok',
    why: '网关忽略 stream，一次性返回 JSON'
  },
  {
    name: 'normal',
    model: 'mock-normal',
    expect: 'ok',
    why: '普通流式响应'
  },
  {
    name: 'dead',
    model: 'mock-dead',
    expect: 'error',
    match: /秒没有收到|响应超过|超时/,
    why: '真的收不到任何字节，必须在空闲上限后中止'
  },
  {
    name: 'idle',
    model: 'mock-idle',
    expect: 'error',
    match: /没有输出新内容|中断|超时/,
    why: '吐了一小段就断流，不能无限等下去'
  }
]

function withWatchdog(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('测试自身看门狗超时')), ms))
  ])
}

async function runScenario(registry, s) {
  const started = Date.now()
  let text = ''
  let thought = ''
  let error = null
  const deltas = []
  try {
    const usage = await withWatchdog(
      registry.streamChat(
        {
          streamId: `s_${s.name}`,
          channel,
          apiKey: 'mock-key',
          model: s.model,
          messages: [{ role: 'user', content: '设计 5 个核心人物' }],
          temperature: 0.85,
          maxTokens: 1024
        },
        (d) => {
          text += d
          deltas.push(d)
        },
        (d) => {
          thought += d
        }
      ),
      Math.max(15_000, IDLE_MS * 6)
    )
    if (!usage || typeof usage.completionTokens !== 'number') error = new Error('没有拿到 usage')
  } catch (e) {
    error = e
  }
  const ms = Date.now() - started

  const problems = []
  if (s.expect === 'ok') {
    if (error) problems.push(`不该失败，却报错：${error.message}`)
    if (!text.includes('周砚秋')) problems.push(`正文没收到，实际 ${JSON.stringify(text.slice(0, 40))}`)
    if (s.name === 'thinking' && !thought) problems.push('思考内容没有通过 onThought 透出')
  } else {
    if (!error) problems.push('应该报错中止，却成功返回了')
    else if (s.match && !s.match.test(error.message)) problems.push(`错误文案不匹配 ${s.match}：${error.message}`)
    if (ms < IDLE_MS - 250) problems.push(`中止得太早（${ms}ms < ${IDLE_MS}ms），可能误杀`)
  }

  return { name: s.name, ok: problems.length === 0, ms, problems, text, thought, error }
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
  console.log(`假网关已启动 http://127.0.0.1:${PORT}/v1 · 空闲上限 ${IDLE_MS}ms`)

  const results = []
  for (const s of picked) {
    const r = await runScenario(registry, s)
    results.push(r)
    const mark = r.ok ? 'PASS' : 'FAIL'
    console.log(`${mark}  ${r.name.padEnd(9)} ${String(r.ms).padStart(6)}ms  ${s.why}`)
    if (!r.ok) for (const p of r.problems) console.log(`        · ${p}`)
    if (r.thought) console.log(`        思考片段：${r.thought.slice(0, 40)}…`)
  }

  server.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})