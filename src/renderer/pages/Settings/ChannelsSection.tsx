import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { KeyRound, Plus } from 'lucide-react'
import type { AppSettings, Channel, ModelEntry, TaskKind } from '@shared/types'
import { uid } from '@shared/utils'
import { mz } from '../../lib/bridge'
import { Button, EmptyState, Modal } from '../../components/ui'
import { useApp } from '../../store/app'
import { ChannelCard } from './channelCard'
import { ChannelDialog } from './channelDialog'
import { commitConfig, ConfirmModal, errMsg, MONO, PageHead } from './common'

/** 删除模型后把指向它的任务分配置空，避免留下悬空 id */
function clearTaskRefs(settings: AppSettings, removed: Set<string>): AppSettings {
  let changed = false
  const taskModels = { ...settings.taskModels }
  for (const key of Object.keys(taskModels) as TaskKind[]) {
    const id = taskModels[key]
    if (id && removed.has(id)) {
      taskModels[key] = null
      changed = true
    }
  }
  return changed ? { ...settings, taskModels } : settings
}

/* ───────────────────────── 主区块 ───────────────────────── */

export function ChannelsSection(): ReactNode {
  const config = useApp((s) => s.config)
  const toast = useApp((s) => s.toast)

  const [keyState, setKeyState] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<string[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Channel | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [pullingId, setPullingId] = useState<string | null>(null)
  const [pull, setPull] = useState<{ channel: Channel; models: string[]; picked: string[] } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Channel | null>(null)

  const channels = config?.channels ?? []
  const idsKey = channels.map((c) => c.id).join('|')

  // 进页面批量查一次 Key 状态（每个渠道一次 IPC，并行）
  useEffect(() => {
    let alive = true
    const list = useApp.getState().config?.channels ?? []
    if (list.length === 0) {
      setKeyState({})
      return
    }
    void (async () => {
      const pairs = await Promise.all(
        list.map(async (c): Promise<[string, boolean]> => {
          try {
            return [c.id, await mz.config.secretHas(`channel:${c.id}`)]
          } catch {
            return [c.id, false]
          }
        })
      )
      if (alive) setKeyState(Object.fromEntries(pairs))
    })()
    return () => {
      alive = false
    }
  }, [idsKey])

  const modelsByChannel = useMemo(() => {
    const map = new Map<string, ModelEntry[]>()
    for (const m of config?.models ?? []) {
      const list = map.get(m.channelId)
      if (list) list.push(m)
      else map.set(m.channelId, [m])
    }
    return map
  }, [config?.models])

  function openCreate(): void {
    setEditing(null)
    setDialogOpen(true)
  }

  function openEdit(channel: Channel): void {
    setEditing(channel)
    setDialogOpen(true)
  }

  async function handleTest(channel: Channel): Promise<void> {
    const cfg = useApp.getState().config
    if (!cfg) return
    const entry = cfg.models.find((m) => m.channelId === channel.id && m.enabled)
    if (!entry) {
      toast('该渠道还没有启用的模型，请先添加模型再测试', 'error')
      return
    }
    setTestingId(channel.id)
    try {
      const r = await mz.ai.test(channel, '', entry.model)
      if (r.ok) toast(`连接成功 · ${entry.model} · ${r.latencyMs ?? 0} ms`, 'ok')
      else toast(r.message ?? '连接测试失败', 'error')
    } catch (e) {
      toast(`连接测试失败：${errMsg(e)}`, 'error')
    } finally {
      setTestingId(null)
    }
  }

  async function handlePull(channel: Channel): Promise<void> {
    setPullingId(channel.id)
    try {
      const r = await mz.ai.models(channel, '')
      if (!r.ok) {
        toast(r.message ?? '拉取模型失败', 'error')
        return
      }
      const cfg = useApp.getState().config
      const existing = new Set((cfg?.models ?? []).filter((m) => m.channelId === channel.id).map((m) => m.model))
      const fresh = r.models.filter((m) => !existing.has(m))
      if (fresh.length === 0) {
        toast('接口返回的模型都已在列表中', 'info')
        return
      }
      setPull({ channel, models: fresh, picked: [...fresh] })
    } catch (e) {
      toast(`拉取模型失败：${errMsg(e)}`, 'error')
    } finally {
      setPullingId(null)
    }
  }

  async function confirmPull(): Promise<void> {
    if (!pull) return
    const { channel, picked } = pull
    const ok = await commitConfig((c) => ({
      ...c,
      models: [
        ...c.models,
        ...picked.map((model): ModelEntry => ({ id: uid('m'), channelId: channel.id, model, label: model, enabled: true }))
      ]
    }))
    if (ok) {
      toast(`已添加 ${picked.length} 个模型`, 'ok')
      setPull(null)
    }
  }

  async function patchChannel(id: string, patch: Partial<Channel>): Promise<void> {
    await commitConfig((c) => ({ ...c, channels: c.channels.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))
  }

  async function addModel(channelId: string, model: string, label: string): Promise<boolean> {
    const cfg = useApp.getState().config
    if (!cfg) return false
    const name = model.trim()
    if (!name) {
      toast('请填写模型 ID', 'error')
      return false
    }
    if (cfg.models.some((m) => m.channelId === channelId && m.model === name)) {
      toast('该模型已在列表中', 'error')
      return false
    }
    return commitConfig((c) => ({
      ...c,
      models: [...c.models, { id: uid('m'), channelId, model: name, label: label.trim() || name, enabled: true }]
    }))
  }

  async function patchModel(entryId: string, patch: Partial<ModelEntry>): Promise<void> {
    await commitConfig((c) => ({ ...c, models: c.models.map((m) => (m.id === entryId ? { ...m, ...patch } : m)) }))
  }

  async function removeModel(entryId: string): Promise<void> {
    await commitConfig((c) => ({
      ...c,
      models: c.models.filter((m) => m.id !== entryId),
      settings: clearTaskRefs(c.settings, new Set([entryId]))
    }))
  }

  async function handleDelete(channel: Channel): Promise<void> {
    setPendingDelete(null)
    const removedModels = new Set((useApp.getState().config?.models ?? []).filter((m) => m.channelId === channel.id).map((m) => m.id))
    const ok = await commitConfig((c) => ({
      ...c,
      channels: c.channels.filter((x) => x.id !== channel.id),
      models: c.models.filter((m) => m.channelId !== channel.id),
      settings: clearTaskRefs(c.settings, removedModels)
    }))
    if (!ok) return
    try {
      await mz.config.secretClear(`channel:${channel.id}`)
    } catch {
      /* Key 清理失败不影响主流程 */
    }
    setKeyState((s) => {
      const next = { ...s }
      delete next[channel.id]
      return next
    })
    toast('渠道已删除', 'ok')
  }

  return (
    <div>
      <PageHead
        title="渠道与模型"
        desc="用你自己的 API Key，墨舟不代收任何模型费用。所有请求从本机直连你填写的接口地址。"
        right={
          <Button variant="primary" size="sm" onClick={openCreate}>
            <Plus size={14} /> 新增渠道
          </Button>
        }
      />

      {channels.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<KeyRound size={26} />}
            title="还没有配置任何渠道"
            desc="添加一个渠道并填入你的 API Key，就能开始写作。推荐先用 DeepSeek 或通义千问，中文长文性价比最高。"
            action={
              <Button variant="primary" onClick={openCreate}>
                <Plus size={14} /> 新增渠道
              </Button>
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {channels.map((channel) => {
            const models = modelsByChannel.get(channel.id) ?? []
            const isOpen = expanded.includes(channel.id)
            return (
              <ChannelCard
                key={channel.id}
                channel={channel}
                models={models}
                hasKey={keyState[channel.id]}
                testing={testingId === channel.id}
                pulling={pullingId === channel.id}
                expanded={isOpen}
                onToggleExpand={() =>
                  setExpanded((list) => (list.includes(channel.id) ? list.filter((x) => x !== channel.id) : [...list, channel.id]))
                }
                onToggleEnabled={(v) => void patchChannel(channel.id, { enabled: v })}
                onTest={() => void handleTest(channel)}
                onEdit={() => openEdit(channel)}
                onDelete={() => setPendingDelete(channel)}
                onPull={() => void handlePull(channel)}
                onAddModel={(model, label) => addModel(channel.id, model, label)}
                onPatchModel={(id, patch) => void patchModel(id, patch)}
                onToggleModel={(id, enabled) => void patchModel(id, { enabled })}
                onRemoveModel={(id) => void removeModel(id)}
              />
            )
          })}
        </div>
      )}

      <ChannelDialog
        open={dialogOpen}
        channel={editing}
        hasKey={editing ? keyState[editing.id] === true : false}
        onClose={() => setDialogOpen(false)}
        onSaved={(saved, keyWritten) => {
          setKeyState((s) => ({ ...s, [saved.id]: keyWritten || Boolean(s[saved.id]) }))
        }}
      />

      <Modal
        open={Boolean(pull)}
        onClose={() => setPull(null)}
        title={`从接口拉取模型${pull ? ` · ${pull.channel.name}` : ''}`}
        width={520}
        footer={
          <>
            <Button onClick={() => setPull(null)}>取消</Button>
            <Button variant="primary" disabled={!pull || pull.picked.length === 0} onClick={() => void confirmPull()}>
              添加 {pull?.picked.length ?? 0} 个模型
            </Button>
          </>
        }
      >
        {pull && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
                接口返回 {pull.models.length} 个新模型（已在列表中的已过滤）
              </span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setPull({ ...pull, picked: [...pull.models] })}>
                  全选
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPull({ ...pull, picked: [] })}>
                  全不选
                </Button>
              </div>
            </div>
            <div className="max-h-[46vh] overflow-auto scroll-thin">
              {pull.models.map((m) => {
                const on = pull.picked.includes(m)
                return (
                  <label key={m} className="flex items-center gap-2 h-8 px-1.5 rounded-md surface-hover" style={{ cursor: 'default' }}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        setPull({ ...pull, picked: e.target.checked ? [...pull.picked, m] : pull.picked.filter((x) => x !== m) })
                      }
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    <span className="text-[12.5px] truncate selectable" style={{ fontFamily: MONO }}>
                      {m}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={Boolean(pendingDelete)}
        title="删除渠道"
        danger
        confirmText="删除渠道"
        message={
          <span>
            确定删除「{pendingDelete?.name}」吗？该渠道下的 {pendingDelete ? modelsByChannel.get(pendingDelete.id)?.length ?? 0 : 0} 个模型和已保存的 Key
            会一并移除，引用这些模型的任务分配会自动重置。作品稿件不受影响。
          </span>
        }
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void handleDelete(pendingDelete)
        }}
      />
    </div>
  )
}
