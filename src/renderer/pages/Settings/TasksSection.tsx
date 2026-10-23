import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { TASK_LABELS, type TaskKind } from '@shared/types'
import { Button, Select } from '../../components/ui'
import { useApp } from '../../store/app'
import { isChannelUsable, LoadingHint, PageHead, patchSettingsSafe } from './common'

/** 展示顺序：按「先写什么」排列，而不是按类型定义顺序 */
const TASK_ORDER: TaskKind[] = ['draft', 'outline', 'polish', 'naming', 'summary', 'audit', 'chat']

const TASK_DESC: Record<TaskKind, string> = {
  draft: '生成、续写正文时使用的模型，长篇主力',
  outline: '推演卷章结构、大纲与节拍',
  polish: '润色、改写、扩写选中段落',
  naming: '角色、地点、功法、招式取名',
  summary: '章节摘要与滚动摘要压缩',
  audit: '一致性审校、设定冲突检查',
  chat: '右侧对话助手的自由问答'
}

export function TasksSection(): ReactNode {
  const config = useApp((s) => s.config)
  const toast = useApp((s) => s.toast)

  if (!config) return <LoadingHint />

  // 只列「模型启用 + 所属渠道启用且有地址」的模型，避免选到用不了的
  const usable = config.models.filter((m) => m.enabled && isChannelUsable(config, m.channelId))
  const channelName = (id: string): string => config.channels.find((c) => c.id === id)?.name ?? '未知渠道'
  const taskModels = config.settings.taskModels

  async function setTaskModel(task: TaskKind, value: string): Promise<void> {
    const ok = await patchSettingsSafe({ taskModels: { ...taskModels, [task]: value || null } })
    if (ok) toast('任务分配已保存', 'ok')
  }

  /** 与主进程 resolveTaskModel 同口径：未指定则回落到正文模型，再回落到第一个可用模型 */
  function effectiveLabel(task: TaskKind): string {
    const preferred = taskModels[task]
    const picked = preferred ? usable.find((m) => m.id === preferred) : undefined
    const entry = picked ?? usable.find((m) => m.id === taskModels.draft) ?? usable[0]
    return entry ? entry.label : '未配置'
  }

  return (
    <div>
      <PageHead
        title="任务分配"
        desc="不同写作任务可以指定不同模型：长文用便宜的大模型，取名和审校用小模型，费用能差好几倍。"
      />

      {usable.length === 0 ? (
        <div
          className="card p-4 flex items-start gap-2.5 text-[12.5px] leading-relaxed mb-4"
          style={{ color: 'var(--warn)' }}
        >
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <span>还没有可用的模型。请先到「渠道与模型」里添加渠道、填入 Key 并启用至少一个模型。</span>
        </div>
      ) : null}

      <div className="card px-4 py-2 mb-3">
        {TASK_ORDER.map((task, i) => {
          const stored = taskModels[task] ?? ''
          const valid = usable.some((m) => m.id === stored) ? stored : ''
          const isDraft = task === 'draft'
          return (
            <div
              key={task}
              className="flex items-center justify-between gap-6 py-2.5"
              style={i === 0 ? undefined : { borderTop: '1px solid var(--border)' }}
            >
              <div className="min-w-0">
                <div className="text-[13px] flex items-center gap-2">
                  {TASK_LABELS[task]}
                  {isDraft && (
                    <span className="chip chip-accent" style={{ height: 18 }}>
                      必选
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
                  {TASK_DESC[task]}
                </div>
              </div>
              <div style={{ width: 240 }} className="shrink-0">
                <Select
                  value={valid}
                  onChange={(e) => void setTaskModel(task, e.target.value)}
                  disabled={usable.length === 0}
                >
                  {isDraft ? (
                    <option value="">请选择正文模型</option>
                  ) : (
                    <option value="">跟随正文模型</option>
                  )}
                  {usable.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} · {channelName(m.channelId)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          )
        })}
      </div>

      <div className="card p-4">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-[12.5px] font-medium">当前生效组合</span>
          <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            未单独指定的任务都跟随正文模型
          </span>
        </div>
        <div className="grid gap-x-8 gap-y-1.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
          {TASK_ORDER.map((task) => (
            <div key={task} className="flex items-center justify-between gap-3 text-[12px]">
              <span style={{ color: 'var(--text-faint)' }}>{TASK_LABELS[task]}</span>
              <span className="truncate" style={{ color: usable.length === 0 ? 'var(--warn)' : 'var(--text)' }}>
                {effectiveLabel(task)}
              </span>
            </div>
          ))}
        </div>
        {usable.length > 0 && !taskModels.draft && (
          <div className="mt-3 flex items-center gap-2 text-[11.5px]" style={{ color: 'var(--warn)' }}>
            <AlertTriangle size={12} />
            「正文生成」还没有明确指定，当前临时使用第一个可用模型。
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void setTaskModel('draft', usable[0]?.id ?? '')}
              style={{ color: 'var(--accent)' }}
            >
              使用「{usable[0]?.label}」
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}