/**
 * Google Gemini（generativelanguage v1beta）协议适配器
 *
 * 关键差异：
 * - 鉴权走 URL 查询参数 `key`，不走请求头
 * - 角色是 user / model（assistant 映射为 model），且要求 user/model 交替
 * - system 抽到顶层 `systemInstruction`
 * - 生成参数放进 `generationConfig`，max_tokens 在这里叫 `maxOutputTokens`
 * - 流式必须加 `:streamGenerateContent?alt=sse`，事件里 text 可能被拆成多个 part
 */
import type { Channel, PromptMessage } from '@shared/types'
import type { StreamHandle } from './sse'
import { HttpStatusError, openEventStream, parseSSE } from './sse'

export interface StreamAdapterArgs {
  channel: Channel
  apiKey: string
  model: string
  messages: PromptMessage[]
  temperature?: number
  maxTokens?: number
  signal: AbortSignal
  onDelta: (d: string) => void
  /** 思考增量（part.thought === true），不计入正文 */
  onThought?: (d: string) => void
  /** 任意进展信号（响应头、SSE 事件） */
  onActivity: () => void
  /**
   * 流收尾异常（没有任何 candidate 帧就 EOF）时的提示。
   * 适配器不抛错：半截正文对写作仍有价值，抛错会让上层把已经拿到的字丢掉。
   */
  onAbnormalEnd?: (reason: string) => void
  /** 把打开的流交给 registry，由它保证请求结束后连接一定被关掉 */
  onStream?: (handle: StreamHandle) => StreamHandle
}

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta'
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

interface GeminiTurn {
  role: 'user' | 'model'
  parts: { text: string }[]
}

export async function streamGemini(args: StreamAdapterArgs): Promise<{ promptTokens: number; completionTokens: number; finishReason?: string }> {
  const { channel, apiKey, model, messages, temperature, maxTokens, signal, onDelta, onThought, onActivity, onAbnormalEnd } = args
  const takeStream = args.onStream ?? ((s: StreamHandle): StreamHandle => s)

  const base = (channel.baseUrl.trim() || DEFAULT_BASE).replace(/\/+$/, '')
  const modelId = model.trim().replace(/^models\//, '') // 允许传 models/xxx 的写法
  const url = `${base}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`

  // system 抽到 systemInstruction；相邻同角色合并成一个 turn（Gemini 要求交替）
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const contents: GeminiTurn[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user'
    const last = contents[contents.length - 1]
    if (last && last.role === role) last.parts.push({ text: m.content })
    else contents.push({ role, parts: [{ text: m.content }] })
  }

  const generationConfig: Record<string, unknown> = {}
  if (typeof temperature === 'number') generationConfig.temperature = temperature
  if (typeof maxTokens === 'number') generationConfig.maxOutputTokens = maxTokens

  const body: Record<string, unknown> = { contents }
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] }
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...(channel.headers ?? {})
  }

  // 走 undici 而不是 fetch：空闲计时器 abort 时 fetch 的 body 会把最后一帧一起丢掉
  const res = await openEventStream(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status, res.errorBody ?? '') // 400/403 常见于 Key 无效
  onActivity() // 已经拿到响应头，说明连接是通的

  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let output = ''
  /** finishReason 归一成与 OpenAI 一致：'length' 表示截断 */
  let finishReason: string | undefined
  /** 见过 candidate 帧即视为收到了服务端的正式内容（哪怕只有一个字都没有的尾帧） */
  let sawCandidate = false
  /** 被安全策略等拦下的原因：正文为空时要能区分「模型不想写」和「模型没来得及写」 */
  let blockedReason: string | undefined

  /** 逐帧取值。SSE 与「整段 JSON」两条路共用，避免出现两套解析规则 */
  const applyFrame = (root: Record<string, unknown>): void => {
    const errPayload = asRecord(root.error)
    if (errPayload) throw new Error(str(errPayload.message) ?? '模型返回错误')

    const candidates = root.candidates
    if (Array.isArray(candidates) && candidates.length > 0) {
      sawCandidate = true
      // finishReason 为 MAX_TOKENS 时说明被截断
      const cand = asRecord(candidates[0])
      const fr = str(cand?.finishReason)
      if (fr) finishReason = fr === 'MAX_TOKENS' ? 'length' : fr
      const parts = cand?.content ? asRecord(cand.content)?.parts : undefined
      if (Array.isArray(parts)) {
        for (const part of parts) {
          const rec = asRecord(part)
          const piece = str(rec?.text)
          if (!piece) continue
          // 2.5 系列把思考内容也放在 parts 里，用 thought:true 标记
          if (rec?.thought === true) {
            onThought?.(piece)
            continue
          }
          output += piece
          onDelta(piece)
        }
      }
    }

    // usageMetadata 一般只在最后一帧出现，直接取最新值
    const usage = asRecord(root.usageMetadata)
    if (usage) {
      const p = num(usage.promptTokenCount)
      const c = num(usage.candidatesTokenCount)
      if (p !== undefined) promptTokens = p
      if (c !== undefined) completionTokens = c
    }

    const blockReason = str(asRecord(root.promptFeedback)?.blockReason)
    if (blockReason) blockedReason = blockReason
  }

  const summarize = (): { promptTokens: number; completionTokens: number; finishReason?: string } => {
    // 内容安全策略拦截：没有任何正文时直接给明确错误。
    // 放在最后判定：Gemini 会把 blockReason 和普通 candidate 放在同一批帧里，
    // 曾经一出 blockReason 就抛错，把同一响应里已经生成的正文整段丢了。
    if (blockedReason && !output) throw new Error(`请求被内容安全策略拦截（${blockedReason}），请调整提示词后重试`)
    return {
      promptTokens: promptTokens ?? estimateTokens(messages.map((m) => m.content).join('')),
      completionTokens: completionTokens ?? estimateTokens(output),
      finishReason
    }
  }

  // Gemini 没加 ?alt=sse 时会一次性返回 JSON 数组；也有的代理按 JSON 返回，这里整段读
  if (!res.stream) {
    const text = res.text ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(text.trim().replace(/^\s*\[/, '[').replace(/\]\s*$/, ']')) as unknown
    } catch {
      throw new Error('模型返回了无法解析的响应（既不是 SSE 流，也不是标准的 generateContent 结构）')
    }
    const frames: Record<string, unknown>[] = Array.isArray(parsed)
      ? parsed.map((f) => asRecord(f)).filter((f): f is Record<string, unknown> => Boolean(f))
      : [asRecord(parsed)].filter((f): f is Record<string, unknown> => Boolean(f))
    if (frames.length === 0) throw new Error('模型返回了空响应（无任何内容帧）')
    for (const frame of frames) applyFrame(frame)
    return summarize()
  }

  const handle = takeStream(res.stream)
  /** 收到 [DONE] 才算服务端主动收尾；Gemini 原生不给 [DONE]，靠 finishReason 判断 */
  let sawDone = false

  for await (const ev of parseSSE(handle.body)) {
    onActivity() // 心跳也算进展
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
      continue
    }
    const root = asRecord(json)
    if (!root) continue
    applyFrame(root)
  }

  if (!sawDone && !finishReason) {
    // Gemini 正常收尾一定带 finishReason；没有就是被掐断了
    onAbnormalEnd?.(sawCandidate ? 'stream ended without finishReason' : 'stream ended without any candidate')
  }

  return summarize()
}
