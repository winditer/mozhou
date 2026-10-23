/**
 * AI 一键开书 —— 卡片与进度条等展示组件
 *
 * 只负责「长什么样」，所有状态与请求都由 QuickStart.tsx 掌管。
 */
import type { ReactNode } from 'react'
import { AlertCircle, Check, Loader2, Plus, RotateCcw, Trash } from 'lucide-react'
import type { SettingItem, StepStatus } from './pipeline'
import { Button, IconButton, Input, Select, Textarea } from '../../../components/ui'

export const STEP_LABELS = ['书名', '设定', '大纲', '章纲', '正文'] as const

function statusText(status: StepStatus): string {
  switch (status) {
    case 'running':
      return '生成中…'
    case 'done':
      return '已完成'
    case 'error':
      return '需要处理'
    default:
      return '待生成'
  }
}

/* ───────────────────────── 五步进度 ───────────────────────── */

export function StepBar({ statuses, current }: { statuses: readonly StepStatus[]; current: number }): ReactNode {
  return (
    <div className="flex items-center gap-1">
      {STEP_LABELS.map((label, i) => {
        const step = i + 1
        const status = statuses[i] ?? 'pending'
        const active = current === step
        const done = status === 'done'
        const failed = status === 'error'
        return (
          <div key={label} className="flex items-center gap-1">
            <div
              className="flex items-center gap-1.5 px-2 rounded-full text-[11.5px]"
              style={{
                height: 24,
                background: active ? 'var(--accent-soft)' : done ? 'var(--panel-2)' : 'transparent',
                color: active ? 'var(--accent)' : done ? 'var(--text)' : 'var(--text-faint)',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                fontWeight: active ? 600 : 400
              }}
            >
              <span className="inline-flex items-center justify-center" style={{ width: 10 }}>
                {done ? (
                  <Check size={11} />
                ) : status === 'running' ? (
                  <Loader2 size={10} className="spin" />
                ) : failed ? (
                  <AlertCircle size={11} style={{ color: 'var(--danger)' }} />
                ) : (
                  <span>{step}</span>
                )}
              </span>
              {label}
            </div>
            {i < STEP_LABELS.length - 1 && (
              <span style={{ width: 8, height: 1, background: 'var(--border-strong)' }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ───────────────────────── 产物卡外框 ───────────────────────── */

export interface CardShellProps {
  index: number
  title: string
  status: StepStatus
  desc?: string
  actions?: ReactNode
  error?: string
  raw?: string
  onRawChange?: (value: string) => void
  onReparse?: () => void
  children?: ReactNode
  footer?: ReactNode
}

export function CardShell({
  index,
  title,
  status,
  desc,
  actions,
  error,
  raw,
  onRawChange,
  onReparse,
  children,
  footer
}: CardShellProps): ReactNode {
  const done = status === 'done'
  return (
    <div className="card p-4 mb-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="shrink-0 inline-flex items-center justify-center rounded-full text-[11px]"
            style={{
              width: 20,
              height: 20,
              background: done ? 'var(--accent)' : 'var(--panel-2)',
              color: done ? 'var(--accent-text)' : 'var(--text-dim)',
              border: `1px solid ${done ? 'var(--accent)' : 'var(--border)'}`
            }}
          >
            {done ? <Check size={12} /> : index}
          </span>
          <div className="text-[13.5px] font-semibold truncate">{title}</div>
          <span
            className="shrink-0 text-[11px]"
            style={{
              color:
                status === 'error' ? 'var(--danger)' : status === 'running' ? 'var(--accent)' : 'var(--text-faint)'
            }}
          >
            {statusText(status)}
          </span>
        </div>
        {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
      </div>

      {desc && (
        <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          {desc}
        </div>
      )}

      {error && (
        <div className="mt-2 flex items-start gap-1.5 text-[12px]" style={{ color: 'var(--danger)' }}>
          <AlertCircle size={13} className="shrink-0" style={{ marginTop: 1 }} />
          <span className="leading-relaxed">{error}</span>
        </div>
      )}

      {status === 'error' && onRawChange && (
        <div className="mt-2">
          <div className="label">模型原始输出（可手工改成 JSON 或「标题：内容」后重新解析）</div>
          <Textarea
            value={raw ?? ''}
            onChange={(e) => onRawChange(e.target.value)}
            rows={6}
            style={{ fontFamily: 'var(--editor-font)', fontSize: 12 }}
          />
          {onReparse && (
            <div className="mt-1.5">
              <Button size="sm" onClick={onReparse} type="button">
                <RotateCcw size={12} />
                重新解析
              </Button>
            </div>
          )}
        </div>
      )}

      {children && <div className="mt-3">{children}</div>}
      {footer && <div className="mt-3 flex items-center justify-between gap-2">{footer}</div>}
    </div>
  )
}

/* ───────────────────────── 流式预览 ───────────────────────── */

export function StreamBox({ text }: { text: string }): ReactNode {
  return (
    <div
      className="rounded-md p-2.5 text-[12px] scroll-thin selectable"
      style={{
        maxHeight: 160,
        overflow: 'auto',
        background: 'var(--panel-2)',
        border: '1px solid var(--border)',
        color: text ? 'var(--text-dim)' : 'var(--text-faint)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'var(--editor-font)',
        lineHeight: 1.7
      }}
    >
      {text || '正在等待模型返回…'}
    </div>
  )
}

/** 首章正文只读预览 */
export function DraftPreview({ text }: { text: string }): ReactNode {
  return (
    <div
      className="rounded-md p-4 scroll-thin selectable"
      style={{
        maxHeight: 340,
        overflow: 'auto',
        background: 'var(--editor-bg)',
        border: '1px solid var(--border)',
        fontFamily: 'var(--editor-font)',
        fontSize: 15,
        lineHeight: 1.85,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: text ? 'var(--editor-text)' : 'var(--text-faint)'
      }}
    >
      {text || '还没有正文，点「生成正文」开始写。'}
    </div>
  )
}

/* ───────────────────────── 可编辑条目 ───────────────────────── */

export function SettingRow({
  item,
  onChange,
  onRemove
}: {
  item: SettingItem
  onChange: (patch: Partial<SettingItem>) => void
  onRemove: () => void
}): ReactNode {
  return (
    <div className="rounded-lg p-2 mb-1.5" style={{ border: '1px solid var(--border)', background: 'var(--panel-2)' }}>
      <div className="flex items-center gap-1.5">
        <Input
          value={item.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="设定标题"
          style={{ height: 28, fontSize: 12.5 }}
        />
        <Select
          value={item.kind}
          onChange={(e) => onChange({ kind: e.target.value === 'character' ? 'character' : 'world' })}
          style={{ width: 92, height: 28, fontSize: 12 }}
          aria-label="条目类型"
        >
          <option value="world">世界观</option>
          <option value="character">角色</option>
        </Select>
        <IconButton onClick={onRemove} aria-label="删除这条设定">
          <Trash size={13} />
        </IconButton>
      </div>
      <Textarea
        value={item.content}
        onChange={(e) => onChange({ content: e.target.value })}
        rows={2}
        placeholder="设定内容"
        className="mt-1.5"
        style={{ fontSize: 12.5 }}
      />
    </div>
  )
}

/** 卷 / 章这类「标题 + 一句话概要」的行 */
export function LineRow({
  title,
  summary,
  onTitle,
  onSummary,
  onRemove,
  summaryRows = 1,
  placeholder
}: {
  title: string
  summary: string
  onTitle: (value: string) => void
  onSummary: (value: string) => void
  onRemove: () => void
  summaryRows?: number
  placeholder?: string
}): ReactNode {
  return (
    <div className="rounded-lg p-2 mb-1.5" style={{ border: '1px solid var(--border)', background: 'var(--panel-2)' }}>
      <div className="flex items-center gap-1.5">
        <Input
          value={title}
          onChange={(e) => onTitle(e.target.value)}
          placeholder={placeholder ?? '标题'}
          style={{ height: 28, fontSize: 12.5 }}
        />
        <IconButton onClick={onRemove} aria-label="删除">
          <Trash size={13} />
        </IconButton>
      </div>
      <Textarea
        value={summary}
        onChange={(e) => onSummary(e.target.value)}
        rows={summaryRows}
        placeholder="一句话概要"
        className="mt-1.5"
        style={{ fontSize: 12.5 }}
      />
    </div>
  )
}

/** 虚线「添加一条」按钮 */
export function AddRow({ label, onClick }: { label: string; onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center justify-center gap-1.5 rounded-lg text-[12px]"
      style={{
        height: 30,
        border: '1px dashed var(--border-strong)',
        background: 'transparent',
        color: 'var(--text-faint)',
        cursor: 'default'
      }}
    >
      <Plus size={12} />
      {label}
    </button>
  )
}

/* ───────────────────────── token 估算 ───────────────────────── */

export function TokenUsage({ tokens }: { tokens: number }): ReactNode {
  const text = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
  return (
    <span className="text-[11.5px] shrink-0" style={{ color: 'var(--text-faint)' }}>
      已用 ≈ {text} tokens
    </span>
  )
}