import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
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
import type { Project, Thread } from '@shared/types'
import { formatDateTime, stripHtml, truncate, uid } from '@shared/utils'
import { Button, EmptyState, Progress, Segmented, Select, Spinner } from '../../components/ui'
import { abortChat, sendChat } from '../../lib/ai'
import { isAbortMessage, streamStatus, useElapsed } from '../../lib/stream'
import { buildSummaryMessages } from '../../lib/prompt'
import { countWords } from '@shared/utils'
import {
  alignRewrite,
  applyParagraphRewrite,
  buildCrossChapterMessages,
  buildRewriteMessages,
  candidateParagraphs,
  checkRewriteTouchesIssue,
  locateEvidence,
  splitParagraphs,
  type BodyParagraph
} from './audit/apply'
import { ApplyPreviewModal, type ApplyPreviewState, type DiffPair } from './audit/ApplyPreview'
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, resolveBudget } from '@shared/budgets'
import { resolveTaskModel, taskModelLabel, useApp } from '../../store/app'
import { IssueCard } from './audit/IssueCard'
import { MarginNotes } from './audit/MarginNotes'
import { AiFlavorPanel } from './audit/AiFlavorPanel'
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

type Scope = 'book' | 'chapter' | 'margin' | 'thread' | 'aiFlavor'

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
  // 0 表示「模型没给这一项打分」，不是「得了 0 分」。
  // 显示成红色的 0/100 会被读成极差，所以单独标成「未评」。
  const unrated = value <= 0
  return (
    <div className="card p-3">
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-[11.5px] font-medium">{label}</span>
        <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
          {hint}
        </span>
      </div>
      <div className="flex items-baseline gap-1 mt-1">
        {unrated ? (
          <span className="text-[15px] font-medium" style={{ color: 'var(--text-faint)' }}>
            未评
          </span>
        ) : (
          <>
            <span className="text-[21px] font-semibold tabular-nums leading-none" style={{ color }}>
              {value}
            </span>
            <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
              /100
            </span>
          </>
        )}
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
  /**
   * 模型一个字都没返回时的说明。
   *
   * 和 raw 分开存：raw 是「有内容但格式不对」，可以整段贴出来给人看；
   * 这里是「压根没内容」，没有东西可贴，只能给一句人能看懂的原因。
   * 两者以前混用一个状态，空串渲染不出任何块，于是页面静默无结果。
   */
  const [emptyReason, setEmptyReason] = useState('')
  /** 采用建议的对比预览状态；null 表示弹窗关闭 */
  const [apply, setApply] = useState<ApplyPreviewState | null>(null)
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
    setEmptyReason('')
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
    setEmptyReason('')
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
          // 预算在发请求时现取，保证拿到最新配置（run* 不是 useCallback，不能用组件作用域的旧值）
          const budgets = useApp.getState().config?.settings.tokenBudgets ?? DEFAULT_TOKEN_BUDGETS
          const res = await sendChat({
            channel: (summaryPicked ?? picked).channel,
            model: (summaryPicked ?? picked).model,
            messages: buildSummaryMessages(live, chapter),
            task: 'summary',
            temperature: 0.3,
            maxTokens: resolveBudget(budgets, BUDGET_KEYS.summaryAudit),
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
      const budgets = useApp.getState().config?.settings.tokenBudgets ?? DEFAULT_TOKEN_BUDGETS
      const res = await sendChat({
        channel: picked.channel,
        model: picked.model,
        messages: buildBookAuditMessages(live, summaries),
        task: 'audit',
        temperature: 0.2,
        // 体检输出是固定结构的 JSON，不需要深推理；不关思考的话 reasoning 会先吃掉
        // 大半个 maxTokens，最后 JSON 只写一半甚至正文为空（thoughtStarved）
        thinking: 'off',
        maxTokens: resolveBudget(budgets, BUDGET_KEYS.auditBook),
        onDelta: sink.onDelta,
        onThought: sink.onThought
      })
      if (bail('已停止体检')) return

      // 模型一个字都没给（思考把额度吃光 / 网关返回空）：这和「格式不对」是两回事。
      // 以前两者都走 setRaw(res.text)，而空串渲染不出任何块，页面看起来就是
      // 「跑完了但什么都没有」——用户根本不知道发生过什么。
      if (!res.text.trim()) {
        setBook(null)
        setRaw('')
        setEmptyReason(
          res.thoughtStarved
            ? '模型把输出额度全用在思考上了，一个字都没返回。请到「设置 → 输出预算 → 体检 → 全书一致性」把额度调大，或换一个非推理模型后重试。'
            : '模型这次没有返回任何内容。请重试；若反复如此，检查该渠道的模型名与余额。'
        )
        toast('体检没有得到任何返回', 'error')
        return
      }
      setEmptyReason('')

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
    setEmptyReason('')
    setIgnored([])
    setProgress({ text: '', thought: '' })
    setRun({ running: true, stage: `体检《${chapter.title}》…`, done: 0, total: 1 })

    try {
      const sink = makeSink((text, thought) => setProgress({ text, thought }))
      const budgets = useApp.getState().config?.settings.tokenBudgets ?? DEFAULT_TOKEN_BUDGETS
      const res = await sendChat({
        channel: picked.channel,
        model: picked.model,
        messages: buildChapterAuditMessages(live, chapter),
        task: 'audit',
        temperature: 0.25,
        thinking: 'off',
        maxTokens: resolveBudget(budgets, BUDGET_KEYS.auditChapter),
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
      // 模型没按 JSON 格式输出、结果是从文字里还原的：要说明，
      // 免得作者以为这些分数是模型严格评出来的。
      if (parsed.note) toast(`章节体检完成，但${parsed.note}`, 'info')
      else toast('章节体检完成', 'ok')
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
    setEmptyReason('')
    setIgnored([])
    setProgress({ text: '', thought: '' })
    setRun({ running: true, stage: '扫描正文里未登记的伏笔…', done: 0, total: 1 })

    try {
      const sink = makeSink((text, thought) => setProgress({ text, thought }))
      const budgets = useApp.getState().config?.settings.tokenBudgets ?? DEFAULT_TOKEN_BUDGETS
      const res = await sendChat({
        channel: picked.channel,
        model: picked.model,
        messages: buildThreadHuntMessages(live, summaryMap(live)),
        task: 'audit',
        temperature: 0.35,
        thinking: 'off',
        maxTokens: resolveBudget(budgets, BUDGET_KEYS.auditThread),
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

  /* ── 采用建议：按 evidence 定位段落 → AI 只重写这几段 → 预览确认 ── */

  /**
   * 正在改的那条问题与它定位到的段落。
   * 存在 ref 里是因为「确认写入」要用到生成时算好的段落位置，
   * 而那时候界面状态可能已经被别处改动过。
   */
  const applyCtxRef = useRef<{
    issue: AuditIssue
    /** 每个被改章节：它的正文分段与命中的段落下标 */
    groups: { chapterId: string; chapterTitle: string; paragraphs: BodyParagraph[]; indexes: number[] }[]
    /** 每段的原文，用于写入前校验正文是否被改过 */
    originals: string[]
  } | null>(null)

  /**
   * 采用一条体检建议：定位段落 → 只重写这几段 → 给作者看对比 → 确认才落盘。
   *
   * 两者共用同一条路径，差别只在「怎么找段落」：
   *   - 章节体检：evidence 是正文原话，用 locateEvidence 精确找，找不到就不改；
   *   - 全书一致性：evidence 是从**章节梗概**里摘的，和正文不会一字不差，
   *     所以在涉及章节里按相似度找候选，并把「我猜的是这几段」明说给作者看。
   * 两种情况下作者都能在预览里逐段跳过，所以「猜」不会变成「乱改」。
   */
  const startApply = async (issue: AuditIssue): Promise<void> => {
    const picked = ensureModel()
    if (!picked) return

    const live = useApp.getState().project
    if (!live) return

    // 这条问题是从「全书一致性」的结果里点出来的吗？两个来源的证据性质不同：
    // 全书体检的证据摘自章节梗概，允许相似度推测；章节体检的证据是正文原话，必须精确。
    const fromBook = (book?.issues ?? []).some((x) => x.id === issue.id)

    // 全书一致性的问题可以横跨多章，全部纳入；章节体检只有一章。
    // chapterIds 是模型填的，可能指向已删除的章节，也可能把梗概序号当成 id 填了，
    // 所以先按真实存在的 id 过滤；一个都不剩时退回「当前章」。
    const ids = issue.chapterIds.filter((id) => live.chapters.some((c) => c.id === id))

    /**
     * 建议文字里常写着「把第 1 章的 X 改为 Y」，而 chapterIds 可能只填了
     * 矛盾的另一侧（甚至漏填）。所以再从建议和问题描述里把「第 N 章」抠出来，
     * 用章序号定位到真实章节，优先尝试——这是模型亲口指定的位置，比盲猜可靠。
     */
    const mentioned: number[] = []
    for (const text of [issue.suggestion, issue.detail, issue.title]) {
      for (const m of String(text || '').matchAll(/第\s*(\d{1,4})\s*章/g)) {
        const n = parseInt(m[1], 10)
        if (n >= 1 && n <= live.chapters.length) mentioned.push(n - 1)
      }
    }
    const mentionedIds = [...new Set(mentioned)].map((i) => live.chapters[i]?.id).filter(Boolean) as string[]

    // 优先：chapterIds ∩ 建议提到的章节 → 建议提到的 → chapterIds → 当前章
    const byId = new Set(ids)
    const bothSides = mentionedIds.filter((id) => byId.has(id))
    const targets0 = bothSides.length
      ? bothSides
      : mentionedIds.length
        ? mentionedIds
        : ids.length
          ? ids
          : [chapterId]
    let chapters = targets0
      .map((id) => live.chapters.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
    if (!chapters.length) {
      toast('找不到这条建议对应的章节', 'error')
      return
    }

    if (!issue.evidence.trim()) {
      setApply({
        running: false,
        error: '这条建议没有给出原文证据，无法判断该改哪一段。请重新体检，或手动修改。',
        pairs: [],
        title: issue.title,
        suggestion: issue.suggestion,
        canRetry: false
      })
      return
    }

    /* ── 定位 ── */
    const groups: { chapterId: string; chapterTitle: string; paragraphs: BodyParagraph[]; indexes: number[] }[] = []
    let anyExact = false
    let anyApprox = false
    for (const ch of chapters) {
      const paragraphs = splitParagraphs(ch.content)
      const strict = locateEvidence(paragraphs, issue.evidence)
      if (strict.indexes.length) {
        anyExact = true
        groups.push({ chapterId: ch.id, chapterTitle: ch.title, paragraphs, indexes: strict.indexes })
        continue
      }
      // 注意这里不 break：全书体检是跨章问题，可能有两章都提到同一件事
      // （「A 章说二十岁、C 章说二十五岁」），只命中一侧就停会让矛盾改不干净。
      // 章节体检的证据必须是正文原话，找不到就是找不到，不做推测；
      // 全书体检才退到「相似度候选」。判断依据必须是**问题本身的来源**而不是
      // 当前标签页——用户在看结果时切到别的标签再切回来，scope 会变，
      // 拿它当依据会让同一份结果的行为时对时错。
      if (!fromBook) continue
      const cand = candidateParagraphs(paragraphs, issue.evidence)
      if (cand.indexes.length) {
        anyApprox = true
        groups.push({ chapterId: ch.id, chapterTitle: ch.title, paragraphs, indexes: cand.indexes })
      }
    }

    // 指定章节里找不到，但这是全书体检的问题时，扩大到全书再找一次：
    // 模型的 chapterIds 常常只写到「矛盾的一侧」，正文证据可能在另一章。
    if (!groups.length && fromBook && chapters.length < live.chapters.length) {
      for (const ch of live.chapters) {
        if (chapters.some((c) => c.id === ch.id)) continue
        const paragraphs = splitParagraphs(ch.content)
        const strict = locateEvidence(paragraphs, issue.evidence)
        if (strict.indexes.length) {
          anyExact = true
          groups.push({ chapterId: ch.id, chapterTitle: ch.title, paragraphs, indexes: strict.indexes })
          continue
        }
        const cand = candidateParagraphs(paragraphs, issue.evidence)
        if (cand.indexes.length) {
          anyApprox = true
          groups.push({ chapterId: ch.id, chapterTitle: ch.title, paragraphs, indexes: cand.indexes })
        }
      }
    }

    if (!groups.length) {
      setApply({
        running: false,
        error: '这条建议定位不到具体段落：它引用的原文在正文里找不到相似内容。可能正文已经改过，请重新体检或手动修改。',
        pairs: [],
        title: issue.title,
        suggestion: issue.suggestion,
        canRetry: false
      })
      return
    }

    const originals = groups.flatMap((g) => g.indexes.map((i) => g.paragraphs[i].text))
    applyCtxRef.current = { issue, groups, originals }

    const multi = groups.length > 1
    // 体检说涉及 N 章、实际只定位到 M 章时，必须说清楚——
    // 否则作者会以为矛盾已经全改完，实际只动了一部分，剩下的还留着。
    const declared = new Set(issue.chapterIds.filter((id) => live.chapters.some((c) => c.id === id))).size
    const missed = declared > groups.length
    const note = [
      multi ? `涉及 ${groups.length} 章` : '定位到 1 章',
      missed ? `体检提到 ${declared} 章，其中 ${declared - groups.length} 章没找到对应正文` : '',
      anyApprox && !anyExact ? '按原文相似度推测的段落，请确认改对了地方' : '',
      multi ? '将统一各章口径' : ''
    ]
      .filter(Boolean)
      .join('；')

    setApply({ running: true, error: null, pairs: [], title: issue.title, suggestion: issue.suggestion, note })

    try {
      /* ── 改写 ── */
      let messages
      if (multi) {
        messages = buildCrossChapterMessages({
          groups: groups.map((g) => ({
            chapterTitle: g.chapterTitle,
            targets: g.indexes.map((i) => g.paragraphs[i].text)
          })),
          title: issue.title,
          detail: issue.detail,
          suggestion: issue.suggestion
        })
      } else {
        const g = groups[0]
        const first = g.indexes[0]
        const last = g.indexes[g.indexes.length - 1]
        messages = buildRewriteMessages({
          targets: g.indexes.map((i) => g.paragraphs[i].text),
          before: g.paragraphs.slice(Math.max(0, first - 2), first).map((x) => x.text).filter(Boolean),
          after: g.paragraphs.slice(last + 1, last + 3).map((x) => x.text).filter(Boolean),
          title: issue.title,
          detail: issue.detail,
          suggestion: issue.suggestion
        })
      }

      const res = await sendChat({
        channel: picked.channel,
        model: picked.model,
        messages,
        task: 'polish',
        temperature: 0.4,
        maxTokens: resolveBudget(
          useApp.getState().config?.settings.tokenBudgets ?? DEFAULT_TOKEN_BUDGETS,
          BUDGET_KEYS.draftSelection
        )
      })

      const rewritten = alignRewrite(res.text, originals.length)
      const pairs: DiffPair[] = []
      let k = 0
      for (const g of groups) {
        for (const pi of g.indexes) {
          const before = g.paragraphs[pi].text
          const after = rewritten[k] || before
          pairs.push({
            // 段号对单章体检就是章内序号；多章时靠 chapterId 区分，序号仍用章内序号更直观
            index: multi ? pi + 1 : pi + 1,
            before,
            after,
            chapterId: g.chapterId,
            chapterTitle: g.chapterTitle
          })
          k++
        }
      }
      const changed = pairs.some((p) => p.before !== p.after)
      // 改动非空不等于改到了点子上：模型常常只是把段落重述一遍。
      // 若建议里的明确替换（如「把亡妻改为妻子」）在结果里没落实，必须提醒。
      const notTargeted = changed
        ? checkRewriteTouchesIssue(
            pairs.map((p) => p.before),
            pairs.map((p) => p.after),
            issue.suggestion
          )
        : null

      setApply({
        running: false,
        error: changed ? null : '模型没有给出任何改动。可以重试，或直接手动修改。',
        pairs,
        title: issue.title,
        suggestion: issue.suggestion,
        canRetry: !changed,
        note: notTargeted ?? note
      })
    } catch (e) {
      setApply({
        running: false,
        error: `改写失败：${(e as Error).message || '调用失败'}`,
        pairs: [],
        title: issue.title,
        suggestion: issue.suggestion,
        canRetry: true
      })
    }
  }

  const confirmApply = (): void => {
    const ctx = applyCtxRef.current
    const st = useApp.getState()
    const live = st.project
    if (!ctx || !live) return

    const kept = (apply?.pairs ?? []).filter((p) => p.before !== p.after)
    if (!kept.length) {
      toast('没有需要写入的改动', 'info')
      return
    }

    // 逐章重新读取当前正文并重新校验：生成对比期间正文可能被编辑过，
    // 拿旧的段落位置去替换会把内容写错地方。多章时任何一章不通过就整体中止，
    // 避免「改了一半」这种更难收拾的中间状态。
    const byChapter = new Map<string, DiffPair[]>()
    for (const p of kept) {
      const id = p.chapterId ?? ctx.groups[0].chapterId
      if (!byChapter.has(id)) byChapter.set(id, [])
      ;(byChapter.get(id) as DiffPair[]).push(p)
    }

    const plans: { chapter: NonNullable<typeof live.chapters[number]>; paragraphs: BodyParagraph[]; indexes: number[]; texts: string[] }[] = []
    for (const [id, items] of byChapter) {
      const chapter = live.chapters.find((c) => c.id === id)
      if (!chapter) {
        toast('有一章已经不存在了，已取消写入', 'error')
        setApply(null)
        return
      }
      const nowParagraphs = splitParagraphs(chapter.content)
      for (const p of items) {
        const i = p.index - 1
        if (!nowParagraphs[i] || nowParagraphs[i].text !== p.before) {
          toast(
            `《${chapter.title}》第 ${p.index} 段的正文在生成对比期间被改过，为避免写错位置，请重新点一次「采用」`,
            'error'
          )
          setApply(null)
          return
        }
      }
      plans.push({
        chapter,
        paragraphs: nowParagraphs,
        indexes: items.map((p) => p.index - 1),
        texts: items.map((p) => p.after)
      })
    }

    for (const plan of plans) {
      const nextContent = applyParagraphRewrite(plan.chapter.content, plan.paragraphs, plan.indexes, plan.texts)
      st.patchChapter(plan.chapter.id, { content: nextContent, words: countWords(nextContent) })
    }

    setApply(null)
    applyCtxRef.current = null
    toast(
      plans.length > 1
        ? `已按建议修改 ${kept.length} 段，涉及 ${plans.length} 章`
        : `已按建议修改 ${kept.length} 段`,
      'ok'
    )
  }

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

  const emptyBlock = emptyReason ? (
    <div
      className="rounded-md px-3.5 py-3 mb-3 text-[11.5px] leading-relaxed"
      style={{
        background: 'color-mix(in srgb, var(--danger) 7%, transparent)',
        border: '1px solid color-mix(in srgb, var(--danger) 26%, transparent)',
        color: 'var(--text)'
      }}
    >
      <div className="flex items-center gap-1.5 mb-1.5 font-medium" style={{ color: 'var(--danger)' }}>
        <AlertTriangle size={12} /> 这次体检没有拿到结果
      </div>
      {emptyReason}
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
              { value: 'thread', label: '伏笔盘点' },
              { value: 'aiFlavor', label: '去 AI 味' }
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
        {emptyBlock}
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
                        onApply={(x) => void startApply(x)}
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
                        onApply={(x) => void startApply(x)}
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
        {/* 去 AI 味是本地优先的独立面板：它的扫描不花钱，所以不该被上面那条
            「审校模型未配置」的提示挡住——没配模型时依然能扫、能看排行。 */}
        {scope === 'aiFlavor' && <AiFlavorPanel project={project} />}

        {/* 段落侧批是批量工作台：范围选择 + 逐章结果，信息量不是一个固定 560px 的框装得下的，
            所以这里不再包固定高度，整块跟随页面滚动（外观仍是卡片，由组件内部自己排）。 */}
        {scope === 'margin' && <MarginNotes project={project} />}

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

      <ApplyPreviewModal
        state={apply}
        onClose={() => setApply(null)}
        onConfirm={confirmApply}
        onRetry={() => {
          const ctx = applyCtxRef.current
          if (ctx) void startApply(ctx.issue)
        }}
      />
    </div>
  )
}
