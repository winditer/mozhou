import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { Channel, ModelEntry } from '@shared/types'
import { PROTOCOL_LABELS } from '@shared/providers'
import { Button, IconButton, Input, Spinner, Switch } from '../../components/ui'
import { useElapsed } from '../../lib/stream'
import { MONO } from './common'

/* ───────────────────────── 渠道卡片 ───────────────────────── */

function ChannelCard({
  channel,
  models,
  hasKey,
  testing,
  pulling,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onTest,
  onEdit,
  onDelete,
  onPull,
  onAddModel,
  onPatchModel,
  onToggleModel,
  onRemoveModel
}: {
  channel: Channel
  models: ModelEntry[]
  /** undefined = 还在向主进程查询 */
  hasKey?: boolean
  testing: boolean
  pulling: boolean
  expanded: boolean
  onToggleExpand: () => void
  onToggleEnabled: (v: boolean) => void
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
  onPull: () => void
  onAddModel: (model: string, label: string) => Promise<boolean>
  onPatchModel: (id: string, patch: Partial<ModelEntry>) => void
  onToggleModel: (id: string, enabled: boolean) => void
  onRemoveModel: (id: string) => void
}): ReactNode {
  const testElapsed = useElapsed(testing)
  const enabledCount = models.filter((m) => m.enabled).length
  return (
    <div className="card p-4" style={{ opacity: channel.enabled ? 1 : 0.72 }}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13.5px] font-medium truncate">{channel.name}</span>
            <span className="chip">{PROTOCOL_LABELS[channel.protocol]}</span>
            <span
              className="chip"
              style={
                hasKey === undefined
                  ? undefined
                  : hasKey
                    ? { color: 'var(--ok)', borderColor: 'color-mix(in srgb, var(--ok) 32%, transparent)' }
                    : { color: 'var(--warn)', borderColor: 'color-mix(in srgb, var(--warn) 32%, transparent)' }
              }
            >
              <KeyRound size={11} />
              {hasKey === undefined ? '检查 Key…' : hasKey ? 'Key 已保存' : '未配置 Key'}
            </span>
            {!channel.enabled && <span className="chip">已停用</span>}
          </div>
          <div
            className="mt-1.5 text-[11.5px] truncate selectable"
            style={{ fontFamily: MONO, color: 'var(--text-faint)' }}
            title={channel.baseUrl}
          >
            {channel.baseUrl || '（未填写 BaseURL）'}
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            {models.length} 个模型
            {models.length > 0 && ` · ${enabledCount} 个启用`}
          </div>
        </div>
        <Switch checked={channel.enabled} onChange={onToggleEnabled} />
      </div>

      <div className="mt-3 flex items-center gap-1.5">
        <Button size="sm" onClick={onTest} disabled={testing || models.length === 0}>
          {testing ? <Spinner size={12} /> : <RefreshCw size={13} />}
          {testing ? `测试中… ${Math.round(testElapsed / 1000)}s` : '测试连接'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Pencil size={13} /> 编辑
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} style={{ color: 'var(--danger)' }}>
          <Trash2 size={13} /> 删除
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onToggleExpand}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />} 模型 {models.length}
        </Button>
      </div>

      {expanded && (
        <ModelsPanel
          models={models}
          pulling={pulling}
          onPull={onPull}
          onAddModel={onAddModel}
          onPatchModel={onPatchModel}
          onToggleModel={onToggleModel}
          onRemoveModel={onRemoveModel}
        />
      )}
    </div>
  )
}

/* ───────────────────────── 模型列表 ───────────────────────── */

function ModelsPanel({
  models,
  pulling,
  onPull,
  onAddModel,
  onPatchModel,
  onToggleModel,
  onRemoveModel
}: {
  models: ModelEntry[]
  pulling: boolean
  onPull: () => void
  onAddModel: (model: string, label: string) => Promise<boolean>
  onPatchModel: (id: string, patch: Partial<ModelEntry>) => void
  onToggleModel: (id: string, enabled: boolean) => void
  onRemoveModel: (id: string) => void
}): ReactNode {
  const [model, setModel] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(): Promise<void> {
    if (busy) return
    setBusy(true)
    const ok = await onAddModel(model, label)
    if (ok) {
      setModel('')
      setLabel('')
    }
    setBusy(false)
  }

  return (
    <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11.5px] font-medium" style={{ color: 'var(--text-dim)' }}>
          模型列表
        </span>
        <Button size="sm" variant="ghost" onClick={onPull} disabled={pulling}>
          {pulling ? <Spinner size={12} /> : <RefreshCw size={12} />}
          {pulling ? '拉取中…' : '从接口拉取'}
        </Button>
      </div>

      {models.length === 0 ? (
        <div className="py-3 text-[12px]" style={{ color: 'var(--text-faint)' }}>
          还没有模型。可以在下方手动添加，或点「从接口拉取」自动获取。
        </div>
      ) : (
        <div>
          {models.map((m) => (
            <div key={m.id} className="py-2" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="flex items-center gap-2">
                <span
                  className="flex-1 min-w-0 truncate text-[12px] selectable"
                  style={{ fontFamily: MONO }}
                  title={m.model}
                >
                  {m.model}
                </span>
                <Switch checked={m.enabled} onChange={(v) => onToggleModel(m.id, v)} />
                <IconButton onClick={() => onRemoveModel(m.id)} title="删除该模型">
                  <Trash2 size={14} />
                </IconButton>
              </div>
              <div className="mt-1.5 grid gap-1.5" style={{ gridTemplateColumns: 'minmax(0,1fr) 96px 96px 96px' }}>
                <InlineInput value={m.label} placeholder="显示名" onCommit={(v) => onPatchModel(m.id, { label: v || m.model })} />
                <InlineNumber value={m.contextWindow} placeholder="上下文" onCommit={(v) => onPatchModel(m.id, { contextWindow: v })} />
                <InlineNumber value={m.priceIn} placeholder="输入 ¥/M" onCommit={(v) => onPatchModel(m.id, { priceIn: v })} />
                <InlineNumber value={m.priceOut} placeholder="输出 ¥/M" onCommit={(v) => onPatchModel(m.id, { priceOut: v })} />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-1.5">
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          placeholder="模型 ID，例如 gpt-4.1"
          style={{ height: 28, fontSize: 12 }}
        />
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="显示名（可选）"
          style={{ height: 28, fontSize: 12, width: 140 }}
        />
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          <Plus size={13} /> 添加模型
        </Button>
      </div>
    </div>
  )
}

/* 小号内联输入：失焦或回车才提交，避免每敲一个字就写盘 */
function InlineInput({
  value,
  placeholder,
  width,
  onCommit
}: {
  value: string
  placeholder?: string
  width?: number
  onCommit: (v: string) => void
}): ReactNode {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      className="input"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.trim()
        if (next !== value) onCommit(next)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      style={{ height: 26, padding: '0 7px', fontSize: 11.5, width }}
    />
  )
}

function InlineNumber({
  value,
  placeholder,
  onCommit
}: {
  value?: number
  placeholder?: string
  onCommit: (v: number | undefined) => void
}): ReactNode {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value])
  return (
    <input
      className="input"
      value={draft}
      placeholder={placeholder}
      inputMode="decimal"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const text = draft.trim()
        if (text === '') {
          if (value !== undefined) onCommit(undefined)
          return
        }
        const n = Number(text)
        if (!Number.isFinite(n) || n < 0) {
          setDraft(value === undefined ? '' : String(value))
          return
        }
        if (n !== value) onCommit(n)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      style={{ height: 26, padding: '0 7px', fontSize: 11.5 }}
    />
  )
}

export { ChannelCard }
