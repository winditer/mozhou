/**
 * AI 适配器注册表
 *
 * 职责：
 * 1. 按 channel.protocol 分发到三家适配器，并管理进行中的流（AbortController）
 * 2. 把各家的原始 HTTP / 网络错误统一翻译成中文友好提示
 * 3. 渠道连通性测试与模型列表拉取（非流式，180 秒超时）
 *
 * 超时策略：
 * - 非流式请求：180 秒总超时
 * - 流式请求：不设总超时（长篇生成本来就久），只看「有没有进展」——
 *   响应头、SSE 事件、心跳注释、思考（reasoning_content）都算进展，
 *   连续 IDLE_TIMEOUT_MS 没有任何进展才中止。
 *
 * 为什么不再用「60 秒内必须收到正文」：思考类模型（deepseek-reasoner / qwen3 等）
 * 会先长时间只吐 reasoning_content，部分网关在排队时也只发心跳注释，
 * 这两类请求看起来「没有正文」，实际上连接一直是活的，按 60 秒掐掉属于误杀。
 */
import type { Channel, ChatRequest, PromptMessage, Protocol, TestResult } from '@shared/types'
import { streamAnthropic } from './anthropic'
import { streamGemini } from './gemini'
import { streamOpenAI } from './openai'
import type { StreamHandle } from './sse'
import { HttpStatusError, joinUrl } from './sse'

type TokenUsage = {
  promptTokens: number
  completionTokens: number
  finishReason?: string
  /**
   * 这次没有产出任何正文（delta 一个字符都没到）。
   *
   * 为什么不抛错：流正常结束但正文为空，多半是模型把 max_tokens 全用在思考上、
   * 或网关把 content 吞成了空串——上层换个方式重试往往能成功，抛错会被当成致命失败
   * 直接弹红条，用户只能看到「生成失败」而不知道该重试。
   */
  empty: boolean
  /**
   * 发现收尾「不正常」的证据（例如 stream 异常中断）。
   * 仅作为排查线索透出去，是否重试仍由上层按 empty / finishReason 判断。
   */
  finishedAbnormally?: boolean
}

interface RunArgs {
  channel: Channel
  apiKey: string
  model: string
  messages: PromptMessage[]
  temperature?: number
  maxTokens?: number
  signal: AbortSignal
  onDelta: (delta: string) => void
  /** 思考/推理增量：不是正文，只用来告诉界面「模型在动」 */
  onThought?: (delta: string) => void
  /** 任何字节级进展（响应头 / SSE 事件 / 心跳），用于重置空闲计时 */
  onActivity: () => void
  /**
   * 发现收尾异常（流没给 `[DONE]` 就断了等）时回调。
   * 适配器自己不抛错——半截正文对写作仍有价值，抛错会让上层把能用的内容丢掉。
   */
  onAbnormalEnd?: (reason: string) => void
  /** 适配器打开流之后交回来，registry 负责在请求结束时关掉连接 */
  onStream?: (handle: StreamHandle) => StreamHandle
}

/** 进行中的流：streamId → 控制器（供 abortStream 用） */
const controllers = new Map<string, AbortController>()

const DEFAULT_IDLE_TIMEOUT_MS = 180_000
const REQUEST_TIMEOUT_MS = 180_000
const ABORTED_MESSAGE = '已中止'
const TIMEOUT_MESSAGE = '请求超时（超过 180 秒无响应）'
/**
 * 停止读取之后等连接关闭的上限。
 * stream() 的任务要等连接真的断掉才 resolve，网关不理会 destroy 时不设上限会一直挂着。
 */
const TEARDOWN_TIMEOUT_MS = 3_000

/** 空闲上限：连续这么久没有任何进展才中止（可用 MOZHOU_AI_IDLE_TIMEOUT_MS 覆盖，测试用） */
function idleTimeoutMs(): number {
  const raw = Number(process.env['MOZHOU_AI_IDLE_TIMEOUT_MS'])
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_TIMEOUT_MS
}

function idleTimeoutMessage(idleMs: number, hasContent: boolean): string {
  const sec = Math.max(1, Math.round(idleMs / 1000))
  if (hasContent) return `模型超过 ${sec} 秒没有输出新内容，已停止本次生成`
  return `等待模型响应超过 ${sec} 秒，已停止本次生成。常见原因：渠道排队或网络不稳定、网关没有开启流式返回、模型正在长时间思考。可以换一个更快的模型，或稍后重试。`
}

const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/* ─────────────────────────── 类型收窄小工具 ─────────────────────────── */

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/* ─────────────────────────── 错误友好化 ─────────────────────────── */

/**
 * 把 HTTP 状态码 + 响应报文翻译成用户能看懂的中文提示
 */
export function friendlyError(status: number, body: string, channelLabel: string): string {
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 200)

  if (status === 401 || status === 403) {
    return `API Key 无效或没有权限，请检查 Key 是否正确、是否已过期（${channelLabel}）`
  }
  if (status === 404) {
    return '接口地址或模型名不存在，请检查 BaseURL 是否以正确的版本号结尾、模型名是否拼写正确'
  }
  if (status === 429) {
    return `请求过于频繁或额度已用尽，请稍后再试（${channelLabel}）`
  }
  if (status === 400) {
    // Gemini 的 Key 无效是 400（API_KEY_INVALID），不是 401，需要在这里单独识别
    if (/api[ _-]?key|invalid[ _-]?key|API_KEY_INVALID|UNAUTHENTICATED|PERMISSION_DENIED|key not valid/i.test(body)) {
      return `API Key 无效或没有权限，请检查 Key 是否正确、是否已过期（${channelLabel}）`
    }
    return `请求参数有误：${snippet || '（服务端未返回详细信息）'}`
  }
  if (status >= 500) {
    return `模型服务端错误（${status}），请稍后重试或更换渠道`
  }
  return `请求失败（${status}）：${snippet || '（服务端未返回详细信息）'}`
}

/** 任意异常 → 中文提示（保留已是中文的自定义错误原文） */
function describeError(err: unknown, channel: Channel): string {
  if (err instanceof HttpStatusError) return friendlyError(err.status, err.body, channel.name)
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return TIMEOUT_MESSAGE
    if (err.name === 'AbortError') return ABORTED_MESSAGE
    if (err instanceof TypeError || /fetch failed|network error|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(err.message)) {
      return `无法连接到 ${channel.baseUrl.trim() || channel.name}，请检查网络、代理或 BaseURL 是否正确`
    }
    return err.message || '未知错误'
  }
  return String(err)
}

/* ─────────────────────────── 分发 ─────────────────────────── */

/**
 * 适配器只负责报用量与结束原因；`empty` 由 streamChat 按「到底有没有收到 delta」判定，
 * 所以这里先填 false 占位，避免每家各自判断导致口径不一致。
 */
async function runAdapter(args: RunArgs): Promise<Omit<TokenUsage, 'empty'>> {
  switch (args.channel.protocol) {
    case 'openai':
      return streamOpenAI(args)
    case 'anthropic':
      return streamAnthropic(args)
    case 'gemini':
      return streamGemini(args)
    default: {
      const unexpected: never = args.channel.protocol
      throw new Error(`不支持的协议：${String(unexpected)}`)
    }
  }
}

/** 中止指定流；返回是否真的找到并中止了一个流 */
export function abortStream(streamId: string): boolean {
  const controller = controllers.get(streamId)
  if (!controller) return false
  controller.abort()
  return true
}

/**
 * 发起一次流式对话，delta 通过 onDelta 回调逐块抛出。
 * 思考类模型会先走 onThought（可选），只用于展示进度，不并入正文。
 */
export async function streamChat(
  req: ChatRequest,
  onDelta: (delta: string) => void,
  onThought?: (delta: string) => void
): Promise<TokenUsage> {
  if (!req.channel.baseUrl.trim() && req.channel.protocol !== 'gemini') {
    throw new Error(`渠道「${req.channel.name}」未配置 BaseURL，请在设置中补全`)
  }

  const controller = new AbortController()
  controllers.set(req.streamId, controller)

  const idleMs = idleTimeoutMs()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let idleError: Error | null = null
  let sawContent = false
  let abnormalEnd: string | null = null

  // 任何进展都重置计时：响应头、SSE 事件、心跳注释、思考增量
  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleError = new Error(idleTimeoutMessage(idleMs, sawContent))
      controller.abort(idleError)
    }, idleMs)
  }
  armIdleTimer()

  const handleActivity = (): void => armIdleTimer()

  const handleDelta = (delta: string): void => {
    sawContent = true
    armIdleTimer()
    onDelta(delta)
  }

  const handleThought = onThought
    ? (delta: string): void => {
        armIdleTimer()
        onThought(delta)
      }
    : undefined

  // 适配器停止读流之后，连接要由这里主动关掉：undici 的 stream() 任务不会因为
  // onDelta 里提前 return 而结束，不 destroy 就会把连接一直占着
  // 明确写成「可为空的对象」而不是 null 联合，否则 TS 会把 finally 里的取值收窄成 never
  const holder: { current?: StreamHandle } = {}
  const openedStream = (handle: StreamHandle): StreamHandle => {
    holder.current = handle
    return handle
  }

  try {
    const usage = await runAdapter({
      channel: req.channel,
      apiKey: req.apiKey,
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      signal: controller.signal,
      onDelta: handleDelta,
      onThought: handleThought,
      onActivity: handleActivity,
      onAbnormalEnd: (reason) => {
        abnormalEnd = reason
      },
      onStream: openedStream
    })
    // 被中止（空闲超时 / 用户点停止）时适配器可能「安静地」返回半截结果，
    // 这时必须按错误上抛：空白正文 + 静默成功，上层没法区分「生成完了」和「卡死了」
    if (idleError) throw idleError
    // 正文是否真的产出过，只认实际收到的 delta：网关可能返回 finishReason:'stop'
    // 却一个字都没给（思考吃光预算 / content 被过滤），这种情况上层必须能识别出来
    return { ...usage, empty: !sawContent, finishedAbnormally: abnormalEnd !== null || usage.finishedAbnormally }
  } catch (err) {
    if (idleError) throw idleError
    if (isAbortError(err)) throw new Error(ABORTED_MESSAGE) // 用户主动中止，上层据此区分
    throw new Error(describeError(err, req.channel))
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    // 关连接并等它真断：不等的话下一次请求可能撞上同一个还占着的 socket
    const stream = holder.current
    if (stream) {
      stream.close()
      await waitForTeardown(stream)
    }
    // 同一 streamId 可能已被新请求占用，只清理自己这一条
    if (controllers.get(req.streamId) === controller) controllers.delete(req.streamId)
  }
}

/**
 * 等流彻底关掉（最多 TEARDOWN_TIMEOUT_MS）。
 * 迟迟不断说明网关不认 destroy，这时放弃等待——连接留给 socket 超时回收，
 * 但不能因此卡住本次请求的返回，更不能把用户的正文丢掉。
 */
async function waitForTeardown(stream: StreamHandle): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  await Promise.race([
    stream.done.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, TEARDOWN_TIMEOUT_MS)
    })
  ])
  if (timer) clearTimeout(timer)
}

/**
 * 渠道连通性测试：一条极短请求，统计耗时
 * 复用流式适配器但不外抛 delta（要拿到 usage 与完整错误链路）
 */
export async function testChannel(channel: Channel, apiKey: string, model: string): Promise<TestResult> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(TIMEOUT_MESSAGE)), REQUEST_TIMEOUT_MS)

  try {
    await runAdapter({
      channel,
      apiKey,
      model,
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0,
      maxTokens: 8,
      signal: controller.signal,
      onDelta: () => {},
      onActivity: () => {}
    })
    return { ok: true, latencyMs: Date.now() - startedAt, model }
  } catch (err) {
    return { ok: false, message: describeError(err, channel) }
  } finally {
    clearTimeout(timer)
  }
}

/* ─────────────────────────── 模型列表 ─────────────────────────── */

interface ModelsEndpoint {
  url: string
  headers: Record<string, string>
}

function modelsEndpoint(channel: Channel, apiKey: string): ModelsEndpoint {
  const base = channel.baseUrl.trim().replace(/\/+$/, '')
  const custom = channel.headers ?? {}

  if (channel.protocol === 'gemini') {
    const root = base || DEFAULT_GEMINI_BASE
    return {
      url: `${root}/models?key=${encodeURIComponent(apiKey)}`,
      headers: { Accept: 'application/json', ...custom }
    }
  }
  if (channel.protocol === 'anthropic') {
    // 与 messages 端点同样的 /v1 规则，避免出现 /v1/v1/models
    const url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`
    return {
      url,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
        ...custom
      }
    }
  }
  return {
    url: joinUrl(base, 'models'),
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...custom }
  }
}

function extractModels(protocol: Protocol, payload: unknown): string[] {
  const root = asRecord(payload)
  if (!root) return []

  if (protocol === 'gemini') {
    if (!Array.isArray(root.models)) return []
    const out: string[] = []
    for (const item of root.models) {
      const rec = asRecord(item)
      const name = rec ? str(rec.name) : undefined
      if (!name) continue
      const methods = rec && Array.isArray(rec.supportedGenerationMethods) ? rec.supportedGenerationMethods : []
      const canGenerate = methods.some((m) => typeof m === 'string' && m.toLowerCase() === 'generatecontent')
      if (!canGenerate) continue // 只要文本生成模型，过滤掉 embedding / aqa 等
      out.push(name.replace(/^models\//, ''))
    }
    return out
  }

  if (!Array.isArray(root.data)) return []
  const out: string[] = []
  for (const item of root.data) {
    const id = str(asRecord(item)?.id)
    if (id) out.push(id)
  }
  return out
}

export async function listModels(
  channel: Channel,
  apiKey: string
): Promise<{ ok: boolean; models: string[]; message?: string }> {
  if (!channel.baseUrl.trim() && channel.protocol !== 'gemini') {
    return { ok: false, models: [], message: `渠道「${channel.name}」未配置 BaseURL，请在设置中补全` }
  }

  const { url, headers } = modelsEndpoint(channel, apiKey)
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!res.ok) {
      return { ok: false, models: [], message: friendlyError(res.status, await res.text(), channel.name) }
    }
    const payload: unknown = await res.json()
    const models = extractModels(channel.protocol, payload)
    if (models.length === 0) {
      return { ok: false, models: [], message: '该渠道没有返回可用的模型列表，请手动填写模型名' }
    }
    return { ok: true, models }
  } catch (err) {
    return { ok: false, models: [], message: describeError(err, channel) }
  }
}