#!/usr/bin/env node
/**
 * 本地假 OpenAI 兼容服务，用于端到端验收 AI 链路（不进入产品包）。
 *   node scripts/mock-openai.cjs [port]
 * 支持：GET /v1/models、POST /v1/chat/completions（SSE 流式 + 非流式）
 */
const http = require('node:http')

const port = Number(process.argv[2] || 8787)
const REPLY = [
  '雨停的时候，周砚秋才发现自己一直握着一枚硬币。',
  '硬币边缘被磨得发亮，像被谁反复摸过很多年。她把它翻过来，背面刻着一个"九"字。',
  '她忽然想起老槐树说过的话——契约不是写在纸上的，是刻在硬币上的。'
].join('\n\n')

const server = http.createServer((req, res) => {
  const url = req.url || '/'
  console.log('[req]', req.method, url, 'len=' + (req.headers['content-length'] || '?'))
  if (req.method === 'GET' && url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'mock-writer-small', object: 'model' },
          { id: 'mock-writer-large', object: 'model' }
        ]
      })
    )
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
        /* ignore */
      }
      const stream = payload.stream !== false
      const auth = req.headers['authorization'] || ''
      if (process.env.MOCK_REQUIRE_KEY === '1' && !auth.startsWith('Bearer ')) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'missing api key' } }))
        return
      }

      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'mock-1',
            object: 'chat.completion',
            model: payload.model || 'mock',
            choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 }
          })
        )
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      const parts = REPLY.match(/[\s\S]{1,12}/g) || []
      let i = 0
      const tick = setInterval(() => {
        if (i < parts.length) {
          res.write(
            `data: ${JSON.stringify({
              id: 'mock-1',
              object: 'chat.completion.chunk',
              model: payload.model || 'mock',
              choices: [{ index: 0, delta: { content: parts[i] }, finish_reason: null }]
            })}\n\n`
          )
          i += 1
        } else {
          res.write(
            `data: ${JSON.stringify({
              id: 'mock-1',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 }
            })}\n\n`
          )
          res.write('data: [DONE]\n\n')
          res.end()
          clearInterval(tick)
        }
      }, 12)
      res.on('close', () => clearInterval(tick))
    })
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'not found' } }))
})

server.listen(port, '127.0.0.1', () => console.log(`mock-openai listening on http://127.0.0.1:${port}/v1`))