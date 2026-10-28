import type { ReactNode } from 'react'
import { KeyRound, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import type { Channel, ModelEntry } from '@shared/types'
import { PROTOCOL_LABELS } from '@shared/providers'
import { Button, Spinner, Switch } from '../../components/ui'
import { useElapsed } from '../../lib/stream'
import { MONO } from './common'

/**
 * 渠道卡片：只负责「这个渠道是什么状态」，模型列表在新增/编辑弹窗里管。
 *
 * 以前模型面板挂在卡片里、默认收起，用户配完 Key 以为就完事了；
 * 现在卡片明确写出「N 个模型 · M 个启用」，想改就点「编辑」——入口只有一个，不会漏。
 */
function ChannelCard({
  channel,
  models,
  hasKey,
  testing,
  onToggleEnabled,
  onTest,
  onEdit,
  onDelete
}: {
  channel: Channel
  models: ModelEntry[]
  /** undefined = 还在向主进程查询 */
  hasKey?: boolean
  testing: boolean
  onToggleEnabled: (v: boolean) => void
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
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
            {models.length === 0 ? (
              <span style={{ color: 'var(--warn)' }}>还没有模型，点「编辑」进去添加</span>
            ) : (
              <>
                {models.length} 个模型 · {enabledCount} 个启用
              </>
            )}
          </div>
        </div>
        <Switch checked={channel.enabled} onChange={onToggleEnabled} />
      </div>

      <div className="mt-3 flex items-center gap-1.5">
        <Button size="sm" onClick={onTest} disabled={testing || models.length === 0} type="button">
          {testing ? <Spinner size={12} /> : <RefreshCw size={13} />}
          {testing ? `测试中… ${Math.round(testElapsed / 1000)}s` : '测试连接'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit} type="button">
          <Pencil size={13} /> 编辑
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} style={{ color: 'var(--danger)' }} type="button">
          <Trash2 size={13} /> 删除
        </Button>
        <div className="flex-1" />
      </div>
    </div>
  )
}

export { ChannelCard }