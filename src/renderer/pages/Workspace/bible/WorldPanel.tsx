import { useState, type ReactNode } from 'react'
import { ChevronRight, Globe, Plus, Trash } from 'lucide-react'
import type { WorldCategory, WorldEntry } from '@shared/types'
import { WORLD_CATEGORY_LABELS } from '@shared/types'
import { uid } from '@shared/utils'
import { Button, EmptyState, Input, Switch, Textarea } from '../../../components/ui'
import { useApp } from '../../../store/app'
import { ConfirmButton } from '../ConfirmButton'

const ORDER: WorldCategory[] = ['world', 'power', 'faction', 'place', 'item', 'rule', 'other']

export function WorldPanel(): ReactNode {
  const project = useApp((s) => s.project)
  const patchProject = useApp((s) => s.patchProject)
  const toast = useApp((s) => s.toast)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const entries = project?.bible.world ?? []
  if (!project) return null

  const write = (next: WorldEntry[]): void => {
    patchProject((p) => ({ ...p, bible: { ...p.bible, world: next } }))
  }

  const patchEntry = (id: string, patch: Partial<WorldEntry>): void => {
    write(entries.map((w) => (w.id === id ? { ...w, ...patch } : w)))
  }

  const addEntry = (category: WorldCategory): void => {
    write([...entries, { id: uid('w'), category, title: '', content: '', visible: true }])
    setCollapsed((m) => ({ ...m, [category]: false }))
  }

  const removeEntry = (id: string): void => {
    write(entries.filter((w) => w.id !== id))
    toast('已删除该设定', 'info')
  }

  if (entries.length === 0) {
    return (
      <div>
        <EmptyState
          icon={<Globe size={26} />}
          title="设定库还是空的"
          desc="世界观、力量体系、势力、地点、物品、规则禁忌——这些是让 AI 在第 40 章还记得第 4 章的基础。可以先用 AI 补一版，再逐条改。"
          action={
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => addEntry('world')}>
                <Plus size={13} /> 手动新增
              </Button>
            </div>
          }
        />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {ORDER.map((cat) => {
        const list = entries.filter((w) => w.category === cat)
        const isCollapsed = !!collapsed[cat]
        return (
          <div key={cat}>
            <div className="flex items-center gap-1.5 h-8">
              <button
                type="button"
                onClick={() => setCollapsed((m) => ({ ...m, [cat]: !m[cat] }))}
                className="flex items-center gap-1.5 min-w-0"
              >
                <ChevronRight
                  size={13}
                  style={{ color: 'var(--text-faint)', transform: isCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform .12s' }}
                />
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{WORLD_CATEGORY_LABELS[cat]}</span>
                <span className="chip" style={{ height: 18, fontSize: 11 }}>
                  {list.length}
                </span>
              </button>
              <div className="flex-1" />
              <Button size="sm" variant="ghost" className="!h-6 !px-1.5 !text-[11px]" onClick={() => addEntry(cat)}>
                <Plus size={12} /> 新增条目
              </Button>
            </div>

            {!isCollapsed && (
              <div className="space-y-2 pl-1">
                {list.length === 0 ? (
                  <div className="text-[11.5px] pl-4 py-1" style={{ color: 'var(--text-faint)' }}>
                    暂无「{WORLD_CATEGORY_LABELS[cat]}」条目
                  </div>
                ) : (
                  list.map((w) => (
                    <div key={w.id} className="rounded-md p-2.5" style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}>
                      <div className="flex items-center gap-2">
                        <Input
                          value={w.title}
                          onChange={(e) => patchEntry(w.id, { title: e.target.value })}
                          placeholder="条目标题，例如：青云宗"
                          className="h-[28px] py-0 text-[12.5px] font-medium"
                          style={{ maxWidth: 260 }}
                        />
                        <div className="flex-1" />
                        <div className="flex items-center gap-2 shrink-0">
                          <Switch
                            checked={w.visible}
                            onChange={(v) => patchEntry(w.id, { visible: v })}
                            label={w.visible ? '对 AI 可见' : '对 AI 隐藏'}
                          />
                          <ConfirmButton
                            label={<Trash size={13} />}
                            title="删除这条设定"
                            onConfirm={() => removeEntry(w.id)}
                            className="!h-6 !w-6 !px-0"
                          />
                        </div>
                      </div>
                      <Textarea
                        rows={2}
                        value={w.content}
                        onChange={(e) => patchEntry(w.id, { content: e.target.value })}
                        placeholder="描述这条设定：它是什么、有什么代价、能怎样推动情节"
                        className="mt-1.5 text-[12.5px]"
                      />
                      {!w.visible && (
                        <div className="mt-1 text-[11px]" style={{ color: 'var(--warn)' }}>
                          关闭后 AI 写作时看不到这条设定，适合暂时隐藏的反转。
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )
      })}

      <div className="pt-1">
        <Button size="sm" variant="ghost" onClick={() => addEntry('other')} className="text-[12px]">
          <Plus size={13} /> 新增「其它」条目
        </Button>
      </div>
    </div>
  )
}