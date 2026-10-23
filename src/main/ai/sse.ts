/**
 * SSE（Server-Sent Events）解析器
 *
 * 三家协议（OpenAI / Anthropic / Gemini）的流式响应都是 SSE，只有事件负载不同，
 * 所以把「字节流 → { event, data }」这一层抽出来复用。
 *
 * 本文件同时承载几个三协议共用的传输小工具（HttpStatusError / joinUrl），
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
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')

  let buffer = ''
  let eventName: string | undefined
  let dataLines: string[] = []

  // 遇到空行时把累积的事件吐出；没有 data 的事件（只有 event:）按规范不派发
  const flush = (): SSEEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined
      return undefined
    }
    const data = dataLines.join('\n')
    const ev: SSEEvent = eventName !== undefined ? { event: eventName, data } : { data }
    eventName = undefined
    dataLines = []
    return ev
  }

  const handleLine = (line: string): SSEEvent | undefined => {
    if (line === '') return flush()
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

    // 收尾：最后一行可能没有结尾换行符
    if (buffer.length > 0) {
      const raw = buffer
      buffer = ''
      const ev = handleLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw)
      if (ev) yield ev
    }
    const tail = flush()
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