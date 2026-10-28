/**
 * 对话改稿的应用预览。
 *
 * 和体检那条链路的 `ApplyPreviewModal` 是同一套原则（改前/改后摆出来、作者看过才落盘），
 * 但列的东西不一样，所以单独一个：这里混着段落改动、字段改动、新增条目三类，
 * 而且每条都可能定位失败或命中多处——那些条目不能勾、只能看。
 *
 * 为什么不复用 ApplyPreview：它的 DiffPair 只有 before/after 两个字符串，
 * 塞不下「找不到原文」「命中三段」这些状态。共用一份 diff 计算（lib/diffText）就够了。
 */
import { useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowRight, Check, Sparkles } from 'lucide-react'
import { Button, Modal } from './ui'
import { diffSpan } from '../lib/diffText'
import type { ResolvedEdit } from '../lib/applyEdits'

export function ChatEditPreview({
  open,
  edits,
  onClose,
  onApply,
  onRetry
}: {
  open: boolean
  edits: ResolvedEdit[]
  onClose: () => void
  onApply: (kept: ResolvedEdit[]) => void
  /** 一批改动全都对不上时，让 AI 拿着真正文重新摘录一次 */
  onRetry?: () => void
}): ReactNode {
  // 作者可以逐条否决：取消勾选的条目保持原样。
  // 键用数组下标——同一条 op 可能展成多行（全书替换、设定多字段），
  // 靠 op 引用区分不开它们。
  const [dropped, setDropped] = useState<Set<number>>(new Set())

  const groups = useMemo(() => {
    const out: { key: string; title: string | null; items: { e: ResolvedEdit; i: number }[] }[] = []
    const byKey = new Map<string, { e: ResolvedEdit; i: number }[]>()
    edits.forEach((e, i) => {
      const k = e.chapterId ?? '__book__'
      if (!byKey.has(k)) byKey.set(k, [])
      ;(byKey.get(k) as { e: ResolvedEdit; i: number }[]).push({ e, i })
    })
    const titled = byKey.size > 1
    for (const [k, items] of byKey) {
      out.push({
        key: k,
        title: titled ? (k === '__book__' ? '大纲与设定' : items[0].e.chapterTitle ?? '（未命名章节）') : null,
        items
      })
    }
    return out
  }, [edits])

  const applicable = edits.filter((e) => e.status === 'found')
  const kept = applicable.filter((e) => !dropped.has(edits.indexOf(e)))
  const blocked = edits.length - applicable.length

  const toggle = (i: number): void => {
    setDropped((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={820}
      title={
        <div className="flex items-center gap-2">
          <Sparkles size={15} style={{ color: 'var(--accent)' }} />
          应用对话里的改动
        </div>
      }
      footer={
        <>
          <div className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            正文改动可在章节版本历史里回退；应用后 30 秒内还能整批撤销
          </div>
          <div className="flex-1" />
          <Button size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!kept.length}
            onClick={() => onApply(kept)}
          >
            <Check size={12} /> 应用选中 {kept.length} 处
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {blocked > 0 && (
          <div
            className="rounded-md px-3 py-2 text-[11.5px] leading-relaxed"
            style={{
              background: 'color-mix(in srgb, var(--warning, #B45309) 8%, transparent)',
              border: '1px solid color-mix(in srgb, var(--warning, #B45309) 26%, transparent)',
              color: 'var(--text-dim)'
            }}
          >
            {applicable.length === 0 ? (
              <>
                这 {blocked} 处全都对不上你书里的正文——最常见的原因是 AI 用了**它自己在对话里写过的那一版**
                （那一版可能没被采用，或你后来另写了一版），而书里是另一版。这些改动不会动任何东西。
              </>
            ) : (
              <>
                有 {blocked} 处没法定下来（找不到原文、或同样的话出现了好几处），这些不会改动任何东西。
                可以让 AI 重新摘录，或在对话里指明是哪一章哪一段。
              </>
            )}
            {applicable.length === 0 && onRetry && (
              <div className="mt-2">
                <Button size="sm" onClick={onRetry}>
                  让它重新读这一章再改
                </Button>
              </div>
            )}
          </div>
        )}

        {groups.map((g) => (
          <div key={g.key} className="flex flex-col gap-2">
            {g.title && (
              <div className="text-[11px] font-medium mt-0.5" style={{ color: 'var(--text-dim)' }}>
                {g.title}
              </div>
            )}
            {g.items.map(({ e, i }) => (
              <EditRow key={i} edit={e} off={dropped.has(i)} onToggle={() => toggle(i)} />
            ))}
          </div>
        ))}

        {!edits.length && (
          <div className="text-[12px] py-6 text-center" style={{ color: 'var(--text-faint)' }}>
            这一轮没有可以应用的改动
          </div>
        )}
      </div>
    </Modal>
  )
}

function EditRow({ edit, off, onToggle }: { edit: ResolvedEdit; off: boolean; onToggle: () => void }): ReactNode {
  const found = edit.status === 'found'
  const status = !found ? (edit.status === 'ambiguous' ? '有歧义' : '找不到原文') : null

  return (
    <div
      className="rounded-md overflow-hidden"
      style={{
        border: `1px solid ${found ? 'var(--border)' : 'color-mix(in srgb, var(--danger) 30%, var(--border))'}`,
        opacity: !found ? 0.75 : off ? 0.45 : 1
      }}
    >
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 text-[10.5px]"
        style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--border)' }}
      >
        {found ? (
          <input
            type="checkbox"
            checked={!off}
            onChange={onToggle}
            title={off ? '点击恢复这一处' : '取消勾选表示不改这一处'}
            style={{ accentColor: 'var(--accent)', width: 12, height: 12 }}
          />
        ) : (
          <AlertTriangle size={11} style={{ color: 'var(--warning, #B45309)' }} />
        )}
        <span style={{ color: 'var(--text-dim)' }}>{edit.label}</span>
        {edit.draftTarget && (
          <span
            className="chip shrink-0"
            style={{ height: 16, padding: '0 6px', fontSize: 10, color: 'var(--accent)' }}
            title="确认后会用「起草」预算写这一章的初稿，进度在右侧面板顶部显示"
          >
            写稿
          </span>
        )}
        {edit.writeTarget && (
          <span
            className="chip shrink-0"
            style={{ height: 16, padding: '0 6px', fontSize: 10, color: 'var(--accent)' }}
            title="确认后按目标字数写这一章"
          >
            {edit.writeTarget.continueOnly ? '续写' : '起草'}
          </span>
        )}
        {edit.chapterCorrected && (
          <span
            className="chip shrink-0"
            style={{ height: 16, padding: '0 6px', fontSize: 10, color: 'var(--warning, #B45309)' }}
            title="AI 报的章节与实际原文所在章节不一致，这里按逐字匹配找到了真正的那一段"
          >
            章节已修正
          </span>
        )}
        {status && (
          <span className="chip" style={{ height: 16, padding: '0 6px', fontSize: 10, color: 'var(--warning, #B45309)' }}>
            {status}
          </span>
        )}
        {edit.note && (
          <span className="ml-auto truncate" style={{ color: 'var(--text-faint)', maxWidth: 320 }} title={edit.note}>
            {edit.note}
          </span>
        )}
      </div>

      {/* 定位不到 / 有歧义的行不画改前改后：这两处根本不会落地，画出来只会让人以为已经精确定位了 */}
      {!found ? null : edit.display === 'paragraph' ? (
        <div className="grid grid-cols-2">
          <div className="p-2.5 text-[11.5px] leading-relaxed border-r" style={{ borderColor: 'var(--border)' }}>
            <div className="text-[10px] mb-1" style={{ color: 'var(--text-faint)' }}>
              {edit.op.op === 'insert_paragraph' ? '原文之后插入' : '改前'}
            </div>
            <div style={{ color: 'var(--text-dim)' }}>
              {edit.before ? (
                (() => {
                  const d = diffSpan(edit.before, edit.after)
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
            <div className="selectable" style={{ color: 'var(--text)' }}>
              {edit.after ? (
                (() => {
                  const d = diffSpan(edit.before, edit.after)
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
                '（删除这一段）'
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="px-2.5 py-2 text-[11.5px] leading-relaxed flex flex-col gap-0.5">
          {edit.display === 'new-entry' ? (
            <div className="selectable" style={{ color: 'var(--text)' }}>
              {edit.after || '（没有内容）'}
            </div>
          ) : (
            <>
              {edit.before && (
                <div style={{ color: 'var(--text-faint)' }}>
                  原：
                  <span style={{ textDecoration: 'line-through', color: 'var(--danger)' }}>{edit.before}</span>
                </div>
              )}
              <div className="selectable" style={{ color: 'var(--text)' }}>
                新：<span style={{ color: 'var(--ok, #2e7d32)' }}>{edit.after || '（清空）'}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}