import { useState, type ReactNode } from 'react'
import { MessageSquareQuote, RefreshCw, Sparkles } from 'lucide-react'
import type { Chapter, Project } from '@shared/types'
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, resolveBudget } from '@shared/budgets'
import { Button, Spinner } from '../../../components/ui'
import { useApp } from '../../../store/app'
import { generateCustom } from '../../../lib/generate'
import { buildMarginNoteMessages, parseMarginNotes, splitParagraphs, type MarginNote } from './margin'
import type { Channel } from '@shared/types'

const KIND_COLOR: Record<MarginNote['kind'], string> = {
  删: '#c05621',
  改: '#2b6cb0',
  慢: '#805ad5',
  快: '#b7791f',
  虚: '#c53030',
  偏: '#2f855a'
}

/**
 * 侧批：段落旁边挂批注，正文本身一个字都不动。
 *
 * 这是「读稿」和「改稿」的分野。AI 一旦直接改写，作者就只能接受或丢弃；
 * 而批注是给作者看的，改不改由他自己的笔决定。
 */
export function MarginNotes({
  project,
  chapter,
  resolveModel
}: {
  project: Project
  chapter: Chapter | null
  /** 取一次可用的模型（体检任务级别） */
  resolveModel: () => { channel: Channel; model: string; label: string } | null
}): ReactNode {
  const budgets = useApp((s) => s.config?.settings.tokenBudgets) ?? DEFAULT_TOKEN_BUDGETS
  const [notes, setNotes] = useState<MarginNote[] | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('')

  const paragraphs = splitParagraphs(chapter)

  async function run(): Promise<void> {
    if (!chapter) return
    const r = resolveModel()
    if (!r) return
    setRunning(true)
    setError(null)
    setLabel(r.label)
    try {
      const messages = buildMarginNoteMessages(project, chapter)
      const text = await generateCustom({
        project,
        chapter,
        channel: r.channel,
        model: r.model,
        task: 'audit',
        temperature: 0.4,
        system: messages[0].content,
        user: messages[1].content,
        maxTokens: resolveBudget(budgets, BUDGET_KEYS.marginNotes),
        onDelta: () => {},
        onThought: () => {}
      })
      setNotes(parseMarginNotes(text, paragraphs.length))
    } catch (e) {
      setError((e as Error).message || '批注失败')
    } finally {
      setRunning(false)
    }
  }

  if (!chapter) return null

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-5 h-11 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <MessageSquareQuote size={14} style={{ color: 'var(--text-dim)' }} />
        <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-dim)' }}>
          段落侧批
        </span>
        <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {notes ? `${notes.length} 条 · ${label}` : '只批注，不改稿'}
        </span>
        <div className="flex-1" />
        <Button size="sm" variant={notes ? 'ghost' : 'primary'} onClick={() => void run()} disabled={running || paragraphs.length === 0}>
          {running ? <Spinner size={12} /> : notes ? <RefreshCw size={13} /> : <Sparkles size={13} />}
          {running ? '正在读稿…' : notes ? '重新批注' : '读一遍这一章'}
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto scroll-thin px-5 py-4">
        {error ? (
          <div className="text-[12px] mb-3" style={{ color: 'var(--danger)' }}>
            {error}
          </div>
        ) : null}

        {!notes ? (
          <div className="text-[12px] leading-relaxed max-w-[560px]" style={{ color: 'var(--text-faint)' }}>
            让 AI 以编辑的视角把这一章读一遍，在需要动的地方写一句话，挂在对应段落旁边。
            <br />
            它不会替你改写。看到不同意的批注，直接无视即可——不能反驳的批注，本来也不算批注。
          </div>
        ) : notes.length === 0 ? (
          <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
            这一章没挑出什么毛病。
          </div>
        ) : (
          <div className="space-y-3 max-w-[720px]">
            {notes.map((n) => {
              const para = paragraphs[n.index - 1] ?? ''
              return (
                <div
                  key={`${n.index}-${n.kind}`}
                  className="rounded-lg p-3"
                  style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span
                      className="text-[10.5px] px-1.5 h-[18px] inline-flex items-center rounded"
                      style={{
                        color: KIND_COLOR[n.kind],
                        background: `color-mix(in srgb, ${KIND_COLOR[n.kind]} 14%, transparent)`
                      }}
                    >
                      {n.kind}
                    </span>
                    <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                      第 {n.index} 段
                    </span>
                  </div>
                  <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                    {n.note}
                  </div>
                  <div
                    className="mt-2 pl-2.5 text-[11.5px] leading-relaxed selectable line-clamp-3"
                    style={{ borderLeft: '2px solid var(--border)', color: 'var(--text-faint)' }}
                  >
                    {para.length > 160 ? `${para.slice(0, 160)}…` : para}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}