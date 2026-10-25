import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import type { Project } from '@shared/types'
import { Button } from '../../../components/ui'
import type { AuditIssue, IssueLevel } from './parse'

const SEVERITY: Record<IssueLevel, { color: string; label: string }> = {
  high: { color: 'var(--danger)', label: '高' },
  medium: { color: 'var(--warn)', label: '中' },
  low: { color: 'var(--text-faint)', label: '低' }
}

export const SEVERITY_COLOR: Record<IssueLevel, string> = {
  high: 'var(--danger)',
  medium: 'var(--warn)',
  low: 'var(--text-faint)'
}

export function IssueCard({
  issue,
  project,
  onJump,
  onIgnore,
  onApply,
  hideChapters
}: {
  issue: AuditIssue
  project: Project
  onJump: (chapterId: string) => void
  onIgnore?: () => void
  /**
   * 把建议真正落到正文上。传了它，「采用」才是一个能用的按钮。
   *
   * 全书一致性和章节体检都传：全书体检的证据虽然摘自章节梗概、和正文不是
   * 一字不差，但可以按相似度在涉及章节里找候选段落，多章问题则一次统一口径。
   * 定位结果一律先给作者看对比、逐段可跳过，所以「猜」不会变成「乱改」。
   */
  onApply?: (issue: AuditIssue) => void
  /** 单章体检时涉及章节只有一个，重复展示没有信息量 */
  hideChapters?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const sev = SEVERITY[issue.level]
  const chapters = issue.chapterIds
    .map((id) => project.chapters.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))

  return (
    <div className="flex overflow-hidden" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--panel)' }}>
      {/* 左侧严重度竖条 */}
      <div style={{ flex: '0 0 3px', background: sev.color }} />

      <div className="flex-1 min-w-0 p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 mb-1 flex-wrap">
              <span
                className="chip"
                style={{
                  height: 18,
                  padding: '0 6px',
                  fontSize: 10.5,
                  color: sev.color,
                  borderColor: `color-mix(in srgb, ${sev.color} 35%, transparent)`,
                  background: `color-mix(in srgb, ${sev.color} 10%, transparent)`
                }}
              >
                {sev.label}
              </span>
              {issue.type && (
                <span className="chip" style={{ height: 18, padding: '0 6px', fontSize: 10.5 }}>
                  {issue.type}
                </span>
              )}
            </div>
            <div className="text-[13px] font-medium leading-snug">{issue.title}</div>
            {issue.detail && issue.detail !== issue.title && (
              <div className="text-[12px] mt-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                {issue.detail}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {issue.suggestion && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setOpen((v) => !v)}
                title={open ? '收起建议' : '查看建议'}
              >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                建议
              </Button>
            )}
            {issue.suggestion && onApply && (
              <Button size="sm" variant="primary" onClick={() => onApply(issue)} title="按这条建议改写正文（会先给你看对比）">
                <Check size={12} /> 采用
              </Button>
            )}
            {onIgnore && (
              <Button size="sm" variant="ghost" onClick={onIgnore} title="忽略这条（只影响当前列表）">
                <X size={12} />
              </Button>
            )}
          </div>
        </div>

        {/* 证据：等宽小字，最多 3 行 */}
        {issue.evidence && (
          <div
            className="mt-2 rounded-md px-2 py-1.5 line-clamp-3"
            style={{
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
              fontFamily: "'SF Mono', ui-monospace, Menlo, Consolas, monospace",
              fontSize: 11,
              lineHeight: 1.6,
              color: 'var(--text-dim)',
              userSelect: 'text'
            }}
            title={issue.evidence}
          >
            “{issue.evidence}”
          </div>
        )}

        {/* 涉及章节 */}
        {!hideChapters && chapters.length > 0 && (
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
              涉及
            </span>
            {chapters.map((c) => (
              <button
                key={c.id}
                className="chip surface-hover"
                style={{ height: 20, padding: '0 7px', fontSize: 10.5, cursor: 'default' }}
                onClick={() => onJump(c.id)}
                title={`跳到《${c.title}》`}
              >
                {c.title}
              </button>
            ))}
          </div>
        )}

        {/* 采纳建议：展开区 */}
        {open && issue.suggestion && (
          <div
            className="mt-2 rounded-md px-2.5 py-2"
            style={{
              background: 'var(--accent-soft)',
              border: '1px solid color-mix(in srgb, var(--accent) 22%, transparent)'
            }}
          >
            <div className="flex items-center gap-1 mb-1 text-[10.5px] font-medium" style={{ color: 'var(--accent)' }}>
              <Check size={11} /> 修改建议
            </div>
            <div className="text-[12px] leading-relaxed selectable" style={{ color: 'var(--text)' }}>
              {issue.suggestion}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}