import { useEffect, useRef, useState } from 'react'

/**
 * 运行中计时器：每 1 秒返回一次「已等待毫秒数」。
 * 停止后冻结在最终值，方便弹窗在完成后仍显示这次花了多久。
 *
 * 用法：const elapsed = useElapsed(running)
 */
export function useElapsed(running: boolean): number {
  const [ms, setMs] = useState(0)
  const startRef = useRef(0)

  useEffect(() => {
    if (!running) return
    startRef.current = Date.now()
    setMs(0)
    const timer = setInterval(() => setMs(Date.now() - startRef.current), 1000)
    return () => clearInterval(timer)
  }, [running])

  return ms
}

export interface StreamMeta {
  /** 已收到的正文 */
  text?: string
  /** 已收到的思考内容（reasoning_content / thinking_delta / thought part） */
  thought?: string
  elapsedMs: number
}

/**
 * 统一的进度文案。思考类模型可能一分多钟只吐思考，这里要能说清「模型在动」，
 * 而不是让用户对着一个转圈猜是不是卡死了。
 */
export function streamStatus(meta: StreamMeta): string {
  const sec = Math.max(0, Math.round(meta.elapsedMs / 1000))
  const textLen = (meta.text ?? '').length
  const thoughtLen = (meta.thought ?? '').length
  if (textLen > 0) return `已收到 ${textLen} 字 · 已等待 ${sec} 秒`
  if (thoughtLen > 0) return `模型正在思考…（已 ${thoughtLen} 字 · 已等待 ${sec} 秒）`
  return `已连接，等待模型吐出第一段内容…（已等待 ${sec} 秒）`
}

/** 是不是用户主动点了停止（main 进程统一抛这个文案，不该按错误处理） */
export function isAbortMessage(message: string): boolean {
  return /已中止|已停止/.test(message)
}