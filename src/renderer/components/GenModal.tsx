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
  /**
   * 最新一次 stage 文案。
   *
   * onStage 是回调，闭包里读到的 state 永远是旧的，所以用 ref 同步一份。
   * 结束时据它决定显示「已完成」还是「已补写 N 轮」——以前结束一律覆盖成
   * 「生成完成」，把补写过程抹掉了，用户看到字分好几段蹦出来却不知道发生过什么。
   */
  const stageRef = useRef('')
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
            if (runIdRef.current !== runId) return
            stageRef.current = s
            setStage(s)
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
          // 保留最后一条过程文案（可能写着「已补写 N 轮」）。这里以前写死
          // setStage('已完成')，把补写/重试的记录全抹掉了。
          setStage(summarizeFinishStage(stageRef.current))
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
  /**
   * 已经跑完但一个字都没有：这是用户报的「思考很久、最后空白」那个现象。
   * 不能再让弹窗只写一句「生成完成」——要说清是模型只想了没写，以及怎么改。
   */
  const blankResult = !running && !error && words === 0 && thought.trim().length > 0

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
            <span>
              {running
                ? stage
                : error
                  ? '生成中断'
                  : blankResult
                    ? '模型只思考，没有写正文'
                    : stage}
            </span>
            {words > 0 && (
              <span className="chip" style={{ height: 20 }}>
                {words} 字
                {config.expectWords ? ` / ${config.expectWords}` : ''}
              </span>
            )}
            {!running && !error && words > 0 && pct !== null && pct < 85 && (
              <span className="text-[11px]" style={{ color: 'var(--accent)' }}>
                不足目标，可点「重新生成」再来一次
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
        <div className="mb-3">
          <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--panel-2)' }}>
            <div
              className="h-full transition-all"
              style={{ width: `${pct}%`, background: pct >= 85 ? 'var(--ok)' : 'var(--accent)' }}
            />
          </div>
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
      {/* 长耗时（思考模型可能 1-3 分钟）时给出可读进度，别让用户对着省略号猜。
          思考阶段单独一行说清「模型在思考、还没开始写正文」，这是用户最常误判成
          「卡死了」的那一段。 */}
      {running && (
        <div className="mt-2 space-y-1 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          <div>{streamStatus({ text, thought, elapsedMs: elapsed })}</div>
          {!text && thought && elapsed > 15_000 && (
            <div style={{ color: 'var(--accent)' }}>
              推理模型会先把整段思路想完再动笔，这段时间界面上不会有正文。着急的话可以点「停止」——已经想出来的部分不会变成正文。
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="mt-3 flex items-start gap-2 text-[12.5px]" style={{ color: 'var(--danger)' }}>
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {blankResult && (
        <div
          className="mt-3 rounded-lg p-3 text-[12px] leading-relaxed"
          style={{ background: 'var(--accent-soft)', color: 'var(--text-dim)' }}
        >
          模型把输出额度全用在思考上了，正文一个字都没写出来。常见于「推理模型 + 目标字数不够大」：
          思考 token 和正文 token 共用同一份输出额度，想得越久，留给正文的越少。
          <div className="mt-1.5" style={{ color: 'var(--text-faint)' }}>
            解决办法：① 写作页把「正文模型」换成非推理模型（如 deepseek-chat 这类）；
            ② 或到「设置 → 输出预算 → 写作 → 正文生成」把额度调大；③ 或把本章目标字数调大后重来。
          </div>
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

/**
 * 收尾时显示哪句话。
 *
 * 「已完成」「正在生成…」这类没有信息量的文案，跑完就统一说「生成完成」；
 * 凡是看得出过程细节的（补写轮次、篇幅不足、重试、被截断）都必须留住——
 * 那正是用户判断「要不要换个模型 / 要不要调预算」的依据。
 */
function summarizeFinishStage(last: string): string {
  const s = (last || '').trim()
  if (!s) return '生成完成'
  // 必须整句比对，不能用 /已完成/ 这样的包含匹配：generate.ts 在补写过的情况下
  // 给的是「已完成（首轮篇幅不足，自动补写 3 轮，共 2132 字）」，包含匹配会把这条
  // 有信息量的文案也吞成「生成完成」，补写过程就又被藏起来了（这是实测踩到的）。
  const NOISE = ['已完成', '正在生成…', '正在连接模型…', '准备中…', '已停止']
  if (NOISE.includes(s)) return '生成完成'
  // 其余「已完成（…）」保留括号里的细节，只把开头统一成「已完成」
  return s
}

export function AbortHint(): ReactNode {
  return <IconButton title="停止">停止</IconButton>
}