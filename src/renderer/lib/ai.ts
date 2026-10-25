import type { ChatRequest, PromptMessage, TaskKind } from '@shared/types'
import { mz } from './bridge'
import { uid } from '@shared/utils'

type Pending = {
  text: string
  thought: string
  onDelta?: (d: string) => void
  onThought?: (d: string) => void
  resolve: (v: AIResult) => void
  reject: (e: Error) => void
  promptTokens: number
  completionTokens: number
}

export interface AIResult {
  text: string
  /** 思考类模型透出的推理内容，仅用于展示进度，不属于正文 */
  thought: string
  promptTokens: number
  completionTokens: number
  ms: number
  /** 'length' 表示被 max_tokens 截断，正文可能是半截的 */
  finishReason?: string
  /** 是否被截断的便捷判断 */
  truncated?: boolean
  /**
   * 这次流一个正文字符都没产出（主进程据 onDelta 是否真被调用过判定）。
   *
   * 为什么必须单独有这个字段而不是用 `text === ''` 去猜：推理模型会把 maxTokens
   * 全花在 reasoning_content 上，正文空着就 stop，这时它既不报错、也不截断，
   * 上层只看到空串，无从判断是「模型没写完」还是「模型没写」。
   * 有了它，长度守护才能区分「重试」与「真的空」。
   */
  empty: boolean
  /** 思考耗尽额度的典型组合：empty 且 finishReason === 'length' */
  thoughtStarved?: boolean
}

const pending = new Map<string, Pending>()
let inited = false

function init(): void {
  if (inited) return
  inited = true
  mz.ai.onChunk(({ streamId, delta }) => {
    const p = pending.get(streamId)
    if (!p) return
    p.text += delta
    p.onDelta?.(delta)
  })
  mz.ai.onThought(({ streamId, delta }) => {
    const p = pending.get(streamId)
    if (!p) return
    p.thought += delta
    p.onThought?.(delta)
  })
  mz.ai.onDone(({ streamId, promptTokens, completionTokens, finishReason, empty }) => {
    const p = pending.get(streamId)
    if (!p) return
    pending.delete(streamId)
    p.promptTokens = promptTokens ?? 0
    p.completionTokens = completionTokens ?? 0
    p.resolve({
      text: p.text,
      thought: p.thought,
      promptTokens: p.promptTokens,
      completionTokens: p.completionTokens,
      ms: 0,
      finishReason,
      // 主进程说没吐字就信主进程；老版本主进程不带这个字段时退回看本地拼出来的文本
      empty: empty ?? p.text.length === 0,
      thoughtStarved: Boolean(empty) && finishReason === 'length'
    })
  })
  mz.ai.onError(({ streamId, message }) => {
    const p = pending.get(streamId)
    if (!p) return
    pending.delete(streamId)
    p.reject(new Error(message))
  })
}

export interface SendOptions {
  channel: ChatRequest['channel']
  model: string
  messages: PromptMessage[]
  task: TaskKind
  temperature?: number
  maxTokens?: number
  onDelta?: (d: string) => void
  /** 思考增量回调（不是正文） */
  onThought?: (d: string) => void
}

export async function sendChat(opts: SendOptions): Promise<AIResult> {
  init()
  const streamId = uid('s')
  const started = Date.now()
  const promise = new Promise<AIResult>((resolve, reject) => {
    pending.set(streamId, {
      text: '',
      thought: '',
      onDelta: opts.onDelta,
      onThought: opts.onThought,
      resolve,
      reject,
      promptTokens: 0,
      completionTokens: 0
    })
  })
  const req: ChatRequest = {
    streamId,
    channel: opts.channel,
    apiKey: '',
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    task: opts.task
  }
  const res = await mz.ai.chat(req)
  if (!res.ok) {
    const p = pending.get(streamId)
    pending.delete(streamId)
    p?.reject(new Error(res.error || '调用失败'))
  }
  const out = await promise
  out.ms = Date.now() - started
  out.truncated = out.finishReason === 'length'
  return out
}

export function abortChat(streamId?: string): void {
  if (streamId) void mz.ai.abort(streamId)
  for (const id of pending.keys()) {
    void mz.ai.abort(id)
  }
}

export function streamingCount(): number {
  return pending.size
}

/** 非流式一次性调用（内部用作流式封装） */
export async function complete(opts: SendOptions): Promise<string> {
  const r = await sendChat(opts)
  return r.text
}