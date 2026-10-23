import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { GENRES, isConventionOverridden, resolveGenreConvention } from '@shared/genres'
import { Button, Textarea } from '../../components/ui'
import { useApp } from '../../store/app'
import { errMsg, LoadingHint, MONO, PageHead, patchSettingsSafe } from './common'

/**
 * 题材公约：编辑「这本书属于什么题材」时附带注入提示词的那段读者契约。
 *
 * 两个设计取向：
 * 1. **只存差异**。没改过的题材不在配置里留键，内置公约将来改进时能一起跟着变；
 *    点「恢复默认」就是删键，而不是把内置文案复制一份存下来。
 * 2. **默认值要能看见**。编辑框里预填的就是当前生效的公约，作者是在它上面改，
 *    而不是面对一块空白猜「我该写什么」。
 */
const GROUPS = ['幻想', '东方', '现代', '现实'] as const

export function GenresSection(): ReactNode {
  const config = useApp((s) => s.config)
  const toast = useApp((s) => s.toast)

  const overrides = config?.settings.genreConventions ?? {}
  const [activeId, setActiveId] = useState<string>(GENRES[0]!.id)
  // 草稿和落盘解耦：输入框允许中途为空 / 半句，失焦时才提交并规范化
  const [draft, setDraft] = useState('')

  const active = useMemo(() => GENRES.find((g) => g.id === activeId) ?? GENRES[0]!, [activeId])
  const effective = resolveGenreConvention(active.id, overrides)
  const isCustom = isConventionOverridden(active.id, overrides)

  useEffect(() => {
    setDraft(effective)
  }, [activeId, effective])

  if (!config) return <LoadingHint />

  const dirty = draft.trim() !== effective.trim()

  /**
   * 提交一条公约。
   * 空文本 = 恢复默认：删键，让内置值重新接管；
   * 否则写入覆盖表（只存这一条，别的题材不动）。
   */
  async function commit(id: string, text: string): Promise<void> {
    const trimmed = text.trim()
    const next = { ...overrides }
    if (trimmed) next[id] = trimmed
    else delete next[id]
    const ok = await patchSettingsSafe({ genreConventions: next })
    if (ok) {
      toast(trimmed ? '题材公约已保存，下一次生成生效' : '已恢复内置公约，下一次生成生效', 'ok')
    }
  }

  return (
    <div>
      <PageHead
        title="题材公约"
        desc="题材决定「读者期待什么」。这段文字会随系统提示词一起发给模型，用来避免写出世面上烂熟的俗套。只影响这本书的题材，作品里也可以单独调整。"
      />

      <div className="flex gap-4">
        {/* 左：题材列表 */}
        <div className="shrink-0" style={{ width: 176 }}>
          <div className="card p-1.5">
            {GROUPS.map((group) => {
              const list = GENRES.filter((g) => g.group === group)
              if (!list.length) return null
              return (
                <div key={group} className="mb-1.5 last:mb-0">
                  <div
                    className="px-2 py-1 text-[10.5px] font-medium"
                    style={{ color: 'var(--text-faint)', letterSpacing: '0.06em' }}
                  >
                    {group}
                  </div>
                  {list.map((g) => {
                    const on = g.id === activeId
                    const customized = isConventionOverridden(g.id, overrides)
                    return (
                      <button
                        key={g.id}
                        onClick={() => setActiveId(g.id)}
                        className={`w-full flex items-center gap-1.5 h-8 px-2 rounded-md text-[12.5px] mb-0.5 ${
                          on ? '' : 'surface-hover'
                        }`}
                        style={{
                          background: on ? 'var(--accent-soft)' : 'transparent',
                          color: on ? 'var(--accent)' : 'var(--text-dim)',
                          fontWeight: on ? 600 : 400,
                          cursor: 'default'
                        }}
                      >
                        <span
                          className="shrink-0 rounded-full"
                          style={{ width: 6, height: 6, background: g.color, opacity: on ? 1 : 0.7 }}
                        />
                        <span className="truncate">{g.name}</span>
                        {customized && (
                          <span className="ml-auto shrink-0 text-[10px]" style={{ color: on ? 'var(--accent)' : 'var(--text-faint)' }}>
                            已改
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
          <div className="mt-2 px-1 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            标「已改」的题材正在使用你写的版本，其余沿用内置公约。
          </div>
        </div>

        {/* 右：编辑区 */}
        <div className="flex-1 min-w-0">
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[13.5px] font-semibold">{active.name}</span>
              <span className="chip" style={{ height: 19 }}>
                {active.group}
              </span>
              {isCustom ? (
                <span className="chip chip-accent" style={{ height: 19 }}>
                  已自定义
                </span>
              ) : (
                <span className="chip" style={{ height: 19 }}>
                  内置默认
                </span>
              )}
              <span className="ml-auto text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                约 {Math.ceil(effective.length / 1.35)} tokens
              </span>
            </div>

            <div className="text-[11.5px] leading-relaxed mb-2.5" style={{ color: 'var(--text-faint)' }}>
              写清三件事最有约束力：读者期待什么、必须做到什么、必须避免什么。
            </div>

            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (dirty) void commit(active.id, draft)
              }}
              placeholder="例如：读者期待…；必须有…；避免…"
              style={{ minHeight: 190, fontSize: 12.5, lineHeight: 1.75, fontFamily: MONO }}
            />

            <div className="flex items-center gap-2 mt-2.5">
              <span className="text-[10.5px]" style={{ color: dirty ? 'var(--warn)' : 'var(--text-faint)' }}>
                {dirty ? '有未保存的修改，点击输入框外即可保存' : '失焦自动保存 · 改动下一次生成生效'}
              </span>
              <div className="ml-auto flex items-center gap-2">
                {dirty && (
                  <Button size="sm" onClick={() => setDraft(effective)}>
                    放弃修改
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={!isCustom}
                  onClick={() => {
                    // 恢复默认＝删键，让 genres.ts 的内置值重新接管
                    setDraft(active.convention)
                    void (async () => {
                      const next = { ...overrides }
                      delete next[active.id]
                      try {
                        await patchSettingsSafe({ genreConventions: next })
                        toast(`${active.name} 已恢复内置公约`, 'ok')
                      } catch (e) {
                        toast(`恢复失败：${errMsg(e)}`, 'error')
                      }
                    })()
                  }}
                >
                  <RotateCcw size={12} /> 恢复默认
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!dirty}
                  onClick={() => void commit(active.id, draft)}
                >
                  保存
                </Button>
              </div>
            </div>
          </div>

          <div className="mt-3 card px-4 py-3">
            <div className="text-[12px] font-medium mb-1.5">内置默认文案</div>
            <div
              className="text-[11.5px] leading-relaxed selectable"
              style={{ color: 'var(--text-faint)' }}
            >
              {active.convention}
            </div>
          </div>

          <div className="mt-3 px-1 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            无题材的书（策划 / 商务 / 学术等场景）不会注入题材公约；某本书若不想要这段约束，
            也可以在工作区右侧「上下文 → 题材公约」里单独关掉，不影响这里的设置。
          </div>
        </div>
      </div>
    </div>
  )
}