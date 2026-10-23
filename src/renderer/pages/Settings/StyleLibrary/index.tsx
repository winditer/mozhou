import { useMemo, useState, type ReactNode } from 'react'
import type { StyleCategory, StylePersona } from '@shared/styleLibrary'
import {
  CATEGORY_LABELS,
  STYLE_CATEGORIES,
  categoryColor,
  filterPersonas,
  tagCounts
} from '@shared/styleLibrary'
import { countWords } from '@shared/utils'
import { useApp } from '../../../store/app'
import { mz } from '../../../lib/bridge'
import { Button, EmptyState, Input, Select } from '../../../components/ui'
import {
  Copy,
  LibraryBig,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { ConfirmModal, LoadingHint, PageHead } from '../common'
import { PersonaEditor } from './personaEditor'

/**
 * 设置 → 系统文风分身库
 *
 * 这里是「全局」层：库里的一百位作者分身对所有书可见，书里通过引用绑定（不是拷贝）。
 * 书内自己写的分身仍然留在书里，两边互不覆盖。
 */
export function StyleLibrarySection(): ReactNode {
  const library = useApp((s) => s.styleLibrary)
  const saveStyleLibrary = useApp((s) => s.saveStyleLibrary)
  const toast = useApp((s) => s.toast)

  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<StyleCategory | 'all'>('all')
  const [tag, setTag] = useState<string>('all')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<StylePersona | null>(null)
  const [pendingDelete, setPendingDelete] = useState<StylePersona | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const personas = library?.personas ?? []
  const shown = useMemo(() => filterPersonas(personas, { query, category, tag }), [personas, query, category, tag])
  const tags = useMemo(() => tagCounts(filterPersonas(personas, { category })), [personas, category])
  const perCategory = useMemo(() => {
    const map = new Map<StyleCategory, number>()
    for (const p of personas) map.set(p.category, (map.get(p.category) ?? 0) + 1)
    return map
  }, [personas])

  if (!library) return <LoadingHint />

  const openNew = (): void => {
    setEditing(null)
    setEditorOpen(true)
  }

  const openEdit = (p: StylePersona): void => {
    setEditing(p)
    setEditorOpen(true)
  }

  const upsert = (p: StylePersona): void => {
    void saveStyleLibrary((lib) => {
      const exists = lib.personas.some((x) => x.id === p.id)
      return {
        ...lib,
        personas: exists ? lib.personas.map((x) => (x.id === p.id ? p : x)) : [...lib.personas, p]
      }
    }).then((ok) => {
      if (ok) toast(`「${p.name}」已保存`, 'ok')
    })
    setEditorOpen(false)
  }

  const remove = (p: StylePersona): void => {
    void saveStyleLibrary((lib) => ({ ...lib, personas: lib.personas.filter((x) => x.id !== p.id) })).then((ok) => {
      if (ok) {
        toast(p.builtin ? `已删除内置分身「${p.name}」，可在「恢复内置」里找回` : `已删除「${p.name}」`, 'ok')
      }
    })
    setPendingDelete(null)
  }

  /** 复制成自定义分身：种子库不允许直接改「出厂篇目」的心理负担太重，先复制再改更安全 */
  const duplicate = (p: StylePersona): void => {
    const now = Date.now()
    const copy: StylePersona = {
      ...p,
      id: `${p.id}-copy-${now.toString(36)}`,
      name: `${p.name}（副本）`,
      builtin: false,
      createdAt: now,
      updatedAt: now
    }
    void saveStyleLibrary((lib) => ({ ...lib, personas: [...lib.personas, copy] })).then((ok) => {
      if (ok) toast(`已复制为「${copy.name}」，可以直接改`, 'ok')
    })
  }

  const resetBuiltin = async (): Promise<void> => {
    setResetOpen(false)
    const ok = await saveStyleLibrary((lib) => lib) // 占位：确保当前状态已落盘
    if (!ok) return
    try {
      const next = await mz.library.resetBuiltin()
      useApp.setState({ styleLibrary: next })
      toast('内置分身已恢复出厂，你自己创建的分身都还在', 'ok')
    } catch (e) {
      toast(`恢复失败：${(e as Error).message}`, 'error')
    }
  }

  const customCount = personas.filter((p) => !p.builtin).length

  return (
    <div>
      <PageHead
        title="系统文风分身库"
        desc="全站共享的文风分身库。书里「文风」页可以直接搜索并引用这里的任何一位，改这里，所有引用它的书都会跟着变。"
        right={
          <div className="flex items-center gap-2">
            <Button onClick={() => setResetOpen(true)} title="把内置分身恢复为出厂内容，自己建的不受影响">
              <RotateCcw size={13} /> 恢复内置
            </Button>
            <Button variant="primary" onClick={openNew}>
              <Plus size={13} /> 新建分身
            </Button>
          </div>
        }
      />

      {/* 概览：全部 + 6 类。
          用 flex-wrap + 固定最小宽度，最后一张卡不会因为凑不满一行而单独占一整行。 */}
      <div className="mb-3.5" style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
        <button
          className="card px-2.5 py-2 text-left surface-hover"
          style={{
            minWidth: 0,
            border: `1px solid ${category === 'all' ? 'var(--accent)' : 'var(--border)'}`,
            background: category === 'all' ? 'var(--accent-soft)' : 'var(--panel)',
            cursor: 'default'
          }}
          onClick={() => {
            setCategory('all')
            setTag('all')
          }}
        >
          <div className="text-[10px] truncate" style={{ color: 'var(--text-faint)' }}>
            全部
          </div>
          <div className="text-[15px] font-semibold tabular-nums" style={{ color: category === 'all' ? 'var(--accent)' : 'var(--text)' }}>
            {personas.length}
          </div>
        </button>
        {/* 自定义类是用户自建分身，数量通常很少，单独放一个小卡，
            而不是和一个 6 类 + 全部共 8 张卡挤成 7+1 的难看折行 */}
        {STYLE_CATEGORIES.filter((c) => c.id !== 'custom').map((c) => {
          const on = category === c.id
          const n = perCategory.get(c.id) ?? 0
          return (
            <button
              key={c.id}
              className="card px-2.5 py-2 text-left surface-hover"
              title={c.desc}
              style={{
                minWidth: 0,
                border: `1px solid ${on ? c.color : 'var(--border)'}`,
                background: on ? `color-mix(in srgb, ${c.color} 10%, var(--panel))` : 'var(--panel)',
                cursor: 'default',
                opacity: n === 0 ? 0.55 : 1
              }}
              onClick={() => {
                setCategory(c.id)
                setTag('all')
              }}
            >
              <div className="text-[10px] truncate" style={{ color: 'var(--text-faint)' }}>
                {c.label}
              </div>
              <div className="text-[15px] font-semibold tabular-nums" style={{ color: on ? c.color : 'var(--text)' }}>
                {n}
              </div>
            </button>
          )
        })}
      </div>

      {/* 自建分身筛选：种子库不占位置，但仍然要能一键筛出来 */}
      {customCount > 0 && (
        <div className="flex items-center gap-1.5 mb-3 text-[11px]">
          <button
            className="text-[11px] px-2 py-0.5"
            style={{
              borderRadius: 5,
              border: `1px solid ${category === 'custom' ? 'var(--accent)' : 'var(--border)'}`,
              background: category === 'custom' ? 'var(--accent-soft)' : 'var(--panel-2)',
              color: category === 'custom' ? 'var(--accent)' : 'var(--text-dim)',
              cursor: 'default'
            }}
            onClick={() => setCategory(category === 'custom' ? 'all' : 'custom')}
          >
            仅看自建（{customCount}）
          </button>
          <span style={{ color: 'var(--text-faint)' }}>你自己新建或复制出来的分身，不受「恢复内置」影响</span>
        </div>
      )}

      {/* 搜索 + 标签 */}
      <div className="flex items-center gap-2 mb-2">
        <div className="relative flex-1">
          <Search
            size={13}
            style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)' }}
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜作者名、代表作、标签、特征内容…（空格分隔可组合，如「古龙 短句」）"
            style={{ height: 32, paddingLeft: 28, fontSize: 12.5 }}
          />
          {query && (
            <button
              className="icon-btn"
              style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', width: 22, height: 22 }}
              onClick={() => setQuery('')}
              title="清空搜索"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <Select
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          style={{ height: 32, width: 140, fontSize: 12.5 }}
          title="按标签筛选"
        >
          <option value="all">全部标签</option>
          {tags.map((t) => (
            <option key={t.tag} value={t.tag}>
              {t.tag}（{t.count}）
            </option>
          ))}
        </Select>
      </div>

      {/* 常用标签快捷条 */}
      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mb-3">
          {tags.slice(0, 18).map((t) => {
            const on = tag === t.tag
            return (
              <button
                key={t.tag}
                className="text-[11px] px-1.5 py-0.5"
                style={{
                  borderRadius: 5,
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                  background: on ? 'var(--accent-soft)' : 'var(--panel-2)',
                  color: on ? 'var(--accent)' : 'var(--text-dim)',
                  cursor: 'default'
                }}
                onClick={() => setTag(on ? 'all' : t.tag)}
              >
                {t.tag}
                <span style={{ opacity: 0.55, marginLeft: 3 }}>{t.count}</span>
              </button>
            )
          })}
          {tag !== 'all' && (
            <button
              className="text-[11px] px-1.5 py-0.5"
              style={{ borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-faint)', cursor: 'default' }}
              onClick={() => setTag('all')}
            >
              清除标签筛选
            </button>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mb-2 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
        <span>
          匹配 <strong style={{ color: 'var(--text)' }}>{shown.length}</strong> 位
        </span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>内置 {personas.length - customCount} 位</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>自建 {customCount} 位</span>
      </div>

      {/* 列表 */}
      {shown.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<LibraryBig size={30} />}
            title={personas.length === 0 ? '分身库是空的' : '没有匹配的分身'}
            desc={
              personas.length === 0
                ? '检查一下 style-library.json 是否写入失败，或点「恢复内置」重新播种一百位作者。'
                : '换个关键词，或者清掉标签筛选。也可以直接新建一个。'
            }
            action={
              personas.length === 0 ? (
                <Button onClick={() => void resetBuiltin()}>
                  <RotateCcw size={13} /> 恢复内置分身
                </Button>
              ) : (
                <Button onClick={() => { setQuery(''); setTag('all'); setCategory('all') }}>清空筛选</Button>
              )
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {shown.map((p) => {
            const open = expanded === p.id
            const words = p.samples.reduce((s, x) => s + countWords(x), 0)
            return (
              <div key={p.id} className="card">
                <div className="flex items-start gap-2.5 p-3">
                  {/* 分类色块 */}
                  <div
                    className="shrink-0 inline-flex items-center justify-center text-[11px] font-semibold"
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 7,
                      background: `color-mix(in srgb, ${categoryColor(p.category)} 14%, var(--panel))`,
                      color: categoryColor(p.category)
                    }}
                  >
                    {p.name.slice(0, 1)}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button
                        className="text-[13.5px] font-semibold truncate"
                        style={{ background: 'transparent', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0 }}
                        onClick={() => setExpanded(open ? null : p.id)}
                        title={open ? '收起特征' : '展开全部特征'}
                      >
                        {p.name}
                      </button>
                      <span
                        className="chip"
                        style={{ height: 17, fontSize: 10 }}
                        title={STYLE_CATEGORIES.find((c) => c.id === p.category)?.desc}
                      >
                        {CATEGORY_LABELS[p.category]}
                      </span>
                      {!p.builtin && (
                        <span className="chip" style={{ height: 17, fontSize: 10 }}>
                          自建
                        </span>
                      )}
                      {p.aiAssisted && (
                        <span className="chip" style={{ height: 17, fontSize: 10, color: 'var(--accent)' }} title="特征卡由 AI 生成或改写">
                          <Sparkles size={9} style={{ marginRight: 2 }} />
                          AI
                        </span>
                      )}
                      {words > 0 && (
                        <span className="text-[10.5px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
                          样本 {p.samples.length} 段 / {words} 字
                        </span>
                      )}
                    </div>

                    {p.summary && (
                      <div className="mt-1 text-[11.5px] leading-relaxed line-clamp-2" style={{ color: 'var(--text-dim)' }}>
                        {p.summary}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-1 mt-1.5">
                      {p.tags.map((t) => (
                        <button
                          key={t}
                          className="text-[10.5px] px-1.5 py-0.5"
                          style={{
                            borderRadius: 4,
                            background: 'var(--panel-2)',
                            border: '1px solid var(--border)',
                            color: 'var(--text-dim)',
                            cursor: 'default'
                          }}
                          onClick={() => setTag(t)}
                          title={`筛出所有带「${t}」的分身`}
                        >
                          {t}
                        </button>
                      ))}
                      {p.refs.length > 0 && (
                        <span className="text-[10.5px] ml-1" style={{ color: 'var(--text-faint)' }}>
                          {p.refs.join(' / ')}
                        </span>
                      )}
                    </div>

                    {open && (
                      <div className="mt-2.5">
                        <div className="text-[11px] font-medium mb-1" style={{ color: 'var(--text-dim)' }}>
                          文风特征（{p.traits.length} 条，生成时逐条进入系统提示词）
                        </div>
                        <ol className="m-0 pl-0 list-none flex flex-col gap-1">
                          {p.traits.map((t, i) => (
                            <li
                              key={i}
                              className="text-[11.5px] leading-relaxed px-2 py-1 selectable"
                              style={{ background: 'var(--panel-2)', borderRadius: 5, color: 'var(--text-dim)' }}
                            >
                              <span className="tabular-nums" style={{ color: 'var(--text-faint)', marginRight: 5 }}>
                                {i + 1}
                              </span>
                              {t}
                            </li>
                          ))}
                        </ol>
                        {p.samples.length > 0 && (
                          <div className="mt-2">
                            <div className="text-[11px] font-medium mb-1" style={{ color: 'var(--text-dim)' }}>
                              原文样本（前 3 段会进提示词）
                            </div>
                            <div
                              className="text-[11px] leading-relaxed p-2 selectable scroll-thin"
                              style={{
                                background: 'var(--panel-2)',
                                borderRadius: 5,
                                color: 'var(--text-faint)',
                                maxHeight: 140,
                                overflow: 'auto',
                                fontFamily: 'var(--editor-font)'
                              }}
                            >
                              {p.samples[0]?.slice(0, 300)}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="shrink-0 flex items-center gap-0.5">
                    <button className="icon-btn" style={{ width: 26, height: 26 }} title="复制为自建分身" onClick={() => duplicate(p)}>
                      <Copy size={12} />
                    </button>
                    <button className="icon-btn" style={{ width: 26, height: 26 }} title="编辑" onClick={() => openEdit(p)}>
                      <Pencil size={12} />
                    </button>
                    <button
                      className="icon-btn"
                      style={{ width: 26, height: 26, color: 'var(--danger)' }}
                      title={p.builtin ? '删除内置分身（可在「恢复内置」里找回）' : '删除'}
                      onClick={() => setPendingDelete(p)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="text-[10.5px] mt-4 leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        种子库只收录「可执行特征卡 + 风格摘要」，不内置名家原文样本（版权考虑）。想更贴近某位作者，
        可以自己往分身里补原文样本——样本会以 few-shot 方式进入上下文，不会重新训练模型。
      </div>

      <PersonaEditor
        open={editorOpen}
        source={editing}
        onClose={() => setEditorOpen(false)}
        onSave={upsert}
      />

      <ConfirmModal
        open={Boolean(pendingDelete)}
        title="删除这个分身？"
        danger
        confirmText="确认删除"
        message={
          <>
            将删除「<b>{pendingDelete?.name}</b>」。
            {pendingDelete?.builtin
              ? '它是内置分身，删除后书里引用过它的地方会提示「来源已删除」，并回落到引用时的快照。'
              : '书里引用过它的地方会提示「来源已删除」。'}
            <br />
            之后可以在右上角「恢复内置」里把它找回来。
          </>
        }
        onConfirm={() => pendingDelete && remove(pendingDelete)}
        onClose={() => setPendingDelete(null)}
      />

      <ConfirmModal
        open={resetOpen}
        title="恢复内置分身？"
        danger
        confirmText="恢复内置"
        message={
          <>
            会把 <b>{personas.filter((p) => p.builtin).length}</b> 位内置分身恢复为出厂内容——
            你对内置分身的修改会丢失，之前删掉的内置分身也会回来。
            <br />
            你自己创建或复制的 <b>{customCount}</b> 位分身不受影响。
          </>
        }
        onConfirm={() => void resetBuiltin()}
        onClose={() => setResetOpen(false)}
      />
    </div>
  )
}