import { useMemo, useState, type ReactNode } from 'react'
import type { Project, StyleProfile } from '@shared/types'
import type { StyleCategory, StylePersona } from '@shared/styleLibrary'
import {
  CATEGORY_LABELS,
  STYLE_CATEGORIES,
  categoryColor,
  filterPersonas,
  personaToRef,
  tagCounts
} from '@shared/styleLibrary'
import { uid } from '@shared/utils'
import { useApp } from '../../../store/app'
import { Button, EmptyState, Input, Modal, Select } from '../../../components/ui'
import { Check, Copy, LibraryBig, Search, X } from 'lucide-react'

/**
 * 「从系统文风分身库添加」弹窗。
 *
 * 关键语义：这里是**引用**，不是拷贝。书里存 `sourceRef.sourceId`，
 * 生成时回系统库取当前值，所以设置页里改了某位作家的特征，所有引用它的书立刻生效。
 *
 * 为什么要 `personaToRef` 同时写一份快照：系统库里那位被删掉时，
 * 书不能因此变成裸写——快照让「已失效的引用」仍然可用，UI 上标红提示即可。
 */
export function LibraryPicker({
  open,
  project,
  onClose
}: {
  open: boolean
  project: Project
  onClose: () => void
}): ReactNode {
  const { styleLibrary, patchProject, toast, setView } = useApp()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<StyleCategory | 'all'>('all')
  const [picked, setPicked] = useState<StylePersona | null>(null)
  const [copyMode, setCopyMode] = useState(false)

  const personas = styleLibrary?.personas ?? []
  const shown = useMemo(() => filterPersonas(personas, { query, category }), [personas, query, category])
  const tags = useMemo(() => tagCounts(filterPersonas(personas, { category })).slice(0, 14), [personas, category])
  const boundIds = useMemo(
    () => new Set(project.styleProfiles.map((p) => p.sourceRef?.sourceId).filter(Boolean) as string[]),
    [project.styleProfiles]
  )

  const reset = (): void => {
    setQuery('')
    setCategory('all')
    setPicked(null)
    setCopyMode(false)
  }

  /**
   * 引用：active 由用户在书内决定，这里默认绑定（符合「添加就是为了用」的直觉）；
   * 已有别的分身生效时顶掉它——和 StyleTab 里开关的语义保持一致。
   */
  const add = (p: StylePersona, asCopy: boolean, bind: boolean): void => {
    const { ref, local } = personaToRef(p)
    const profile: StyleProfile = asCopy
      ? {
          id: uid('sp'),
          name: `${p.name}（拷贝）`,
          summary: p.summary,
          traits: [...p.traits],
          samples: [...p.samples],
          active: bind
        }
      : {
          id: uid('sp'),
          name: p.name,
          summary: p.summary,
          traits: [...p.traits],
          samples: [...p.samples],
          active: bind,
          sourceRef: ref
        }
    patchProject((proj) => {
      const list = [...proj.styleProfiles, profile]
      return {
        ...proj,
        styleProfiles: profile.active ? list.map((x) => ({ ...x, active: x.id === profile.id })) : list
      }
    })
    toast(
      bind
        ? `已引用「${p.name}」并绑定本书，后续生成都会带上它`
        : `已引用「${p.name}」，到文风页打开开关即可生效`,
      'ok'
    )
    reset()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset()
        onClose()
      }}
      width={880}
      title="从系统文风分身库添加"
      footer={
        <>
          <Button
            onClick={() => {
              reset()
              onClose()
            }}
          >
            取消
          </Button>
          <div className="flex-1" />
          <label className="flex items-center gap-1.5 text-[11.5px] mr-1" style={{ color: 'var(--text-dim)' }}>
            <input type="checkbox" checked={copyMode} onChange={(e) => setCopyMode(e.target.checked)} />
            拷贝一份到本书（不跟随系统库更新）
          </label>
          <Button variant="ghost" disabled={!picked} onClick={() => picked && add(picked, copyMode, false)}>
            仅添加
          </Button>
          <Button variant="primary" disabled={!picked} onClick={() => picked && add(picked, copyMode, true)}>
            添加并绑定本书
          </Button>
        </>
      }
    >
      {personas.length === 0 ? (
        <EmptyState
          icon={<LibraryBig size={30} />}
          title="系统分身库还是空的"
          desc="到「设置 → 文风分身库」里恢复内置的一百位作者，或在那边新建属于自己的分身。"
          action={
            <Button
              onClick={() => {
                onClose()
                setView('settings')
              }}
            >
              去设置
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex items-center gap-2 mb-2">
            <div className="relative flex-1">
              <Search
                size={13}
                style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)' }}
              />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜作者名、代表作、标签、特征…（空格分隔可组合）"
                style={{ height: 32, paddingLeft: 28, fontSize: 12.5 }}
              />
              {query && (
                <button
                  className="icon-btn"
                  style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', width: 22, height: 22 }}
                  onClick={() => setQuery('')}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <Select
              value={category}
              onChange={(e) => setCategory(e.target.value as StyleCategory | 'all')}
              style={{ height: 32, width: 132, fontSize: 12.5 }}
            >
              <option value="all">全部分类</option>
              {STYLE_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>

          {tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 mb-2">
              {tags.map((t) => (
                <button
                  key={t.tag}
                  className="text-[10.5px] px-1.5 py-0.5"
                  style={{
                    borderRadius: 4,
                    border: '1px solid var(--border)',
                    background: 'var(--panel-2)',
                    color: 'var(--text-dim)',
                    cursor: 'default'
                  }}
                  onClick={() => setQuery(t.tag)}
                >
                  {t.tag}
                </button>
              ))}
            </div>
          )}

          <div className="text-[11px] mb-1.5" style={{ color: 'var(--text-faint)' }}>
            共 {shown.length} 位可选 · 已引用 {boundIds.size} 位 · 引用会跟随系统库更新
          </div>

          <div className="flex flex-col gap-1 max-h-[420px] overflow-auto scroll-thin pr-1">
            {shown.length === 0 && (
              <div className="py-10 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
                没有匹配的分身
              </div>
            )}
            {shown.map((p) => {
              const on = picked?.id === p.id
              const already = boundIds.has(p.id)
              return (
                <button
                  key={p.id}
                  className="text-left px-2.5 py-2"
                  style={{
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                    background: on ? 'var(--accent-soft)' : 'var(--panel)',
                    borderRadius: 7,
                    cursor: 'default'
                  }}
                  onClick={() => setPicked(on ? null : p)}
                  onDoubleClick={() => add(p, copyMode, true)}
                >
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className="shrink-0 inline-flex items-center justify-center text-[10px] font-semibold"
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 5,
                        background: `color-mix(in srgb, ${categoryColor(p.category)} 14%, var(--panel))`,
                        color: categoryColor(p.category)
                      }}
                    >
                      {p.name.slice(0, 1)}
                    </span>
                    <span className="text-[12.5px] font-semibold">{p.name}</span>
                    <span className="chip" style={{ height: 16, fontSize: 9.5 }}>
                      {CATEGORY_LABELS[p.category]}
                    </span>
                    {already && (
                      <span className="chip chip-accent" style={{ height: 16, fontSize: 9.5 }}>
                        已引用
                      </span>
                    )}
                    {p.refs.length > 0 && (
                      <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                        {p.refs.slice(0, 2).join(' / ')}
                      </span>
                    )}
                    <div className="flex-1" />
                    {on && <Check size={13} style={{ color: 'var(--accent)' }} />}
                  </div>
                  {p.summary && (
                    <div className="mt-1 text-[11px] leading-relaxed line-clamp-2" style={{ color: 'var(--text-dim)' }}>
                      {p.summary}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1 mt-1">
                    {p.tags.map((t) => (
                      <span
                        key={t}
                        className="text-[10px] px-1 py-0.5"
                        style={{ borderRadius: 3, background: 'var(--panel-2)', color: 'var(--text-faint)' }}
                      >
                        {t}
                      </span>
                    ))}
                    <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                      {p.traits.length} 条特征
                    </span>
                  </div>
                </button>
              )
            })}
          </div>

          <div className="mt-2.5 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            <Copy size={10} style={{ display: 'inline', marginRight: 3 }} />
            引用与拷贝的区别：引用只存来源 id，系统库里改了这边立刻跟着变；拷贝会各走各的，适合你想在这个基础上二次加工时用。
          </div>
        </>
      )}
    </Modal>
  )
}