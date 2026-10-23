import { useCallback, useRef, useState } from 'react'
import type { PromptMessage, TaskKind } from '@shared/types'
import { abortChat, sendChat } from '../../lib/ai'
import { resolveTaskModel, useApp } from '../../store/app'

export interface RunOptions {
  task: TaskKind
  messages: PromptMessage[]
  maxTokens?: number
  temperature?: number
}

export interface AiTextApi {
  text: string
  /** 思考类模型的推理内容：可能很长，只用来判断「模型正在动」 */
  thought: string
  running: boolean
  /** 本次运行已等待的毫秒数（运行中每秒刷新） */
  elapsedMs: number
  error: string | null
  /**
   * 本次输出是否被 max_tokens 截断。
   * 截断意味着内容是半截的，调用方不该把半句话当成品写进稿子。
   */
  truncated: boolean
  run: (opts: RunOptions) => Promise<string | null>
  stop: () => void
  reset: () => void
  setText: (t: string) => void
}

/**
 * 统一封装「流式调用 + 中断 + 报错」。
 * 未配置模型时直接提示并返回 null，调用方无需重复判断。
 *
 * 思考类模型（deepseek-reasoner / qwen3 等）会先长时间只吐 reasoning_content，
 * 这里把它单独存进 thought，正文仍走 text，界面上显示「模型思考中」而不是干等。
 */
export function useAiText(): AiTextApi {
  const [text, setText] = useState('')
  const [thought, setThought] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const aliveRef = useRef(true)
  const abortedRef = useRef(false)
  const startedRef = useRef(0)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopTicking = useCallback((): void => {
    if (tickRef.current) {
      clearInterval(tickRef.current)
      tickRef.current = null
    }
  }, [])

  const reset = useCallback((): void => {
    abortedRef.current = false
    stopTicking()
    setText('')
    setThought('')
    setError(null)
    setTruncated(false)
    setRunning(false)
    setElapsedMs(0)
  }, [stopTicking])

  const stop = useCallback((): void => {
    abortedRef.current = true
    abortChat()
  }, [])

  const run = useCallback(async (opts: RunOptions): Promise<string | null> => {
    const state = useApp.getState()
    const picked = resolveTaskModel(state.config, state.project, opts.task)
    if (!picked) {
      setError('未配置模型')
      state.toast('请先到设置 → 渠道与模型里配置一个模型', 'error')
      return null
    }

    abortedRef.current = false
    aliveRef.current = true
    setRunning(true)
    setError(null)
    setText('')
    setThought('')
    setTruncated(false)
    setElapsedMs(0)
    startedRef.current = Date.now()
    stopTicking()
    tickRef.current = setInterval(() => setElapsedMs(Date.now() - startedRef.current), 1000)

    try {
      const res = await sendChat({
        channel: picked.channel,
        model: picked.model,
        messages: opts.messages,
        task: opts.task,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        onDelta: (d) => {
          if (!aliveRef.current) return
          if (abortedRef.current) return
          setText((prev) => prev + d)
        },
        onThought: (d) => {
          if (!aliveRef.current) return
          if (abortedRef.current) return
          setThought((prev) => prev + d)
        }
      })
      if (abortedRef.current) {
        useApp.getState().toast('已停止生成', 'info')
        return null
      }
      setText(res.text)
      setTruncated(!!res.truncated)
      // 正文为空但思考很长：典型是 max_tokens 被思考吃光。
      // 这种情况必须明确告诉用户原因，否则界面上只是一片空白，看起来像"没生成"。
      if (!res.text.trim() && (res.thought ?? '').trim()) {
        const tip = '模型只输出了思考过程，正文被 max tokens 截断。请换一个非推理模型，或调大该渠道的最大输出后重试。'
        setError(tip)
        useApp.getState().toast(tip, 'error')
        return null
      }
      if (!res.text.trim()) {
        const tip = '模型没有返回任何正文。请重试；若反复如此，检查该渠道的模型名与余额。'
        setError(tip)
        useApp.getState().toast(tip, 'error')
        return null
      }
      return res.text
    } catch (e) {
      if (abortedRef.current) {
        useApp.getState().toast('已停止生成', 'info')
        return null
      }
      const msg = (e as Error).message || '调用失败'
      setError(msg)
      useApp.getState().toast(`AI 调用失败：${msg}`, 'error')
      return null
    } finally {
      aliveRef.current = false
      stopTicking()
      setElapsedMs(Date.now() - startedRef.current)
      setRunning(false)
    }
  }, [stopTicking])

  return { text, thought, running, elapsedMs, error, truncated, run, stop, reset, setText }
}