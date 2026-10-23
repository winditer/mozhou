import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  BookOpen,
  CircleStop,
  Flag,
  Info,
  ListChecks,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Stethoscope
} from 'lucide-react'
import type { Chapter, Project, Thread } from '@shared/types'
import { formatDateTime, stripHtml, truncate, uid } from '@shared/utils'
import { Button, EmptyState, Progress, Segmented, Select, Spinner } from '../../components/ui'
import { abortChat, sendChat } from '../../lib/ai'
import { isAbortMessage, streamStatus, useElapsed } from '../../lib/stream'
import { buildSummaryMessages } from '../../lib/prompt'
import { resolveTaskModel, taskModelLabel, useApp } from '../../store/app'
import { IssueCard } from './audit/IssueCard'
import { MarginNotes } from './audit/MarginNotes'
import {
  buildBookAuditMessages,
  buildChapterAuditMessages,
  buildThreadHuntMessages
} from './audit/prompts'
import {
  locateThreadChapter,
  parseBookIssues,
  parseChapterReport,
  parseThreadSuggestions,
  type AuditIssue,
  type ChapterReport,
  type IssueLevel,
  type ThreadSuggestion
} from './audit/parse'

/* ────────────────────────── 会话级缓存 ──────────────────────────
   扫描结果只存在内存里（按作品 id 区分），不写进 project，
   这样既不会污染数据模型，切回体检页时也不用重跑一次花钱的请求。 */

interface BookCache {
  at: number
  issues: AuditIssue[]
}
interface ChapterCache {
  at: number
  report: ChapterReport
}
interface ThreadCache {
  at: number
  items: ThreadSuggestion[]
}

const cache = {
  book: new Map<string, BookCache>(),
  chapter: new Map<string, ChapterCache>(),
  thread: new Map<string, ThreadCache>()
}

/** 防止组件卸载重挂后重复发起（会重复扣费） */
const inflight = { book: false, chapter: false, thread: false }

type Scope = 'book' | 'chapter' | 'margin' | 'thread'

interface RunState {
  running: boolean
  stage: string
  done: number
  total: number
}

const IDLE: RunState = { running: false, stage: '', done: 0, total: 0 }

/* ────────────────────────── 小工具 ────────────────────────── */

function scoreColor(value: number, invert: boolean): string {
  const good = invert ? value <= 30 : value >= 70
  const mid = invert ? value <= 60 : value >= 45
  if (good) return 'var(--ok)'
  if (mid) return 'var(--warn)'
  return 'var(--danger)'
}

/** 把当前项目的「章节 → 梗概」整理出来；没有摘要的退化成正文片段，不额外花钱 */
function summaryMap(project: Project): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of project.chapters) {
    const cachedSummary = (project.summaries[c.id] || c.summary || '').trim()
    out[c.id] = cachedSummary || truncate(stripHtml(c.content).replace(/\s+/g, ' '), 180)
  }
  return out
}

/**
 * 流式进度接收器：把收到的正文 / 思考增量累积起来交给界面。
 * 体检的产出是结构化结果，没必要逐字渲染正文，只用来显示「已收到多少字」，
 * 让用户在等 1–3 分钟思考模型时能看出模型还在动。
 */
function makeSink(onUpdate: (text: string, thought: string) => void): {
  onDelta: (d: string) => void
  onThought: (d: string) => void
  reset: () => void
} {
  let text = ''
  let thought = ''
  return {
    onDelta: (d) => {
      text += d
      onUpdate(text, thought)
    },
    onThought: (d) => {
      thought += d
      onUpdate(text, thought)
    },
    reset: () => {
      text = ''
      thought = ''
      onUpdate('', '')
    }
  }
}

function MetricBar({
  label,
  value,
  hint,
  invert
}: {
  label: string
  value: number
  hint: string
  invert?: boolean
}): ReactNode {
  const color = scoreColor(value, Boolean(invert))
  return (
    <div className="card p-3">
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-[11.5px] font-medium">{label}</span>
        <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
          {hint}
        </span>
      </div>
      <div className="flex items-baseline gap-1 mt-1">
        <span className="text-[21px] font-semibold tabular-nums leading-none" style={{ color }}>
          {value}
        </span>
        <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
          /100
        </span>
      </div>
      <div className="mt-2 rounded-full overflow-hidden" style={{ height: 5, background: 'var(--panel-2)' }}>
        <div
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            height: '100%',
            background: color,
            borderRadius: 999
          }}
        />
      </div>
    </div>
  )
}

/* ────────────────────────── 主组件 ────────────────────────── */

export function AuditTab({ project }: { project: Project }): ReactNode {
  const config = useApp((s) => s.config)
  const toast = useApp((s) => s.toast)
  const patchProject = useApp((s) => s.patchProject)
  const activeChapterId = useApp((s) => s.activeChapterId)

  const [scope, setScope] = useState<Scope>('book')
  const [run, setRun] = useState<RunState>(IDLE)
  const [raw, setRaw] = useState('')
  const [ignored, setIgnored] = useState<string[]>([])

  const [book, setBook] = useState<BookCache | null>(() => cache.book.get(project.id) ?? null)
  const [chapterId, setChapterId] = useState<string>(() => activeChapterId ?? project.chapters[0]?.id ?? '')
  const [report, setReport] = useState<ChapterReport | null>(null)
  const [reportAt, setReportAt] = useState(0)
  const [suggestions, setSuggestions] = useState<ThreadSuggestion[]>([])
  const [threadAt, setThreadAt] = useState(0)

  const abortedRef = useRef(false)
  /** 本次运行是否已经给过「已停止」提示，避免同名 info 弹两次 */
  const abortNotifiedRef = useRef(false)
  /** 当前这次 AI 调用收到的正文 / 思考（只用来显示进度） */
  const [progress, setProgress] = useState({ text: '', thought: '' })

  // 毫秒级太吵，秒级足够让用户看出模型在动；不设任何上限，等多久都靠它说明情况
  const elapsed = useElapsed(run.running)
  const liveStatus = streamStatus({
    text: progress.text,
    thought: progress.thought,
    elapsedMs: elapsed
  })

  /** 用户主动停止：按 info 文案收尾，不当错误弹红 */
  const noteAbort = useCallback(
    (label: string): void => {
      if (abortNotifiedRef.current) return
      abortNotifiedRef.current = true
      toast(label, 'info')
    },
    [toast]
  )

  /** 已点了停止就直接结束本次流程 */
  const bail = useCallback(
    (label: string): boolean => {
      if (!abortedRef.current) return false
      noteAbort(label)
      return true
    },
    [noteAbort]
  )

  /* 切换作品时重置本地视图 */
  useEffect(() => {
    setBook(cache.book.get(project.id) ?? null)
    setReport(null)
    setReportAt(0)
    setSuggestions([])
    setThreadAt(0)
    setRaw('')
    setIgnored([])
    setChapterId(activeChapterId ?? project.chapters[0]?.id ?? '')
  }, [project.id, activeChapterId])

  const modelLabel = taskModelLabel(config, project, 'audit')
  const configured = modelLabel.indexOf('未配置') === -1

  // 还要为几章现生成摘要（有缓存、有章节 self summary、或没正文的都算命中）
  const pendingSummaries = useMemo(
    () =>
      project.chapters.filter(
        (c) => !(project.summaries[c.id] || c.summary || '').trim() && stripHtml(c.content).trim()
      ).length,
    [project.chapters, project.summaries]
  )

  const currentChapterId = useMemo(() => {
    if (project.chapters.some((c) => c.id === chapterId)) return chapterId
    return project.chapters[0]?.id ?? ''
  }, [chapterId, project.chapters])

  const ensureModel = useCallback((): NonNullable<ReturnType<typeof resolveTaskModel>> | null => {
    const st = useApp.getState()
    const picked = resolveTaskModel(st.config, st.project, 'audit')
    if (!picked) {
      st.toast('请先到设置 → 渠道与模型里配置一个模型', 'error')
      return null
    }
    return picked
  }, [])

  const stop = useCallback((): void => {
    abortedRef.current = true
    abortChat()
  }, [])

  const jumpToChapter = useCallback((id: string): void => {
    const st = useApp.getState()
    st.setActiveChapter(id)
    st.setTab('write')
  }, [])

  /* ── 检查器 1：全书一致性 ── */

  const runBook = async (): Promise<void> => {
    if (inflight.book) {
      toast('上一次体检还在进行中', 'info')
      return
    }
    const picked = ensureModel()
    if (!picked) return

    const snapshot = useApp.getState().project
    if (!snapshot) return
    if (!snapshot.chapters.length) {
      toast('还没有章节，先写点正文再来体检', 'info')
      return
    }

    inflight.book = true
    abortedRef.current = false
    abortNotifiedRef.current = false
    setRaw('')
    setIgnored([])
    setProgress({ text: '', thought: '' })

    const chapterCount = snapshot.chapters.length
    // 摘要占 n 步，统一审校算最后一步，进度条才不会被误读成「已经跑完」
    const total = chapterCount + 1
    const summaries: Record<string, string> = {}
    setRun({ running: true, stage: '准备上下文…', done: 0, total })

    try {
      /* 阶段 A：逐章压缩（已有摘要直接复用） */
      const summaryPicked = resolveTaskModel(
        useApp.getState().config,
        useApp.getState().project,
        'summary'
      )
      const sink = makeSink((text, thought) => setProgress({ text, thought }))

      for (let i = 0; i < chapterCount; i++) {
        if (bail('已停止体检')) return
        sink.reset()
        const live = useApp.getState().project
        const chapter = live?.chapters[i]
        if (!live || !chapter) continue

        const cached = (live.summaries[chapter.id] || chapter.summary || '').trim()
        if (cached) {
          summaries[chapter.id] = cached
          setRun({ running: true, stage: `复用已有摘要 ${i + 1}/${chapterCount} 章`, done: i + 1, total })
          continue
        }

        const body = stripHtml(chapter.content).trim()
        if (!body) {
          summaries[chapter.id] = '（这一章还没有写正文）'
          setRun({ running: true, stage: `跳过空章 ${i + 1}/${chapterCount}`, done: i + 1, total })
          continue
        }

        setRun({ running: true, stage: `摘要 ${i + 1}/${chapterCount} 章 · ${chapter.title}`, done: i, total })
        try {
          const res = await sendChat({
            channel: (summaryPicked ?? picked).channel,
            model: (summaryPicked ?? picked).model,
            messages: buildSummaryMessages(live, chapter),
            task: 'summary',
            temperature: 0.3,
            maxTokens: 700,
            onDelta: sink.onDelta,
            onThought: sink.onThought
          })
          if (bail('已停止体检')) return
          const text = res.text.trim()
          if (text) {
            summaries[chapter.id] = text
            useApp.getState().patchProject((p) => ({ ...p, summaries: { ...p.summaries, [chapter.id]: text } }))
          } else {
            summaries[chapter.id] = truncate(body, 150)
          }
        } catch (e) {
          const message = (e as Error).message || '调用失败'
          // 停止不该被当成「这一章摘要失败」，整次体检直接收尾
          if (abortedRef.current || isAbortMessage(message)) {
            noteAbort('已停止体检')
            return
          }
          // 单章摘要失败不该让整次体检崩掉，退化成正文片段
          summaries[chapter.id] = truncate(body, 150)
          toast(`《${chapter.title}》摘要失败：${message}`, 'error')
        }
        setRun({ running: true, stage: `摘要 ${i + 1}/${chapterCount} 章`, done: i + 1, total })
      }

      if (bail('已停止体检')) return

      /* 阶段 B：统一审校 */
      setRun({ running: true, stage: '统一审校中（最慢的一步，思考模型可能要几分钟）…', done: chapterCount, total })
      const live = useApp.getState().project
      if (!live) return

      sink.reset()
      const res = await sendChat({
        channel: picked.channel,
        model: picked.model,
        messages: buildBookAuditMessages(live, summaries),
        task: 'audit',
        temperature: 0.2,
        maxTokens: 2600,
        onDelta: sink.onDelta,
        onThought: sink.onThought
      })
      if (bail('已停止体检')) return

      const parsed = parseBookIssues(res.text, live)
      if (!parsed.ok) {
        setBook(null)
        setRaw(res.text)
        toast('没能解析成结构化结果，已在页面顶部展示模型返回', 'error')
        return
      }
      const next: BookCache = { at: Date.now(), issues: parsed.value }
      setBook(next)
      cache.book.set(live.id, next)
      toast(
        parsed.value.length ? `体检完成：发现 ${parsed.value.length} 个问题` : '体检完成：没发现明显的不一致',
        'ok'
      )
    } catch (e) {
      const message = (e as Error).message || '调用失败'
      if (abortedRef.current || isAbortMessage(message)) noteAbort('已停止体检')
      else toast(`体检失败：${message}`, 'error')
    } finally {
      inflight.book = false
      setRun(IDLE)
    }
  }

  /* ── 检查器 2：章节体检 ── */

  const runChapterAudit = async (): Promise<void> => {
    if (inflight.chapter) {
      toast('正在体检中，请稍候', 'info')
      return
    }
    const picked = ensureModel()
    if (!picked) return

    const live = useApp.getState().project
    if (!live) return
    const chapter = live.chapters.find((c) => c.id === currentChapterId) ?? live.chapters[0]
    if (!chapter) {
      toast('还没有章节', 'info')
      return
    }
    if (!stripHtml(chapter.content).trim()) {
      toast('这一章还没有正文，先写点内容', 'info')
      return
    }

    inflight.chapter = true
    abortedRef.current = false
    abortNotifiedRef.current = false
    setRaw('')
    setIgnored([])
    setProgress({ text: '', thought: '' })
    setRun({ running: true, stage: `体检《${chapter.title}》…`, done: 0, total: 1 })

    try {
      const sink = makeSink((text, thought) => setProgress({ text, thought }))
      const res = await sendChat({
        channel: picked.channel,
        model: picked.model,
        messages: buildChapterAuditMessages(live, chapter),
        task: 'audit',
        temperature: 0.25,
        maxTokens: 2200,
        onDelta: sink.onDelta,
        onThought: sink.onThought
      })
      if (bail('已停止体检')) return

      const parsed = parseChapterReport(res.text, live, chapter.id)
      if (!parsed.ok) {
        setReport(null)
        setRaw(res.text)
        toast('没能解析成结构化结果，已在页面顶部展示模型返回', 'error')
        return
      }
      const at = Date.now()
      setReport(parsed.value)
      setReportAt(at)
      cache.chapter.set(`${live.id}:${chapter.id}`, { at, report: parsed.value })
      toast('章节体检完成', 'ok')
    } catch (e) {
      const message = (e as Error).message || '调用失败'
      if (abortedRef.current || isAbortMessage(message)) noteAbort('已停止体检')
      else toast(`体检失败：${message}`, 'error')
    } finally {
      inflight.chapter = false
      setRun(IDLE)
    }
  }

  /* ── 检查器 3：伏笔猎手 ── */

  const runThreadHunt = async (): Promise<void> => {
    if (inflight.thread) {
      toast('正在扫描中，请稍候', 'info')
      return
    }
    const picked = ensureModel()
    if (!picked) return

    const live = useApp.getState().project
    if (!live) return
    if (!live.chapters.some((c) => stripHtml(c.content).trim())) {
      toast('还没有正文可供分析', 'info')
      return
    }

    inflight.thread = true
    abortedRef.current = false
    abortNotifiedRef.current = false
    setRaw('')
    setIgnored([])
    setProgress({ text: '', thought: '' })
    setRun({ running: true, stage: '扫描正文里未登记的伏笔…', done: 0, total: 1 })

    try {
      const sink = makeSink((text, thought) => setProgress({ text, thought }))
      const res = await sendChat({
        channel: picked.channel,
        model: picked.model,
        messages: buildThreadHuntMessages(live, summaryMap(live)),
        task: 'audit',
        temperature: 0.35,
        maxTokens: 2000,
        onDelta: sink.onDelta,
        onThought: sink.onThought
      })
      if (bail('已停止扫描')) return

      const parsed = parseThreadSuggestions(res.text, live)
      if (!parsed.ok) {
        setSuggestions([])
        setRaw(res.text)
        toast('没能解析成结构化结果，已在页面顶部展示模型返回', 'error')
        return
      }
      const at = Date.now()
      setSuggestions(parsed.value)
      setThreadAt(at)
      cache.thread.set(live.id, { at, items: parsed.value })
      toast(parsed.value.length ? `找到 ${parsed.value.length} 条未登记的伏笔` : '没找到未登记的伏笔', 'ok')
    } catch (e) {
      const message = (e as Error).message || '调用失败'
      if (abortedRef.current || isAbortMessage(message)) noteAbort('已停止扫描')
      else toast(`扫描失败：${message}`, 'error')
    } finally {
      inflight.thread = false
      setRun(IDLE)
    }
  }

  /* ── 伏笔台账操作 ── */

  const toggleThread = (id: string): void => {
    patchProject((p) => ({
      ...p,
      bible: {
        ...p.bible,
        threads: p.bible.threads.map((t) =>
          t.id === id ? { ...t, status: t.status === 'open' ? 'closed' : 'open' } : t
        )
      }
    }))
  }

  const registerThread = (s: ThreadSuggestion): void => {
    const chapter = s.chapterId ? project.chapters.find((c) => c.id === s.chapterId) : null
    const thread: Thread = {
      id: uid('th'),
      title: s.title,
      setup: chapter ? `《${chapter.title}》：${s.setup}` : s.setup,
      payoff: s.suggestion,
      status: 'open',
      level: 'sub'
    }
    patchProject((p) => ({ ...p, bible: { ...p.bible, threads: [...p.bible.threads, thread] } }))
    setSuggestions((list) => list.filter((x) => x.id !== s.id))
    toast('已登记为伏笔', 'ok')
  }

  /* ── 渲染 ── */

  const lastAt =
    scope === 'book' ? (book?.at ?? 0) : scope === 'chapter' ? reportAt : scope === 'thread' ? threadAt : 0

  const visible = (list: AuditIssue[]): AuditIssue[] => list.filter((x) => !ignored.includes(x.id))
  const ignore = (id: string): void => setIgnored((list) => [...list, id])

  const runBanner = run.running ? (
    <div className="card p-3 mb-3">
      <div className="flex items-center gap-2">
        <Spinner size={12} />
        <span className="text-[12px] flex-1 min-w-0 truncate">{run.stage}</span>
        {run.total > 0 && (
          <span className="text-[11px] tabular-nums shrink-0" style={{ color: 'var(--text-faint)' }}>
            {run.done}/{run.total}
          </span>
        )}
        <Button size="sm" variant="danger" onClick={stop}>
          <CircleStop size={12} /> 停止
        </Button>
      </div>
      {/* 长耗时关卡的「模型在动」证据：思考字数 / 已收到字数 + 已等待秒数，不设超时 */}
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
        <Sparkles size={10} />
        <span className="min-w-0 truncate">{liveStatus}</span>
      </div>
      {run.total > 0 && (
        <div className="mt-2">
          <Progress value={run.done} max={run.total} height={4} />
        </div>
      )}
    </div>
  ) : null

  const rawBlock = raw ? (
    <div className="card p-3 mb-3">
      <div className="flex items-center gap-1.5 mb-2 text-[11.5px]" style={{ color: 'var(--warn)' }}>
        <Info size={12} /> 结构化解析失败，以下是模型的原始返回
      </div>
      <pre
        className="text-[11px] whitespace-pre-wrap rounded-md p-2.5 max-h-[280px] overflow-auto scroll-thin"
        style={{
          background: 'var(--panel-2)',
          border: '1px solid var(--border)',
          fontFamily: "'SF Mono', ui-monospace, Menlo, Consolas, monospace",
          lineHeight: 1.6,
          color: 'var(--text-dim)',
          userSelect: 'text'
        }}
      >
        {raw}
      </pre>
      <div className="mt-2 text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
        模型可能没按格式输出。可以直接再跑一次，或换一个更听话的模型（设置 → 渠道与模型 → 一致性审校）。
      </div>
    </div>
  ) : null

  const modelHint = (
    <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>
      <Sparkles size={11} />
      审校模型：{modelLabel}
    </div>
  )

  const notConfigured = !configured && (
    <div
      className="rounded-md px-3 py-2 mb-3 text-[11.5px]"
      style={{
        background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
        border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)',
        color: 'var(--warn)'
      }}
    >
      还没有配置「一致性审校」的模型，按钮暂不可用。到 设置 → 任务模型 里给它指定一个渠道和模型即可。
    </div>
  )

  return (
    <div className="h-full overflow-auto scroll-thin">
      <div className="max-w-[900px] mx-auto px-8 py-7">
        {/* 顶部：检查器切换 + 上次体检时间 */}
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <Segmented<Scope>
            value={scope}
            options={[
              { value: 'book', label: '全书一致性' },
              { value: 'chapter', label: '章节体检' },
              { value: 'margin', label: '段落侧批' },
              { value: 'thread', label: '伏笔盘点' }
            ]}
            onChange={(v) => {
              setScope(v)
              setRaw('')
              setIgnored([])
            }}
          />
          <div className="flex items-center gap-2 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            <span>
              {lastAt > 0 ? `上次体检 ${formatDateTime(lastAt)}` : '还没有体检过'}
            </span>
          </div>
        </div>

        {notConfigured}
        {runBanner}
        {rawBlock}

        {/* ───────────── 全书一致性 ───────────── */}
        {scope === 'book' && (
          <>
            {(!book || run.running) && (
              <div className="card p-5">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 mt-0.5" style={{ color: 'var(--accent)' }}>
                    <ShieldCheck size={22} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-[14px]">全书一致性体检</div>
                    <div className="text-[12px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                      分两阶段跑：先把每章正文压成摘要（已经生成过的直接复用，不重复花钱），再把角色卡、世界观、时间线、伏笔台账和
                      全部章节梗概一次性交给 AI 统一审校，找出人设漂移、时间错乱、设定被破坏和埋了没填的坑。
                    </div>
                    <div className="mt-3 flex items-center gap-3 flex-wrap">
                      <span className="chip">
                        共 {project.chapters.length} 章 /{' '}
                        {pendingSummaries > 0 ? `${pendingSummaries} 次摘要 + 1 次审校` : '摘要全部命中缓存 + 1 次审校'}
                      </span>
                      <span className="chip">
                        <Flag size={10} /> {project.bible.threads.filter((t) => t.status === 'open').length} 条未回收伏笔
                      </span>
                      {modelHint}
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    size="lg"
                    disabled={!configured || run.running}
                    onClick={() => void runBook()}
                  >
                    {run.running ? <Spinner size={13} /> : <ScanSearch size={14} />}
                    {run.running ? '体检中…' : '开始体检'}
                  </Button>
                </div>
              </div>
            )}

            {book && (
              <>
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span className="text-[12px] font-medium">共 {visible(book.issues).length} 个问题</span>
                  {(['high', 'medium', 'low'] as IssueLevel[]).map((lv) => {
                    const n = visible(book.issues).filter((x) => x.level === lv).length
                    if (!n) return null
                    const color =
                      lv === 'high' ? 'var(--danger)' : lv === 'medium' ? 'var(--warn)' : 'var(--text-faint)'
                    return (
                      <span
                        key={lv}
                        className="chip"
                        style={{
                          height: 20,
                          fontSize: 10.5,
                          color,
                          borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
                          background: `color-mix(in srgb, ${color} 8%, transparent)`
                        }}
                      >
                        {lv === 'high' ? '高' : lv === 'medium' ? '中' : '低'} {n}
                      </span>
                    )
                  })}
                  <div className="flex-1" />
                  <Button size="sm" disabled={run.running} onClick={() => void runBook()}>
                    <RotateCcw size={12} /> 重新体检
                  </Button>
                </div>

                {visible(book.issues).length === 0 ? (
                  <EmptyState
                    icon={<ShieldCheck size={26} />}
                    title={book.issues.length ? '问题都已被你忽略' : '没发现明显的不一致'}
                    desc={
                      book.issues.length
                        ? '当前列表里的问题都被你忽略了。重新体检可以拿到一份新的结果。'
                        : 'AI 通读了全部章节梗概，没有找出人设、时间线、设定或逻辑上的硬伤。这不代表书没问题，只是没有明显的自相矛盾。'
                    }
                    action={
                      <Button size="sm" onClick={() => void runBook()} disabled={run.running}>
                        <RotateCcw size={12} /> 再跑一次
                      </Button>
                    }
                  />
                ) : (
                  <div className="flex flex-col gap-2">
                    {visible(book.issues).map((issue) => (
                      <IssueCard
                        key={issue.id}
                        issue={issue}
                        project={project}
                        onJump={jumpToChapter}
                        onIgnore={() => ignore(issue.id)}
                      />
                    ))}
                  </div>
                )}

                <div className="mt-4 flex items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                  <Info size={11} />
                  结果基于体检当时的内容，写完新章节后建议重新跑一次。忽略只影响当前列表，不会改动任何设定。
                </div>
              </>
            )}
          </>
        )}

        {/* ───────────── 章节体检 ───────────── */}
        {scope === 'chapter' && (
          <>
            <div className="card p-4 mb-3">
              <div className="flex items-end gap-2 flex-wrap">
                <div className="flex-1 min-w-[220px]">
                  <div className="label">选择章节</div>
                  <Select
                    value={currentChapterId}
                    onChange={(e) => {
                      setChapterId(e.target.value)
                      setReport(null)
                      setRaw('')
                      setIgnored([])
                      const hit = cache.chapter.get(`${project.id}:${e.target.value}`)
                      if (hit) {
                        setReport(hit.report)
                        setReportAt(hit.at)
                      } else {
                        setReportAt(0)
                      }
                    }}
                  >
                    {project.chapters.map((c, i) => (
                      <option key={c.id} value={c.id}>
                        {String(i + 1).padStart(2, '0')} · {c.title}（{c.words} 字）
                      </option>
                    ))}
                  </Select>
                </div>
                <Button
                  variant="primary"
                  disabled={!configured || run.running || !project.chapters.length}
                  onClick={() => void runChapterAudit()}
                >
                  <Stethoscope size={14} /> 体检这一章
                </Button>
              </div>
              {project.chapters.length === 0 && (
                <div className="text-[11.5px] mt-2" style={{ color: 'var(--text-faint)' }}>
                  还没有章节。
                </div>
              )}
              <div className="mt-2">{modelHint}</div>
            </div>

            {report && !run.running && (
              <>
                <div className="grid gap-2.5 mb-3" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                  <MetricBar label="节奏" value={report.scores.rhythm} hint="越高越好" />
                  <MetricBar label="冲突" value={report.scores.conflict} hint="越高越好" />
                  <MetricBar label="悬念" value={report.scores.suspense} hint="越高越好" />
                  <MetricBar label="注水" value={report.scores.water} hint="越低越好" invert />
                </div>

                {report.comment && (
                  <div className="card p-3.5 mb-3">
                    <div className="flex items-center gap-1.5 mb-1.5 text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>
                      <ListChecks size={12} /> 编辑评语
                    </div>
                    <div className="text-[12.5px] leading-relaxed selectable">{report.comment}</div>
                  </div>
                )}

                {visible(report.issues).length === 0 ? (
                  <div className="card p-4 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
                    这一章没有被挑出具体问题。
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {visible(report.issues).map((issue) => (
                      <IssueCard
                        key={issue.id}
                        issue={issue}
                        project={project}
                        onJump={jumpToChapter}
                        onIgnore={() => ignore(issue.id)}
                        hideChapters
                      />
                    ))}
                  </div>
                )}
              </>
            )}

            {!report && !run.running && project.chapters.length > 0 && (
              <div className="card p-4 flex items-start gap-2.5">
                <div className="shrink-0 mt-0.5" style={{ color: 'var(--text-faint)' }}>
                  <Stethoscope size={16} />
                </div>
                <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                  单章体检会给这一章打四个分（节奏、冲突、悬念、注水程度），并指出具体位置的问题。
                  想看整本书前后对不对得上，切到「全书一致性」。
                </div>
              </div>
            )}
          </>
        )}

        {/* ───────────── 伏笔盘点 ───────────── */}
        {scope === 'margin' && (
          <div className="card overflow-hidden" style={{ height: 560 }}>
            <MarginNotes
              project={project}
              chapter={project.chapters.find((c: Chapter) => c.id === currentChapterId) ?? project.chapters[0] ?? null}
              resolveModel={() => {
                const r = resolveTaskModel(config, project, 'audit')
                return r ? { channel: r.channel, model: r.model, label: r.label } : null
              }}
            />
          </div>
        )}

        {scope === 'thread' && (
          <>
            <div className="card p-4 mb-3">
              <div className="flex items-start gap-3">
                <div className="shrink-0 mt-0.5" style={{ color: 'var(--accent)' }}>
                  <Flag size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[13.5px]">
                    伏笔台账 · 共 {project.bible.threads.length} 条 /{' '}
                    <span style={{ color: 'var(--warn)' }}>
                      {project.bible.threads.filter((t) => t.status === 'open').length} 条未回收
                    </span>
                  </div>
                  <div className="text-[11.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                    下面是设定里已经登记的伏笔，本地直接列出、不花任何额度。点章节名可以跳到埋设的那一章去补。
                  </div>
                </div>
                <Button size="sm" disabled={!configured || run.running} onClick={() => void runThreadHunt()}>
                  <ScanSearch size={12} /> AI 找出正文里未登记的伏笔
                </Button>
              </div>
            </div>

            {project.bible.threads.length === 0 ? (
              <div className="card p-4 mb-3 text-[12px]" style={{ color: 'var(--text-faint)' }}>
                台账还是空的。可以先去「设定 → 伏笔」手动建几条，或者让 AI 从正文里帮你找。
              </div>
            ) : (
              <div className="flex flex-col gap-2 mb-4">
                {[...project.bible.threads]
                  .sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1))
                  .map((t) => {
                    const located = locateThreadChapter(t.setup, project)
                    const chapter = located ? project.chapters.find((c) => c.id === located) : null
                    return (
                      <div
                        key={t.id}
                        className="card p-3"
                        style={{
                          borderLeft: `3px solid ${t.status === 'open' ? 'var(--warn)' : 'var(--border-strong)'}`
                        }}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[13px] font-medium flex-1 min-w-[140px] truncate">{t.title}</span>
                          <span className="chip" style={{ height: 18, fontSize: 10.5 }}>
                            {t.level === 'main' ? '主线' : '支线'}
                          </span>
                          {chapter ? (
                            <button
                              className="chip surface-hover"
                              style={{ height: 20, fontSize: 10.5, cursor: 'default' }}
                              onClick={() => jumpToChapter(chapter.id)}
                              title="跳到这一章"
                            >
                              <BookOpen size={10} /> {chapter.title}
                            </button>
                          ) : (
                            <span className="chip" style={{ height: 20, fontSize: 10.5 }} title="没能从埋设描述里认出是第几章">
                              埋设章 —
                            </span>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => toggleThread(t.id)}>
                            {t.status === 'open' ? '标记已回收' : '标记未回收'}
                          </Button>
                        </div>
                        {(t.setup || t.payoff) && (
                          <div className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                            {t.setup && <span>埋设：{truncate(t.setup, 120)}</span>}
                            {t.setup && t.payoff && <span style={{ color: 'var(--text-faint)' }}> ｜ </span>}
                            {t.payoff && <span>回收：{truncate(t.payoff, 120)}</span>}
                          </div>
                        )}
                      </div>
                    )
                  })}
              </div>
            )}

            {suggestions.length > 0 && (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[12px] font-medium">AI 找到 {suggestions.length} 条未登记的伏笔</span>
                  <div className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => setSuggestions([])}>
                    清空
                  </Button>
                </div>
                <div className="flex flex-col gap-2">
                  {suggestions.map((s) => {
                    const chapter = s.chapterId ? project.chapters.find((c) => c.id === s.chapterId) : null
                    return (
                      <div key={s.id} className="card p-3">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                              <span
                                className="chip"
                                style={{
                                  height: 18,
                                  fontSize: 10.5,
                                  color: 'var(--accent)',
                                  borderColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
                                  background: 'color-mix(in srgb, var(--accent) 8%, transparent)'
                                }}
                              >
                                未登记
                              </span>
                              {chapter ? (
                                <button
                                  className="chip surface-hover"
                                  style={{ height: 18, fontSize: 10.5, cursor: 'default' }}
                                  onClick={() => jumpToChapter(chapter.id)}
                                >
                                  <BookOpen size={10} /> {chapter.title}
                                </button>
                              ) : (
                                <span className="chip" style={{ height: 18, fontSize: 10.5 }}>
                                  章节未定位
                                </span>
                              )}
                            </div>
                            <div className="text-[13px] font-medium leading-snug">{s.title}</div>
                            {s.setup && (
                              <div className="text-[12px] mt-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                                {s.setup}
                              </div>
                            )}
                            {s.suggestion && (
                              <div className="text-[11.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-faint)' }}>
                                回收建议：{s.suggestion}
                              </div>
                            )}
                          </div>
                          <Button size="sm" onClick={() => registerThread(s)}>
                            <Flag size={12} /> 登记为伏笔
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {run.running && suggestions.length === 0 && (
              <div className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                正在通读 {project.chapters.length} 章梗概找悬念，稍等…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}