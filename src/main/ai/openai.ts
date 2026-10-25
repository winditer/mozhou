/**
 * OpenAI Chat Completions 协议适配器
 *
 * 关键差异（相对另外两家）：
 * - 鉴权走 `Authorization: Bearer`，system 消息就是普通 messages 的一员
 * - 增量在 `choices[0].delta.content`
 * - token 用量要 `stream_options.include_usage` 才会随流返回，且部分服务端不认这个字段
 */
import type { Channel, PromptMessage } from '@shared/types'
import type { OpenedStream, StreamHandle } from './sse'
import { HttpStatusError, joinUrl, openEventStream, parseSSE } from './sse'

export interface StreamAdapterArgs {
  channel: Channel
  apiKey: string
  model: string
  messages: PromptMessage[]
  temperature?: number
  maxTokens?: number
  signal: AbortSignal
  onDelta: (d: string) => void
  /** 思考/推理增量（reasoning_content 等），不计入正文 */
  onThought?: (d: string) => void
  /** 任意进展信号（响应头、SSE 事件、心跳注释） */
  onActivity: () => void
  /**
   * 流收尾异常（没等到 `[DONE]` 就 EOF、上游中途报错）时的提示。
   * 适配器不抛错：半截正文对写作仍有价值，抛错会让上层把已经拿到的字丢掉。
   */
  onAbnormalEnd?: (reason: string) => void
  /** 把打开的流交给 registry，由它保证请求结束后连接一定被关掉 */
  onStream?: (handle: StreamHandle) => StreamHandle
}

/** 中文场景下的粗略换算：约 1.6 字符 ≈ 1 token */
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

/** delta.content 可能是字符串，也可能是多模态 parts 数组 */
function contentText(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    let out = ''
    for (const part of v) {
      const text = str(asRecord(part)?.text)
      if (text) out += text
    }
    return out
  }
  return ''
}

/**
 * 思考增量。各家字段名不统一：
 * - DeepSeek / 多数网关：delta.reasoning_content
 * - OpenRouter 等：delta.reasoning
 * - 部分自建网关：delta.thinking
 */
function thoughtText(delta: Record<string, unknown> | undefined): string {
  if (!delta) return ''
  return str(delta.reasoning_content) ?? str(delta.reasoning) ?? str(delta.thinking) ?? ''
}

interface PlainBody {
  /** 是否识别出结构（可能是空正文的正常响应） */
  parsed: boolean
  content: string
  thought: string
  promptTokens?: number
  completionTokens?: number
  /** 整段返回时同样可能被 max_tokens 截断，不记下来上层就分不清「写完」和「写断」 */
  finishReason?: string
}

function readUsageFields(usage: Record<string, unknown> | undefined): {
  promptTokens?: number
  completionTokens?: number
} {
  if (!usage) return {}
  const p = num(usage.prompt_tokens)
  const c = num(usage.completion_tokens)
  return { promptTokens: p, completionTokens: c }
}

/**
 * 解析「不是 SSE」的响应体。
 * 有的网关无视 stream:true，整段生成完才返回一个普通 JSON；
 * 也有的网关 content-type 写成 JSON、内容却是 SSE 文本，这里都兜住。
 */
function parsePlainBody(raw: string): PlainBody {
  const text = raw.trim()
  if (!text) return { parsed: false, content: '', thought: '' }

  if (text.startsWith('data:')) {
    let content = ''
    let thought = ''
    let promptTokens: number | undefined
    let completionTokens: number | undefined
    let finishReason: string | undefined
    let parsed = false
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim()
      if (!l.startsWith('data:')) continue
      const payload = l.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const root = asRecord(JSON.parse(payload) as unknown)
        if (!root) continue
        parsed = true
        const choice = asRecord(Array.isArray(root.choices) ? root.choices[0] : undefined)
        content += contentText(asRecord(choice?.delta)?.content)
        thought += thoughtText(asRecord(choice?.delta))
        const usage = readUsageFields(asRecord(root.usage))
        promptTokens = usage.promptTokens ?? promptTokens
        completionTokens = usage.completionTokens ?? completionTokens
        const fr = str(choice?.finish_reason)
        if (fr) finishReason = fr
      } catch {
        continue
      }
    }
    return { parsed, content, thought, promptTokens, completionTokens, finishReason }
  }

  try {
    const root = asRecord(JSON.parse(text) as unknown)
    if (!root) return { parsed: false, content: '', thought: '' }
    const choice = asRecord(Array.isArray(root.choices) ? root.choices[0] : undefined)
    const message = asRecord(choice?.message)
    const usage = readUsageFields(asRecord(root.usage))
    return {
      parsed: true,
      content: contentText(message?.content) || str(choice?.text) || '',
      thought: thoughtText(message),
      finishReason: str(choice?.finish_reason),
      ...usage
    }
  } catch {
    return { parsed: false, content: '', thought: '' }
  }
}

export async function streamOpenAI(args: StreamAdapterArgs): Promise<{ promptTokens: number; completionTokens: number; finishReason?: string }> {
  const { channel, apiKey, model, messages, temperature, maxTokens, signal, onDelta, onThought, onActivity, onAbnormalEnd } = args
  const takeStream = args.onStream ?? ((s: StreamHandle): StreamHandle => s)

  const url = joinUrl(channel.baseUrl, 'chat/completions')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    Accept: 'text/event-stream',
    ...(channel.headers ?? {}) // 渠道自定义头（如 OpenRouter 的 HTTP-Referer）可覆盖默认值
  }

  const buildBody = (withStreamOptions: boolean, completionTokensField = false): Record<string, unknown> => {
    const body: Record<string, unknown> = { model, messages, stream: true }
    if (withStreamOptions) body.stream_options = { include_usage: true }
    if (typeof temperature === 'number') body.temperature = temperature
    if (typeof maxTokens === 'number') {
      // 新一些的服务端只认 max_completion_tokens，旧参数会被判为不支持；
      // 这里先用旧参数，收到 400 再换新参数重试一次。
      if (completionTokensField) body.max_completion_tokens = maxTokens
      else body.max_tokens = maxTokens
    }
    return body
  }

  // 走 undici 而不是 fetch：下面按「有没有新事件」重置空闲计时，计时器 abort 时
  // fetch 的 body 会把网关最后送来的那一帧一起丢掉——那帧常带着 finish_reason
  const send = (withStreamOptions: boolean, completionTokensField = false): Promise<OpenedStream> =>
    openEventStream(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(withStreamOptions, completionTokensField)),
      signal
    })

  let res = await send(true)
  if (res.status === 400) {
    const text = res.errorBody ?? ''
    // 兼容不支持 stream_options 的服务端：报文里提到该字段就摘掉重试一次
    if (/stream_options/i.test(text)) {
      res = await send(false)
    } else if (typeof maxTokens === 'number' && /max_tokens|max_completion_tokens/i.test(text)) {
      // 参数名不被接受：换 max_completion_tokens 再试
      res = await send(true, true)
    } else {
      throw new HttpStatusError(400, text)
    }
    if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status, res.errorBody ?? '')
  } else if (res.status < 200 || res.status >= 300) {
    throw new HttpStatusError(res.status, res.errorBody ?? '')
  }
  onActivity() // 已经拿到响应头，说明连接是通的

  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let output = ''
  /** 服务端给出的结束原因：'length' 表示被 max_tokens 截断，正文可能不完整 */
  let finishReason: string | undefined

  const readUsage = (usage: Record<string, unknown> | undefined): void => {
    const usageFields = readUsageFields(usage)
    if (usageFields.promptTokens !== undefined && usageFields.promptTokens > 0) promptTokens = usageFields.promptTokens
    if (usageFields.completionTokens !== undefined && usageFields.completionTokens > 0) {
      completionTokens = usageFields.completionTokens
    }
  }

  // 网关无视 stream:true 时不是 SSE，整段正文一次性给出
  if (!res.stream) {
    const plain = parsePlainBody(res.text ?? '')
    if (!plain.parsed) {
      throw new Error('模型返回了无法解析的响应（既不是 SSE 流，也不是标准的 chat.completion 结构）')
    }
    if (plain.thought) onThought?.(plain.thought)
    if (plain.content) onDelta(plain.content)
    return {
      promptTokens: plain.promptTokens ?? estimateTokens(messages.map((m) => m.content).join('')),
      completionTokens: plain.completionTokens ?? estimateTokens(plain.content),
      finishReason: plain.finishReason
    }
  }

  const handle = takeStream(res.stream)
  /** 收到 [DONE] 才算服务端主动收尾；否则视为被掐断 */
  let sawDone = false

  for await (const ev of parseSSE(handle.body)) {
    onActivity() // 心跳注释也算进展：连接活着就别掐
    const data = ev.data.trim()
    if (!data) continue
    if (data === '[DONE]') {
      sawDone = true
      break
    }

    let json: unknown
    try {
      json = JSON.parse(data) as unknown
    } catch {
      continue // 非 JSON 行（心跳 / 代理注入的注释）直接跳过
    }
    const root = asRecord(json)
    if (!root) continue

    // 少数代理用 200 + error 负载报错
    const errPayload = asRecord(root.error)
    if (errPayload) throw new Error(str(errPayload.message) ?? '模型返回错误')

    const choices = root.choices
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = asRecord(choices[0])
      const delta = asRecord(choice?.delta)
      const piece = contentText(delta?.content)
      if (piece) {
        output += piece
        onDelta(piece)
      }
      // 思考类模型先吐 reasoning_content，正文要等思考结束；把思考透出去让界面有反馈
      const thought = thoughtText(delta)
      if (thought) onThought?.(thought)
      // 个别服务端把 usage 挂在 choice 上
      const fr = choice?.finish_reason
      if (typeof fr === 'string' && fr) finishReason = fr
      readUsage(asRecord(choice?.usage))
    }
    readUsage(asRecord(root.usage))
  }

  // 没有 [DONE] 就 EOF：网关中途掐了连接。帧已经全部消费，正文照给，
  // 只把「收尾不干净」告诉 registry——上层据此决定要不要当半成品处理
  if (!sawDone) onAbnormalEnd?.('stream ended without [DONE]')

  // 没拿到 usage 时按字符数估算，保证上层计费/统计不中断
  return {
    promptTokens: promptTokens ?? estimateTokens(messages.map((m) => m.content).join('')),
    completionTokens: completionTokens ?? estimateTokens(output),
    finishReason
  }
}
