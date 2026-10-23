import type { ReactNode } from 'react'
import { Flag, Plus, Trash } from 'lucide-react'
import type { Thread } from '@shared/types'
import { uid } from '@shared/utils'
import { Button, EmptyState, Input, Segmented, Textarea } from '../../../components/ui'
import { useApp } from '../../../store/app'
import { ConfirmButton } from '../ConfirmButton'

export function ThreadsPanel(): ReactNode {
  const project = useApp((s) => s.project)
  const patchProject = useApp((s) => s.patchProject)
  if (!project) return null

  const threads = project.bible.threads
  const write = (next: Thread[]): void => {
    patchProject((p) => ({ ...p, bible: { ...p.bible, threads: next } }))
  }
  const patchThread = (id: string, patch: Partial<Thread>): void => {
    write(threads.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }
  const add = (): void => {
    write([...threads, { id: uid('th'), title: '', setup: '', payoff: '', status: 'open', level: 'main' }])
  }

  const open = threads.filter((t) => t.status === 'open').length
  const ordered = [...threads].sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1))

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          共 {threads.length} 条 · <span style={{ color: 'var(--warn)' }}>{open} 条未回收</span>
        </div>
        <Button size="sm" onClick={add}>
          <Plus size={13} /> 新增伏笔
        </Button>
      </div>

      {threads.length === 0 ? (
        <EmptyState
          icon={<Flag size={26} />}
          title="还没有伏笔台账"
          desc="埋了什么、打算什么时候回收。未回收的会一直挂在列表顶部提醒你，避免写到结尾才发现有坑没填。"
          action={
            <Button size="sm" onClick={add}>
              <Plus size={13} /> 新增伏笔
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {ordered.map((t) => (
            <div
              key={t.id}
              className="rounded-md p-2.5"
              style={{
                background: 'var(--panel)',
                border: '1px solid var(--border)',
                borderLeft: t.status === 'open' ? '3px solid var(--warn)' : '1px solid var(--border)'
              }}
            >
              <div className="flex items-center gap-2">
                <Input
                  value={t.title}
                  onChange={(e) => patchThread(t.id, { title: e.target.value })}
                  placeholder="伏笔：例如 老槐树的年轮刻痕"
                  className="h-[28px] py-0 text-[12.5px] font-medium flex-1"
                />
                <Segmented
                  value={t.level}
                  options={[
                    { value: 'main', label: '主线' },
                    { value: 'sub', label: '支线' }
                  ]}
                  onChange={(v) => patchThread(t.id, { level: v })}
                />
                <Segmented
                  value={t.status}
                  options={[
                    { value: 'open', label: '未回收' },
                    { value: 'closed', label: '已回收' }
                  ]}
                  onChange={(v) => patchThread(t.id, { status: v })}
                />
                <ConfirmButton
                  label={<Trash size={13} />}
                  title="删除这条伏笔"
                  onConfirm={() => write(threads.filter((x) => x.id !== t.id))}
                  className="!h-6 !w-6 !px-0"
                />
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[11px] mb-1" style={{ color: 'var(--text-faint)' }}>
                    埋设
                  </div>
                  <Textarea
                    rows={2}
                    value={t.setup}
                    onChange={(e) => patchThread(t.id, { setup: e.target.value })}
                    placeholder="在第几章、以什么形式出现"
                    className="text-[12px]"
                  />
                </div>
                <div>
                  <div className="text-[11px] mb-1" style={{ color: 'var(--text-faint)' }}>
                    回收计划
                  </div>
                  <Textarea
                    rows={2}
                    value={t.payoff}
                    onChange={(e) => patchThread(t.id, { payoff: e.target.value })}
                    placeholder="打算在哪一卷、怎么解释"
                    className="text-[12px]"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}