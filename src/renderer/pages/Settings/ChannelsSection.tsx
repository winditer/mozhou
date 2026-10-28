import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { KeyRound, Plus } from 'lucide-react'
import type { Channel, ModelEntry } from '@shared/types'
import { mz } from '../../lib/bridge'
import { Button, EmptyState } from '../../components/ui'
import { useApp } from '../../store/app'
import { ChannelCard } from './channelCard'
import { ChannelDialog } from './channelDialog'
import { clearTaskRefs } from '@shared/taskModels'
import { commitConfig, ConfirmModal, errMsg, PageHead } from './common'

/* ───────────────────────── 主区块 ───────────────────────── */

/**
 * 渠道与模型。
 *
 * 模型列表不再挂在卡片里：新增/编辑弹窗是唯一入口，渠道与它的模型一次保存。
 * 卡片只留状态与操作（测试连接 / 编辑 / 删除），用户在列表页就能判断「这个渠道能不能用」。
 */
export function ChannelsSection(): ReactNode {
  const config = useApp((s) => s.config)
  const toast = useApp((s) => s.toast)

  const [keyState, setKeyState] = useState<Record<string, boolean>>({})
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Channel | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
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
      toast('该渠道还没有启用的模型，请先编辑渠道添加模型', 'error')
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

  async function patchChannel(id: string, patch: Partial<Channel>): Promise<void> {
    await commitConfig((c) => ({ ...c, channels: c.channels.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))
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
          <Button variant="primary" size="sm" onClick={openCreate} type="button">
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
              <Button variant="primary" onClick={openCreate} type="button">
                <Plus size={14} /> 新增渠道
              </Button>
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {channels.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              models={modelsByChannel.get(channel.id) ?? []}
              hasKey={keyState[channel.id]}
              testing={testingId === channel.id}
              onToggleEnabled={(v) => void patchChannel(channel.id, { enabled: v })}
              onTest={() => void handleTest(channel)}
              onEdit={() => openEdit(channel)}
              onDelete={() => setPendingDelete(channel)}
            />
          ))}
        </div>
      )}

      <ChannelDialog
        open={dialogOpen}
        channel={editing}
        models={editing ? modelsByChannel.get(editing.id) ?? [] : []}
        hasKey={editing ? keyState[editing.id] === true : false}
        onClose={() => setDialogOpen(false)}
        onSaved={(saved, keyWritten) => {
          setKeyState((s) => ({ ...s, [saved.id]: keyWritten || Boolean(s[saved.id]) }))
        }}
      />

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