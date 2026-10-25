/**
 * 「采用建议」的对比确认弹窗。
 *
 * 为什么要弹窗而不是直接改：这一步会真的动作者的稿子。让改动在落盘前
 * **逐段并排看一遍**，是这类操作唯一可接受的方式——AI 改稿再准也可能跑偏，
 * 作者必须有机会在看到 diff 之后才点确认。
 */

import { useState, type ReactNode } from 'react'
import { ArrowRight, Check, RefreshCw, X } from 'lucide-react'
import { Button, Modal, Spinner } from '../../../components/ui'

export interface DiffPair {
  /** 段落序号（从 1 开始，给作者看的） */
  index: number
  before: string
  after: string
  /**
   * 这一组属于哪一章（章节 id）。单章体检时为空，全书一致性体检时必填——
   * 那时对比列表里会同时出现好几章的段落，不标章节名根本分不清改的是哪儿。
   */
  chapterId?: string
  /** 章节标题，用于分组标题展示 */
  chapterTitle?: string
}

export interface ApplyPreviewState {
  /** 正在生成改写 */
  running: boolean
  /** 出错信息（生成失败 / 定位失败） */
  error: string | null
  /** 逐段对比；为空且无 error 时表示还没开始 */
  pairs: DiffPair[]
  /** 问题标题，让人知道在改什么 */
  title: string
  suggestion: string
  /** 定位到了几段 / 面板上的提示 */
  note?: string
  /** 是否还能重试（AI 生成失败时） */
  canRetry?: boolean
}

/**
 * 找出两段文字的最小差异区间（最长公共前缀/后缀之外的部分）。
 *
 * 整段加删除线对「只改了两三个字」的情况反而更难读：作者要在一大段划掉的
 * 文字里自己找差异。所以这里算出真正变化的那一小段，只给它上高亮。
 */
function diffSpan(before: string, after: string): { pre: string; del: string; post: string; ins: string } {
  const a = before
  const b = after
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  return { pre: a.slice(0, start), del: a.slice(start, endA), post: a.slice(endA), ins: b.slice(start, endB) }
}

/**
 * 把对比项按章节分组。
 *
 * 单章体检时全都没有 chapterId，返回一个无标题的组，渲染出来和以前的扁平列表一样。
 * 全书一致性体检涉及多章，按章分组并带上章名——不然「第 3 段」同时指好几章，
 * 作者根本分不清自己在改哪一章。
 */
function groupPairs(pairs: DiffPair[]): { key: string; title: string | null; items: DiffPair[] }[] {
  const groups: { key: string; title: string | null; items: DiffPair[] }[] = []
  const byChapter = new Map<string, DiffPair[]>()
  for (const p of pairs) {
    const k = p.chapterId ?? ''
    if (!byChapter.has(k)) byChapter.set(k, [])
    ;(byChapter.get(k) as DiffPair[]).push(p)
  }
  const titled = byChapter.size > 1
  for (const [k, items] of byChapter) {
    groups.push({
      key: k || 'single',
      title: titled ? items[0].chapterTitle ?? '（未命名章节）' : null,
      items
    })
  }
  return groups
}

export function ApplyPreviewModal({
  state,
  onClose,
  onConfirm,
  onRetry
}: {
  state: ApplyPreviewState | null
  onClose: () => void
  onConfirm: () => void
  onRetry: () => void
}): ReactNode {
  // 作者可以逐段否决：取消勾选的段落保持原样。
  // 键必须带上章节 id —— 全书一致性体检会把好几章的段落列在一起，
  // 只用「第 N 段」作键，第 2 章的第 3 段会和第 1 章的第 3 段串成一个。
  const keyOf = (p: DiffPair): string => `${p.chapterId ?? ''}:${p.index}`
  const [dropped, setDropped] = useState<Set<string>>(new Set())
  const open = state !== null
  const pairs = state?.pairs ?? []
  const kept = pairs.filter((p) => !dropped.has(keyOf(p)))
  const changed = kept.filter((p) => p.before !== p.after)
  /** 涉及一章以上时，提示语要说明「各章」而不是「其余段落」 */
  const multiChapter = new Set(pairs.map((p) => p.chapterId ?? '')).size > 1
  const ready = !state?.running && !state?.error && changed.length > 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={760}
      title={
        <div className="flex items-center gap-2">
          <Check size={15} style={{ color: 'var(--accent)' }} />
          采用这条建议
        </div>
      }
      footer={
        <>
          {state?.error && state.canRetry && (
            <Button size="sm" onClick={onRetry}>
              <RefreshCw size={12} /> 重试
            </Button>
          )}
          <div className="flex-1" />
          <Button size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" variant="primary" disabled={!ready} onClick={onConfirm}>
            <Check size={12} /> 写入正文
          </Button>
        </>
      }
    >
      {state && (
        <div className="flex flex-col gap-3">
          {/* 问题与建议 */}
          <div
            className="rounded-md px-3 py-2.5"
            style={{
              background: 'var(--accent-soft)',
              border: '1px solid color-mix(in srgb, var(--accent) 22%, transparent)'
            }}
          >
            <div className="text-[12.5px] font-medium mb-1">{state.title}</div>
            {state.suggestion && (
              <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                建议：{state.suggestion}
              </div>
            )}
          </div>

          {state.running && (
            <div className="flex items-center gap-2 text-[12px] py-6 justify-center" style={{ color: 'var(--text-dim)' }}>
              <Spinner size={13} /> 正在按建议改写这几段…
            </div>
          )}

          {state.error && (
            <div
              className="rounded-md px-3 py-2.5 text-[11.5px] leading-relaxed"
              style={{
                background: 'color-mix(in srgb, var(--danger) 7%, transparent)',
                border: '1px solid color-mix(in srgb, var(--danger) 26%, transparent)'
              }}
            >
              {state.error}
            </div>
          )}

          {state.note && !state.error && (
            <div className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {state.note}
            </div>
          )}

          {/* 逐段对比。全书一致性体检涉及多章时按章分组，否则一个扁平列表。 */}
          {groupPairs(pairs).map((group) => (
            <div key={group.key} className="flex flex-col gap-2">
              {group.title && (
                <div className="text-[11px] font-medium mt-0.5" style={{ color: 'var(--text-dim)' }}>
                  {group.title}
                </div>
              )}
              {group.items.map((p) => {
                const off = dropped.has(keyOf(p))
                const noChange = p.before === p.after
                return (
                  <div
                    key={keyOf(p)}
                    className="rounded-md overflow-hidden"
                    style={{ border: '1px solid var(--border)', opacity: off ? 0.45 : 1 }}
                  >
                    <div
                      className="flex items-center gap-2 px-2.5 py-1.5 text-[10.5px]"
                      style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--border)' }}
                    >
                      <span style={{ color: 'var(--text-faint)' }}>第 {p.index} 段</span>
                      {noChange && <span style={{ color: 'var(--text-faint)' }}>· 无变化</span>}
                      <div className="flex-1" />
                      <button
                        className="chip surface-hover"
                        style={{ height: 18, padding: '0 6px', fontSize: 10, cursor: 'default' }}
                        onClick={() =>
                          setDropped((prev) => {
                            const next = new Set(prev)
                            const k = keyOf(p)
                            if (next.has(k)) next.delete(k)
                            else next.add(k)
                            return next
                          })
                        }
                        title={off ? '点击恢复这一段的改写' : '点击跳过这一段（保留原文）'}
                      >
                        {off ? '已跳过' : '跳过此段'}
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-0">
                      <div className="p-2.5 text-[11.5px] leading-relaxed border-r" style={{ borderColor: 'var(--border)' }}>
                        <div className="text-[10px] mb-1" style={{ color: 'var(--text-faint)' }}>
                          改前
                        </div>
                        <div style={{ color: 'var(--text-dim)' }}>
                          {p.before ? (
                            (() => {
                              const d = diffSpan(p.before, p.after)
                              return (
                                <>
                                  {d.pre}
                                  {d.del && (
                                    <span
                                      style={{
                                        color: 'var(--danger)',
                                        background: 'color-mix(in srgb, var(--danger) 12%, transparent)',
                                        textDecoration: 'line-through'
                                      }}
                                    >
                                      {d.del}
                                    </span>
                                  )}
                                  {d.post}
                                </>
                              )
                            })()
                          ) : (
                            '（空）'
                          )}
                        </div>
                      </div>
                      <div className="p-2.5 text-[11.5px] leading-relaxed">
                        <div className="flex items-center gap-1 text-[10px] mb-1" style={{ color: 'var(--text-faint)' }}>
                          改后 <ArrowRight size={9} />
                        </div>
                        <div style={{ color: 'var(--text)' }} className="selectable">
                          {p.after ? (
                            (() => {
                              const d = diffSpan(p.before, p.after)
                              return (
                                <>
                                  {d.pre}
                                  {d.ins && (
                                    <span
                                      style={{
                                        color: 'var(--ok, #2e7d32)',
                                        background: 'color-mix(in srgb, var(--ok, #2e7d32) 14%, transparent)'
                                      }}
                                    >
                                      {d.ins}
                                    </span>
                                  )}
                                  {d.post}
                                </>
                              )
                            })()
                          ) : (
                            '（空）'
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}

          {ready && (
            <div className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
              将修改 {changed.length} 段
              {dropped.size ? `（已跳过 ${dropped.size} 段）` : ''}。
              {multiChapter ? '各章其余段落逐字不变。' : '其余段落逐字不变。'}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}