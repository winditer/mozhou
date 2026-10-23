import type { ReactNode } from 'react'
import type { Project } from '@shared/types'
import { formatDateTime, formatNumber, lengthTier } from '@shared/utils'
import { getScene } from '@shared/scenes'
import { useApp } from '../../store/app'
import { Progress } from '../../components/ui'

export function StatsTab({ project }: { project: Project }): ReactNode {
  const { config } = useApp()
  const total = project.chapters.reduce((s, c) => s + c.words, 0)
  const done = project.chapters.filter((c) => c.status === 'done').length
  const target = project.settings.targetTotalWords
  const tier = lengthTier(total)
  const scene = getScene(project.sceneId)
  const avg = project.chapters.length ? Math.round(total / project.chapters.length) : 0
  const maxWords = Math.max(1, ...project.chapters.map((c) => c.words))
  const usageCost = project.usage.reduce((s, u) => s + u.cost, 0)
  const usageTokens = project.usage.reduce((s, u) => s + u.promptTokens + u.completionTokens, 0)

  const cards = [
    { label: '全书字数', value: formatNumber(total), sub: `${project.chapters.length} 章 · 篇均 ${formatNumber(avg)} 字` },
    { label: '已完结章节', value: `${done} / ${project.chapters.length}`, sub: done === project.chapters.length && done > 0 ? '全部完成 🎉' : '继续加油' },
    { label: '篇幅档位', value: tier.label, sub: scene.name },
    { label: '模型用量', value: formatNumber(usageTokens), sub: usageCost > 0 ? `估算花费 ¥${usageCost.toFixed(3)}` : '按你填写的单价估算' }
  ]

  return (
    <div className="h-full overflow-auto scroll-thin">
      <div className="max-w-[900px] mx-auto px-8 py-7">
        <h2 className="text-[15px] font-semibold mb-4">写作统计</h2>

        <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          {cards.map((c) => (
            <div key={c.label} className="card p-3.5">
              <div className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                {c.label}
              </div>
              <div className="text-[19px] font-semibold mt-1 tabular-nums">{c.value}</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                {c.sub}
              </div>
            </div>
          ))}
        </div>

        {target > 0 && (
          <div className="card p-4 mb-6">
            <div className="flex items-end justify-between mb-2">
              <div>
                <div className="text-[12px] font-medium">全书目标进度</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                  目标 {formatNumber(target)} 字 · 还差 {formatNumber(Math.max(0, target - total))} 字 · 按每章{' '}
                  {project.settings.targetWordsPerChapter} 字还需约{' '}
                  {Math.ceil(Math.max(0, target - total) / Math.max(1, project.settings.targetWordsPerChapter))} 章
                </div>
              </div>
              <div className="text-[16px] font-semibold tabular-nums" style={{ color: 'var(--accent)' }}>
                {Math.min(100, Math.round((total / target) * 100))}%
              </div>
            </div>
            <Progress value={total} max={target} height={7} />
          </div>
        )}

        <div className="card p-4 mb-6">
          <div className="text-[12px] font-medium mb-3">章节字数分布</div>
          <div className="flex flex-col gap-1.5">
            {project.chapters.map((c, i) => (
              <div key={c.id} className="flex items-center gap-2.5">
                <span className="text-[10.5px] w-5 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="text-[11.5px] truncate" style={{ width: 150, color: 'var(--text-dim)' }} title={c.title}>
                  {c.title}
                </span>
                <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--panel-2)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max(1, (c.words / maxWords) * 100)}%`, background: 'var(--accent)' }}
                  />
                </div>
                <span className="text-[11px] tabular-nums w-16 text-right" style={{ color: 'var(--text-dim)' }}>
                  {formatNumber(c.words)}
                </span>
              </div>
            ))}
            {project.chapters.length === 0 && (
              <div className="text-[12px] py-6 text-center" style={{ color: 'var(--text-faint)' }}>
                还没有章节
              </div>
            )}
          </div>
        </div>

        <div className="card p-4">
          <div className="text-[12px] font-medium mb-2">最近调用记录</div>
          {project.usage.length === 0 ? (
            <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-faint)' }}>
              还没有调用记录。生成内容后这里会显示每次用掉多少 token。
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {project.usage.slice(-12).reverse().map((u) => (
                <div key={u.id} className="flex items-center gap-3 text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                  <span style={{ width: 128 }}>{formatDateTime(u.at)}</span>
                  <span className="chip" style={{ height: 18 }}>
                    {u.task}
                  </span>
                  <span className="flex-1 truncate">{u.model}</span>
                  <span className="tabular-nums">
                    {u.promptTokens}+{u.completionTokens} tk
                  </span>
                  <span className="tabular-nums" style={{ width: 60, textAlign: 'right' }}>
                    ¥{u.cost.toFixed(4)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="text-[10.5px] mt-3" style={{ color: 'var(--text-faint)' }}>
            提示：墨舟不做任何加价，费用是按你在渠道里填写的单价本地估算的，仅供参考。
            {config?.models.length === 0 && ' 你还没有配置模型。'}
          </div>
        </div>
      </div>
    </div>
  )
}