import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PromptMessage, Project } from '@shared/types'
import { countWords } from '@shared/utils'
import { abortChat, sendChat } from '../../../lib/ai'
import { isAbortMessage, streamStatus, useElapsed } from '../../../lib/stream'
import { resolveTaskModel, useApp } from '../../../store/app'
import { Button, Textarea } from '../../../components/ui'
import { Columns2, Copy, Square, Sparkles } from 'lucide-react'
import { buildTrialMessages, cleanList, seedFromProject, type StyleSource } from './prompts'

function Pane({
  title,
  tag,
  accent,
  text,
  running,
  empty
}: {
  title: string
  tag: string
  accent?: boolean
  text: string
  running: boolean
  empty: string
}): ReactNode {
  const words = countWords(text)
  return (
    <div
      className="card flex flex-col overflow-hidden"
      style={{
        borderColor: accent ? 'color-mix(in srgb, var(--accent) 32%, var(--border))' : 'var(--border)',
        background: accent ? 'color-mix(in srgb, var(--accent-soft) 55%, var(--panel))' : 'var(--panel)'
      }}
    >
      <div
        className="flex items-center gap-1.5 px-3 h-9 shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <span className="text-[12px] font-medium">{title}</span>
        <span className="chip" style={{ height: 18, fontSize: 10.5 }}>
          {tag}
        </span>
        <div className="flex-1" />
        <span className="text-[10.5px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
          {words ? `${words} 字` : ''}
        </span>
        <button
          className="icon-btn"
          style={{ width: 24, height: 24 }}
          title="复制这段"
          disabled={!text}
          onClick={() => void navigator.clipboard.writeText(text)}
        >
          <Copy size={12} />
        </button>
      </div>
      <div className="p-3 min-h-[168px] max-h-[260px] overflow-auto scroll-thin">
        {text ? (
          <div
            className="text-[12.5px] leading-[1.85] whitespace-pre-wrap selectable"
            style={{ color: 'var(--text)' }}
          >
            {text}
          </div>
        ) : (
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            {running ? '正在写…' : empty}
          </div>
        )}
      </div>
    </div>
  )
}

export function TrialCompare({
  project,
  name,
  samples,
  traits
}: {
  project: Project
  name: string
  samples: string[]
  traits: string[]
}): ReactNode {
  const { config, toast } = useApp()
  const [seed, setSeed] = useState(() => seedFromProject(project))
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  /** 两路各自的思考增量，只用来显示进度；正文仍以 onDelta 收到的为准 */
  const [leftThought, setLeftThought] = useState('')
  const [rightThought, setRightThought] = useState('')
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 双路并发也一样：秒级计时 + 思考字数，等多久都继续等
  const elapsed = useElapsed(running)
  const liveStatus = streamStatus({
    text: left + right,
    thought: leftThought + rightThought,
    elapsedMs: elapsed
  })

  const aliveRef = useRef(true)
  const runRef = useRef(false)
  const stoppedRef = useRef(false)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (runRef.current) abortChat()
    }
  }, [])

  const cleanSamples = cleanList(samples)
  const cleanTraits = cleanList(traits)
  const resolved = resolveTaskModel(config, project, 'draft')

  const compare = async (): Promise<void> => {
    if (!resolved) {
      toast('还没有可用模型，请先到设置 → 渠道与模型里配置', 'error')
      return
    }
    const s = seed.trim()
    if (!s) {
      toast('先给一个引子，比如主角此刻正在做什么', 'error')
      return
    }

    setLeft('')
    setRight('')
    setLeftThought('')
    setRightThought('')
    setErr(null)
    setRunning(true)
    runRef.current = true
    stoppedRef.current = false

    const src: StyleSource = { traits: cleanTraits, samples: cleanSamples }
    const messagesNo = buildTrialMessages(s, null)
    const messagesOn = buildTrialMessages(s, src)

    const fire = (
      messages: PromptMessage[],
      push: (d: string) => void,
      pushThought: (d: string) => void
    ): ReturnType<typeof sendChat> =>
      sendChat({
        channel: resolved.channel,
        model: resolved.model,
        messages,
        task: 'draft',
        temperature: 0.85,
        maxTokens: 600,
        onDelta: (d) => {
          if (!aliveRef.current) return
          push(d)
        },
        onThought: (d) => {
          if (!aliveRef.current) return
          pushThought(d)
        }
      })

    // 两路并发：先各自发起，再统一 await
    const p1 = fire(messagesNo, (d) => setLeft((t) => t + d), (d) => setLeftThought((t) => t + d))
    const p2 = fire(messagesOn, (d) => setRight((t) => t + d), (d) => setRightThought((t) => t + d))
    const [r1, r2] = await Promise.allSettled([p1, p2])

    runRef.current = false
    if (!aliveRef.current) return
    setRunning(false)
    if (stoppedRef.current) return

    const e1 = r1.status === 'rejected' ? (r1.reason as Error).message : ''
    const e2 = r2.status === 'rejected' ? (r2.reason as Error).message : ''
    if (e1 || e2) {
      const msg = [e1 && `裸写失败：${e1}`, e2 && `带分身失败：${e2}`].filter(Boolean).join('；')
      // 用户主动停止（含 main 抛的「已中止」）只留一句 info，不展示成红色失败
      if (isAbortMessage(msg)) {
        toast('已停止生成', 'info')
        return
      }
      setErr(msg)
      toast(msg, 'error')
    }
  }

  const stop = (): void => {
    stoppedRef.current = true
    runRef.current = false
    abortChat()
    setRunning(false)
    toast('已停止生成', 'info')
  }

  return (
    <div>
      <div className="card p-3 mb-3">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles size={13} style={{ color: 'var(--accent)' }} />
          <span className="text-[12px] font-medium">给个引子</span>
          <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            同一个引子写两遍：左边裸写，右边带上你的分身——差别一眼就能看出来。
          </span>
        </div>
        <Textarea
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          rows={2}
          placeholder="例如：雨停之后，她在巷口看见那辆本该报废的旧车又停回来了。"
          style={{ minHeight: 56 }}
        />
        <div className="flex items-center gap-2 mt-2">
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
            {cleanTraits.length} 条特征 · {cleanSamples.length} 段样本
            {cleanTraits.length === 0 && ' · 无特征卡时仅做样本注入'}
          </span>
          <div className="flex-1" />
          {running ? (
            <Button size="sm" variant="danger" onClick={stop}>
              <Square size={11} /> 停止
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void compare()} disabled={!resolved}>
              <Columns2 size={12} /> 对比试写
            </Button>
          )}
        </div>
        {!resolved && (
          <div className="text-[11px] mt-1.5" style={{ color: 'var(--warn)' }}>
            未配置模型，无法试写。请先到设置里添加渠道与模型。
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11.5px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
          {running
            ? `两路并发中 · ${liveStatus}`
            : left || right
              ? '对比结果'
              : '结果'}
        </span>
        <div className="flex-1" />
        <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
          「{name.trim() || '未命名分身'}」
        </span>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Pane
          title="不带分身"
          tag="模型裸写"
          text={left}
          running={running}
          empty="点「对比试写」，这里会出现模型在没有任何文风约束时的写法——通常四平八稳、句式均匀。"
        />
        <Pane
          title="带分身"
          tag={cleanTraits.length ? `${cleanTraits.length} 条特征` : '仅样本'}
          accent
          text={right}
          running={running}
          empty="右边会注入你的特征卡与前 3 段样本。两栏并排一看，像不像当场见分晓。"
        />
      </div>

      {err && (
        <div className="text-[11px] mt-2" style={{ color: 'var(--danger)' }}>
          {err}
        </div>
      )}

      <div className="text-[10.5px] mt-2.5 leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        不满意就回上一步改特征卡，或换几段更有代表性的样本再试。试写是廉价验收，比正式写完整章再返工便宜得多。
      </div>
    </div>
  )
}