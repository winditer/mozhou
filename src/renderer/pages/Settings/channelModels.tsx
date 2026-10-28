import { useEffect, useState, type ReactNode } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { Channel, ModelEntry } from '@shared/types'
import { uid } from '@shared/utils'
import { mz } from '../../lib/bridge'
import { Button, IconButton, Input, Spinner, Switch } from '../../components/ui'
import { useApp } from '../../store/app'
import { errMsg, MONO } from './common'

/**
 * 模型列表编辑器（渠道新增 / 编辑弹窗内使用）。
 *
 * 为什么从渠道卡片搬进来：模型是渠道的一部分（换渠道就得换模型），
 * 以前它藏在卡片里一个默认收起的「模型 N」按钮后面，用户配完 Key 根本不知道还要再展开一次。
 *
 * 这里所有增删改都只改内存里的 staged 数组，点「保存」时才和渠道一起落盘——
 * 中途取消不该在配置里留下半成品。
 */
export function ChannelModels({
  channel,
  models,
  apiKey,
  onChange
}: {
  /** 表单当前值拼出来的渠道（用于拉取模型列表，尚未落盘也要能拉） */
  channel: Channel
  models: ModelEntry[]
  /** 弹窗里刚输入的 Key；留空则回落到钥匙串里已保存的那把 */
  apiKey: string
  onChange: (next: ModelEntry[]) => void
}): ReactNode {
  const toast = useApp((s) => s.toast)
  const [model, setModel] = useState('')
  const [label, setLabel] = useState('')
  const [pulling, setPulling] = useState(false)
  const [candidates, setCandidates] = useState<string[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])

  // 关掉弹窗时组件会卸载；这里只负责把「拉取中」的候选清空，避免下次打开看到上次的结果
  useEffect(() => {
    setCandidates(null)
    setPicked([])
  }, [channel.id])

  const has = (name: string): boolean => models.some((m) => m.model === name)

  function addModels(names: string[]): void {
    const fresh = names.filter((n) => !has(n)).map(
      (n): ModelEntry => ({ id: uid('m'), channelId: channel.id, model: n, label: n, enabled: true })
    )
    if (fresh.length === 0) {
      toast('这些模型已经在列表里了', 'info')
      return
    }
    onChange([...models, ...fresh])
    toast(`已加入 ${fresh.length} 个模型，点「保存」后生效`, 'ok')
  }

  function submitManual(): void {
    const name = model.trim()
    if (!name) {
      toast('请填写模型 ID', 'error')
      return
    }
    if (has(name)) {
      toast('该模型已在列表中', 'error')
      return
    }
    onChange([
      ...models,
      { id: uid('m'), channelId: channel.id, model: name, label: label.trim() || name, enabled: true }
    ])
    setModel('')
    setLabel('')
  }

  async function pull(): Promise<void> {
    if (pulling) return
    if (!channel.baseUrl.trim() && channel.protocol !== 'gemini') {
      toast('请先填写 BaseURL，再拉取模型列表', 'error')
      return
    }
    setPulling(true)
    try {
      const r = await mz.ai.models(channel, apiKey.trim())
      if (!r.ok) {
        toast(r.message ?? '拉取模型失败', 'error')
        return
      }
      const fresh = r.models.filter((m) => !has(m))
      if (fresh.length === 0) {
        toast('接口返回的模型都已在列表中', 'info')
        return
      }
      setCandidates(fresh)
      setPicked([...fresh])
    } catch (e) {
      toast(`拉取模型失败：${errMsg(e)}`, 'error')
    } finally {
      setPulling(false)
    }
  }

  function patch(id: string, next: Partial<ModelEntry>): void {
    onChange(models.map((m) => (m.id === id ? { ...m, ...next } : m)))
  }

  return (
    <div className="rounded-lg" style={{ border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[12.5px] font-medium">模型列表</span>
          <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {models.length === 0 ? '还没有模型' : `${models.length} 个 · ${models.filter((m) => m.enabled).length} 个启用`}
          </span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void pull()} disabled={pulling} type="button">
          {pulling ? <Spinner size={12} /> : <RefreshCw size={12} />}
          {pulling ? '拉取中…' : '从接口拉取'}
        </Button>
      </div>

      {models.length === 0 ? (
        <div className="px-3 py-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          填一个模型 ID 就能用。不知道叫什么，可以先保存渠道，再回来点「从接口拉取」自动获取。
        </div>
      ) : (
        <div>
          {models.map((m) => (
            <div key={m.id} className="px-3 py-2" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate text-[12px] selectable" style={{ fontFamily: MONO }} title={m.model}>
                  {m.model}
                </span>
                {!m.enabled && (
                  <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                    已停用
                  </span>
                )}
                <Switch checked={m.enabled} onChange={(v) => patch(m.id, { enabled: v })} />
                <IconButton onClick={() => onChange(models.filter((x) => x.id !== m.id))} title="从列表移除该模型">
                  <Trash2 size={14} />
                </IconButton>
              </div>
              <div className="mt-1.5 grid gap-1.5" style={{ gridTemplateColumns: 'minmax(0,1fr) 96px 96px 96px' }}>
                <InlineInput value={m.label} placeholder="显示名" onCommit={(v) => patch(m.id, { label: v || m.model })} />
                <InlineNumber value={m.contextWindow} placeholder="上下文" onCommit={(v) => patch(m.id, { contextWindow: v })} />
                <InlineNumber value={m.priceIn} placeholder="输入 ¥/M" onCommit={(v) => patch(m.id, { priceIn: v })} />
                <InlineNumber value={m.priceOut} placeholder="输出 ¥/M" onCommit={(v) => patch(m.id, { priceOut: v })} />
              </div>
            </div>
          ))}
        </div>
      )}

      {candidates && (
        <div className="px-3 py-2" style={{ borderTop: '1px solid var(--border)', background: 'var(--panel-2)' }}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
              接口返回 {candidates.length} 个新模型
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setPicked([...candidates])} type="button">
                全选
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPicked([])} type="button">
                全不选
              </Button>
            </div>
          </div>
          <div className="max-h-[168px] overflow-auto scroll-thin">
            {candidates.map((name) => {
              const on = picked.includes(name)
              return (
                <label key={name} className="flex items-center gap-2 h-7 px-1 rounded-md surface-hover" style={{ cursor: 'default' }}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, name] : picked.filter((x) => x !== name))}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  <span className="text-[12px] truncate selectable" style={{ fontFamily: MONO }}>
                    {name}
                  </span>
                </label>
              )
            })}
          </div>
          <div className="flex items-center justify-end gap-2 mt-1.5">
            <Button size="sm" variant="ghost" onClick={() => setCandidates(null)} type="button">
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={picked.length === 0}
              onClick={() => {
                addModels(picked)
                setCandidates(null)
                setPicked([])
              }}
              type="button"
            >
              加入 {picked.length} 个
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5 px-3 py-2" style={{ borderTop: '1px solid var(--border)' }}>
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitManual()
          }}
          placeholder="模型 ID，例如 deepseek-flash"
          style={{ height: 28, fontSize: 12 }}
        />
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitManual()
          }}
          placeholder="显示名（可选）"
          style={{ height: 28, fontSize: 12, width: 130 }}
        />
        <Button size="sm" onClick={submitManual} type="button">
          <Plus size={13} /> 添加
        </Button>
      </div>
    </div>
  )
}

/* ───────────────────────── 小号内联输入 ───────────────────────── */

/** 失焦或回车才提交，避免每敲一个字就重排整个列表 */
function InlineInput({
  value,
  placeholder,
  onCommit
}: {
  value: string
  placeholder?: string
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
      style={{ height: 26, padding: '0 7px', fontSize: 11.5 }}
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