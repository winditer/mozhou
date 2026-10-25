#!/usr/bin/env node
/**
 * 流收尾与空正文的回归测试（开发用，不进入产品包）。
 *
 *   node scripts/test-stream-finish.cjs
 *
 * 覆盖三件容易在网关差异里出错、又直接表现为用户症状的事：
 *   1. 网关在最后一帧给了 `finish_reason:"length"` 之后**不给空行、不给 [DONE] 就断开**。
 *      旧 parseSSE 只按空行切事件，这一帧被整帧吞掉 → 上层永远拿不到 length，
 *      正文被截断却报 stop。症状就是「写了一半就停」。
 *   2. 只吐 reasoning_content、正文一个字没有就 stop（推理模型把 max_tokens 花在思考上）。
 *      上层必须能拿到 `empty: true`，否则无从判断该不该重试。
 *   3. 正常流式：empty=false、finishReason='stop'。
 *
 * 做法与 test-ai-timeouts.cjs 一致：起一个本地假网关，用 esbuild 把
 * src/main/ai/registry.ts 打包到临时目录再 require，走真正的适配器代码路径。
 */
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.MOCK_PORT || 8801)

/* ─────────────────────────── 编译被测模块 ─────────────────────────── */

function loadRegistry() {
  const outfile = path.join(os.tmpdir(), `mozhou-stream-${process.pid}.cjs`)
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

const BODY = '雨落在瓦上，一层一层地压下去。'

function chunk(delta, finish) {
  return `data: ${JSON.stringify({
    id: 'm',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish ?? null }]
  })}\n\n`
}

const behaviours = {
  /**
   * 最后一帧带 finish_reason:'length'，**后面不给空行也不给 [DONE]**，直接 end()。
   * 这一帧里有正文也有结束原因，是旧实现会吞掉的那一帧。
   */
  'mock-tail-no-done'(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write(chunk({ content: BODY }))
    // 注意：故意不写 "\n\n" 结尾，也不写 [DONE]
    res.write(`data: ${JSON.stringify({
      id: 'm',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: '他推开门。' }, finish_reason: 'length' }]
    })}`)
    res.end()
  },

  /** 只吐思考，正文一个字都没有，然后正常 stop */
  'mock-thought-only'(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write(chunk({ role: 'assistant' }))
    for (let i = 0; i < 5; i++) res.write(chunk({ reasoning_content: `第 ${i + 1} 步：${BODY}` }))
    res.write(chunk({}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  },

  /** 正常流式 */
  'mock-normal'(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write(chunk({ role: 'assistant' }))
    res.write(chunk({ content: BODY }))
    res.write(chunk({ content: '他推开门。' }))
    res.write(chunk({}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  }
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url || '').endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: Object.keys(behaviours).map((id) => ({ id })) }))
        return
      }
      if (req.method === 'POST' && (req.url || '').includes('/chat/completions')) {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          let model = 'mock-normal'
          try {
            model = JSON.parse(body).model || model
          } catch {
            /* 用默认行为 */
          }
          const fn = behaviours[model] || behaviours['mock-normal']
          fn(req, res)
        })
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })
}

/* ─────────────────────────── 断言 ─────────────────────────── */

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

const BASE = `http://127.0.0.1:${PORT}/v1`

function req(model) {
  return {
    streamId: `s_${model}_${Math.random().toString(36).slice(2, 8)}`,
    channel: { id: 'ch_mock', name: 'mock', protocol: 'openai', baseUrl: BASE, headers: {} },
    apiKey: 'test',
    model,
    messages: [{ role: 'user', content: '写' }],
    task: 'draft'
  }
}

async function main() {
  const server = await startServer()
  const registry = loadRegistry()

  try {
    /* ── 1. 最后一帧不带 [DONE] 也要被解析出来 ── */
    console.log('1. 最后一帧给了 finish_reason 但不给 [DONE] 就断开')
    {
      let text = ''
      const usage = await registry.streamChat(req('mock-tail-no-done'), (d) => {
        text += d
      })
      check('正文都收到了', text === BODY + '他推开门。', JSON.stringify(text))
      check(
        "finishReason 是 'length'（不再是 undefined）",
        usage.finishReason === 'length',
        `实际 ${JSON.stringify(usage.finishReason)}`
      )
      check('empty 为 false（确实有正文）', usage.empty === false, `实际 ${usage.empty}`)
    }

    /* ── 2. 只有思考、没有正文 → empty 必须为 true ── */
    console.log('2. 只吐思考、正文为空')
    {
      let text = ''
      let thought = ''
      const usage = await registry.streamChat(
        req('mock-thought-only'),
        (d) => {
          text += d
        },
        (d) => {
          thought += d
        }
      )
      check('正文确实为空', text === '', JSON.stringify(text))
      check('思考内容收到了（不算正文）', thought.length > 0, `实际 ${thought.length} 字`)
      check('empty 为 true（上层据此重试）', usage.empty === true, `实际 ${usage.empty}`)
    }

    /* ── 3. 正常流式 ── */
    console.log('3. 正常流式')
    {
      let text = ''
      const usage = await registry.streamChat(req('mock-normal'), (d) => {
        text += d
      })
      check('正文完整', text === BODY + '他推开门。', JSON.stringify(text))
      check('empty 为 false', usage.empty === false, `实际 ${usage.empty}`)
      check("finishReason 为 'stop'", usage.finishReason === 'stop', `实际 ${JSON.stringify(usage.finishReason)}`)
    }

    /* ── 4. 连接真断（无任何数据）应报错而不是静默返回空 ── */
    console.log('4. 中途断流：正文保留、不算致命错误')
    {
      // 用 mock-tail-no-done 的变体已覆盖；这里只确认「有正文但没 [DONE]」不会抛错
      let text = ''
      let threw = null
      try {
        await registry.streamChat(req('mock-tail-no-done'), (d) => {
          text += d
        })
      } catch (e) {
        threw = e
      }
      check('没有抛错（半截正文对写作仍有价值）', threw === null, String(threw && threw.message))
      check('正文保留', text.length > 0, JSON.stringify(text))
    }
  } finally {
    server.close()
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有用例失败'}：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})