/**
 * Anthropic Messages 协议适配器
 *
 * 关键差异（相对 OpenAI）：
 * - 鉴权走 `x-api-key` + 固定版本头 `anthropic-version`，没有 Bearer
 * - system 不是 messages 的一员，而是顶层 `system` 字符串（多条用空行连接）
 * - `max_tokens` 必填，缺了直接 400
 * - 流式事件带类型：content_block_delta 出文本，message_start / message_delta 给用量
 */
import type { Channel, PromptMessage } from '@shared/types'
import { HttpStatusError, parseSSE } from './sse'

export interface StreamAdapterArgs {
  channel: Channel
  apiKey: string
  model: string
  messages: PromptMessage[]
  temperature?: number
  maxTokens?: number
  signal: AbortSignal
  onDelta: (d: string) => void
  /** 扩展思考（thinking_delta），不计入正文 */
  onThought?: (d: string) => void
  /** 任意进展信号（响应头、SSE 事件、ping） */
  onActivity: () => void
}

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096
const CHARS_PER_TOKEN = 1.6

function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN)
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export async function streamAnthropic(args: StreamAdapterArgs): Promise<{ promptTokens: number; completionTokens: number; finishReason?: string }> {
  const { channel, apiKey, model, messages, temperature, maxTokens, signal, onDelta, onThought, onActivity } = args

  // baseUrl 可能写成 https://api.anthropic.com，也可能已经带 /v1（代理常见）
  const base = channel.baseUrl.trim().replace(/\/+$/, '')
  const url = /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    // 某些代理/直连环境要求显式声明允许浏览器环境访问
    'anthropic-dangerous-direct-browser-access': 'true',
    Accept: 'text/event-stream',
    ...(channel.headers ?? {})
  }

  // system 抽成顶层字符串，messages 只保留 user / assistant
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const turns: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    turns.push({ role: m.role, content: m.content })
  }

  const body: Record<string, unknown> = {
    model,
    messages: turns,
    max_tokens: typeof maxTokens === 'number' ? maxTokens : DEFAULT_MAX_TOKENS, // 必填字段
    stream: true
  }
  if (systemText) body.system = systemText
  if (typeof temperature === 'number') body.temperature = temperature

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!res.ok) throw new HttpStatusError(res.status, await res.text())
  onActivity() // 已经拿到响应头，说明连接是通的
  if (!res.body) throw new Error('模型返回了空响应（无响应体）')

  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let output = ''
  /** stop_reason 归一：max_tokens → length */
  let stopReason: string | undefined

  // 网关无视 stream:true 时返回整段 message JSON，正文要一次性抽出
  const contentType = res.headers.get('content-type') ?? ''
  if (!/text\/event-stream/i.test(contentType)) {
    const raw = await res.text()
    let text = ''
    let thought = ''
    let parsed = false
    try {
      const root = asRecord(JSON.parse(raw) as unknown)
      if (root) {
        parsed = true
        const blocks = root.content
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            const rec = asRecord(block)
            const piece = str(rec?.text) ?? ''
            if (rec?.type === 'thinking') thought += piece
            else text += piece
          }
        }
        // message_delta 事件带 stop_reason；max_tokens 表示被截断
        const sr = str(root.stop_reason) ?? str(asRecord(root.delta)?.stop_reason)
        if (sr) stopReason = sr === 'max_tokens' ? 'length' : sr
        const usage = asRecord(root.usage)
        const p = usage ? num(usage.input_tokens) : undefined
        const c = usage ? num(usage.output_tokens) : undefined
        if (p !== undefined) promptTokens = p
        if (c !== undefined) completionTokens = c
      }
    } catch {
      parsed = false
    }
    if (!parsed) throw new Error('模型返回了无法解析的响应（既不是 SSE 流，也不是标准的 message 结构）')
    if (thought) onThought?.(thought)
    if (text) onDelta(text)
    return {
      promptTokens: promptTokens ?? estimateTokens(messages.map((m) => m.content).join('')),
      completionTokens: completionTokens ?? estimateTokens(text),
      finishReason: stopReason
    }
  }

  for await (const ev of parseSSE(res.body)) {
    onActivity() // ping / 心跳也算进展
    const data = ev.data.trim()
    if (!data) continue
    if (data === '[DONE]') break

    let json: unknown
    try {
      json = JSON.parse(data) as unknown
    } catch {
      continue
    }
    const root = asRecord(json)
    if (!root) continue

    const type = str(root.type) ?? ev.event ?? ''
    if (type === 'error' || ev.event === 'error') {
      const errPayload = asRecord(root.error)
      throw new Error(str(errPayload?.message) ?? '模型返回错误')
    }

    switch (type) {
      case 'message_start': {
        // 用量分两处给：输入在 message_start，输出在 message_delta 累计
        const usage = asRecord(asRecord(root.message)?.usage)
        if (usage) {
          const p = num(usage.input_tokens)
          const c = num(usage.output_tokens)
          if (p !== undefined && p > 0) promptTokens = p
          if (c !== undefined && c > 0) completionTokens = c
        }
        break
      }
      case 'content_block_delta': {
        const delta = asRecord(root.delta)
        // 扩展思考：type 为 thinking_delta，文本在 delta.thinking
        if (str(delta?.type) === 'thinking_delta') {
          const thinking = str(delta?.thinking) ?? ''
          if (thinking) onThought?.(thinking)
          break
        }
        const piece = str(delta?.text)
        if (piece) {
          output += piece
          onDelta(piece)
        }
        break
      }
      case 'message_delta': {
        // message_delta 事件带 stop_reason；max_tokens 表示被截断
        const sr = str(root.stop_reason) ?? str(asRecord(root.delta)?.stop_reason)
        if (sr) stopReason = sr === 'max_tokens' ? 'length' : sr
        const usage = asRecord(root.usage)
        const c = usage ? num(usage.output_tokens) : undefined
        if (c !== undefined) completionTokens = c // 取最后一次（服务端给的是累计值）
        break
      }
      default:
        // ping / content_block_start / content_block_stop / message_stop 无需处理
        break
    }
  }

  return {
    promptTokens: promptTokens ?? estimateTokens(messages.map((m) => m.content).join('')),
    completionTokens: completionTokens ?? estimateTokens(output)
  }
}