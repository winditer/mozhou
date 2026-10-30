import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Chapter, Project, Recital } from '@shared/types'
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, resolveBudget } from '@shared/budgets'
import { countWords, formatNumber, relativeTime } from '@shared/utils'
import { resolveTaskModel, useApp } from '../../../store/app'
import { generateCustom, textToParagraphHtml } from '../../../lib/generate'
import { abortChat } from '../../../lib/ai'
import { mz } from '../../../lib/bridge'
import { isAbortMessage, useElapsed } from '../../../lib/stream'
import {
  Button,
  Checkbox,
  EmptyState,
  Modal,
  Progress,
  Segmented,
  Select,
  Slider,
  Spinner,
  Textarea
} from '../../../components/ui'
import { CircleStop, Download, Mic, Pause, Play, RotateCcw, Sparkles, Square, Volume2 } from 'lucide-react'
import {
  RECITAL_DURATIONS,
  RECITAL_STYLES,
  buildRecitalMessages,
  findRecitalStyle,
  targetWordsForMinutes,
  type RecitalMinutes
} from './prompt'
import { parseRecital } from './parse'
import { useSpeech, type SpeechApi } from './useSpeech'

type Scope = 'chapter' | 'picked' | 'book'

interface Failure {
  title: string
  reason: string
}

const SCOPES: { value: Scope; label: string }[] = [
  { value: 'chapter', label: '本章' },
  { value: 'picked', label: '指定章节' },
  { value: 'book', label: '全书' }
]

export function RecitalTab({ project }: { project: Project }): ReactNode {
  const config = useApp((s) => s.config)
  const activeChapterId = useApp((s) => s.activeChapterId)
  const { patchProject, toast } = useApp()
  const budgets = config?.settings.tokenBudgets ?? DEFAULT_TOKEN_BUDGETS

  const [scope, setScope] = useState<Scope>('chapter')
  const [picked, setPicked] = useState<string[]>([])
  const [styleId, setStyleId] = useState<string>(RECITAL_STYLES[0].id)
  const [minutes, setMinutes] = useState<RecitalMinutes>(3)
  const [running, setRunning] = useState(false)
  const [prog, setProg] = useState<{ index: number; total: number; chars: number; title: string } | null>(null)
  const [summary, setSummary] = useState<{ ok: number; fail: Failure[]; aborted: boolean } | null>(null)
  const [confirmTargets, setConfirmTargets] = useState<Chapter[] | null>(null)

  const abortedRef = useRef(false)
  const runningRef = useRef(false)
  const elapsed = useElapsed(running)
  const speech = useSpeech()

  // 老书读盘时 normalizeProject 会补 {}，这里再兜一层：漏网数据不该把整页打崩
  const recitals: Record<string, Recital> = project.recitals ?? {}
  const style = findRecitalStyle(styleId)
  const targetWords = targetWordsForMinutes(minutes)

  /** 章节字数优先用已算好的 words，缺失（老数据 / 导入）时现算一次，避免每帧全量统计 */
  const wordsById = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of project.chapters) map.set(c.id, c.words || countWords(c.content))
    return map
  }, [project.chapters])

  const hasActive = project.chapters.some((c) => c.id === activeChapterId)
  const current = hasActive ? project.chapters.find((c) => c.id === activeChapterId)! : project.chapters[0] ?? null

  const scopeChapters = useMemo(() => {
    if (scope === 'chapter') return current ? [current] : []
    if (scope === 'picked') return project.chapters.filter((c) => picked.includes(c.id))
    return project.chapters
  }, [scope, current, picked, project.chapters])

  // 只有有正文的章能生成：空的章丢给模型只会换回一段瞎编
  const targets = scopeChapters.filter((c) => (wordsById.get(c.id) ?? 0) > 0)
  const skipped = scopeChapters.length - targets.length
  const scopeWords = targets.reduce((a, c) => a + (wordsById.get(c.id) ?? 0), 0)

  // 第一次切到「指定章节」时，默认勾上当前打开的这一章，省得作者面对一堆空勾
  useEffect(() => {
    if (scope !== 'picked') return
    setPicked((prev) => (prev.length ? prev : current ? [current.id] : []))
  }, [scope, current])

  // 切章 / 切范围都必须掐断朗读，不许后台继续念
  useEffect(() => {
    speech.stop()
    // 只跟这两件事有关：speech 每次渲染引用都会变，跟它会让朗读刚开就被停掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChapterId, scope])

  // 离开页面：既停朗读，也停批量生成。让一批调用在看不见的地方继续烧钱，
  // 比「回来发现只生成了三章」更糟。
  useEffect(() => {
    return () => {
      abortedRef.current = true
      if (runningRef.current) abortChat()
    }
  }, [])

  const writeRecital = (chapter: Chapter, parsed: { title: string; script: string }, usedStyle: string, model: string): void => {
    const next: Recital = {
      at: Date.now(),
      styleId: usedStyle,
      title: parsed.title,
      script: parsed.script,
      model,
      edited: false
    }
    patchProject((p) => ({ ...p, recitals: { ...p.recitals, [chapter.id]: next } }))
  }

  const runBatch = async (list: Chapter[]): Promise<void> => {
    const resolved = resolveTaskModel(config, project, 'draft')
    if (!resolved) {
      toast('还没有可用模型，请先到设置 → 渠道与模型里配置', 'error')
      return
    }
    speech.stop()
    abortedRef.current = false
    runningRef.current = true
    setRunning(true)
    setSummary(null)

    const fail: Failure[] = []
    let ok = 0
    for (let i = 0; i < list.length; i++) {
      if (abortedRef.current) break
      const chapter = list[i]
      let chars = 0
      setProg({ index: i + 1, total: list.length, chars: 0, title: chapter.title })
      try {
        const { system, user } = buildRecitalMessages(project, chapter, style, targetWords)
        const raw = await generateCustom({
          project,
          chapter,
          channel: resolved.channel,
          model: resolved.model,
          task: 'draft',
          temperature: 0.9,
          system,
          user,
          budgets,
          maxTokens: resolveBudget(budgets, BUDGET_KEYS.recitalScript, targetWords),
          onDelta: (d) => {
            chars += d.length
            const n = chars
            setProg((p) => (p ? { ...p, chars: n } : p))
          },
          onThought: () => {
            /* 思考内容不算正文，进度里只数字数就够 */
          }
        })
        if (abortedRef.current) break
        // 解析失败（空稿）也走 catch：让它进失败清单，而不是写一份空稿落盘
        const parsed = parseRecital(raw, chapter.title)
        writeRecital(chapter, parsed, style.id, resolved.label)
        ok++
        if (parsed.warnings.length) toast(`《${chapter.title}》：${parsed.warnings[0]}`, 'info')
      } catch (e) {
        const message = (e as Error)?.message || '调用失败'
        if (abortedRef.current || isAbortMessage(message)) break
        fail.push({ title: chapter.title, reason: message })
      }
    }

    runningRef.current = false
    setRunning(false)
    setProg(null)
    setSummary({ ok, fail, aborted: abortedRef.current })
    if (ok && fail.length) toast(`成功 ${ok} 章 · 失败 ${fail.length} 章`, 'info')
    else if (ok) toast(`已生成 ${ok} 章评书稿`, 'ok')
    else if (fail.length) toast(`生成失败：${fail[0].reason}`, 'error')
  }

  const start = (list: Chapter[]): void => {
    if (!list.length) {
      toast(scope === 'chapter' ? '本章还没有正文，先写点东西再来' : '选中的章节都没有正文，生成不了', 'error')
      return
    }
    // 手改过的稿子重新生成会覆盖，必须先问一句
    const edited = list.filter((c) => recitals[c.id]?.edited)
    if (edited.length) {
      setConfirmTargets(list)
      return
    }
    void runBatch(list)
  }

  const stop = (): void => {
    abortedRef.current = true
    abortChat()
    toast('已停止，已生成的章节已保留', 'info')
  }

  const exportAll = async (): Promise<void> => {
    const rows = scopeChapters.filter((c) => recitals[c.id])
    if (!rows.length) {
      toast('还没有可导出的评书稿', 'error')
      return
    }
    const items = rows.map((c) => {
      const r = recitals[c.id]
      const heading = r.title && r.title !== c.title ? `${c.title} · ${r.title}` : r.title || c.title
      // 导出通道吃 HTML：纯文本里的换行在 markdown 转换里会被吞掉，先包成段落
      return { title: heading, content: textToParagraphHtml(r.script) }
    })
    try {
      const res = await mz.io.exportFile({ kind: 'md', title: `《${project.title}》评书稿`, items })
      if (res?.message) toast(`导出失败：${res.message}`, 'error')
      else if (!res?.canceled) toast(`已导出到 ${res?.path ?? ''}`, 'ok')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const hintParts: string[] = [style.desc, `目标约 ${targetWords} 字`]
  if (scope === 'chapter' && !hasActive) hintParts.unshift('当前没有打开章节，已默认取第一章')
  if (scope === 'chapter' && current && (wordsById.get(current.id) ?? 0) === 0) hintParts.push('本章还没有正文')
  if (targets.length > 1) hintParts.push(`将逐章生成 ${targets.length} 章`)
  if (skipped > 0) hintParts.push(`跳过 ${skipped} 个空章`)

  const results = scopeChapters.filter((c) => recitals[c.id])
  const rate = speech.state.rate
  const ttsReady = speech.state.supported

  return (
    <div className="h-full overflow-auto scroll-thin">
      <div className="max-w-[920px] mx-auto px-8 py-7">
        <div className="flex items-start gap-2.5 mb-3">
          <Mic size={16} style={{ color: 'var(--accent)', marginTop: 2 }} />
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">评书</h2>
            <div className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
              把这一章改成人能站在台上「说」的评书稿：短句、口语、留扣子。生成后可以在这里朗读或导出。
            </div>
          </div>
        </div>

        {/* 控制条 */}
        <div className="card px-4 py-3 mb-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <div className="flex items-center gap-2">
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                范围
              </span>
              <Segmented<Scope>
                value={scope}
                options={SCOPES}
                onChange={(v) => {
                  speech.stop()
                  setScope(v)
                }}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                风格
              </span>
              <Select value={styleId} onChange={(e) => setStyleId(e.target.value)} style={{ width: 148 }}>
                {RECITAL_STYLES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                时长
              </span>
              <Segmented<string>
                value={String(minutes)}
                options={RECITAL_DURATIONS.map((d) => ({ value: String(d.value), label: d.label }))}
                onChange={(v) => setMinutes(Number(v) as RecitalMinutes)}
              />
            </div>
            <div className="flex-1" />
            {running ? (
              <Button variant="danger" onClick={stop} title="停止后已生成的章节会保留">
                <CircleStop size={13} /> 停止
              </Button>
            ) : (
              <Button variant="primary" onClick={() => start(targets)} disabled={!targets.length}>
                <Sparkles size={13} /> 生成评书稿
              </Button>
            )}
          </div>

          <div className="mt-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            {hintParts.join(' · ')}
            {targets.length > 1 && ` · 合计 ${formatNumber(scopeWords)} 字原文`}
          </div>

          {scope === 'picked' && (
            <div className="mt-3">
              <div
                className="card px-2.5 py-2 max-h-[190px] overflow-auto scroll-thin"
                style={{ background: 'var(--panel-2)' }}
              >
                {project.chapters.length === 0 && (
                  <div className="text-[12px] py-2" style={{ color: 'var(--text-faint)' }}>
                    还没有章节
                  </div>
                )}
                <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                  {project.chapters.map((c) => {
                    const w = wordsById.get(c.id) ?? 0
                    return (
                      <Checkbox
                        key={c.id}
                        checked={picked.includes(c.id)}
                        disabled={running}
                        onChange={(on) => setPicked((prev) => (on ? [...prev, c.id] : prev.filter((x) => x !== c.id)))}
                        title={w === 0 ? '这一章还没有正文，不能生成' : undefined}
                        label={
                          <span className="truncate" style={{ opacity: w === 0 ? 0.6 : 1 }}>
                            {c.title} · {formatNumber(w)} 字
                          </span>
                        }
                      />
                    )
                  })}
                </div>
              </div>
              <div className="mt-1.5 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                已选 {targets.length} 章 · 合计 {formatNumber(scopeWords)} 字
              </div>
            </div>
          )}
        </div>

        {/* 进度 */}
        {running && prog && (
          <div className="card px-4 py-3 mb-3">
            <div className="flex items-center gap-2 text-[12.5px]">
              <Spinner size={12} />
              <span className="font-medium">
                第 {prog.index}/{prog.total} 章
              </span>
              <span style={{ color: 'var(--text-dim)' }}>· 已收到 {prog.chars} 字</span>
              <span className="truncate" style={{ color: 'var(--text-faint)' }}>
                《{prog.title}》
              </span>
              <div className="flex-1" />
              <span style={{ color: 'var(--text-faint)' }}>已等待 {Math.round(elapsed / 1000)} 秒</span>
            </div>
            <div className="mt-2">
              <Progress value={prog.chars} max={Math.max(1, targetWords)} />
            </div>
          </div>
        )}

        {/* 结束汇总 */}
        {!running && summary && (summary.ok > 0 || summary.fail.length > 0) && (
          <div className="card px-4 py-3 mb-3">
            <div className="text-[12.5px]">
              成功 {summary.ok} 章 / 失败 {summary.fail.length} 章
              {summary.aborted && <span style={{ color: 'var(--text-faint)' }}>（中途已停止）</span>}
            </div>
            {summary.fail.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {summary.fail.map((f) => (
                  <li key={f.title} className="text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                    · 《{f.title}》：{f.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* 朗读设置 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-2">
          <div
            className="flex items-center gap-1.5 text-[12px]"
            style={{ color: ttsReady ? 'var(--text-dim)' : 'var(--text-faint)' }}
          >
            <Volume2 size={13} /> 朗读
          </div>
          <div className="flex items-center gap-2">
            <div className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              语速
            </div>
            <div style={{ width: 96 }}>
              <Slider value={rate} min={0.7} max={1.5} step={0.1} onChange={speech.setRate} />
            </div>
            <div className="text-[11.5px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
              {rate.toFixed(1)}×
            </div>
          </div>
          <Select
            value={String(speech.state.voiceIndex)}
            disabled={!ttsReady}
            onChange={(e) => speech.setVoice(Number(e.target.value))}
            style={{ width: 168 }}
          >
            {speech.state.voices.length === 0 && <option value="0">无可用中文语音</option>}
            {speech.state.voices.map((v, i) => (
              <option key={`${v.label}-${i}`} value={String(i)}>
                {v.label}
              </option>
            ))}
          </Select>
          {!ttsReady && (
            <div className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              {speech.state.hint}
            </div>
          )}
          <div className="flex-1" />
          <Button
            onClick={() => void exportAll()}
            disabled={!results.length}
            title="把当前范围里已生成的评书稿导出成一份 Markdown"
          >
            <Download size={13} /> 导出本页
          </Button>
        </div>

        {/* 结果 */}
        {results.length === 0 ? (
          <EmptyState
            icon={<Mic size={22} />}
            title="还没有评书稿"
            desc={`选好范围和风格，点「生成评书稿」。${scope === 'chapter' ? '当前只生成你正在写的这一章。' : ''}`}
          />
        ) : (
          <div className="space-y-3">
            {results.map((c) => (
              <RecitalCard
                key={c.id}
                chapter={c}
                recital={recitals[c.id]}
                speech={speech}
                ttsReady={ttsReady}
                busy={running}
                onScriptChange={(script) =>
                  patchProject((p) => {
                    const cur = p.recitals[c.id]
                    if (!cur) return p
                    return { ...p, recitals: { ...p.recitals, [c.id]: { ...cur, script, edited: true } } }
                  })
                }
                onRegenerate={() => start([c])}
              />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={Boolean(confirmTargets)}
        onClose={() => setConfirmTargets(null)}
        title="这份稿子你改过"
        width={440}
        footer={
          <>
            <Button onClick={() => setConfirmTargets(null)}>取消</Button>
            <Button
              variant="primary"
              onClick={() => {
                const list = confirmTargets ?? []
                setConfirmTargets(null)
                if (list.length) void runBatch(list)
              }}
            >
              覆盖并生成
            </Button>
          </>
        }
      >
        <div className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          重新生成会覆盖你手改过的评书稿，改动不会保留。
          <div className="mt-2">
            涉及
            {(confirmTargets ?? [])
              .filter((c) => recitals[c.id]?.edited)
              .map((c) => `《${c.title}》`)
              .join('、')}
          </div>
        </div>
      </Modal>
    </div>
  )
}

function RecitalCard({
  chapter,
  recital,
  speech,
  ttsReady,
  busy,
  onScriptChange,
  onRegenerate
}: {
  chapter: Chapter
  recital: Recital
  speech: SpeechApi
  ttsReady: boolean
  busy: boolean
  onScriptChange: (script: string) => void
  onRegenerate: () => void
}): ReactNode {
  const active = speech.state.key === chapter.id
  const mode = active ? speech.state.mode : 'idle'
  const index = active ? speech.state.index : -1
  const total = active ? speech.state.total : 0
  const playing = mode === 'playing'
  const paused = mode === 'paused'
  const stalled = mode === 'stalled'
  const styleName = findRecitalStyle(recital.styleId).name

  const playFromStart = (): void => {
    // 每次都重新 load：稿子可能刚被改过 / 刚重新生成过，玩家手里的切句不能是旧的
    speech.load(recital.script, chapter.id)
    speech.play(0)
  }

  return (
    <div className="card px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13.5px] font-semibold truncate">{recital.title || chapter.title}</span>
            <span className="chip">{chapter.title}</span>
            <span className="chip">{styleName}</span>
            {recital.edited && <span className="chip chip-accent">已手改</span>}
            <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {formatNumber(countWords(recital.script))} 字 · {relativeTime(recital.at)}
              {recital.model ? ` · ${recital.model}` : ''}
            </span>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onRegenerate} disabled={busy} title="按当前风格与时长重写这一章">
          <RotateCcw size={12} /> 重新生成
        </Button>
      </div>

      <div className="mt-2">
        <Textarea
          value={recital.script}
          onChange={(e) => onScriptChange(e.target.value)}
          style={{ minHeight: 240, lineHeight: 1.8 }}
          spellCheck={false}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {playing ? (
          <Button size="sm" disabled={!ttsReady} onClick={() => speech.pause()}>
            <Pause size={12} /> 暂停
          </Button>
        ) : paused ? (
          <Button size="sm" disabled={!ttsReady} onClick={() => speech.resume()}>
            <Play size={12} /> 继续
          </Button>
        ) : stalled ? (
          <Button
            size="sm"
            disabled={!ttsReady}
            onClick={() => speech.play(index < 0 ? 0 : index)}
            title="这台机器的暂停不可靠，直接从当前句重播"
          >
            <Play size={12} /> 从第 {Math.max(1, index + 1)} 句重播
          </Button>
        ) : (
          <Button size="sm" disabled={!ttsReady} onClick={playFromStart}>
            <Play size={12} /> 播放
          </Button>
        )}
        {(playing || paused || stalled) && (
          <Button size="sm" disabled={!ttsReady} onClick={() => speech.stop()}>
            <Square size={12} /> 停止
          </Button>
        )}
        {active && total > 0 && (
          <span className="text-[11.5px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
            {index >= 0 ? `第 ${index + 1}/${total} 句` : `共 ${total} 句`}
            {stalled ? ' · 已暂停（系统暂停不可靠，可重播）' : ''}
          </span>
        )}
        {!ttsReady && (
          <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            {speech.state.hint}
          </span>
        )}
      </div>
    </div>
  )
}