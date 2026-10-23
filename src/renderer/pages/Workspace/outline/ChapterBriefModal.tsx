import { useEffect, useRef, type ReactNode } from 'react'
import { CircleStop, Sparkles } from 'lucide-react'
import type { OutlineNode, Project } from '@shared/types'
import { Button, Modal, Textarea } from '../../../components/ui'
import { buildOutlineMessages, tokensForWords } from '../../../lib/prompt'
import { useApp } from '../../../store/app'
import { useAiText } from '../useAiText'

/**
 * 判断文本是不是半句话。
 *
 * finish_reason === 'length' 是最可靠的信号，但有些网关不返回它，
 * 所以再补一条启发式：中文句子正常以句末标点或收尾字结束，
 * 如果末尾是逗号、顿号、或停在「的/和/与/把/被/是」这类虚词上，
 * 基本可以断定被截断了。
 */
function looksUnfinished(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  const last = t.slice(-1)
  if (/[。！？…"」』）】]$/.test(last)) return false
  // 停在句中标点：一定是断的
  if (/[，、；：,;:]/.test(last)) return true
  // 停在明显需要后继的字上
  if (/[的和与把被是在从对向为之了着过很更最不没]$/.test(last)) return true
  // 停在半句话的中间（既没有句末标点，也不是数字或英文结尾）
  if (/[\u4e00-\u9fa5]$/.test(last)) return true
  return false
}

/**
 * 单章章纲生成：流式输出预览 → 应用到该章 summary。
 * 打开即自动开始，失败可重试。
 */
export function ChapterBriefModal({
  node,
  project,
  onClose
}: {
  node: OutlineNode | null
  project: Project
  onClose: () => void
}): ReactNode {
  const patchProject = useApp((s) => s.patchProject)
  const toast = useApp((s) => s.toast)
  const ai = useAiText()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const nodeId = node?.id ?? null

  const generate = (target: OutlineNode): void => {
    const instruction = [
      `请为这一章生成详细章纲：《${target.title}》。`,
      '要求：①按顺序列出 4–6 个情节点；②标明开场钩子、核心冲突、结尾悬念；③写清这一章推进了什么、改变了什么；④不要写正文，不要解释。',
      '总长度 150–260 字，直接用短段落输出。'
    ].join('\n')
    void ai.run({
      task: 'outline',
      messages: buildOutlineMessages(project, instruction),
      // 提示词要求 150–260 字，按 420 字给正文预算 + 思考余量；
      // 之前这里预算偏紧时模型被截断，吐出来的就是半句话
      maxTokens: tokensForWords(420),
      temperature: 0.7
    })
  }

  useEffect(() => {
    if (!nodeId || !node) return
    generate(node)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [ai.text])

  const apply = (): void => {
    if (!node) return
    const text = ai.text.trim()
    if (!text) {
      toast('还没有生成内容', 'info')
      return
    }
    // 被截断的半句话不该直接写进章纲——宁可让作者点「重新生成」，
    // 也不要留下一段读到一半就断掉的摘要
    if (ai.truncated || looksUnfinished(text)) {
      const why = ai.truncated ? '这次输出被截断了' : '这段文字看起来没写完'
      const ok = window.confirm(`${why}，结尾可能不完整。仍然写入吗？\n\n建议先点「重新生成」。`)
      if (!ok) return
    }
    const targetId = node.id
    const walk = (list: OutlineNode[]): OutlineNode[] =>
      list.map((n) =>
        n.id === targetId
          ? { ...n, summary: text }
          : n.children.length
            ? { ...n, children: walk(n.children) }
            : n
      )
    patchProject((p) => ({ ...p, outline: walk(p.outline) }))
    toast('章纲已写入摘要', 'ok')
    onClose()
  }

  const footer = (
    <>
      <span className="mr-auto text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
        {ai.running ? '生成中…' : '可直接编辑后再写入'}
      </span>
      {!ai.running && (ai.truncated || looksUnfinished(ai.text)) ? (
        <span className="text-[11px]" style={{ color: 'var(--warning, #b26a00)' }}>
          {ai.truncated ? '输出被截断，结尾可能不完整' : '这段好像没写完'}
        </span>
      ) : null}
      {ai.running ? (
        <Button variant="danger" onClick={ai.stop}>
          <CircleStop size={13} /> 停止
        </Button>
      ) : (
        <>
          <Button onClick={() => node && generate(node)} title="用同一个要求再跑一次">
            <Sparkles size={13} /> 重新生成
          </Button>
          <Button onClick={apply} disabled={!ai.text.trim()} variant="primary">
            写入摘要
          </Button>
        </>
      )}
    </>
  )

  return (
    <Modal open={!!node} onClose={onClose} title={node ? `生成本章章纲 · ${node.title}` : '生成本章章纲'} width={680} footer={footer}>
      {ai.running && !ai.text ? (
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
          <Sparkles size={13} />
          {ai.thought
            ? `模型正在思考…（已 ${ai.thought.length} 字，已等待 ${Math.round(ai.elapsedMs / 1000)} 秒）`
            : `正在构思这一章的情节点…（已等待 ${Math.round(ai.elapsedMs / 1000)} 秒）`}
        </div>
      ) : (
        <div ref={scrollRef} className="max-h-[46vh] overflow-auto scroll-thin">
          <Textarea
            value={ai.text}
            onChange={(e) => ai.setText(e.target.value)}
            rows={12}
            readOnly={ai.running}
            className="text-[12.5px]"
            style={{ fontFamily: 'var(--ui-font)', lineHeight: 1.8 }}
          />
        </div>
      )}
    </Modal>
  )
}