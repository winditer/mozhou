#!/usr/bin/env node
/**
 * 空正文 / 最后一帧回归测试（开发用，不进入产品包）。
 *
 * 覆盖两类线上真实故障：
 * 1) 流「正常结束」但一个正文字符都没有（模型把 max_tokens 全用在思考上、
 *    或网关把 content 吞掉）——上层以前拿到空串当成功，用户看到的就是空白页。
 * 2) 网关在最后一帧给了 finish_reason:"length" 之后不给空行 / 不给 [DONE]
 *    直接断开——旧版 parseSSE 只按空行切事件，这一帧被整帧吞掉，truncated 判断失效。
 *
 *   node scripts/test-empty-completion.cjs            # 跑全部场景
 *   node scripts/test-empty-completion.cjs empty      # 只跑某个场景
 *
 * 与 test-ai-timeouts.cjs 同样的做法：起一个假 OpenAI 网关，用 esbuild 把
 * src/main/ai/registry.ts 打包到临时目录再 require，不引入任何新依赖。
 */
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.AI_EMPTY_TEST_PORT || 8811)
const IDLE_MS = Number(process.env.AI_EMPTY_TEST_IDLE_MS || 4000)

// registry 在模块加载时读取该变量，必须先设好再 require
process.env['MOZHOU_AI_IDLE_TIMEOUT_MS'] = String(IDLE_MS)

/** 断言计数：最终报告里要说清楚跑了多少条 */
let assertions = 0
function check(problems, cond, message) {
  assertions += 1
  if (!cond) problems.push(message)
}

function loadRegistry() {
  const outfile = path.join(os.tmpdir(), `mozhou-empty-ai-${process.pid}.cjs`)
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

const CONTENT = ['周砚秋把表盖撬开，', '镊子尖抵着那截断轴，', '他没急着拆，先听了听。']

function open(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  // 必须 flush：不 flush 的话 Node 会等第一段 body 才把报文头送出去，
  // 客户端（undici handler）就迟迟收不到 onResponseStart，看起来像「响应头卡住」
  if (typeof res.flushHeaders === 'function') res.flushHeaders()
}

function frame(res, choice) {
  res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }] })}\n\n`)
}

function frameNoBlank(res, choice) {
  // 不给结尾空行：模拟「最后一帧之后再没有分隔符」
  res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }] })}`)
}

const behaviours = {
  /** a) 只吐 reasoning_content，然后 stop：正文一个字都没有 */
  'mock-thought-only'(res) {
    open(res)
    frame(res, { delta: { role: 'assistant' }, finish_reason: null })
    for (let i = 0; i < 4; i += 1) {
      frame(res, { delta: { reasoning_content: `第 ${i + 1} 步：先想清楚他为什么不肯求人。` }, finish_reason: null })
    }
    frame(res, { delta: {}, finish_reason: 'stop' })
    res.write('data: [DONE]\n\n')
    res.end()
  },

  /** 变体：思考吃光 max_tokens，正文为空但 finish_reason 是 length */
  'mock-thought-length'(res) {
    open(res)
    frame(res, { delta: { role: 'assistant' }, finish_reason: null })
    for (let i = 0; i < 4; i += 1) {
      frame(res, { delta: { reasoning_content: '继续想：这一步该让他沉默。' }, finish_reason: null })
    }
    frame(res, { delta: {}, finish_reason: 'length' })
    // 网关直接断开，不给 [DONE]
    res.end()
  },

  /** b) 吐正文，最后一帧带 length，且这一帧没有结尾空行 → 立刻断开（无 [DONE]） */
  'mock-truncated-no-blank'(res) {
    open(res)
    frame(res, { delta: { role: 'assistant' }, finish_reason: null })
    for (const part of CONTENT) frame(res, { delta: { content: part }, finish_reason: null })
    frameNoBlank(res, { delta: { content: '镊子一沉。' }, finish_reason: 'length' })
    res.end()
  },

  /** b 的变体：最后一帧有换行但没有空行 */
  'mock-truncated-newline'(res) {
    open(res)
    for (const part of CONTENT) frame(res, { delta: { content: part }, finish_reason: null })
    res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '他停了停。' }, finish_reason: 'length' }] })}\n`)
    res.end()
  },

  /** b 的变体：切在半个 JSON 里（chunk 边界截断），只能用超时中止 */
  'mock-truncated-mid-json'(res) {
    open(res)
    for (const part of CONTENT) frame(res, { delta: { content: part }, finish_reason: null })
    res.write('data: {"id":"mock","choices":[{"index":0,"delta":{"content":"镊子')
    // 不再写，也不结束；由空闲计时器收掉
  },

  /** c) 正常流式 */
  'mock-normal'(res) {
    open(res)
    frame(res, { delta: { role: 'assistant' }, finish_reason: null })
    for (const part of CONTENT) frame(res, { delta: { content: part }, finish_reason: null })
    frame(res, { delta: {}, finish_reason: 'stop' })
    res.write('data: [DONE]\n\n')
    res.end()
  },

  /** c 的变体：没有 [DONE]，但正常给了 stop 并关闭连接 */
  'mock-normal-no-done'(res) {
    open(res)
    for (const part of CONTENT) frame(res, { delta: { content: part }, finish_reason: null })
    frame(res, { delta: {}, finish_reason: 'stop' })
    res.end()
  }
}

function startServer() {
  const server = http.createServer((req, res) => {
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
    name: 'empty',
    model: 'mock-thought-only',
    why: 'a) 只吐思考后 stop：上层必须能看出「正文为空」',
    expect({ problems, usage, text, error }) {
      check(problems, !error, `不该报错，却失败：${error && error.message}`)
      if (error) return
      check(problems, text === '', `正文应为空，实际 ${JSON.stringify(text)}`)
      check(problems, usage && usage.empty === true, 'empty 应为 true')
      check(problems, usage && usage.finishReason === 'stop', `finishReason 应为 stop，实际 ${usage && usage.finishReason}`)
      check(problems, usage && usage.completionTokens >= 0, '应仍得到 completionTokens')
    }
  },
  {
    name: 'empty-length',
    model: 'mock-thought-length',
    why: '思考吃光 max_tokens：empty=true 且 finishReason=length',
    expect({ problems, usage, text, error }) {
      check(problems, !error, `不该报错，却失败：${error && error.message}`)
      if (error) return
      check(problems, text === '', `正文应为空，实际 ${JSON.stringify(text)}`)
      check(problems, usage && usage.empty === true, 'empty 应为 true')
      check(problems, usage && usage.finishReason === 'length', `finishReason 应为 length，实际 ${usage && usage.finishReason}`)
    }
  },
  {
    name: 'truncated',
    model: 'mock-truncated-no-blank',
    why: 'b) 末帧带 length 且无结尾空行：最后一帧不能被吞',
    expect({ problems, usage, text, error }) {
      check(problems, !error, `不该报错，却失败：${error && error.message}`)
      if (error) return
      check(problems, text.includes('周砚秋'), '前置正文应完整收到')
      check(problems, text.includes('镊子一沉'), `最后一帧的正文也要收到，实际 ${JSON.stringify(text)}`)
      check(problems, usage && usage.finishReason === 'length', `finishReason 应为 length，实际 ${usage && usage.finishReason}`)
      check(problems, usage && usage.empty === false, 'empty 应为 false')
    }
  },
  {
    name: 'truncated-nl',
    model: 'mock-truncated-newline',
    why: 'b) 变体：末帧有换行但无空行，同样不能吞',
    expect({ problems, usage, text, error }) {
      check(problems, !error, `不该报错，却失败：${error && error.message}`)
      if (error) return
      check(problems, text.includes('他停了停'), `最后一帧的正文也要收到，实际 ${JSON.stringify(text)}`)
      check(problems, usage && usage.finishReason === 'length', `finishReason 应为 length，实际 ${usage && usage.finishReason}`)
    }
  },
  {
    name: 'mid-json',
    model: 'mock-truncated-mid-json',
    why: 'b) 变体：切在半个 JSON 里，只能靠空闲计时中止',
    expect({ problems, text, error }) {
      check(problems, Boolean(error), '半个 JSON 之后断流，应中止而不是静默成功')
      check(problems, text.includes('周砚秋'), '中止前收到的正文要保留给上层')
    }
  },
  {
    name: 'normal',
    model: 'mock-normal',
    why: 'c) 正常流式：empty=false、finishReason=stop',
    expect({ problems, usage, text, error }) {
      check(problems, !error, `不该报错，却失败：${error && error.message}`)
      if (error) return
      check(problems, text === CONTENT.join(''), `正文应完整，实际 ${JSON.stringify(text)}`)
      check(problems, usage && usage.empty === false, 'empty 应为 false')
      check(problems, usage && usage.finishReason === 'stop', `finishReason 应为 stop，实际 ${usage && usage.finishReason}`)
    }
  },
  {
    name: 'no-done',
    model: 'mock-normal-no-done',
    why: 'c) 变体：没有 [DONE] 但给了 stop，正文必须完整',
    expect({ problems, usage, text, error }) {
      check(problems, !error, `不该报错，却失败：${error && error.message}`)
      if (error) return
      check(problems, text === CONTENT.join(''), `正文应完整，实际 ${JSON.stringify(text)}`)
      check(problems, usage && usage.empty === false, 'empty 应为 false')
      check(problems, usage && usage.finishReason === 'stop', `finishReason 应为 stop，实际 ${usage && usage.finishReason}`)
      check(problems, usage && usage.finishedAbnormally === true, '没有 [DONE] 应被标记为收尾异常')
    }
  }
]

function withWatchdog(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('测试自身看门狗超时')), ms))
  ])
}

async function runScenario(registry, s) {
  const startedAt = Date.now()
  let text = ''
  let thought = ''
  let error = null
  let usage = null
  try {
    usage = await withWatchdog(
      registry.streamChat(
        {
          streamId: `s_${s.name}`,
          channel,
          apiKey: 'mock-key',
          model: s.model,
          messages: [{ role: 'user', content: '接着写下一段' }],
          temperature: 0.85,
          maxTokens: 512
        },
        (d) => {
          text += d
        },
        (d) => {
          thought += d
        }
      ),
      Math.max(15_000, IDLE_MS * 4)
    )
  } catch (e) {
    error = e
  }
  const ms = Date.now() - startedAt

  const problems = []
  check(problems, usage === null || typeof usage === 'object', '返回值应是对象')
  s.expect({ problems, usage, text, thought, error, ms })

  return { name: s.name, ok: problems.length === 0, ms, problems, text, thought, error, usage }
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
    console.log(`${mark}  ${r.name.padEnd(13)} ${String(r.ms).padStart(6)}ms  ${s.why}`)
    if (r.usage) {
      console.log(
        `        empty=${r.usage.empty} finishReason=${String(r.usage.finishReason)} ` +
          `prompt=${r.usage.promptTokens} completion=${r.usage.completionTokens} ` +
          `abnormal=${String(r.usage.finishedAbnormally)}`
      )
    }
    if (!r.ok) for (const p of r.problems) console.log(`        · ${p}`)
  }

  server.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过 · ${assertions} 条断言`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})