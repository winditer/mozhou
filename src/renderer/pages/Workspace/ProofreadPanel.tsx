import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Editor } from '@tiptap/react'
import { CheckCircle2, EyeOff, FileSearch, RotateCcw, Trash2 } from 'lucide-react'
import { summarizeProof, PROOF_KIND_LABEL, type ProofIssue, type ProofKind } from '../../lib/textcraft'
import { Button } from '../../components/ui'

/**
 * 校读面板：机器最擅长、人最容易漏的那几类错。
 *
 * 关键的一条产品立场：**机器说的话，作者有权不听。**
 * 所以每一条都能「忽略」——忽略不是删除，它在本次编辑里记住，
 * 正文一改也不会把同一处误报重新弹回来。忽略记录按"问题指纹"存，
 * 改动了那一处文字，指纹就变了，新出现的问题照常提示。
 */
export function ProofreadPanel({
  editor,
  chapterKey,
  onJump
}: {
  editor: Editor | null
  /** 当前章节 id：换章时清空忽略记录，避免上一章的忽略串到下一章 */
  chapterKey?: string
  /** 点一条问题，把光标移到对应位置（找不到就不动） */
  onJump?: (issue: ProofIssue) => void
}): ReactNode {
  const [only, setOnly] = useState<ProofKind | null>(null)
  /** 被作者忽略的问题 id */
  const [ignored, setIgnored] = useState<Set<string>>(() => new Set())

  /**
   * 校读文本直接取自编辑器文档的纯文本。
   *
   * 这一点很关键：区间（range）是纯文本偏移，必须和 ProseMirror 文档坐标同源，
   * 否则「采用建议」就会改错位置。早先由上层先剥标题、压段落再传进来，
   * 偏移全对不上，表现就是点了没反应。
   */
  /**
   * 校读文本 = 各段落以换行相连，标题段用等长空格遮掉。
   *
   * 为什么要自己拼而不直接用 doc.textContent：后者会把段落首尾直接粘在一起，
   * 「上一段末字 + 下一段首字」会被误判成字间空格，而且纯文本偏移与块坐标对不上。
   * 这里与下方 applyFix 里的 block 映射共用同一套段落顺序，偏移天然一致。
   */
  const text = useMemo(() => {
    const doc = editor?.state.doc
    if (!doc) return ''
    const paras: string[] = []
    doc.descendants((node) => {
      if (!node.isTextblock) return true
      paras.push(node.textContent)
      return false
    })
    return paras
      .map((p, i) => (i === 0 ? ' '.repeat(p.length) : p))
      .join('\n')
  }, [editor, editor?.state.doc])

  // 换章就清空忽略记录：上一章"这条是误报"的判断不该影响这一章
  const lastKey = useRef(chapterKey)
  useEffect(() => {
    if (lastKey.current === chapterKey) return
    lastKey.current = chapterKey
    setIgnored(new Set())
  }, [chapterKey])

  const summary = useMemo(() => summarizeProof(text), [text])

  // 忽略状态跟着正文走：文本变短了很多（换章）时自动清空，避免旧章的忽略记录串到新章
  const all = useMemo(() => summary.issues.filter((i) => !ignored.has(i.id)), [summary.issues, ignored])
  const list = only ? all.filter((i) => i.kind === only) : all
  const activeCount = all.length
  const ignoredCount = summary.issues.length - activeCount

  const byKind = useMemo(() => {
    const m: Record<ProofKind, number> = { punct: 0, width: 0, repeat: 0, space: 0, quote: 0 }
    for (const i of all) m[i.kind]++
    return m
  }, [all])

  /**
   * 采用建议。
   *
   * 按问题自带的精确区间改：区间是纯文本坐标，映射回 ProseMirror 位置后替换。
   * 替换前会核对「取出来的这段字」确实是问题所指的那段，
   * 避免正文已经改动过、坐标错位时把好句子改坏。
   */
  function applyFix(issue: ProofIssue): void {
    // 注意：空格类问题的建议值是空字符串（等于「删掉」），不能用 truthy 判断
    if (issue.suggestion === null || issue.suggestion === undefined || !editor) return

    editor
      .chain()
      .focus()
      .command(({ tr, state, dispatch }) => {
        /**
         * 建立「纯文本偏移 → 文档位置」的精确映射。
         *
         * 易错点：ProseMirror 的 doc.textContent 会把各段落直接拼起来，
         * 段落之间没有分隔字符，但位置编号里每个块要占一格。
         * 所以不能按「长度累加」硬算，只能逐块遍历、按块记录起点，
         * 再在命中的那一块里做块内偏移。
         */
        // 与上方 text 的拼法保持一致：段落之间有一个 '\n' 占位
        type Block = { textStart: number; textEnd: number; posStart: number }
        const blocks: Block[] = []
        let cursor = 0
        state.doc.descendants((node, pos) => {
          if (!node.isTextblock) return true
          const len = node.textContent.length
          blocks.push({ textStart: cursor, textEnd: cursor + len, posStart: pos + 1 })
          cursor += len + 1
          return false
        })

        const plainToPos = (offset: number): number => {
          for (const b of blocks) {
            if (offset >= b.textStart && offset <= b.textEnd) return b.posStart + (offset - b.textStart)
          }
          return -1
        }

        let from = -1
        let to = -1
        let expected = ''

        if (issue.range) {
          from = plainToPos(issue.range.start)
          to = plainToPos(issue.range.end)
          if (from < 0 || to < 0 || to <= from) return false
          expected = state.doc.textBetween(from, to, '')
        } else {
          // 没有精确区间（如引号配对数不对）时，退回按片段搜索第一处
          for (const b of blocks) {
            if (issue.snippet && b.textEnd - b.textStart >= issue.snippet.length) {
              const local = text.slice(b.textStart, b.textEnd).indexOf(issue.snippet)
              if (local >= 0) {
                from = b.posStart + local
                to = from + issue.snippet.length
                expected = issue.snippet
                break
              }
            }
          }
          if (from < 0) return false
        }

        // 一致性校验：切出来的这段字必须正是问题所指，否则说明坐标已失效
        if (issue.kind === 'space') {
          if (!/^[ \t]+$/.test(expected)) return false
        } else if (issue.kind === 'punct') {
          if (!/^[,;:?!]$/.test(expected)) return false
        } else if (issue.kind === 'repeat') {
          if (!isWholeRepetition(expected)) return false
        }

        tr.insertText(issue.suggestion as string, from, to)
        if (dispatch) dispatch(tr)
        return true
      })
      .run()
  }

  function ignore(issue: ProofIssue): void {
    setIgnored((prev) => new Set(prev).add(issue.id))
  }

  function ignoreAllShown(): void {
    setIgnored((prev) => {
      const next = new Set(prev)
      for (const i of list) next.add(i.id)
      return next
    })
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--text-dim)' }}>
          <FileSearch size={13} />
          校读
        </div>
        <div className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          只看标点、空格、重复词和引号配对，本地完成，不调用模型。误报的可以直接忽略。
        </div>
        {ignoredCount > 0 ? (
          <button
            className="mt-1.5 flex items-center gap-1 text-[10.5px]"
            style={{ color: 'var(--text-faint)' }}
            onClick={() => setIgnored(new Set())}
          >
            <RotateCcw size={10} />
            已忽略 {ignoredCount} 条 · 点此恢复
          </button>
        ) : null}
      </div>

      <div className="px-3 py-2 flex flex-wrap items-center gap-1 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Chip active={only === null} onClick={() => setOnly(null)}>
          全部 {activeCount}
        </Chip>
        {(Object.keys(PROOF_KIND_LABEL) as ProofKind[])
          .filter((k) => byKind[k] > 0)
          .map((k) => (
            <Chip key={k} active={only === k} onClick={() => setOnly(k)}>
              {PROOF_KIND_LABEL[k]} {byKind[k]}
            </Chip>
          ))}
        {list.length > 1 ? (
          <button
            className="ml-auto flex items-center gap-1 text-[10.5px]"
            style={{ color: 'var(--text-faint)' }}
            onClick={ignoreAllShown}
            title="把这些都当作误报，本次不再提示"
          >
            <EyeOff size={10} />
            全部忽略
          </button>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 overflow-auto scroll-thin px-2 py-2">
        {list.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4">
            <CheckCircle2 size={22} style={{ color: 'var(--accent)' }} />
            <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              {summary.issues.length === 0 ? '这一章没查出机械错误' : '剩下的都已被你忽略'}
            </div>
            <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
              标点和字面干净不代表稿子好。要判断节奏和人物，用「体检」。
            </div>
          </div>
        ) : (
          list.map((issue) => (
            <div
              key={issue.id}
              className="group rounded-md px-2.5 py-2 mb-1.5"
              style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}
            >
              <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                {issue.message}
              </div>
              {issue.snippet ? (
                <div
                  className="mt-1 text-[11px] rounded px-1.5 py-1 selectable"
                  style={{ background: 'var(--panel)', color: 'var(--text-faint)', wordBreak: 'break-all', cursor: onJump ? 'pointer' : undefined }}
                  onClick={() => onJump?.(issue)}
                  title={onJump ? '点击定位到这一处' : undefined}
                >
                  …{issue.snippet}…
                </div>
              ) : null}
              <div className="mt-1.5 flex justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => ignore(issue)} title="这是误报，本次不再提示">
                  <EyeOff size={12} /> 忽略
                </Button>
                {issue.suggestion !== null && issue.suggestion !== undefined ? (
                  <Button size="sm" variant="ghost" onClick={() => applyFix(issue)}>
                    <Trash2 size={12} /> 采用建议
                  </Button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** 判断字符串是不是「同一个原子片段重复了 2 次或 3 次」 */
function isWholeRepetition(s: string): boolean {
  const n = s.length
  if (n < 2) return false
  for (const k of [1, 2]) {
    if (n % k !== 0) continue
    const unit = s.slice(0, n / k)
    if (unit.repeat(k) === s) return true
  }
  return false
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      onClick={onClick}
      className="px-2 h-6 rounded text-[11px] transition-colors"
      style={{
        background: active ? 'var(--accent-soft)' : 'var(--panel)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        color: active ? 'var(--accent)' : 'var(--text-dim)'
      }}
    >
      {children}
    </button>
  )
}