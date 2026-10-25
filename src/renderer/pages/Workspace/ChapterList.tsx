import { useState, type ReactNode } from 'react'
import type { Project } from '@shared/types'
import { formatNumber } from '@shared/utils'
import { useApp, CHAPTER_STATUS_COLOR, CHAPTER_STATUS_LABEL } from '../../store/app'
import { ChapterHistory } from './ChapterHistory'
import { IconButton } from '../../components/ui'
import { FileText, History, NotebookPen, Plus, Trash2 } from 'lucide-react'

export function ChapterList({
  project,
  onEditSummary
}: {
  project: Project
  /** 打开「本章梗概」查看/编辑弹窗 */
  onEditSummary: (chapterId: string) => void
}): ReactNode {
  const { activeChapterId, setActiveChapter, addChapter, patchChapter, removeChapter, cycleChapterStatus, toast } = useApp()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [historyId, setHistoryId] = useState<string | null>(null)

  return (
    <div className="flex flex-col h-full" style={{ width: 244, background: 'var(--sidebar)', borderRight: '1px solid var(--border)' }}>
      <div className="flex items-center px-3 h-11 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <span className="text-[12px] font-medium" style={{ color: 'var(--text-dim)' }}>
          章节 · {project.chapters.length}
        </span>
        <div className="flex-1" />
        <IconButton title="新建章节" onClick={() => addChapter()}>
          <Plus size={15} />
        </IconButton>
      </div>

      <div className="flex-1 min-h-0 overflow-auto scroll-thin py-1.5">
        {project.chapters.map((c, i) => {
          const active = c.id === activeChapterId
          return (
            <div
              key={c.id}
              className="group mx-1.5 px-2 py-1.5 rounded-md mb-0.5"
              style={{ background: active ? 'var(--accent-soft)' : 'transparent' }}
              onClick={() => setActiveChapter(c.id)}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="text-[10.5px] w-5 shrink-0 tabular-nums"
                  style={{ color: active ? 'var(--accent)' : 'var(--text-faint)' }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                {editingId === c.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => {
                      if (draft.trim()) patchChapter(c.id, { title: draft.trim() })
                      setEditingId(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    className="flex-1 min-w-0 bg-transparent outline-none text-[12.5px]"
                    style={{ color: 'var(--text)' }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="flex-1 min-w-0 text-[12.5px] truncate"
                    style={{ color: active ? 'var(--accent)' : 'var(--text)', fontWeight: active ? 600 : 400 }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setEditingId(c.id)
                      setDraft(c.title)
                    }}
                    title={c.title}
                  >
                    {c.title || '未命名'}
                  </span>
                )}
                {c.versions?.length ? (
                  <button
                    className="shrink-0"
                    style={{ color: 'var(--text-faint)' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      setHistoryId(c.id)
                    }}
                    title={`这一章有 ${c.versions.length} 个历史版本`}
                  >
                    <History size={11} />
                  </button>
                ) : null}
                <button
                  className="opacity-0 group-hover:opacity-100 shrink-0"
                  style={{ color: 'var(--text-faint)' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmId(c.id)
                  }}
                  title="删除本章"
                >
                  <Trash2 size={11} />
                </button>
              </div>
              <div className="flex items-center gap-2 pl-[26px] mt-0.5">
                <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                  {formatNumber(c.words)} 字
                </span>
                <button
                  className="text-[10px] px-1 rounded"
                  style={{
                    color: CHAPTER_STATUS_COLOR[c.status].fg,
                    background: CHAPTER_STATUS_COLOR[c.status].bg,
                    border: `1px solid ${c.status === 'draft' ? 'transparent' : 'var(--border)'}`
                  }}
                  title="点击切换状态：待写 → 撰写中 → 已完成"
                  onClick={(e) => {
                    e.stopPropagation()
                    cycleChapterStatus(c.id)
                  }}
                >
                  {CHAPTER_STATUS_LABEL[c.status]}
                </button>
              </div>
              {(() => {
                const sm = (project.summaries[c.id] || c.summary || '').trim()
                return (
                  <button
                    className={
                      'mt-0.5 flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[10.5px] ' +
                      (sm ? '' : 'opacity-0 group-hover:opacity-100')
                    }
                    style={{
                      color: sm ? 'var(--text-dim)' : 'var(--text-faint)',
                      opacity: sm || active ? 1 : undefined
                    }}
                    title={sm ? `梗概：${sm}\n\n点击编辑` : '本章还没有梗概，点击添加'}
                    onClick={(e) => {
                      e.stopPropagation()
                      onEditSummary(c.id)
                    }}
                  >
                    <NotebookPen size={10} className="shrink-0" />
                    <span className="min-w-0 truncate">{sm ? sm.replace(/\n/g, ' ') : '加梗概'}</span>
                  </button>
                )
              })()}
            </div>
          )
        })}

        {project.chapters.length === 0 && (
          <div className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
            还没有章节
            <div className="mt-2">
              <button className="text-[12px]" style={{ color: 'var(--accent)' }} onClick={() => addChapter()}>
                + 新建第一章
              </button>
            </div>
          </div>
        )}
      </div>

      {confirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(8,12,18,.42)' }}>
          <div className="card p-5" style={{ width: 380, background: 'var(--panel)' }}>
            <div className="font-medium mb-1.5 text-[13.5px]">删除这一章？</div>
            <div className="text-[12.5px] mb-4" style={{ color: 'var(--text-dim)' }}>
              「{project.chapters.find((c) => c.id === confirmId)?.title}」将被永久删除，此操作不可恢复。
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => setConfirmId(null)}>
                取消
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  removeChapter(confirmId)
                  setConfirmId(null)
                  toast('章节已删除', 'ok')
                }}
              >
                <FileText size={13} /> 确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {historyId && (
        <ChapterHistory
          open
          chapter={project.chapters.find((c) => c.id === historyId) ?? null}
          onClose={() => setHistoryId(null)}
          onRestore={(snapshotId) => {
            const target = project.chapters.find((c) => c.id === historyId)
            const snap = target?.versions?.find((v) => v.id === snapshotId)
            if (!target || !snap) return
            // 还原也是改动：当前内容会先被存成快照，所以还原本身也能再撤销
            patchChapter(target.id, { content: snap.content })
            toast('已还原到该版本（当前内容已存入历史）', 'ok')
          }}
          onClear={() => {
            // 清空历史是不可逆的：这里沿用「删除部件要二次确认」的既有做法，
            // 不静默清掉作者唯一的后悔药
            if (!historyId) return
            patchChapter(historyId, { versions: [] })
            toast('历史版本已清空', 'ok')
            setHistoryId(null)
          }}
        />
      )}
    </div>
  )
}