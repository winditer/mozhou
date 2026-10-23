import { useState, type ReactNode } from 'react'
import { EyeOff, Plus, Trash, Users } from 'lucide-react'
import type { Character } from '@shared/types'
import { Button, EmptyState, Field, Input, Modal, Select, Switch, Textarea } from '../../../components/ui'
import { useApp } from '../../../store/app'
import { uid } from '@shared/utils'
import { ConfirmButton } from '../ConfirmButton'

function emptyCharacter(): Character {
  return {
    id: uid('ch'),
    name: '',
    role: '配角',
    age: '',
    identity: '',
    appearance: '',
    personality: '',
    motivation: '',
    flaw: '',
    arc: '',
    speechStyle: '',
    relations: [],
    hidden: false,
    notes: ''
  }
}

const ROLES = ['主角', '配角', '反派', '龙套']

export function CharactersPanel(): ReactNode {
  const project = useApp((s) => s.project)
  const patchProject = useApp((s) => s.patchProject)
  const toast = useApp((s) => s.toast)
  const [draft, setDraft] = useState<Character | null>(null)
  const characters = project?.bible.characters ?? []

  if (!project) return null

  /** 打开详情：先拷一份草稿，点「保存」才写回 store，避免误改 */
  const openEditor = (c: Character): void => {
    setDraft({ ...c, relations: c.relations.map((r) => ({ ...r })) })
  }

  const save = (): void => {
    if (!draft) return
    const next: Character = { ...draft, name: draft.name.trim() || '未命名角色' }
    patchProject((p) => ({
      ...p,
      bible: {
        ...p.bible,
        characters: p.bible.characters.some((c) => c.id === next.id)
          ? p.bible.characters.map((c) => (c.id === next.id ? next : c))
          : [...p.bible.characters, next]
      }
    }))
    setDraft(null)
    toast('角色已保存', 'ok')
  }

  const remove = (id: string): void => {
    patchProject((p) => ({ ...p, bible: { ...p.bible, characters: p.bible.characters.filter((c) => c.id !== id) } }))
    setDraft(null)
    toast('角色已删除', 'info')
  }

  const add = (): void => setDraft(emptyCharacter())

  const patchDraft = (patch: Partial<Character>): void => setDraft((d) => (d ? { ...d, ...patch } : d))

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          共 {characters.length} 人 · 标记「对 AI 隐藏」的角色不会出现在写作上下文中
        </div>
        <Button size="sm" onClick={add}>
          <Plus size={13} /> 新增角色
        </Button>
      </div>

      {characters.length === 0 ? (
        <EmptyState
          icon={<Users size={26} />}
          title="还没有角色"
          desc="先立住主角：他想要什么、怕失去什么、哪一点会把他逼到墙角。也可以让 AI 先给一版草稿，再自己改。"
          action={
            <Button size="sm" onClick={add}>
              <Plus size={13} /> 新增角色
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {characters.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => openEditor(c)}
              className="text-left rounded-md p-3 surface-hover"
              style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
            >
              <div className="flex items-center gap-2">
                <span className="truncate" style={{ fontSize: 14, fontWeight: 600 }}>
                  {c.name || '未命名角色'}
                </span>
                <span className="chip chip-accent shrink-0" style={{ height: 18, fontSize: 11 }}>
                  {c.role || '未定'}
                </span>
                {c.hidden && <EyeOff size={12} style={{ color: 'var(--text-faint)' }} className="shrink-0" />}
                <div className="flex-1" />
                <span className="text-[11px] shrink-0" style={{ color: 'var(--text-faint)' }}>
                  {c.age ? `${c.age} 岁` : ''}
                </span>
              </div>
              <div className="mt-1.5 line-clamp-1 text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {c.identity || c.personality || '暂无身份与性格描述'}
              </div>
              {c.motivation && (
                <div className="mt-1 line-clamp-1 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                  动机：{c.motivation}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        title="角色详情"
        width={760}
        footer={
          <>
            {draft && (
              <ConfirmButton
                className="mr-auto"
                label={<span className="inline-flex items-center gap-1"><Trash size={13} /> 删除角色</span>}
                confirmLabel="确认删除？"
                onConfirm={() => remove(draft.id)}
              />
            )}
            <Button onClick={() => setDraft(null)}>取消</Button>
            <Button variant="primary" onClick={save}>
              保存
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2.5">
              <Field label="姓名">
                <Input value={draft.name} onChange={(e) => patchDraft({ name: e.target.value })} placeholder="例如：沈砚" />
              </Field>
              <Field label="定位">
                <Select value={draft.role} onChange={(e) => patchDraft({ role: e.target.value })}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                  {draft.role && ROLES.indexOf(draft.role) === -1 && <option value={draft.role}>{draft.role}</option>}
                </Select>
              </Field>
              <Field label="年龄">
                <Input value={draft.age} onChange={(e) => patchDraft({ age: e.target.value })} placeholder="27 / 不详" />
              </Field>
              <Field label="身份">
                <Input value={draft.identity} onChange={(e) => patchDraft({ identity: e.target.value })} placeholder="职业、头衔、立场" />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <Field label="外貌">
                <Textarea rows={2} value={draft.appearance} onChange={(e) => patchDraft({ appearance: e.target.value })} className="text-[12.5px]" placeholder="能被一眼记住的特征" />
              </Field>
              <Field label="性格">
                <Textarea rows={2} value={draft.personality} onChange={(e) => patchDraft({ personality: e.target.value })} className="text-[12.5px]" placeholder="行为倾向，不要只写形容词" />
              </Field>
              <Field label="动机（想要什么）">
                <Textarea rows={2} value={draft.motivation} onChange={(e) => patchDraft({ motivation: e.target.value })} className="text-[12.5px]" />
              </Field>
              <Field label="缺陷（会害了他什么）">
                <Textarea rows={2} value={draft.flaw} onChange={(e) => patchDraft({ flaw: e.target.value })} className="text-[12.5px]" />
              </Field>
              <Field label="人物弧光（从…到…）">
                <Textarea rows={2} value={draft.arc} onChange={(e) => patchDraft({ arc: e.target.value })} className="text-[12.5px]" placeholder="从只顾自保 → 到愿意为人挡刀" />
              </Field>
              <Field label="说话方式">
                <Textarea rows={2} value={draft.speechStyle} onChange={(e) => patchDraft({ speechStyle: e.target.value })} className="text-[12.5px]" placeholder="句长、口癖、称呼习惯、会不会说脏话" />
              </Field>
            </div>

            <Field label="关系">
              <div className="space-y-1.5">
                {draft.relations.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={r.name}
                      onChange={(e) =>
                        patchDraft({ relations: draft.relations.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
                      }
                      className="h-[28px] py-0 text-[12px]"
                      style={{ maxWidth: 150 }}
                      placeholder="对方姓名"
                    />
                    <Input
                      value={r.desc}
                      onChange={(e) =>
                        patchDraft({ relations: draft.relations.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)) })
                      }
                      className="h-[28px] py-0 text-[12px] flex-1"
                      placeholder="关系描述：师徒 / 相互利用 / 血缘但仇视"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => patchDraft({ relations: draft.relations.filter((_, j) => j !== i) })}
                      title="移除这条关系"
                    >
                      <Trash size={12} />
                    </Button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" onClick={() => patchDraft({ relations: [...draft.relations, { name: '', desc: '' }] })}>
                  <Plus size={12} /> 添加关系
                </Button>
              </div>
            </Field>

            <div className="grid grid-cols-2 gap-2.5 items-start">
              <Field label="备注">
                <Textarea rows={2} value={draft.notes} onChange={(e) => patchDraft({ notes: e.target.value })} className="text-[12.5px]" />
              </Field>
              <div className="pt-6">
                <Switch checked={draft.hidden} onChange={(v) => patchDraft({ hidden: v })} label="对 AI 隐藏" />
                <div className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
                  打开后这个角色不会进入写作上下文。适合暂时藏起来的幕后人物，避免 AI 提前泄露身份。
                </div>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}