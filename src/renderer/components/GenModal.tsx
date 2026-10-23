import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, Check, Copy, RefreshCw, Square, Sparkles } from 'lucide-react'
import { countWords } from '@shared/utils'
import { Button, IconButton, Modal } from './ui'
import { abortChat } from '../lib/ai'
import { isAbortMessage, streamStatus, useElapsed } from '../lib/stream'

export interface GenConfig {
  title: string
  hint?: string
  expectWords?: number
  acceptLabel?: string
  /** 「保存为本章梗概」时写回哪一章（从章节列表直接打开某章时，可能不是当前活动章） */
  summaryChapterId?: string
  /** 「替代整段」类任务：采纳时用生成结果替换这个范围，而不是插入 */
  replaceRange?: { from: number; to: number }
  run: (
    onDelta: (d: string) => void,
    onStage: (s: string) => void,
    onThought: (d: string) => void
  ) => Promise<string>
}

export function GenModal({
  config,
  onClose,
  onAccept
}: {
  config: GenConfig | null
  onClose: () => void
  onAccept: (text: string) => void
}): ReactNode {
  const [text, setText] = useState('')
  const [thought, setThought] = useState('')
  const [stage, setStage] = useState('准备中…')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const runIdRef = useRef(0)
  const stoppedRef = useRef(false)
  const elapsed = useElapsed(running)

  const start = useCallback(
    (cfg: GenConfig) => {
      const runId = ++runIdRef.current
      stoppedRef.current = false
      setText('')
      setThought('')
      setError(null)
      setRunning(true)
      setStage('正在连接模型…')
      cfg
        .run(
          (d) => {
            if (runIdRef.current !== runId) return
            setText((t) => t + d)
            requestAnimationFrame(() => {
              const el = bodyRef.current
              if (el) el.scrollTop = el.scrollHeight
            })
          },
          (s) => {
            if (runIdRef.current === runId) setStage(s)
          },
          (d) => {
            if (runIdRef.current !== runId) return
            setThought((t) => t + d)
          }
        )
        .then((final) => {
          if (runIdRef.current !== runId) return
          if (final) setText((t) => (t.length >= final.length ? t : final))
          setRunning(false)
          setStage('已完成')
        })
        .catch((e: Error) => {
          if (runIdRef.current !== runId) return
          setRunning(false)
          // 用户自己点的停止不算错误；真正的失败才标红
          if (stoppedRef.current || isAbortMessage(e.message)) {
            setStage('已停止')
            return
          }
          setError(e.message)
          setStage('已中断')
        })
    },
    []
  )

  useEffect(() => {
    if (config) start(config)
    return () => {
      runIdRef.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  if (!config) return null
  const words = countWords(text)
  const pct = config.expectWords ? Math.min(100, Math.round((words / config.expectWords) * 100)) : null

  return (
    <Modal
      open
      onClose={() => {
        if (running) abortChat()
        onClose()
      }}
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={15} style={{ color: 'var(--accent)' }} />
          {config.title}
        </span>
      }
      width={760}
      footer={
        <>
          <div className="flex-1 flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-faint)' }}>
            <span>{running ? stage : error ? '生成中断' : '生成完成'}</span>
            {words > 0 && (
              <span className="chip" style={{ height: 20 }}>
                {words} 字
                {config.expectWords ? ` / ${config.expectWords}` : ''}
              </span>
            )}
          </div>
          {running ? (
            <Button
              onClick={() => {
                stoppedRef.current = true
                abortChat()
                setRunning(false)
                setStage('已停止')
              }}
            >
              <Square size={13} /> 停止
            </Button>
          ) : (
            <Button onClick={() => start(config)} disabled={running}>
              <RefreshCw size={13} /> 重新生成
            </Button>
          )}
          <Button onClick={onClose}>放弃</Button>
          <Button
            variant="primary"
            disabled={running || !text.trim()}
            onClick={() => {
              onAccept(text)
              onClose()
            }}
          >
            <Check size={13} /> {config.acceptLabel ?? '采纳'}
          </Button>
        </>
      }
    >
      {config.hint && (
        <div className="mb-3 text-[12px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          {config.hint}
        </div>
      )}
      {pct !== null && (
        <div className="mb-3 h-1 rounded-full overflow-hidden" style={{ background: 'var(--panel-2)' }}>
          <div
            className="h-full transition-all"
            style={{ width: `${pct}%`, background: pct >= 85 ? 'var(--ok)' : 'var(--accent)' }}
          />
        </div>
      )}
      <div
        ref={bodyRef}
        className="rounded-lg p-4 overflow-auto scroll-thin selectable"
        style={{
          maxHeight: '48vh',
          minHeight: 160,
          background: 'var(--panel-2)',
          border: '1px solid var(--border)',
          fontFamily: 'var(--editor-font)',
          fontSize: 15,
          lineHeight: 1.85,
          whiteSpace: 'pre-wrap',
          color: 'var(--editor-text)'
        }}
      >
        {text ? (
          text
        ) : running && thought ? (
          <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>{thought.slice(-600)}</span>
        ) : running ? (
          <span className="pulse">…</span>
        ) : null}
      </div>
      {/* 长耗时（思考模型可能 1-3 分钟）时给出可读进度，别让用户对着省略号猜 */}
      {running && (
        <div className="mt-2 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          {streamStatus({ text, thought, elapsedMs: elapsed })}
        </div>
      )}
      {error && (
        <div className="mt-3 flex items-start gap-2 text-[12.5px]" style={{ color: 'var(--danger)' }}>
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {!running && text && (
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(text)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? '已复制' : '复制全文'}
          </Button>
        </div>
      )}
    </Modal>
  )
}

export function AbortHint(): ReactNode {
  return <IconButton title="停止">停止</IconButton>
}