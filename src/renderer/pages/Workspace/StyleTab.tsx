import { useState, type ReactNode } from 'react'
import type { Project, StyleProfile } from '@shared/types'
import { findPersona, resolveRef } from '@shared/styleLibrary'
import { countWords, formatNumber } from '@shared/utils'
import { resolveTaskModel, useApp } from '../../store/app'
import { Button, EmptyState, Switch } from '../../components/ui'
import { Columns2, Fingerprint, LibraryBig, Link2Off, Pencil, Plus, Settings2, Trash2 } from 'lucide-react'
import { ConfirmButton } from './ConfirmButton'
import { StyleEditorModal } from './style/StyleEditorModal'
import { LibraryPicker } from './style/LibraryPicker'
import { MAX_TOTAL_WORDS } from './style/prompts'

const HOW_TO: { n: string; title: string; desc: string }[] = [
  { n: '1', title: '喂样本', desc: '2–5 段你亲手写、已定稿的文字，总量 5000 字以内' },
  { n: '2', title: '提炼特征', desc: 'AI 读成 3–6 条可执行规则，每条都能手改' },
  { n: '3', title: '试写对比', desc: '同一引子写两遍，裸写与带分身并排看差别' }
]

export function StyleTab({ project }: { project: Project }): ReactNode {
  const { config, patchProject, toast, setView, styleLibrary } = useApp()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<StyleProfile | null>(null)
  const [startStep, setStartStep] = useState<1 | 2 | 3>(1)
  const [pickerOpen, setPickerOpen] = useState(false)

  const hasModel = Boolean(resolveTaskModel(config, project, 'polish'))
  const profiles = project.styleProfiles
  const activeName = profiles.find((p) => p.active)?.name ?? ''
  const libCount = styleLibrary?.personas.length ?? 0

  const openNew = (): void => {
    setEditing(null)
    setStartStep(1)
    setModalOpen(true)
  }

  const openEdit = (p: StyleProfile, step: 1 | 2 | 3 = 1): void => {
    setEditing(p)
    setStartStep(step)
    setModalOpen(true)
  }

  const setActive = (id: string, on: boolean): void => {
    patchProject((p) => ({
      ...p,
      styleProfiles: p.styleProfiles.map((x) =>
        x.id === id ? { ...x, active: on } : on ? { ...x, active: false } : x
      )
    }))
    const target = profiles.find((x) => x.id === id)
    toast(on ? `已绑定「${target?.name ?? ''}」，后续生成都会带上它` : '已解除绑定，本书改用默认笔感', 'ok')
  }

  const remove = (id: string): void => {
    patchProject((p) => ({ ...p, styleProfiles: p.styleProfiles.filter((x) => x.id !== id) }))
    toast('分身已删除', 'ok')
  }

  return (
    <div className="h-full overflow-auto scroll-thin">
      <div className="max-w-[900px] mx-auto px-8 py-7">
        {/* 头部 */}
        <div className="flex items-start gap-2.5 mb-3">
          <Fingerprint size={16} style={{ color: 'var(--accent)', marginTop: 2 }} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold">文风分身</h2>
              <span className="chip">{profiles.length}</span>
              {activeName && (
                <span className="chip chip-accent" title={`本书当前生效：${activeName}`}>
                  生效中：{activeName}
                </span>
              )}
            </div>
            <div className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
              喂给 AI 几段你自己的文字，它就能写得像你——不是模仿，是学会你的句子节奏。
            </div>
          </div>
          <div className="flex-1" />
          <Button onClick={() => setPickerOpen(true)} title="从系统文风分身库里搜索并引用">
            <LibraryBig size={13} /> 从分身库添加
          </Button>
          <Button onClick={openNew}>
            <Plus size={13} /> 新建分身
          </Button>
        </div>

        {/* 未配置模型提示 */}
        {!hasModel && (
          <div
            className="flex items-center gap-2 px-3 py-2 mb-3 text-[11.5px]"
            style={{
              background: 'color-mix(in srgb, var(--warn) 12%, var(--panel))',
              border: '1px solid color-mix(in srgb, var(--warn) 30%, var(--border))',
              borderRadius: 7,
              color: 'var(--text-dim)'
            }}
          >
            <Settings2 size={13} style={{ color: 'var(--warn)' }} />
            <span>还没有可用模型：可以照常写样本，但「提炼特征 / 试写对比」要等配置好模型后才能用。</span>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => setView('settings')}>
              去设置
            </Button>
          </div>
        )}

        {/* 三步说明 */}
        <div className="grid gap-2 mb-4" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          {HOW_TO.map((h) => (
            <div key={h.n} className="card px-3 py-2.5">
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-flex items-center justify-center rounded-full text-[10px] font-semibold shrink-0"
                  style={{
                    width: 15,
                    height: 15,
                    background: 'var(--accent-soft)',
                    color: 'var(--accent)'
                  }}
                >
                  {h.n}
                </span>
                <span className="text-[12px] font-medium">{h.title}</span>
              </div>
              <div className="text-[10.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-faint)' }}>
                {h.desc}
              </div>
            </div>
          ))}
        </div>

        {/* 分身库入口条：书内自建与系统库两条路，别让用户以为只能自己喂样本 */}
        <div
          className="flex items-center gap-2 px-3 py-2 mb-3 text-[11.5px]"
          style={{
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
            borderRadius: 7,
            color: 'var(--text-dim)'
          }}
        >
          <LibraryBig size={13} style={{ color: 'var(--accent)' }} />
          {libCount > 0 ? (
            <span>
              系统分身库里有 <strong style={{ color: 'var(--text)' }}>{libCount}</strong> 位作者（古龙、金庸、天蚕土豆…），
              可以直接搜索引用，不用自己喂样本。
            </span>
          ) : (
            <span>系统分身库还没有内容，可以到设置里恢复内置的一百位作者。</span>
          )}
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setPickerOpen(true)} style={{ color: 'var(--accent)' }}>
            搜索并添加
          </Button>
        </div>

        {/* 列表 */}
        {profiles.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<Fingerprint size={30} />}
              title="还没有文风分身"
              desc="两条路：从系统分身库直接引用一位你喜欢的作家（改一处，所有书同步），或者把你的代表作喂给它，提炼专属于你的文风规则。"
              action={
                <div className="flex items-center gap-2">
                  <Button variant="primary" onClick={() => setPickerOpen(true)}>
                    <LibraryBig size={13} /> 从分身库选一位
                  </Button>
                  <Button onClick={openNew}>
                    <Plus size={13} /> 用自己的样本创建
                  </Button>
                </div>
              }
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {profiles.map((p) => {
              // 引用型分身：显示系统库里的**当前**内容（实时跟随），不是书里的旧快照
              const resolved = p.sourceRef ? resolveRef(p.sourceRef, p, styleLibrary?.personas) : null
              const effTraits = resolved ? resolved.traits : p.traits
              const effSamples = resolved ? resolved.samples : p.samples
              const missing = resolved?.missing ?? false
              const words = effSamples.reduce((s, x) => s + countWords(x), 0)
              const traits = effTraits.filter((t) => t.trim().length > 0)
              const preview = effSamples[0]?.replace(/\s+/g, ' ').trim() ?? ''
              const libEntry = p.sourceRef ? findPersona(styleLibrary?.personas ?? [], p.sourceRef.sourceId) : undefined
              return (
                <div key={p.id} className="card p-3.5">
                  <div className="flex items-start gap-2.5">
                    <div
                      className="inline-flex items-center justify-center shrink-0"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 7,
                        background: p.active ? 'var(--accent-soft)' : 'var(--panel-2)',
                        color: p.active ? 'var(--accent)' : 'var(--text-faint)'
                      }}
                    >
                      {p.sourceRef ? <LibraryBig size={14} /> : <Fingerprint size={14} />}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13.5px] font-semibold truncate">
                          {resolved?.name || p.name || '未命名分身'}
                        </span>
                        {p.active ? (
                          <span className="chip chip-accent" style={{ height: 18, fontSize: 10.5 }}>
                            已绑定本书
                          </span>
                        ) : (
                          <span className="chip" style={{ height: 18, fontSize: 10.5 }}>
                            未绑定
                          </span>
                        )}
                        {p.sourceRef && !missing && (
                          <span
                            className="chip"
                            style={{ height: 18, fontSize: 10.5, color: 'var(--accent)' }}
                            title="跟随系统分身库，那边一改这边立刻同步"
                          >
                            引用库中
                          </span>
                        )}
                        {missing && (
                          <span className="chip chip-danger" style={{ height: 18, fontSize: 10.5 }} title="系统库里已删除该分身">
                            <Link2Off size={9} style={{ marginRight: 2 }} />
                            来源已删除
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 mt-1 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                        <span>特征 {traits.length} 条</span>
                        {effSamples.length > 0 && (
                          <>
                            <span style={{ opacity: 0.5 }}>·</span>
                            <span>样本 {effSamples.length} 段</span>
                            <span style={{ opacity: 0.5 }}>·</span>
                            <span className="tabular-nums">共 {formatNumber(words)} 字</span>
                          </>
                        )}
                        {words > MAX_TOTAL_WORDS && <span style={{ color: 'var(--warn)' }}>超出建议上限</span>}
                      </div>

                      {resolved?.summary && (
                        <div className="mt-1 text-[11px] leading-relaxed line-clamp-2" style={{ color: 'var(--text-dim)' }}>
                          {resolved.summary}
                        </div>
                      )}

                      {missing && (
                        <div className="mt-1 text-[11px]" style={{ color: 'var(--warn)' }}>
                          系统分身库里已经没有「{p.sourceRef?.snapshotName || p.name}」，当前按引用时的快照继续生效。
                          可以删除它，或到设置里重新添加。
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-1 mt-1.5">
                        {traits.slice(0, 3).map((t, i) => (
                          <span
                            key={i}
                            className="text-[11px] px-1.5 py-0.5 truncate"
                            style={{
                              maxWidth: 260,
                              background: 'var(--panel-2)',
                              border: '1px solid var(--border)',
                              borderRadius: 5,
                              color: 'var(--text-dim)'
                            }}
                            title={t}
                          >
                            {t}
                          </span>
                        ))}
                        {traits.length > 3 && (
                          <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                            +{traits.length - 3}
                          </span>
                        )}
                        {traits.length === 0 && (
                          <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                            未提炼特征 · 仅做样本注入
                          </span>
                        )}
                      </div>

                      {libEntry && libEntry.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {libEntry.tags.map((t) => (
                            <span
                              key={t}
                              className="text-[10px] px-1 py-0.5"
                              style={{ borderRadius: 3, background: 'var(--panel-2)', color: 'var(--text-faint)' }}
                            >
                              {t}
                            </span>
                          ))}
                          {libEntry.refs.length > 0 && (
                            <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
                              {libEntry.refs.join(' / ')}
                            </span>
                          )}
                        </div>
                      )}

                      {preview && (
                        <div
                          className="mt-1.5 text-[11px] truncate"
                          style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}
                          title={preview}
                        >
                          「{preview.slice(0, 90)}」
                        </div>
                      )}
                    </div>

                    <div className="shrink-0 flex flex-col items-end gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                          {p.active ? '启用中' : '启用'}
                        </span>
                        <Switch checked={p.active} onChange={(v) => setActive(p.id, v)} />
                      </div>
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>
                          <Pencil size={11} /> {p.sourceRef ? '编辑副本' : '编辑'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(p, 3)}
                          disabled={!hasModel}
                          title={hasModel ? '用同一个引子写两遍做对比' : '需要先配置模型'}
                        >
                          <Columns2 size={11} /> 试写对比
                        </Button>
                        <ConfirmButton
                          onConfirm={() => remove(p.id)}
                          title={
                            p.sourceRef
                              ? '解除引用不会动系统分身库里的那条'
                              : '删除后样本与特征卡都会丢失'
                          }
                          label={
                            <>
                              <Trash2 size={11} /> {p.sourceRef ? '解除' : '删除'}
                            </>
                          }
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="text-[10.5px] mt-4 leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          同一时间只有一本分身对本书生效；切换开关会顶掉之前的绑定。分身的特征卡与前 3 段样本会进入每次生成的系统提示词，
          因此比不开文风时略微多花一点 token。
        </div>
      </div>

      <StyleEditorModal
        open={modalOpen}
        project={project}
        source={editing}
        initialStep={startStep}
        onClose={() => setModalOpen(false)}
      />

      <LibraryPicker open={pickerOpen} project={project} onClose={() => setPickerOpen(false)} />
    </div>
  )
}