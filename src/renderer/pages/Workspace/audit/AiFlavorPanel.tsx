/**
 * 「去 AI 味」检查器。
 *
 * 形态和同目录另外三个检查器都不同，故意的：
 *   - 全书一致性 / 章节体检 / 伏笔盘点 是「跑一次，收一份问题清单」；
 *   - 这里第一步是**本地算**（不花钱、立刻出），先给一张全书排行，
 *     作者点开某一章才发请求去改。
 *
 * 这么排的理由写在 lib/aiFlavor.ts 顶部：AI 味是可数的句子级现象，
 * 而全书范围跑模型又贵又慢。先本地排行，把「今天该修哪三章」摆出来，
 * 作者才愿意用；上来就让他等三分钟再拿 12 条上限的问题清单，没人会看第二次。
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, CircleStop, FileWarning, RefreshCw, ScanText, Sparkles, Wand2 } from 'lucide-react'
import type { Chapter, Project } from '@shared/types'
import { countWords, stripHtml } from '@shared/utils'
import { Button, EmptyState, Progress, Select, Spinner } from '../../../components/ui'
import { sendChat } from '../../../lib/ai'
import { isAbortMessage, streamStatus, useElapsed } from '../../../lib/stream'
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, resolveBudget } from '@shared/budgets'
import { resolveTaskModel, useApp } from '../../../store/app'
import {
  FLAVOR_KIND_HINT,
  FLAVOR_KIND_LABEL,
  flavorLevel,
  pickRewriteTargets,
  scanBook,
  scanFlavor,
  type BookFlavorReport,
  type FlavorKind,
  type FlavorReport
} from '../../../lib/aiFlavor'
import { splitParagraphs, applyParagraphRewrite, type BodyParagraph } from './apply'
import { ApplyPreviewModal, type ApplyPreviewState, type DiffPair } from './ApplyPreview'
import {
  alignFlavorRewrite,
  buildFlavorRewriteMessages,
  flavorRewriteWarning,
  toFlavorTargets
} from './aiFlavorPrompt'

/** 会话级缓存：本地扫描是免费的，但重扫整本仍要读几十万字正文，切回来不必重算 */
const cache = { book: new Map<string, BookFlavorReport>(), chapter: new Map<string, FlavorReport>() }

const KIND_COLOR: Record<FlavorKind, string> = {
  adverb: 'var(--warn)',
  explain: 'var(--danger)',
  elevate: '#805ad5',
  abstract: '#2b6cb0',
  uniform: '#b7791f',
  dialog: '#2f855a'
}

/** 与 scoreColor 的语义一致：反向着色的项（这里没有）不影响，统一用高分为危 */
function scoreTone(score: number): string {
  const lv = flavorLevel(score)
  return lv.tone === 'ok' ? 'var(--ok)' : lv.tone === 'warn' ? 'var(--warn)' : 'var(--danger)'
}

/**
 * 章节标题的展示文本。
 *
 * 作者建章时常常把章号写进标题本身（「第 2 章 老槐树」），这时再前置一个
 * 「第 2 章 ·」就会出现「第 2 章 · 第 2 章 老槐树」。所以标题里已经带章号时
 * 原样显示，只补一个空的章名兜底。
 */
function chapterLabel(title: string, order: number): string {
  const t = title.trim()
  if (!t) return `第 ${order} 章`
  return /^第\s*[0-9一二三四五六七八九十百千]+\s*[章回节]/.test(t) ? t : `第 ${order} 章 · ${t}`
}

function DistBar({ byKind, total }: { byKind: Record<FlavorKind, number>; total: number }): ReactNode {
  const kinds = (Object.keys(byKind) as FlavorKind[]).filter((k) => byKind[k] > 0)
  if (!kinds.length) return null
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {kinds.map((k) => (
        <span
          key={k}
          className="chip"
          style={{
            height: 18,
            padding: '0 6px',
            fontSize: 10.5,
            color: KIND_COLOR[k],
            borderColor: `color-mix(in srgb, ${KIND_COLOR[k]} 35%, transparent)`,
            background: `color-mix(in srgb, ${KIND_COLOR[k]} 10%, transparent)`
          }}
          title={FLAVOR_KIND_HINT[k]}
        >
          {FLAVOR_KIND_LABEL[k]} {byKind[k]}
        </span>
      ))}
      {total > 0 && (
        <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
          共 {total} 处
        </span>
      )}
    </div>
  )
}

export function AiFlavorPanel({ project }: { project: Project }): ReactNode {
  const toast = useApp((s) => s.toast)
  const config = useApp((s) => s.config)

  const [book, setBook] = useState<BookFlavorReport | null>(() => cache.book.get(project.id) ?? null)
  const [chapterId, setChapterId] = useState<string>(() => project.chapters[0]?.id ?? '')
  const [report, setReport] = useState<FlavorReport | null>(null)
  const [preview, setPreview] = useState<ApplyPreviewState | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ text: '', thought: '' })

  const abortedRef = useRef(false)
  const elapsed = useElapsed(running)
  const status = streamStatus({ text: progress.text, thought: progress.thought, elapsedMs: elapsed })

  /** 「确认写入」要用生成时算好的段落位置，那时界面状态可能已被改动 */
  const pendingRef = useRef<{
    chapterId: string
    paragraphs: BodyParagraph[]
    indexes: number[]
    rewritten: string[]
    originals: string[]
  } | null>(null)

  const current = useMemo(
    () => project.chapters.find((c) => c.id === chapterId) ?? project.chapters[0] ?? null,
    [project.chapters, chapterId]
  )

  const modelLabel = (() => {
    const r = resolveTaskModel(config, project, 'polish')
    return r ? r.label : '润色改写 · 未配置'
  })()
  const configured = Boolean(resolveTaskModel(config, project, 'polish'))

  /* ── 本地扫描：全书 ── */

  const runBookScan = useCallback((): void => {
    if (!project.chapters.length) {
      toast('还没有章节', 'info')
      return
    }
    const r = scanBook(project.chapters.map((c) => ({ id: c.id, title: c.title, content: c.content })))
    setBook(r)
    cache.book.set(project.id, r)
    if (!r.ranking.length) toast('整本书没扫出明显的 AI 味', 'ok')
    else toast(`扫完了：${r.ranking.length} 章建议修，最重的是《${r.ranking[0].title}》`, 'ok')
  }, [project.id, project.chapters, toast])

  /** 切到某一章并立刻本地扫一遍（免费，不用等） */
  const inspect = useCallback(
    (id: string): void => {
      const ch = project.chapters.find((c) => c.id === id)
      if (!ch) return
      setChapterId(id)
      const r = scanFlavor(ch.content)
      setReport(r)
      cache.chapter.set(`${project.id}:${id}`, r)
    },
    [project.chapters, project.id]
  )

  /* ── AI 改写：只改本地挑出的脏段 ── */

  const runRewrite = useCallback(
    async (chapter: Chapter, onlyIndex?: number): Promise<void> => {
      const picked = resolveTaskModel(useApp.getState().config, useApp.getState().project, 'polish')
      if (!picked) {
        toast('请先到设置 → 任务模型里给「润色改写」配一个模型', 'error')
        return
      }

      const live = useApp.getState().project
      if (!live) return
      const target = live.chapters.find((c) => c.id === chapter.id)
      if (!target) return

      // 现扫一遍，不用组件里的旧结果：作者可能刚在编辑器里改过这一章，
      // 拿旧报告去定位段落会改错地方。
      const fresh = scanFlavor(target.content)
      const targets = onlyIndex
        ? pickRewriteTargets(fresh, 99, 0).filter((t) => t.index === onlyIndex)
        : pickRewriteTargets(fresh, 5, 35)

      if (!targets.length) {
        toast('这一章没挑出需要改的段落', 'info')
        return
      }

      // 正文分段必须和「段落序号」用同一套切法，否则序号对不上会改错段。
      // scanFlavor 与 splitParagraphs 都按换行切并去掉空段和标题行，序号可一一对应。
      const paragraphs = splitParagraphs(target.content)
      const indexes = targets.map((t) => t.index - 1).filter((i) => i >= 0 && i < paragraphs.length)
      if (!indexes.length) {
        toast('段落定位失败，请刷新后重试', 'error')
        return
      }

      abortedRef.current = false
      setRunning(true)
      setProgress({ text: '', thought: '' })
      setPreview({
        running: true,
        error: null,
        pairs: [],
        title: `去 AI 味 · ${targets.length} 段`,
        suggestion: `模型：${picked.label}`,
        note: '本地已定位这些段落的毛病，AI 只负责改写，其余段落不受影响。'
      })

      try {
        const first = indexes[0]
        const last = indexes[indexes.length - 1]
        const messages = buildFlavorRewriteMessages(
          live,
          target,
          toFlavorTargets(
            fresh.paragraphs.filter((p) => targets.some((t) => t.index === p.index))
          ),
          {
            before: paragraphs.slice(Math.max(0, first - 1), first).map((p) => p.text).filter(Boolean),
            after: paragraphs.slice(last + 1, last + 2).map((p) => p.text).filter(Boolean)
          }
        )

        let text = ''
        let thought = ''
        const budgets = useApp.getState().config?.settings.tokenBudgets ?? DEFAULT_TOKEN_BUDGETS
        const res = await sendChat({
          channel: picked.channel,
          model: picked.model,
          messages,
          task: 'polish',
          temperature: 0.75,
          maxTokens: resolveBudget(
            budgets,
            BUDGET_KEYS.draftSelection,
            Math.max(300, indexes.reduce((s, i) => s + countWords(paragraphs[i].text), 0))
          ),
          onDelta: (d) => {
            text += d
            setProgress({ text, thought })
          },
          onThought: (d) => {
            thought += d
            setProgress({ text, thought })
          }
        })
        if (abortedRef.current || isAbortMessage(res.text)) {
          setPreview(null)
          toast('已停止去 AI 味', 'info')
          return
        }
        if (!res.text.trim()) {
          setPreview({
            running: false,
            error: res.thoughtStarved
              ? '模型把输出额度全用在思考上了，一个字都没返回。到「设置 → 输出预算 → 正文生成 → 选中段落润色」把额度调大，或换一个非推理模型。'
              : '模型这次没有返回任何内容，可以重试一次。',
            pairs: [],
            title: '去 AI 味',
            suggestion: '',
            canRetry: true
          })
          return
        }

        const rewritten = alignFlavorRewrite(res.text, indexes.length)
        const pairs: DiffPair[] = indexes.map((pi, k) => ({
          index: pi + 1,
          before: paragraphs[pi].text,
          after: rewritten[k] ?? ''
        }))

        // 改写失控的段落：如实标出来，不悄悄混进对比列表
        const warnings = pairs
          .map((p) => ({ p, w: flavorRewriteWarning(p.before, p.after) }))
          .filter((x) => x.w)
        const emptyCount = pairs.filter((p) => !p.after.trim()).length

        pendingRef.current = {
          chapterId: target.id,
          paragraphs,
          indexes,
          rewritten,
          originals: indexes.map((i) => paragraphs[i].text)
        }

        setPreview({
          running: false,
          error: null,
          pairs,
          title: `去 AI 味 · ${indexes.length} 段`,
          suggestion: `模型：${picked.label}`,
          note:
            (emptyCount ? `${emptyCount} 段模型没有返回，将保留原文。` : '') +
            (warnings.length
              ? ` ${warnings.length} 段改写幅度异常（${warnings
                  .map((x) => `第 ${x.p.index} 段`)
                  .join('、')}），请重点核对。`
              : ''),
          canRetry: true
        })
      } catch (e) {
        const message = (e as Error).message || '调用失败'
        if (abortedRef.current || isAbortMessage(message)) {
          setPreview(null)
          toast('已停止去 AI 味', 'info')
        } else {
          setPreview({
            running: false,
            error: `改写失败：${message}`,
            pairs: [],
            title: '去 AI 味',
            suggestion: '',
            canRetry: true
          })
        }
      } finally {
        setRunning(false)
      }
    },
    [toast]
  )

  /** 确认写入：只替换被改的段落，其余逐字不动 */
  const confirmWrite = useCallback((): void => {
    const pending = pendingRef.current
    const state = preview
    if (!pending || !state) return

    const live = useApp.getState().project
    if (!live) return
    const chapter = live.chapters.find((c) => c.id === pending.chapterId)
    if (!chapter) {
      toast('这一章已经不在了', 'error')
      setPreview(null)
      return
    }

    // 预览 -> 实际要写的段落：跳过作者取消勾选了的那几段，也跳过空串
    const pairs = state.pairs
    const artistic = pending.indexes.map((pi, k) => ({ pi, k, after: pairs[k]?.after ?? '' }))
    const usable = artistic.filter((x) => x.after.trim())
    if (!usable.length) {
      toast('没有可写入的改动', 'info')
      setPreview(null)
      return
    }

    // 写入前校验正文没被别人动过：作者可能在预览开着的时候在别处改了这一章，
    // 这时候按旧位置替换会把内容写乱。
    const currentParagraphs = splitParagraphs(chapter.content)
    for (let k = 0; k < pending.indexes.length; k++) {
      const pi = pending.indexes[k]
      const still = currentParagraphs[pi]?.text
      if (still !== pending.originals[k]) {
        toast('这一章在预览期间被改动过，请重新检测后再改', 'error')
        setPreview(null)
        return
      }
    }

    const nextHtml = applyParagraphRewrite(
      chapter.content,
      currentParagraphs,
      usable.map((x) => x.pi),
      usable.map((x) => x.after)
    )

    useApp.getState().patchChapter(chapter.id, { content: nextHtml })
    // 改完立刻重扫，排行与分数跟着更新——否则作者会以为按钮没生效
    const fresh = scanFlavor(nextHtml)
    setReport(fresh)
    cache.chapter.set(`${live.id}:${chapter.id}`, fresh)
    cache.book.delete(live.id)
    setBook(null)
    setPreview(null)
    toast(`已写入 ${usable.length} 段`, 'ok')
  }, [preview, toast])

  /* ── 渲染 ── */

  if (!project.chapters.length) {
    return (
      <div className="h-full flex items-center justify-center">
        <EmptyState icon={<ScanText size={22} />} title="还没有章节" desc="先写点正文，再来扫 AI 味。" />
      </div>
    )
  }

  const level = book ? flavorLevel(book.score) : null

  return (
    <div className="h-full overflow-auto scroll-thin">
      <div className="max-w-[900px] mx-auto px-8 py-7">
        {/* 第一步：全书扫描（本地，免费） */}
        <div className="card p-5 mb-4">
          <div className="flex items-start gap-3">
            <div className="shrink-0 mt-0.5" style={{ color: 'var(--accent)' }}>
              <ScanText size={22} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-[14px]">全书 AI 味扫描</div>
              <div className="text-[12px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                逐章统计机器腔的浓度——万能修饰词、替读者下结论、段末升华、抽象代替具体、句式过于整齐、台词交代设定。
                <strong>这一步在你本地算，不花 token</strong>，扫完给你一份「哪几章最该修」的排行；点开某一章再让 AI 改，
                而且只改被点名的段落，其余逐字不动。
              </div>
              <div className="mt-3 flex items-center gap-3 flex-wrap">
                <span className="chip">共 {project.chapters.length} 章</span>
                {level && (
                  <span
                    className="chip"
                    style={{
                      color: scoreTone(book!.score),
                      borderColor: `color-mix(in srgb, ${scoreTone(book!.score)} 35%, transparent)`
                    }}
                  >
                    全书 AI 味 {book!.score} · {level.label}
                  </span>
                )}
                <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  改写模型：{modelLabel}
                </span>
              </div>
            </div>
            <Button variant={book ? 'ghost' : 'primary'} size="lg" onClick={runBookScan} disabled={running}>
              <ScanText size={14} />
              {book ? '重新扫描' : '开始扫描'}
            </Button>
          </div>
        </div>

        {/* 排行 */}
        {book && (
          <>
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className="text-[12px] font-medium">
                {book.ranking.length ? `${book.ranking.length} 章建议修` : '没有明显需要修的章节'}
              </span>
              <DistBar byKind={book.byKind} total={book.total} />
            </div>

            {book.ranking.length === 0 ? (
              <div className="card p-4 text-[12px]" style={{ color: 'var(--text-dim)' }}>
                整本书扫下来没发现明显的机器腔。偶尔有零星几处不影响阅读，不值得动。
              </div>
            ) : (
              <div className="flex flex-col gap-2 mb-5">
                {book.ranking.map((c, i) => {
                  const active = c.id === current?.id
                  return (
                    <button
                      key={c.id}
                      className="text-left rounded-md transition-colors w-full"
                      style={{
                        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                        background: active ? 'var(--accent-soft)' : 'var(--panel)',
                        padding: '10px 12px'
                      }}
                      onClick={() => inspect(c.id)}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="text-[11px] tabular-nums shrink-0"
                          style={{ color: 'var(--text-faint)', width: 18 }}
                        >
                          {i + 1}
                        </span>
                        <span className="text-[12.5px] font-medium truncate flex-1 min-w-0">
                          {chapterLabel(c.title, c.order)}
                        </span>
                        <span className="text-[10.5px] shrink-0" style={{ color: 'var(--text-faint)' }}>
                          {c.words} 字
                        </span>
                        <span
                          className="text-[13px] font-semibold tabular-nums shrink-0"
                          style={{ color: scoreTone(c.score), width: 34, textAlign: 'right' }}
                        >
                          {c.score}
                        </span>
                      </div>
                      <div className="mt-1.5 pl-[26px]">
                        <div
                          className="rounded-full overflow-hidden mb-1.5"
                          style={{ height: 4, background: 'var(--panel-2)' }}
                        >
                          <div
                            style={{
                              width: `${c.score}%`,
                              height: '100%',
                              background: scoreTone(c.score),
                              borderRadius: 999
                            }}
                          />
                        </div>
                        <DistBar byKind={c.byKind} total={c.total} />
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}

        {/* 第二步：单章详情与改写 */}
        <div className="card p-4 mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12.5px] font-medium shrink-0">查看章节</span>
            <div style={{ minWidth: 220, flex: 1 }}>
              <Select value={current?.id ?? ''} onChange={(e) => inspect(e.target.value)}>
                {project.chapters.map((c, i) => (
                  <option key={c.id} value={c.id}>
                    {chapterLabel(c.title, i + 1)}
                  </option>
                ))}
              </Select>
            </div>
            {report && (
              <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                {report.total} 处 · {report.words} 字
              </span>
            )}
            <Button
              size="sm"
              variant={report && report.total > 0 ? 'primary' : 'ghost'}
              disabled={!configured || running || !current || !report || report.total === 0}
              onClick={() => current && void runRewrite(current)}
              title={configured ? '把本地挑出的脏段交给 AI 改写，先看对比再决定是否写入' : '需要先配置「润色改写」模型'}
            >
              {running ? <Spinner size={12} /> : <Sparkles size={13} />}
              {running ? '改写中…' : 'AI 改写这几段'}
            </Button>
          </div>

          {running && (
            <div className="mt-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {status}
            </div>
          )}
        </div>

        {report && (
          <div className="flex flex-col gap-2">
            {report.paragraphs.length === 0 ? (
              <div className="card p-4 text-[12px]" style={{ color: 'var(--text-dim)' }}>
                这一章没扫出机器腔。要么写得很干净，要么这一章还没有正文。
              </div>
            ) : (
              report.paragraphs.map((p) => (
                <div
                  key={p.index}
                  className="rounded-md"
                  style={{ border: '1px solid var(--border)', background: 'var(--panel)', padding: '10px 12px' }}
                >
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                      第 {p.index} 段 · {p.words} 字
                    </span>
                    <span
                      className="text-[11px] font-semibold tabular-nums"
                      style={{ color: scoreTone(p.score) }}
                    >
                      {p.score}
                    </span>
                    <div className="flex-1" />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!configured || running}
                      onClick={() => current && void runRewrite(current, p.index)}
                      title="只改这一段"
                    >
                      <Wand2 size={11} /> 改这段
                    </Button>
                  </div>
                  <div
                    className="text-[12px] leading-relaxed mb-2"
                    style={{ color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}
                  >
                    {p.text.length > 220 ? `${p.text.slice(0, 220)}…` : p.text}
                  </div>
                  <div className="flex flex-col gap-1">
                    {p.hits.slice(0, 6).map((h, i) => (
                      <div key={`${h.kind}-${i}`} className="flex items-start gap-1.5 text-[11px]">
                        <span
                          className="shrink-0"
                          style={{ color: KIND_COLOR[h.kind], minWidth: 76 }}
                        >
                          {FLAVOR_KIND_LABEL[h.kind]}
                        </span>
                        <span style={{ color: 'var(--text-faint)' }}>
                          <span style={{ color: 'var(--text-dim)' }}>
                            {h.text.length > 18 ? `${h.text.slice(0, 18)}…` : h.text}
                          </span>{' '}
                          — {h.why}
                        </span>
                      </div>
                    ))}
                    {p.hits.length > 6 && (
                      <div className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                        另有 {p.hits.length - 6} 处
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        <div className="mt-4 text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          扫描是本地正则，凭词与句式计数，偶尔会把正常的修辞标出来——看到不对的直接无视即可。
          只有点「AI 改写」才会调用模型，而且只改你看到的这几段。
        </div>
      </div>

      <ApplyPreviewModal
        state={preview}
        onClose={() => setPreview(null)}
        onConfirm={confirmWrite}
        onRetry={() => current && void runRewrite(current)}
      />
    </div>
  )
}