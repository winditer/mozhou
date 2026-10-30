import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  CircleStop,
  Eraser,
  MessageSquareQuote,
  RefreshCw,
  Sparkles,
  Trash2
} from 'lucide-react'
import type { Chapter, MarginNote, MarginNoteKind, Project } from '@shared/types'
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, MAX_OUTPUT_TOKENS, resolveBudget } from '@shared/budgets'
import { formatDateTime, truncate } from '@shared/utils'
import { Button, Spinner } from '../../../components/ui'
import { abortChat } from '../../../lib/ai'
import { generateCustom } from '../../../lib/generate'
import { resolveTaskModel, useApp } from '../../../store/app'
import {
  chapterFingerprint,
  runMarginForChapters,
  splitParagraphs
} from './margin'

const KIND_COLOR: Record<MarginNoteKind, string> = {
  删: '#c05621',
  改: '#2b6cb0',
  慢: '#805ad5',
  快: '#b7791f',
  虚: '#c53030',
  偏: '#2f855a'
}

/**
 * 写作页右侧「旁批」栏。
 *
 * 它和体检页那个批量工作台是同一份数据（`project.marginNotes`）的两种看法：
 * 那边是「一次读很多章」，这边是「正写到这一章，边写边看编辑说了什么」。
 * 所以这里不选范围、不显示全书，只干三件事：点一条跳到那一段、标已处理、重跑本章。
 */
export function MarginGutter({
  project,
  chapter,
  onClose
}: {
  project: Project
  chapter: Chapter | null
  onClose: () => void
}): ReactNode {
  const config = useApp((s) => s.config)
  const patchProject = useApp((s) => s.patchProject)
  const toast = useApp((s) => s.toast)
  const budgets = useApp((s) => s.config?.settings.tokenBudgets) ?? DEFAULT_TOKEN_BUDGETS

  const [running, setRunning] = useState(false)
  const [received, setReceived] = useState(0)
  const [error, setError] = useState('')
  /** 最近一次跳转的段落：只是给列表加个高亮，让作者知道自己刚点的是哪条 */
  const [focused, setFocused] = useState<number | null>(null)
  const abortedRef = useRef(false)

  // 换章就清掉上一章的高亮与错误，免得黄条挂在别的章上
  useEffect(() => {
    setFocused(null)
    setError('')
    setReceived(0)
  }, [chapter?.id])

  // 老作品可能没有 marginNotes（读盘已兜底，这里再兜一层，少一个 {} 不该让旁批栏白屏）
  const sets = project.marginNotes ?? {}
  const set = chapter ? sets[chapter.id] : undefined
  const notes = useMemo(
    () => [...(set?.notes ?? [])].sort((a, b) => a.paragraph - b.paragraph),
    [set]
  )
  const paragraphs = useMemo(() => splitParagraphs(chapter), [chapter])
  const fingerprint = useMemo(() => chapterFingerprint(chapter), [chapter])
  // 指纹对不上：正文改过，序号可能错位。只提示，不擅自清空——批注还是作者的资产
  const stale = Boolean(set && set.fingerprint && fingerprint && set.fingerprint !== fingerprint)

  const modelLabel = config ? resolveTaskModel(config, project, 'audit')?.label ?? '' : ''
  const configured = Boolean(modelLabel)

  const runChapter = useCallback(async (): Promise<void> => {
    if (!chapter || running) return
    const pickedModel = resolveTaskModel(config, project, 'audit')
    if (!pickedModel) {
      toast('请先到 设置 → 任务模型 给「一致性审校」配一个模型', 'error')
      return
    }
    abortedRef.current = false
    // 记住这次跑的是哪本书：跑到一半换了作品，结果不能写进另一本
    const runProjectId = useApp.getState().project?.id
    setRunning(true)
    setError('')
    setReceived(0)
    try {
      const result = await runMarginForChapters({
        chapters: [chapter],
        project: useApp.getState().project ?? project,
        modelLabel: pickedModel.label,
        shouldStop: () => abortedRef.current,
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
              // 与体检页同一口径：批注是 JSON，先关思考，免得正文为空。
              thinking: 'off',
              onDelta: ctx.onDelta,
              onThought: () => {}
            })
          const first = await ask(base)
          if (first.trim() || abortedRef.current) return first
          return ask(Math.min(base * 2, MAX_OUTPUT_TOKENS))
        },
        onProgress: (p) => setReceived(p.stage === 'start' ? 0 : p.received),
        // 立刻落盘：作者可能马上关掉面板，结果不能只活在这次请求里
        onChapter: (c, next) => {
          useApp.getState().patchProject((p) =>
            p.id === runProjectId
              ? { ...p, marginNotes: { ...p.marginNotes, [c.id]: next } }
              : p
          )
        }
      })

      if (result.blocked) {
        setError(result.blocked)
        toast(result.blocked, 'error')
      } else if (result.stopped) {
        toast('已停止批注', 'info')
      } else if (result.failures.length) {
        const message = result.failures[0].message
        setError(message)
        toast(`这一章批注失败：${message}`, 'error')
      } else {
        const notesDone = result.sets[chapter.id]?.notes.length ?? 0
        toast(notesDone ? `批完这一章：${notesDone} 条` : '这一章没挑出什么毛病', 'ok')
      }
    } catch (e) {
      const message = (e as Error)?.message || '批注失败'
      setError(message)
      toast(message, 'error')
    } finally {
      setRunning(false)
    }
  }, [budgets, chapter, config, project, running, toast])

  const stop = useCallback((): void => {
    abortedRef.current = true
    abortChat()
  }, [])

  const clearChapter = useCallback((): void => {
    if (!chapter) return
    patchProject((p) => {
      const next = { ...p.marginNotes }
      delete next[chapter.id]
      return { ...p, marginNotes: next }
    })
    toast('已清空本章批注', 'ok')
  }, [chapter, patchProject, toast])

  const jump = useCallback(
    (note: MarginNote): void => {
      if (!chapter) return
      const st = useApp.getState()
      // 跳段契约：一次性信号交给 Workspace 在编辑器就绪后消费
      st.setPendingReveal({ chapterId: chapter.id, paragraph: note.paragraph })
      st.setActiveChapter(chapter.id)
      setFocused(note.paragraph)
    },
    [chapter]
  )

  const toggleResolved = useCallback(
    (note: MarginNote): void => {
      if (!chapter || !set) return
      patchProject((p) => {
        const current = p.marginNotes?.[chapter.id]
        if (!current) return p
        const notes = current.notes.map((n) =>
          n === note || (n.paragraph === note.paragraph && n.note === note.note)
            ? { ...n, resolved: n.resolved ? undefined : true }
            : n
        )
        return { ...p, marginNotes: { ...p.marginNotes, [chapter.id]: { ...current, notes } } }
      })
    },
    [chapter, patchProject, set]
  )

  const removeNote = useCallback(
    (note: MarginNote): void => {
      if (!chapter) return
      patchProject((p) => {
        const current = p.marginNotes?.[chapter.id]
        if (!current) return p
        const notes = current.notes.filter(
          (n) => !(n === note || (n.paragraph === note.paragraph && n.note === note.note))
        )
        return { ...p, marginNotes: { ...p.marginNotes, [chapter.id]: { ...current, notes } } }
      })
    },
    [chapter, patchProject]
  )

  if (!chapter) {
    return (
      <div className="h-full flex flex-col">
        <div
          className="flex items-center gap-2 px-3 h-11 shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <span className="text-[12.5px] font-medium flex-1">旁批</span>
          <button className="text-[11px]" style={{ color: 'var(--text-faint)' }} onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="p-3 text-[12px]" style={{ color: 'var(--text-faint)' }}>
          先选一章。
        </div>
      </div>
    )
  }

  const openCount = notes.filter((n) => !n.resolved).length

  return (
    <div className="h-full flex flex-col">
      {/* 顶栏：章名 + 条数 + 关闭 */}
      <div
        className="flex items-center gap-1.5 px-3 h-11 shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <MessageSquareQuote size={13} style={{ color: 'var(--text-dim)' }} />
        <span className="text-[12.5px] font-medium truncate" style={{ color: 'var(--text-dim)' }}>
          {chapter.title || '未命名章节'}
        </span>
        <span className="text-[11px] shrink-0" style={{ color: 'var(--text-faint)' }}>
          {notes.length} 条{openCount > 0 && openCount !== notes.length ? ` · ${openCount} 未处理` : ''}
        </span>
        <div className="flex-1" />
        <button className="text-[11px] shrink-0" style={{ color: 'var(--text-faint)' }} onClick={onClose}>
          关闭
        </button>
      </div>

      {/* 生成信息 + 两个动作 */}
      <div className="px-3 py-2 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          {set
            ? `生成于 ${formatDateTime(set.at)}${set.model ? ` · ${set.model}` : ''}`
            : '只批注，不改稿'}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button
            size="sm"
            variant={set ? 'ghost' : 'primary'}
            disabled={running || !configured || paragraphs.length === 0}
            onClick={() => void runChapter()}
          >
            {running ? <Spinner size={11} /> : set ? <RefreshCw size={11} /> : <Sparkles size={11} />}
            {running ? '正在读稿…' : set ? '重新批注本章' : '批注这一章'}
          </Button>
          {running ? (
            <Button size="sm" variant="danger" onClick={stop}>
              <CircleStop size={11} /> 停止
            </Button>
          ) : (
            set && (
              <Button size="sm" variant="ghost" title="清空本章批注" onClick={clearChapter}>
                <Eraser size={11} /> 清空本章
              </Button>
            )
          )}
        </div>
        {running && (
          <div className="mt-1.5 text-[10.5px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
            已收到 {received} 字
          </div>
        )}
        {!configured && (
          <div className="mt-1.5 text-[10.5px] leading-relaxed" style={{ color: 'var(--warn)' }}>
            还没有配置「一致性审校」模型，到 设置 → 任务模型 指定后再来批。
          </div>
        )}
        {error && (
          <div className="mt-1.5 text-[10.5px] leading-relaxed" style={{ color: 'var(--danger)' }}>
            {error}
          </div>
        )}
      </div>

      {/* 正文改过的黄条：不自动作废结果，但必须让作者看见 */}
      {stale && (
        <div
          className="px-3 py-2 shrink-0 text-[10.5px] leading-relaxed"
          style={{
            background: 'color-mix(in srgb, var(--warn) 12%, transparent)',
            borderBottom: '1px solid color-mix(in srgb, var(--warn) 28%, transparent)',
            color: 'var(--warn)'
          }}
        >
          <div className="flex items-start gap-1.5">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              正文改过，批注的段落可能对不上；建议重新批注本章。
              <div className="mt-1">
                <Button size="sm" variant="ghost" disabled={running} onClick={() => void runChapter()}>
                  重新批注本章
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-auto scroll-thin px-2.5 py-2.5">
        {notes.length === 0 ? (
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            {set ? (
              '这一章没挑出什么毛病。改过正文之后再批一次也行。'
            ) : (
              <>
                让 AI 以编辑的视角把这一章读一遍，在需要动的地方写一句话，挂在对应段落旁边。
                它不会替你改写——看到不同意的批注，直接无视即可。
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {notes.map((n) => {
              const para = paragraphs[n.paragraph - 1] ?? ''
              const excerpt = n.quote || truncate(para, 60)
              const isFocused = focused === n.paragraph
              return (
                <div
                  key={`${n.paragraph}-${n.note}`}
                  className="rounded-lg p-2 cursor-pointer transition-colors"
                  style={{
                    background: isFocused ? 'var(--accent-soft)' : 'var(--panel-2)',
                    border: `1px solid ${isFocused ? 'var(--accent)' : 'var(--border)'}`
                  }}
                  onClick={() => jump(n)}
                  title="点击跳到这一段"
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span
                      className="text-[10px] px-1.5 h-[17px] inline-flex items-center rounded shrink-0"
                      style={{
                        color: KIND_COLOR[n.kind],
                        background: `color-mix(in srgb, ${KIND_COLOR[n.kind]} 14%, transparent)`
                      }}
                    >
                      {n.kind}
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                      第 {n.paragraph} 段
                    </span>
                    {n.resolved && (
                      <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                        · 已处理
                      </span>
                    )}
                    <div className="flex-1" />
                    {/* 点按钮不该触发整条的跳转，所以这里拦住冒泡 */}
                    <button
                      className="text-[10px] px-1 rounded"
                      style={{ color: 'var(--text-faint)', cursor: 'default' }}
                      title={n.resolved ? '取消已处理' : '标记已处理'}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleResolved(n)
                      }}
                    >
                      {n.resolved ? '取消已处理' : '标为已处理'}
                    </button>
                    <button
                      className="px-0.5 rounded"
                      style={{ color: 'var(--text-faint)', cursor: 'default' }}
                      title="删除这条批注"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeNote(n)
                      }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  <div
                    className="text-[11.5px] leading-relaxed"
                    style={{
                      color: 'var(--text-dim)',
                      textDecoration: n.resolved ? 'line-through' : 'none'
                    }}
                  >
                    {n.note}
                  </div>
                  {excerpt && (
                    <div
                      className="mt-1 pl-2 text-[10.5px] leading-relaxed line-clamp-2"
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
    </div>
  )
}