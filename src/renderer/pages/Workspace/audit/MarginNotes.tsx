import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Eraser,
  MessageSquareQuote,
  Sparkles,
  Trash2
} from 'lucide-react'
import type { Chapter, MarginNote, MarginNoteKind, MarginNoteSet, Project } from '@shared/types'
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, MAX_OUTPUT_TOKENS, resolveBudget } from '@shared/budgets'
import { countWords, formatDateTime, stripHtml, truncate } from '@shared/utils'
import { Button, Checkbox, Modal, Progress, Segmented, Select, Spinner } from '../../../components/ui'
import { abortChat } from '../../../lib/ai'
import { generateCustom } from '../../../lib/generate'
import { resolveTaskModel, taskModelLabel, useApp } from '../../../store/app'
import {
  MARGIN_KINDS,
  runMarginForChapters,
  splitParagraphs,
  type MarginFailure
} from './margin'

const KIND_COLOR: Record<MarginNoteKind, string> = {
  删: '#c05621',
  改: '#2b6cb0',
  慢: '#805ad5',
  快: '#b7791f',
  虚: '#c53030',
  偏: '#2f855a'
}

type RangeMode = 'chapter' | 'pick' | 'book'
type ResolvedFilter = 'all' | 'open' | 'done'

/* ────────────────────── 运行状态（提到模块级） ──────────────────────
   为什么不放组件 state：切到「全书一致性」再切回来，组件会卸载重挂。
   状态放组件里的话，进度、失败列表、停止按钮一起消失，而请求还在跑继续扣钱。
   放模块级 + useSyncExternalStore，切走看得见是「还在跑」，切回来还能点停止。 */

interface RunState {
  running: boolean
  /** 已结束的章数（成功 / 失败 / 跳过都算） */
  done: number
  total: number
  title: string
  /** 当前这次调用已收到的字数 */
  received: number
  failures: MarginFailure[]
  /** 结束后的一句话结论 */
  summary: string
  stopped: boolean
}

const IDLE_RUN: RunState = {
  running: false,
  done: 0,
  total: 0,
  title: '',
  received: 0,
  failures: [],
  summary: '',
  stopped: false
}

let runState: RunState = IDLE_RUN
const runListeners = new Set<() => void>()

function patchRun(next: Partial<RunState>): void {
  runState = { ...runState, ...next }
  for (const l of runListeners) l()
}

function useRunState(): RunState {
  return useSyncExternalStore(
    (cb) => {
      runListeners.add(cb)
      return () => runListeners.delete(cb)
    },
    () => runState,
    () => runState
  )
}

/** 停止信号也要跨挂载：切走再切回来时，停止按钮必须还能真的停住那个还在跑的请求 */
const abortFlag = { stopped: false }

/** 章节是否有正文。0 字的章不批：批了也只会得到一堆「正文为空」的胡说 */
function hasBody(chapter: Chapter): boolean {
  return stripHtml(chapter.content).trim().length > 0
}

function kindBadge(kind: MarginNoteKind): ReactNode {
  return (
    <span
      className="text-[10.5px] px-1.5 h-[18px] inline-flex items-center rounded shrink-0"
      style={{
        color: KIND_COLOR[kind],
        background: `color-mix(in srgb, ${KIND_COLOR[kind]} 14%, transparent)`
      }}
    >
      {kind}
    </span>
  )
}

/**
 * 体检页 › 段落侧批（批量工作台）
 *
 * 这是「批量读稿」的地方：选范围、跑、按章看结果、勾掉已处理的。
 * 结果一律写进 `project.marginNotes`——批注是花钱换来的编辑意见，
 * 只在组件里存着，作者切去改两段再回来就没了。
 */
export function MarginNotes({ project }: { project: Project }): ReactNode {
  const config = useApp((s) => s.config)
  const patchProject = useApp((s) => s.patchProject)
  const activeChapterId = useApp((s) => s.activeChapterId)
  const toast = useApp((s) => s.toast)
  const budgets = useApp((s) => s.config?.settings.tokenBudgets) ?? DEFAULT_TOKEN_BUDGETS

  const run = useRunState()

  // 换作品时清掉上一本留下的「完成：3 章成功」横幅；正在跑的那次不清，进度还得看得见
  useEffect(() => {
    if (!runState.running) patchRun(IDLE_RUN)
  }, [project.id])

  const [range, setRange] = useState<RangeMode>('chapter')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [resolvedFilter, setResolvedFilter] = useState<ResolvedFilter>('all')
  const [kindFilter, setKindFilter] = useState<'all' | MarginNoteKind>('all')
  const [confirmClear, setConfirmClear] = useState(false)

  /* ── 章节池 ── */

  // 段落按需切、按章缓存：整本上千章时不能每次渲染都全量 stripHtml
  const paragraphsCache = useMemo(() => {
    const cache = new Map<string, string[]>()
    const get = (chapter: Chapter): string[] => {
      let v = cache.get(chapter.id)
      if (!v) {
        v = splitParagraphs(chapter)
        cache.set(chapter.id, v)
      }
      return v
    }
    return { get }
  }, [project.chapters])

  const withBody = useMemo(() => project.chapters.filter(hasBody), [project.chapters])
  const emptyCount = project.chapters.length - withBody.length

  // 兼容没有 marginNotes 的老作品（读盘已兜底，这里再兜一层：少一个 {} 不该让整页白屏）
  const sets = project.marginNotes ?? {}

  const [chapterId, setChapterId] = useState<string>(() => {
    const preferred = activeChapterId && project.chapters.some((c) => c.id === activeChapterId)
      ? activeChapterId
      : withBody[0]?.id ?? project.chapters[0]?.id ?? ''
    return preferred
  })
  const [picked, setPicked] = useState<string[]>(() => {
    if (activeChapterId && withBody.some((c) => c.id === activeChapterId)) return [activeChapterId]
    return withBody[0] ? [withBody[0].id] : []
  })

  // 当前打开的章换了（比如从旁批栏点了「跳到正文」再回来），「本章」跟着换
  useEffect(() => {
    if (!activeChapterId) return
    if (!project.chapters.some((c) => c.id === activeChapterId)) return
    setChapterId(activeChapterId)
  }, [activeChapterId, project.chapters])

  /** 「本章」下拉的生效值：章节被删或没选时退回第一个有正文的章 */
  const effectiveId = project.chapters.some((c) => c.id === chapterId) ? chapterId : withBody[0]?.id ?? ''

  const currentChapter = project.chapters.find((c) => c.id === effectiveId) ?? null

  const targets = useMemo(() => {
    if (range === 'chapter') {
      const one = project.chapters.find((c) => c.id === effectiveId)
      return one && hasBody(one) ? [one] : []
    }
    if (range === 'pick') {
      const wanted = new Set(picked)
      return withBody.filter((c) => wanted.has(c.id))
    }
    return withBody
  }, [range, project.chapters, effectiveId, picked, withBody])

  const totalWords = useMemo(
    () => targets.reduce((sum, c) => sum + countWords(stripHtml(c.content)), 0),
    [targets]
  )
  const alreadyCount = targets.filter((c) => Boolean(sets[c.id])).length

  const modelLabel = taskModelLabel(config, project, 'audit')
  const configured = modelLabel.indexOf('未配置') === -1

  /* ── 执行 ── */

  const runChapters = useCallback(
    async (chapters: Chapter[]): Promise<void> => {
      if (!chapters.length || runState.running) return
      const pickedModel = resolveTaskModel(config, project, 'audit')
      if (!pickedModel) {
        toast('请先到 设置 → 任务模型 给「一致性审校」配一个模型', 'error')
        return
      }

      abortFlag.stopped = false
      // 记住这次跑的是哪本书：跑到一半作者换了作品，结果绝不能落到另一本的 marginNotes 里
      const runProjectId = useApp.getState().project?.id
      patchRun({
        running: true,
        done: 0,
        total: chapters.length,
        title: chapters[0]?.title ?? '',
        received: 0,
        failures: [],
        summary: '',
        stopped: false
      })

      try {
        const result = await runMarginForChapters({
          chapters,
          // 用 store 里的最新快照：本次运行前已落盘的旧批注要参与 resolved 合并
          project: useApp.getState().project ?? project,
          modelLabel: pickedModel.label,
          shouldStop: () => abortFlag.stopped,
          generate: async (ctx) => {
            const base = resolveBudget(budgets, BUDGET_KEYS.marginNotes)
            const ask = (maxTokens: number) =>
              generateCustom({
                project: ctx.project,
                chapter: ctx.chapter,
                channel: pickedModel.channel,
                model: pickedModel.model,
                task: 'audit',
                temperature: 0.4,
                system: ctx.system,
                user: ctx.user,
                maxTokens,
                // 批注是严格 JSON，不需要推理；不关思考时 reasoning 会先把额度吃光，
                // 正文空着回来（deepseek-v4.1-flash 上就是这样）。
                thinking: 'off',
                onDelta: ctx.onDelta,
                onThought: () => {}
              })
            const first = await ask(base)
            // 非 DeepSeek 渠道可能不认 thinking 开关：空稿再翻倍试一次。
            if (first.trim() || abortFlag.stopped) return first
            return ask(Math.min(base * 2, MAX_OUTPUT_TOKENS))
          },
          onProgress: (p) => {
            const finished = p.stage === 'done' || p.stage === 'fail' || p.stage === 'skip'
            patchRun({
              done: finished ? p.index : Math.max(0, p.index - 1),
              total: p.total,
              title: p.chapterTitle,
              received: p.stage === 'start' ? 0 : p.received
            })
          },
          // 逐章落盘：中途停止时，已经跑完的章不能跟着一起丢
          onChapter: (chapter, set) => {
            useApp.getState().patchProject((p) =>
              p.id === runProjectId
                ? { ...p, marginNotes: { ...p.marginNotes, [chapter.id]: set } }
                : p
            )
          }
        })

        if (result.blocked) {
          patchRun({ running: false, summary: result.blocked, stopped: false })
          toast(result.blocked, 'error')
          return
        }

        const ok = Object.keys(result.sets).length
        const failed = result.failures.length
        const summary = result.stopped
          ? `已停止：${ok} 章完成${failed ? `，${failed} 章失败` : ''}，没跑的章保持原样`
          : `完成：${ok} 章成功${failed ? ` / ${failed} 章失败` : ''}`
        patchRun({ running: false, failures: result.failures, summary, stopped: result.stopped })
        if (result.stopped) {
          toast(`已停止批注：${ok} 章已完成并保存`, 'info')
        } else if (failed) {
          toast(`${ok} 章成功，${failed} 章失败（原因见下方）`, 'error')
        } else {
          toast(`批注完成：${ok} 章`, 'ok')
        }
      } catch (e) {
        const message = (e as Error)?.message || '批注失败'
        patchRun({ running: false, failures: [{ chapterId: '', title: '本次运行', message }], summary: message })
        toast(message, 'error')
      }
    },
    [budgets, config, project, toast]
  )

  const stop = useCallback((): void => {
    abortFlag.stopped = true
    abortChat()
  }, [])

  /* ── 批注读写 ── */

  const jump = useCallback((chapter: Chapter, paragraph: number): void => {
    const st = useApp.getState()
    // 契约：先放一次性跳段信号，再切章；Workspace 在编辑器就绪后消费
    st.setPendingReveal({ chapterId: chapter.id, paragraph })
    st.setActiveChapter(chapter.id)
  }, [])

  const toggleResolved = useCallback(
    (chapterIdValue: string, index: number): void => {
      patchProject((p) => {
        const set = p.marginNotes?.[chapterIdValue]
        if (!set) return p
        const notes = set.notes.map((n, i) =>
          i === index ? { ...n, resolved: n.resolved ? undefined : true } : n
        )
        return { ...p, marginNotes: { ...p.marginNotes, [chapterIdValue]: { ...set, notes } } }
      })
    },
    [patchProject]
  )

  const removeNote = useCallback(
    (chapterIdValue: string, index: number): void => {
      patchProject((p) => {
        const set = p.marginNotes?.[chapterIdValue]
        if (!set) return p
        const notes = set.notes.filter((_, i) => i !== index)
        return { ...p, marginNotes: { ...p.marginNotes, [chapterIdValue]: { ...set, notes } } }
      })
    },
    [patchProject]
  )

  const clearAll = useCallback((): void => {
    patchProject((p) => ({ ...p, marginNotes: {} }))
    setConfirmClear(false)
    toast('已清空全书批注', 'ok')
  }, [patchProject, toast])

  /* ── 结果分组 ── */

  const groups = useMemo(() => {
    const out: { chapter: Chapter; index: number; set: MarginNoteSet }[] = []
    project.chapters.forEach((chapter, i) => {
      const set = sets[chapter.id]
      if (set) out.push({ chapter, index: i + 1, set })
    })
    return out
  }, [project.chapters, sets])

  const matches = useCallback(
    (n: MarginNote): boolean => {
      if (kindFilter !== 'all' && n.kind !== kindFilter) return false
      if (resolvedFilter === 'open') return !n.resolved
      if (resolvedFilter === 'done') return Boolean(n.resolved)
      return true
    },
    [kindFilter, resolvedFilter]
  )

  const totalNotes = groups.reduce((s, g) => s + g.set.notes.length, 0)
  const visibleNotes = groups.reduce((s, g) => s + g.set.notes.filter(matches).length, 0)

  const chapterTitle = (chapter: Chapter): string => chapter.title || '未命名章节'

  /* ── 渲染 ── */

  if (!project.chapters.length) {
    return (
      <div className="card p-5 text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
        这本书还没有章节。先写好正文，再回来让编辑读一遍。
      </div>
    )
  }

  return (
    <div className="pb-10">
      {/* 范围与任务摘要 */}
      <div className="card p-4 mb-3">
        <div className="flex items-center gap-2.5 flex-wrap">
          <Segmented<RangeMode>
            value={range}
            options={[
              { value: 'chapter', label: '本章' },
              { value: 'pick', label: '指定章节' },
              { value: 'book', label: '全书' }
            ]}
            onChange={setRange}
          />
          {range === 'chapter' && (
            <Select
              value={effectiveId}
              onChange={(e) => setChapterId(e.target.value)}
              style={{ width: 240 }}
              aria-label="选择要批注的章节"
            >
              {project.chapters.map((c) => (
                <option key={c.id} value={c.id} disabled={!hasBody(c)}>
                  {chapterTitle(c)}
                  {hasBody(c) ? '' : '（无正文）'}
                </option>
              ))}
            </Select>
          )}
          <div className="flex-1" />
          {range === 'pick' ? (
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setPicked(withBody.map((c) => c.id))}>
                全选
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPicked([])}>
                全不选
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPicked(withBody.filter((c) => !picked.includes(c.id)).map((c) => c.id))}
              >
                反选
              </Button>
            </div>
          ) : null}
        </div>

        {range === 'pick' && (
          <div
            className="mt-3 rounded-lg p-2 max-h-[220px] overflow-auto scroll-thin"
            style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}
          >
            {project.chapters.map((c) => {
              const body = hasBody(c)
              return (
                <div key={c.id} className="flex items-center gap-2 px-1 py-1">
                  <Checkbox
                    checked={body && picked.includes(c.id)}
                    disabled={!body}
                    title={body ? undefined : '这一章还没有正文，无法批注'}
                    onChange={(next) =>
                      setPicked((prev) =>
                        next ? [...new Set([...prev, c.id])] : prev.filter((id) => id !== c.id)
                      )
                    }
                    label={
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="truncate max-w-[420px]">{chapterTitle(c)}</span>
                        <span className="text-[10.5px] shrink-0" style={{ color: 'var(--text-faint)' }}>
                          {body ? `${countWords(stripHtml(c.content))} 字` : '无正文'}
                        </span>
                      </span>
                    }
                  />
                </div>
              )
            })}
          </div>
        )}

        <div className="mt-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          {range === 'pick' && (
            <>
              已选 {targets.length} 章 / 共 {withBody.length} 章有正文。
              <br />
            </>
          )}
          将批注 {targets.length} 章 · 合计 {totalWords} 字 · 预计 {targets.length} 次调用。
          {alreadyCount > 0 && (
            <span style={{ color: 'var(--warn)' }}>
              {' '}
              其中 {alreadyCount} 章已有批注，重跑会覆盖（已标记「已处理」的会保留）。
            </span>
          )}
          {range === 'book' && emptyCount > 0 && (
            <span style={{ color: 'var(--text-faint)' }}> {emptyCount} 章没有正文，已跳过。</span>
          )}
          {range === 'chapter' && currentChapter && !hasBody(currentChapter) && (
            <span style={{ color: 'var(--warn)' }}> 这一章还没有正文，先写点字再批。</span>
          )}
        </div>

        {!configured && (
          <div
            className="mt-3 rounded-md px-3 py-2 text-[11.5px] leading-relaxed"
            style={{
              background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)',
              color: 'var(--warn)'
            }}
          >
            还没有配置「一致性审校」的模型，批注按钮暂不可用。到 设置 → 任务模型 里给它指定一个渠道和模型即可。
            <div className="mt-2">
              <Button size="sm" onClick={() => useApp.getState().setView('settings')}>
                去设置
              </Button>
            </div>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="primary"
            disabled={!configured || run.running || targets.length === 0}
            onClick={() => void runChapters(targets)}
          >
            <Sparkles size={13} /> 开始批注
          </Button>
          {run.running && (
            <Button variant="danger" size="sm" onClick={stop}>
              <CircleStop size={12} /> 停止
            </Button>
          )}
          <div className="flex-1" />
          {totalNotes > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmClear(true)}>
              <Eraser size={12} /> 清空全部批注
            </Button>
          )}
        </div>
      </div>

      {/* 运行进度 / 结果摘要 / 失败原因 */}
      {(run.running || run.summary || run.failures.length > 0) && (
        <div className="card p-4 mb-3">
          {run.running ? (
            <>
              <div className="flex items-center gap-2">
                <Spinner size={12} />
                <span className="text-[12px] flex-1 min-w-0 truncate">
                  正在批注 {run.title || '…'}（{run.done}/{run.total}）
                </span>
                <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
                  已收到 {run.received} 字
                </span>
                <Button variant="danger" size="sm" onClick={stop}>
                  <CircleStop size={12} /> 停止
                </Button>
              </div>
              <div className="mt-2">
                <Progress value={run.done} max={run.total} height={4} />
              </div>
            </>
          ) : (
            run.summary && (
              <div
                className="text-[12px] flex items-center gap-1.5"
                style={{ color: run.failures.length ? 'var(--danger)' : 'var(--text-dim)' }}
              >
                {run.failures.length ? <AlertTriangle size={13} /> : <MessageSquareQuote size={13} />}
                {run.summary}
              </div>
            )
          )}

          {run.failures.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {run.failures.map((f, i) => (
                <div
                  key={`${f.chapterId}-${i}`}
                  className="rounded-md px-2.5 py-2 text-[11.5px]"
                  style={{
                    background: 'color-mix(in srgb, var(--danger) 7%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--danger) 24%, transparent)'
                  }}
                >
                  <div style={{ color: 'var(--danger)' }}>
                    <span className="font-medium">{f.title}</span>
                    <span> · {f.message}</span>
                  </div>
                  {f.raw && (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer select-none" style={{ color: 'var(--text-faint)' }}>
                        模型的原始返回
                      </summary>
                      <pre
                        className="mt-1 text-[11px] whitespace-pre-wrap rounded p-2 max-h-[220px] overflow-auto scroll-thin"
                        style={{
                          background: 'var(--panel-2)',
                          border: '1px solid var(--border)',
                          color: 'var(--text-dim)',
                          fontFamily: "'SF Mono', ui-monospace, Menlo, Consolas, monospace",
                          userSelect: 'text'
                        }}
                      >
                        {f.raw}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 结果区 */}
      {totalNotes === 0 ? (
        <div className="card p-5 text-[12px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          {groups.length > 0
            ? '这批读完了：一条批注都没挑出来，各章都没什么毛病。正文改过之后可以再批一次。'
            : '还没有批注。选好范围，点「开始批注」，AI 会以编辑的视角逐章读一遍，在需要动的地方写一句话挂在段落旁边。它不会替你改写。'}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className="text-[12px] font-medium">
              批注结果 · {groups.length} 章 / {totalNotes} 条
            </span>
            <div className="flex-1" />
            <Segmented<ResolvedFilter>
              value={resolvedFilter}
              options={[
                { value: 'all', label: '全部' },
                { value: 'open', label: '未处理' },
                { value: 'done', label: '已处理' }
              ]}
              onChange={setResolvedFilter}
            />
            <Select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as 'all' | MarginNoteKind)}
              style={{ width: 110 }}
              aria-label="按批注类型筛选"
            >
              <option value="all">全部类型</option>
              {MARGIN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </div>

          {visibleNotes === 0 && (
            <div className="card p-4 mb-3 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              当前筛选下没有批注。换一个筛选条件试试。
            </div>
          )}

          <div className="space-y-2.5">
            {groups.map(({ chapter, index, set }) => {
              const visible = set.notes
                .map((n, i) => ({ n, i }))
                .filter(({ n }) => matches(n))
              if (!visible.length) return null
              const isCollapsed = Boolean(collapsed[chapter.id])
              const paragraphs = paragraphsCache.get(chapter)
              return (
                <div key={chapter.id} className="card overflow-hidden">
                  <button
                    className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left surface-hover"
                    style={{ borderBottom: isCollapsed ? 'none' : '1px solid var(--border)' }}
                    onClick={() =>
                      setCollapsed((prev) => ({ ...prev, [chapter.id]: !prev[chapter.id] }))
                    }
                  >
                    {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <span className="text-[11px] tabular-nums shrink-0" style={{ color: 'var(--text-faint)' }}>
                      {String(index).padStart(2, '0')}
                    </span>
                    <span className="text-[12.5px] font-medium truncate">{chapterTitle(chapter)}</span>
                    <span className="text-[11px] shrink-0" style={{ color: 'var(--text-dim)' }}>
                      {visible.length}
                      {visible.length !== set.notes.length ? `/${set.notes.length}` : ''} 条
                    </span>
                    <div className="flex-1" />
                    <span className="text-[10.5px] shrink-0" style={{ color: 'var(--text-faint)' }}>
                      {formatDateTime(set.at)}
                      {set.model ? ` · ${set.model}` : ''}
                    </span>
                  </button>

                  {!isCollapsed && (
                    <div className="p-2.5 space-y-2">
                      {visible.map(({ n, i }) => {
                        const para = paragraphs[n.paragraph - 1] ?? ''
                        const excerpt = n.quote || truncate(para, 80)
                        return (
                          <div
                            key={`${n.paragraph}-${i}`}
                            className="rounded-lg p-2.5"
                            style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              {kindBadge(n.kind)}
                              <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                                第 {n.paragraph} 段
                              </span>
                              {n.resolved && (
                                <span className="chip" style={{ height: 17, fontSize: 10 }}>
                                  已处理
                                </span>
                              )}
                              <div className="flex-1" />
                              <Button size="sm" variant="ghost" onClick={() => jump(chapter, n.paragraph)}>
                                跳到正文
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => toggleResolved(chapter.id, i)}>
                                {n.resolved ? '取消已处理' : '标记已处理'}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                title="删除这条批注"
                                onClick={() => removeNote(chapter.id, i)}
                              >
                                <Trash2 size={12} />
                              </Button>
                            </div>
                            <div
                              className="text-[12px] leading-relaxed"
                              style={{ color: 'var(--text-dim)', textDecoration: n.resolved ? 'line-through' : 'none' }}
                            >
                              {n.note}
                            </div>
                            {excerpt && (
                              <div
                                className="mt-1.5 pl-2 text-[11px] leading-relaxed selectable line-clamp-2"
                                style={{ borderLeft: '2px solid var(--border)', color: 'var(--text-faint)' }}
                              >
                                {excerpt}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="清空全部批注"
        width={460}
        footer={
          <>
            <Button onClick={() => setConfirmClear(false)}>取消</Button>
            <Button variant="danger" onClick={clearAll}>
              清空全部
            </Button>
          </>
        }
      >
        <div className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          将删除全书 {groups.length} 章共 {totalNotes} 条批注，不能恢复。正文一个字都不会动。
          <br />
          如果只想清掉某一章，去写作页右侧的「旁批」栏点「清空本章」。
        </div>
      </Modal>
    </div>
  )
}