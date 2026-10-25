/**
 * SSE（Server-Sent Events）解析器
 *
 * 三家协议（OpenAI / Anthropic / Gemini）的流式响应都是 SSE，只有事件负载不同，
 * 所以把「字节流 → { event, data }」这一层抽出来复用。
 *
 * 本文件同时承载几个三协议共用的传输小工具（HttpStatusError / joinUrl / openEventStream），
 * 避免在每个适配器里重复实现同一段逻辑。
 */

/** 一条 SSE 事件：event 为事件名（缺省时不含该字段），data 为多行 data 拼接结果 */
export interface SSEEvent {
  event?: string
  data: string
  /**
   * `:` 开头的注释行（多数网关用它做心跳/保活）。
   * 不携带正文，但能证明连接还活着——上层据此重置空闲计时，不会把「正在排队」误判成超时。
   */
  comment?: string
  /**
   * 这条事件是靠「流结束」收尾的，不是靠空行（服务端最后一帧没跟空行就断开了）。
   * 上层据此判断这一帧之后不会再有 `[DONE]`，可以直接结束。
   */
  atEOF?: boolean
}

/** 非 2xx 响应：携带状态码与原始报文，由 registry 统一转成中文友好提示 */
export class HttpStatusError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string) {
    super(`HTTP ${status}`)
    this.name = 'HttpStatusError'
    this.status = status
    this.body = body
  }
}

/**
 * 拼接 URL：去掉 baseUrl 末尾的斜杠、path 开头的斜杠，避免出现 `//`
 */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * 逐事件解析 SSE 流。
 *
 * 要点：
 * - TextDecoder 增量解码（stream: true），避免多字节中文字符被 chunk 边界切断
 * - 保留未闭合的半行，跨 chunk 拼起来再解析
 * - 同时支持 `\r\n` 与 `\n`（行尾的 `\r` 直接剥掉）
 * - 同一事件内多行 `data:` 用 `\n` 连接（规范行为）
 * - `:` 开头的注释行（多数服务用它做心跳）忽略
 * - `[DONE]` 不做特殊处理，原样作为 data 抛出，由调用方决定是否结束
 *
 * 收尾：EOF 时残留的半行、以及「有换行但没等到空行」的最后一帧都必须补吐出来。
 * 曾经这里只按空行切事件，网关在最后一帧给了 `finish_reason:"length"` 之后直接断开，
 * 那一帧就被吞掉，上层于是既拿不到 length、也不知道正文其实被截断了。
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')

  let buffer = ''
  let eventName: string | undefined
  let dataLines: string[] = []

  // 遇到空行时把累积的事件吐出；没有 data 的事件（只有 event:）按规范不派发
  const flush = (atEOF = false): SSEEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined
      return undefined
    }
    const data = dataLines.join('\n')
    const ev: SSEEvent = eventName !== undefined ? { event: eventName, data } : { data }
    if (atEOF) ev.atEOF = true
    eventName = undefined
    dataLines = []
    return ev
  }

  const handleLine = (line: string, atEOF = false): SSEEvent | undefined => {
    // EOF 时的空行不能当分隔符处理（吐了反而会让收尾逻辑提前 releaseLock）
    if (line === '') return atEOF ? undefined : flush()
    if (line.startsWith(':')) return undefined // 注释 / 心跳，忽略
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1) // 规范：冒号后最多吃掉一个空格
    if (field === 'data') {
      dataLines.push(value)
      return undefined
    }
    if (field === 'event') {
      eventName = value
      return undefined
    }
    return undefined // id / retry 等字段本应用不到
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) buffer += decoder.decode(value, { stream: true })
      if (done) buffer += decoder.decode()

      // 逐行消费，剩余的半行留在 buffer 里等下一个 chunk
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const raw = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const ev = handleLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw)
        if (ev) yield ev
        nl = buffer.indexOf('\n')
      }

      if (done) break
    }

    // 收尾：最后一帧既可能缺结尾换行符，也可能有换行但后面没空行
    if (buffer.length > 0) {
      const raw = buffer
      buffer = ''
      const ev = handleLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw, true)
      if (ev) yield ev
    }
    const tail = flush(true)
    if (tail) yield tail
  } finally {
    // 提前 return / 抛错时也要放开锁，防止流悬挂
    try {
      reader.releaseLock()
    } catch {
      /* 已释放则忽略 */
    }
  }
}

/** 打开成功的一条流式响应：body 直接喂给 parseSSE */
export interface StreamHandle {
  body: ReadableStream<Uint8Array>
  /** 停止读取并关掉底层连接（幂等，随时可调） */
  close: () => void
  /** 底层请求真正结束（成功、失败、被 close 都算）时 resolve，永不 reject */
  done: Promise<void>
}

/**
 * 打开一条流式请求的结果。
 *
 * 非 2xx 时只有 `errorBody`（截断到 MAX_ERROR_BODY）；2xx 时要么给 `stream`（SSE 或
 * 其它流式响应），要么给 `text`（网关无视 stream:true，整段 JSON 一次性返回）。
 * 由适配器按 content-type 分流，不需要各自处理两套响应对象。
 */
export interface OpenedStream {
  status: number
  /** 2xx 且不是 SSE 时：整段响应体（已按 UTF-8 解码） */
  text?: string
  /** 2xx 且是流式响应时：交给 parseSSE 读 */
  stream?: StreamHandle
  /** 非 2xx 时的原始报文 */
  errorBody?: string
}

const MAX_ERROR_BODY = 64 * 1024

/** 只声明用到的成员，避免把整个 undici 类型面搬进来 */
interface DispatchController {
  abort(reason: Error): void
}

interface DispatchHandler {
  onRequestStart?: (controller: DispatchController, context: unknown) => void
  onResponseStart?: (controller: DispatchController, statusCode: number, headers: Record<string, unknown>) => void
  onResponseData?: (controller: DispatchController, chunk: Uint8Array) => void
  onResponseEnd?: (controller: DispatchController) => void
  onResponseError?: (controller: DispatchController, error: Error) => void
}

/**
 * 底层发一条 HTTP 请求，帧一到就交给 onChunk，直到结束。
 *
 * 为什么不用 fetch：fetch 的 body 只有「读完」和「abort」两条路，而空闲计时器要靠
 * 「又来了新事件」才重置——它一 abort，网关最后送来的那一帧（往往正是带
 * finish_reason 的）就被连着连接一起丢掉，于是出现「正文空白」或「被截断却报 stop」。
 * undici 的 dispatch + handler 能让我们在任意时刻 controller.abort() 自己收尾，
 * 且 abort 之前已经进 handler 的帧一个都不会丢；停手之后连接一定会被释放。
 *
 * undici 是 Electron 内置 fetch 的底层实现（Node 也自带同名模块），引用它不引入新依赖。
 */
async function dispatchStream(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  onStart: (status: number, contentType: string) => void,
  onChunk: (chunk: Uint8Array) => void
): Promise<{ abort: (reason: Error) => void; finished: Promise<void>; end: () => 'eof' | Error | null }> {
  const undiciModule = (await import('undici')) as unknown as {
    getGlobalDispatcher: () => { dispatch: (opts: Record<string, unknown>, handler: DispatchHandler) => boolean }
  }
  const target = new URL(url)
  const dispatcher = undiciModule.getGlobalDispatcher()

  let responseStatus = 0
  /**
   * 连接是怎么结束的：'eof' = 服务端正常关闭；Error = 出错；null = 还没结束。
   * 必须和「我们主动 abort」分开——主动 abort 的空闲超时是错误，
   * 而服务端正常 EOF 是收尾，二者在 openEventStream 里的处理完全不同。
   */
  let endReason: 'eof' | Error | null = null
  let pendingAbort: Error | null = null
  let abortRequest: ((reason: Error) => void) | null = null
  let settle: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    settle = resolve
  })

  const handler: DispatchHandler = {
    onRequestStart(controller) {
      // 空闲计时器 / 外部 abort 都走这里：连接随即被释放，已进 handler 的帧不会丢
      abortRequest = (reason) => controller.abort(reason)
      // controller 没到之前就来过 abort 请求的话，这里补一次
      if (pendingAbort) abortRequest(pendingAbort)
    },
    onResponseStart(_controller, statusCode, headers) {
      responseStatus = statusCode
      onStart(statusCode, String(headers['content-type'] ?? ''))
    },
    onResponseData(_controller, chunk) {
      onChunk(chunk)
    },
    onResponseEnd() {
      // 连接是服务端 read 端正常关掉的（EOF），不是我们主动 abort
      endReason = 'eof'
      settle()
    },
    onResponseError(_controller, error) {
      endReason = error
      settle()
    }
  }

  dispatcher.dispatch(
    {
      origin: target.origin,
      path: `${target.pathname}${target.search}`,
      method: init.method,
      headers: init.headers,
      body: init.body,
      // 不传 signal：undici 对外部 signal 的中止既不会回调 onResponseError，也不会 settle
      // 我们这边等它结束的 Promise，于是「中止之后请求永远挂住」。改为自己监听 signal，
      // 走和空闲超时同一条 controller.abort() 路径，保证一定收尾
      headersTimeout: 0,
      bodyTimeout: 0
    },
    handler
  )

  const onOuterAbort = (): void => abortRequest?.(init.signal.reason instanceof Error ? init.signal.reason : new Error('请求已中止'))
  if (init.signal.aborted) queueMicrotask(onOuterAbort)
  else init.signal.addEventListener('abort', onOuterAbort, { once: true })

  return {
    /** 中止请求（幂等；handler 还没拿到 controller 时先记下，拿到后立刻补发） */
    abort: (reason: Error) => {
      if (abortRequest) abortRequest(reason)
      else pendingAbort ??= reason
    },
    finished,
    /** 连接是服务端正常关闭（EOF）还是出错/被中止 */
    end: (): 'eof' | Error | null => pendingAbort ?? endReason
  }
}

/**
 * 打开流式响应，并保证「停止读取后连接一定被关掉」。
 * 适配器只需根据 `status` / `stream` / `text` 分流，具体怎么收尾由这里负责。
 */
export async function openEventStream(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
): Promise<OpenedStream> {
  /** 已到达但还没被读走的 chunk；parseSSE 成批取走，这里只做搬运 */
  const pending: Uint8Array[] = []
  /**
   * 流是否已经结束（正常 EOF 或出错都算），只作「别再收 chunk / 别再等」的标志。
   *
   * 曾经它同时兼任「结束时的错误」，于是正常收尾也被塞进一个 Error('stream closed')，
   * pull() 见到它就 controller.error()——把**正常结束**报成了错误。parseSSE 随即抛出
   * 「stream closed」，已经收到的正文和最后一帧（往往带着 finish_reason）一起丢掉。
   * 现在把「结束」和「出错」拆开：正常 EOF 走 controller.close()，只有真错误才 error()。
   */
  let ended: Error | null = null
  /** 是否正常结束（连接读完了，不是被 abort / 网络错误打断） */
  let endedCleanly = false
  let wake: (() => void) | null = null
  let closeRequest: ((reason: Error) => void) | null = null
  let closed = false
  let status = 0
  let isSSE = false
  let resolveHeaders: () => void = () => {}
  const headersReady = new Promise<void>((resolve) => {
    resolveHeaders = resolve
  })
  const decoder = new TextDecoder('utf-8')

  const notify = (): void => {
    if (!wake) return
    const fn = wake
    wake = null
    fn()
  }

  /** 幂等：正常读完、出错、用户中止三条路都会走到 */
  const close = (reason = new Error('stream closed')): void => {
    if (closed) return
    closed = true
    ended ??= reason
    closeRequest?.(reason)
    notify()
  }

  const control = await dispatchStream(
    url,
    init,
    (code, contentType) => {
      status = code
      // 网关无视 stream:true 时会返回 application/json，这种没有 SSE 帧可拆，要整段读
      isSSE = /text\/event-stream/i.test(contentType)
      resolveHeaders()
    },
    (chunk) => {
      if (ended) return
      pending.push(new Uint8Array(chunk))
      notify()
    }
  )
  closeRequest = (reason) => control.abort(reason)

  // 连接结束（正常 EOF / 出错 / 被 abort）都要叫醒读端：
  // 之前只在 pull() 里等 wake，请求结束后没人 notify，reader.read() 会永远挂着
  void control.finished.then(() => {
    const why = control.end()
    // 只有「服务端正常关闭连接（EOF）」才算干净收尾；空闲超时 / 外部中止 / 网络错误
    // 都还是错误——它们意味着「还没写完就断了」，语义和「写完了」完全不同。
    // 这里以前无条件塞 Error('stream closed')，于是 ① 正常 EOF 被 pull() 报成错误
    // （正文和最后一帧一起丢）；② 反过来又让「静默悬挂」无法与 EOF 区分。
    if (!ended) {
      endedCleanly = why === 'eof'
      ended = why instanceof Error ? why : new Error('stream closed')
    }
    resolveHeaders()
    notify()
  })

  // 等响应头。两种打断必须都兜住：
  // 1) 外部 abort（用户停止 / 空闲计时器）——undici 对 signal 的中止不回调 handler，只能自己听
  // 2) 连接在响应头之前就断了——Node 的 http 服务端只要不 flush 报文头，undici 一直不派
  //    onResponseStart，光等 headersReady 会永远挂住（实测过），所以 finished 也要能唤醒
  await Promise.race([
    headersReady,
    control.finished,
    new Promise<void>((resolve) => {
      if (init.signal.aborted) resolve()
      else init.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  ])
  // 头都没到就结束了：这属于真正的传输失败，交给上层按网络错误提示
  if (status === 0) throw ended ?? new Error('连接在返回响应头之前就断开了，请检查网络或网关')

  /** 把剩下的字节全读出来（非 SSE 响应、错误报文都走这里） */
  const drain = async (): Promise<string> => {
    let out = ''
    for (;;) {
      const chunk = pending.shift()
      if (chunk) {
        out += decoder.decode(chunk, { stream: true })
        continue
      }
      if (ended) break
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
    out += decoder.decode()
    return out
  }

  if (status < 200 || status >= 300) {
    const body = await drain()
    close()
    void control.finished
    return { status, errorBody: body.slice(0, MAX_ERROR_BODY) }
  }

  if (!isSSE) {
    const text = await drain()
    close()
    void control.finished
    return { status, text }
  }

  const done = control.finished
  const body = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      while (pending.length === 0) {
        if (ended) {
          // 关键分流：正常读完就 close()，让 parseSSE 走 EOF 收尾（把最后一帧补吐出来）；
          // 只有真错误才 error()，否则「正常结束」会被当成异常，正文被丢掉。
          if (endedCleanly) controller.close()
          else controller.error(ended)
          return
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      controller.enqueue(pending.shift() as Uint8Array)
    },
    cancel() {
      close()
    }
  })

  return { status, stream: { body, close, done } }
}
