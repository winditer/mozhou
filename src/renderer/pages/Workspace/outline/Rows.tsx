import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronRight, FileText, Layers, Plus, Sparkles, SquarePen, Trash } from 'lucide-react'
import type { Chapter, OutlineNode } from '@shared/types'
import { Button, IconButton, Input, Textarea } from '../../../components/ui'
import { ConfirmButton } from '../ConfirmButton'
import { STATUS_LABEL, nextStatus } from './parse'

const STATUS_COLOR: Record<OutlineNode['status'], { fg: string; bg: string }> = {
  planned: { fg: 'var(--text-faint)', bg: 'var(--panel-2)' },
  writing: { fg: 'var(--accent)', bg: 'var(--accent-soft)' },
  done: { fg: 'var(--ok)', bg: 'color-mix(in srgb, var(--ok) 12%, transparent)' }
}

export function StatusBadge({ status, onClick }: { status: OutlineNode['status']; onClick: () => void }): ReactNode {
  const c = STATUS_COLOR[status]
  return (
    <button
      type="button"
      onClick={onClick}
      title="点击切换状态：待写 → 进行中 → 已完成"
      className="shrink-0 h-[19px] px-1.5 rounded text-[11px] leading-none"
      style={{ color: c.fg, background: c.bg, border: `1px solid ${c.fg === 'var(--text-faint)' ? 'var(--border)' : 'transparent'}` }}
    >
      {STATUS_LABEL[status]}
    </button>
  )
}

/** 可点击变输入框的行内标题 */
function InlineTitle({ value, onCommit, bold }: { value: string; onCommit: (v: string) => void; bold?: boolean }): ReactNode {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false)
          const v = draft.trim()
          if (v && v !== value) onCommit(v)
          else setDraft(value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(value)
            setEditing(false)
          }
        }}
        className="h-[26px] py-0 text-[13px]"
        style={{ maxWidth: 420 }}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value)
        setEditing(true)
      }}
      className="min-w-0 text-left truncate rounded px-1 -mx-1 hover:bg-[var(--panel-2)]"
      style={{ color: 'var(--text)', fontSize: 13, fontWeight: bold ? 600 : 400 }}
      title="点击重命名"
    >
      {value || '未命名'}
    </button>
  )
}

export interface RowActions {
  onPatch: (id: string, patch: Partial<OutlineNode>) => void
  onRemove: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
  onAddChild: (volumeId: string) => void
  onGenerateBrief: (node: OutlineNode) => void
  onBuildChapter: (node: OutlineNode) => void
  onOpenChapter: (chapter: Chapter) => void
}

export function VolumeRow({
  node,
  collapsed,
  onToggle,
  actions,
  chapterCount,
  childLabel = '章'
}: {
  node: OutlineNode
  collapsed: boolean
  onToggle: () => void
  actions: RowActions
  chapterCount: number
  childLabel?: string
}): ReactNode {
  return (
    <div
      className="group flex items-center gap-1.5 h-9 pl-1 pr-1.5 rounded-md"
      style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}
    >
      <button type="button" onClick={onToggle} className="shrink-0 w-5 h-5 flex items-center justify-center rounded" style={{ color: 'var(--text-faint)' }} title={collapsed ? '展开' : '折叠'}>
        <ChevronRight size={14} style={{ transform: collapsed ? 'none' : 'rotate(90deg)', transition: 'transform .12s' }} />
      </button>
      <Layers size={13} style={{ color: 'var(--accent)' }} className="shrink-0" />
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <InlineTitle value={node.title} bold onCommit={(v) => actions.onPatch(node.id, { title: v })} />
        <StatusBadge status={node.status} onClick={() => actions.onPatch(node.id, { status: nextStatus(node.status) })} />
        <span className="chip shrink-0" style={{ height: 18, fontSize: 11 }}>
          {chapterCount} {childLabel}
        </span>
        {node.summary && (
          <span className="min-w-0 truncate text-[11.5px]" style={{ color: 'var(--text-faint)' }} title={node.summary}>
            {node.summary}
          </span>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <IconButton onClick={() => actions.onMove(node.id, -1)} title="上移" style={{ width: 24, height: 24 }}>
          <ArrowUp size={13} />
        </IconButton>
        <IconButton onClick={() => actions.onMove(node.id, 1)} title="下移" style={{ width: 24, height: 24 }}>
          <ArrowDown size={13} />
        </IconButton>
        <IconButton onClick={() => actions.onAddChild(node.id)} title="新增子章" style={{ width: 24, height: 24 }}>
          <Plus size={13} />
        </IconButton>
        <ConfirmButton label={<Trash size={13} />} title="删除本卷（含其下所有章）" onConfirm={() => actions.onRemove(node.id)} className="!h-6 !w-6 !px-0" />
      </div>
    </div>
  )
}

export function ChapterRow({
  node,
  index,
  chapter,
  actions
}: {
  node: OutlineNode
  index: number
  chapter: Chapter | undefined
  actions: RowActions
}): ReactNode {
  const [openBrief, setOpenBrief] = useState(false)

  return (
    <div className="group">
      <div className="flex items-center gap-1.5 h-8 pl-6 pr-1.5 rounded-md surface-hover">
        <span className="shrink-0 text-[11px] tabular-nums w-4 text-right" style={{ color: 'var(--text-faint)' }}>
          {index}
        </span>
        <FileText size={12} style={{ color: 'var(--text-faint)' }} className="shrink-0" />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <InlineTitle value={node.title} onCommit={(v) => actions.onPatch(node.id, { title: v })} />
          <StatusBadge status={node.status} onClick={() => actions.onPatch(node.id, { status: nextStatus(node.status) })} />
          {chapter && (
            <button
              type="button"
              onClick={() => actions.onOpenChapter(chapter)}
              className="shrink-0 h-[18px] px-1.5 rounded inline-flex items-center gap-1 text-[11px] leading-none"
              style={{ color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 10%, transparent)' }}
              title={`已建章节：${chapter.title}（点击前往写作）`}
            >
              <Check size={10} /> 已建章
            </button>
          )}
          {node.summary && !openBrief && (
            <span className="min-w-0 truncate text-[11.5px]" style={{ color: 'var(--text-faint)' }} title={node.summary}>
              {node.summary.replace(/\n/g, ' ')}
            </span>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <IconButton onClick={() => setOpenBrief((v) => !v)} title="写入本章摘要" active={openBrief} style={{ width: 24, height: 24 }}>
            <SquarePen size={13} />
          </IconButton>
          <IconButton onClick={() => actions.onGenerateBrief(node)} title="AI 生成本章章纲" style={{ width: 24, height: 24 }}>
            <Sparkles size={13} />
          </IconButton>
          {!chapter && (
            <Button size="sm" className="!h-6 !px-1.5 !text-[11px]" onClick={() => actions.onBuildChapter(node)} title="以本章标题新建章节并关联">
              建为章节
            </Button>
          )}
          <IconButton onClick={() => actions.onMove(node.id, -1)} title="上移" style={{ width: 24, height: 24 }}>
            <ArrowUp size={13} />
          </IconButton>
          <IconButton onClick={() => actions.onMove(node.id, 1)} title="下移" style={{ width: 24, height: 24 }}>
            <ArrowDown size={13} />
          </IconButton>
          <ConfirmButton label={<Trash size={13} />} title="删除本章" onConfirm={() => actions.onRemove(node.id)} className="!h-6 !w-6 !px-0" />
        </div>
      </div>

      {openBrief && (
        <div className="pl-10 pr-2 pb-2">
          <Textarea
            autoFocus
            rows={3}
            value={node.summary}
            placeholder="本章情节点：开场钩子 / 核心冲突 / 结尾悬念……（失焦自动保存）"
            onChange={(e) => actions.onPatch(node.id, { summary: e.target.value })}
            className="text-[12px]"
          />
          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {node.summary.length} 字符 · 摘要会随「大纲」一起注入给 AI
          </div>
        </div>
      )}
    </div>
  )
}