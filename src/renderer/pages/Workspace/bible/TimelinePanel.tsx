import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, Clock, Plus, Trash } from 'lucide-react'
import type { TimelineEvent } from '@shared/types'
import { uid } from '@shared/utils'
import { Button, EmptyState, Input } from '../../../components/ui'
import { useApp } from '../../../store/app'
import { ConfirmButton } from '../ConfirmButton'

/** 以数组下标为依据交换两个元素，保证“上移/下移”在按 time 排序后依然符合直觉 */
function swap(list: TimelineEvent[], a: number, b: number): TimelineEvent[] {
  if (a < 0 || b < 0 || a >= list.length || b >= list.length) return list
  const next = [...list]
  const tmp = next[a]!
  next[a] = next[b]!
  next[b] = tmp
  return next
}

export function TimelinePanel(): ReactNode {
  const project = useApp((s) => s.project)
  const patchProject = useApp((s) => s.patchProject)
  if (!project) return null

  const events = project.bible.timeline
  const write = (next: TimelineEvent[]): void => {
    patchProject((p) => ({ ...p, bible: { ...p.bible, timeline: next } }))
  }

  const ordered = [...events].sort((a, b) => (a.time || '').localeCompare(b.time || ''))
  const indexOf = (id: string): number => events.findIndex((e) => e.id === id)

  const move = (id: string, dir: -1 | 1): void => {
    const i = indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= events.length) return
    write(swap(events, i, j))
  }

  const patchEvent = (id: string, patch: Partial<TimelineEvent>): void => {
    write(events.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  }

  const add = (): void => {
    write([...events, { id: uid('tl'), time: '', title: '', desc: '' }])
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          按时间排序显示 · 共 {events.length} 个节点（时间可写“第 3 天 / 三年前 / 玄历 412 年”）
        </div>
        <Button size="sm" onClick={add}>
          <Plus size={13} /> 新增节点
        </Button>
      </div>

      {events.length === 0 ? (
        <EmptyState
          icon={<Clock size={26} />}
          title="还没有时间线"
          desc="把关键事件按先后记下来。写到现在时，AI 能靠它判断“这件事到底发生了没有”，减少时间线打架。"
          action={
            <Button size="sm" onClick={add}>
              <Plus size={13} /> 新增节点
            </Button>
          }
        />
      ) : (
        <div className="space-y-1.5">
          {ordered.map((e, idx) => (
            <div
              key={e.id}
              className="flex items-start gap-2 rounded-md p-2.5"
              style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
            >
              <div className="shrink-0 flex flex-col items-center gap-1 pt-0.5">
                <span
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] tabular-nums"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                >
                  {idx + 1}
                </span>
                <div className="w-px flex-1" style={{ background: 'var(--border)' }} />
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex items-center gap-2">
                  <Input
                    value={e.time}
                    onChange={(ev) => patchEvent(e.id, { time: ev.target.value })}
                    placeholder="时间点"
                    className="h-[27px] py-0 text-[12px]"
                    style={{ maxWidth: 150 }}
                  />
                  <Input
                    value={e.title}
                    onChange={(ev) => patchEvent(e.id, { title: ev.target.value })}
                    placeholder="发生了什么"
                    className="h-[27px] py-0 text-[12.5px] flex-1 font-medium"
                  />
                  <div className="shrink-0 flex items-center gap-0.5">
                    <Button size="sm" variant="ghost" className="!h-6 !w-6 !px-0" onClick={() => move(e.id, -1)} title="上移">
                      <ArrowUp size={12} />
                    </Button>
                    <Button size="sm" variant="ghost" className="!h-6 !w-6 !px-0" onClick={() => move(e.id, 1)} title="下移">
                      <ArrowDown size={12} />
                    </Button>
                    <ConfirmButton
                      label={<Trash size={12} />}
                      title="删除该节点"
                      onConfirm={() => write(events.filter((x) => x.id !== e.id))}
                      className="!h-6 !w-6 !px-0"
                    />
                  </div>
                </div>
                <Input
                  value={e.desc}
                  onChange={(ev) => patchEvent(e.id, { desc: ev.target.value })}
                  placeholder="补充说明：谁在场、后果是什么"
                  className="h-[27px] py-0 text-[11.5px]"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}