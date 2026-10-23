import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react'
import type { Project } from '@shared/types'
import {
  groupByChapter,
  searchBook,
  searchInChapter,
  countByChapter,
  type SearchHit
} from '../../lib/search'

/**
 * 搜索面板。
 *
 * 两个范围：全书 / 本章。默认找本章——正在写这一章时，作者要的多半是
 * 「这章里那个词在哪」，而不是把整本书翻一遍。但想查伏笔、查人名时就要全书。
 *
 * 命中结果按章节折叠，点了直接跳到那一章那一处。
 */
export function SearchPanel({
  project,
  chapterId,
  onJump,
  onClose
}: {
  project: Project
  chapterId: string | null
  onJump: (hit: SearchHit) => void
  onClose: () => void
}): ReactNode {
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<'chapter' | 'book'>('chapter')
  const [caseSensitive, setCaseSensitive] = useState(false)
  /** 折叠起来的章节 */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const chapter = useMemo(() => project.chapters.find((c) => c.id === chapterId) ?? null, [project, chapterId])

  const hits = useMemo(() => {
    if (!q.trim()) return []
    return scope === 'book'
      ? searchBook(project, q, { caseSensitive })
      : chapter
        ? searchInChapter(chapter, q, { caseSensitive })
        : []
  }, [q, scope, caseSensitive, project, chapter])

  const groups = useMemo(() => groupByChapter(hits, project), [hits, project])
  const counts = useMemo(() => countByChapter(hits), [hits])

  /** 高亮命中词：只把命中本身包起来，不整段渲染富文本 */
  function renderLine(hit: SearchHit): ReactNode {
    return (
      <span className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)', wordBreak: 'break-all' }}>
        {hit.before}
        <mark
          style={{
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            padding: '0 1px',
            borderRadius: 2
          }}
        >
          {hit.match}
        </mark>
        {hit.after}
      </span>
    )
  }

  const total = hits.length

  return (
    <div className="flex flex-col h-full" data-mz-search>
      <div className="px-3 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-1.5">
          <Search size={13} style={{ color: 'var(--text-dim)' }} />
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-dim)' }}>
            搜索
          </span>
          <button className="ml-auto" onClick={onClose} title="关闭 ⌘F">
            <X size={13} style={{ color: 'var(--text-faint)' }} />
          </button>
        </div>

        <div
          className="mt-2 flex items-center gap-1 rounded px-2 h-8"
          style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
        >
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
              // 回车跳到第一条，符合「搜完就想去看」的习惯
              if (e.key === 'Enter' && hits[0]) {
                e.preventDefault()
                onJump(hits[0])
              }
            }}
            placeholder={scope === 'book' ? '在全书里找…' : '在这一章里找…'}
            className="flex-1 bg-transparent outline-none text-[12px]"
            style={{ color: 'var(--text)' }}
          />
          {q ? (
            <button onClick={() => setQ('')} title="清空">
              <X size={12} style={{ color: 'var(--text-faint)' }} />
            </button>
          ) : null}
        </div>

        <div className="mt-2 flex items-center gap-1">
          <Seg active={scope === 'chapter'} onClick={() => setScope('chapter')} disabled={!chapter}>
            本章
          </Seg>
          <Seg active={scope === 'book'} onClick={() => setScope('book')}>
            全书
          </Seg>
          <label
            className="ml-auto flex items-center gap-1 text-[10.5px] cursor-pointer select-none"
            style={{ color: 'var(--text-faint)' }}
            title="区分大小写（对英文有用，中文无影响）"
          >
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
              className="accent-current"
              style={{ width: 11, height: 11 }}
            />
            Aa
          </label>
        </div>
      </div>

      <div className="px-3 py-1.5 shrink-0 text-[11px]" style={{ color: 'var(--text-faint)' }}>
        {!q.trim()
          ? '输入关键词。回车跳到第一处。'
          : total === 0
            ? `没有找到「${q.trim()}」`
            : `共 ${total} 处 · 分布在 ${groups.length} 章`}
      </div>

      <div className="flex-1 min-h-0 overflow-auto scroll-thin px-2 pb-2">
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.chapterId)
          return (
            <div key={g.chapterId} className="mb-1.5">
              <button
                className="w-full flex items-center gap-1 px-1 py-1 text-left"
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev)
                    if (next.has(g.chapterId)) next.delete(g.chapterId)
                    else next.add(g.chapterId)
                    return next
                  })
                }
              >
                {isCollapsed ? (
                  <ChevronRight size={12} style={{ color: 'var(--text-faint)' }} />
                ) : (
                  <ChevronDown size={12} style={{ color: 'var(--text-faint)' }} />
                )}
                <span className="text-[11.5px] font-medium truncate" style={{ color: 'var(--text-dim)' }}>
                  {g.chapterTitle}
                </span>
                <span className="text-[10.5px] shrink-0" style={{ color: 'var(--text-faint)' }}>
                  {g.hits.length}
                </span>
              </button>

              {isCollapsed
                ? null
                : g.hits.map((h) => (
                    <button
                      key={h.id}
                      className="w-full text-left rounded px-2 py-1.5 mb-1"
                      style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}
                      onClick={() => onJump(h)}
                      title="跳到这一处"
                    >
                      {renderLine(h)}
                    </button>
                  ))}
            </div>
          )
        })}

        {q.trim() && total === 0 ? (
          <div className="px-2 py-6 text-center text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            {scope === 'chapter' ? '这一章里没有。要不要切到「全书」？' : '全书都没有这个字。'}
          </div>
        ) : null}
      </div>

      {Object.keys(counts).length > 0 ? (
        <div
          className="px-3 py-1.5 shrink-0 text-[10.5px]"
          style={{ borderTop: '1px solid var(--border)', color: 'var(--text-faint)' }}
        >
          {scope === 'book' ? '全书搜索会扫过每一章正文，但不含设定集。' : '只搜正文，不含设定集与大纲。'}
        </div>
      ) : null}
    </div>
  )
}

function Seg({
  active,
  onClick,
  disabled,
  children
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}): ReactNode {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-2 h-6 rounded text-[11px] transition-colors disabled:opacity-40"
      style={{
        background: active ? 'var(--accent-soft)' : 'var(--panel)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        color: active ? 'var(--accent)' : 'var(--text-dim)'
      }}
    >
      {children}
    </button>
  )
}