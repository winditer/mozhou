import { useEffect, useState, type ReactNode } from 'react'
import type { Project } from '@shared/types'
import { useApp } from '../../store/app'
import { Button, Modal, Textarea } from '../../components/ui'
import { Sparkles } from 'lucide-react'

/**
 * 查看 / 编辑本章梗概。
 * 梗概同时存在两个地方：chapter.summary（章节自身）和 project.summaries[chapterId]（上下文缓存），
 * 保存与清空都要一起改，否则后续生成时读到的和界面上看到的会不一致。
 */
export function ChapterSummaryModal({
  project,
  chapterId,
  onClose,
  onGenerate
}: {
  project: Project
  chapterId: string | null
  onClose: () => void
  onGenerate: (chapterId: string) => void
}): ReactNode {
  const { patchChapter, patchProject, toast } = useApp()
  const [text, setText] = useState('')

  const index = project.chapters.findIndex((c) => c.id === chapterId)
  const chapter = index >= 0 ? project.chapters[index] : null

  // 每次打开（或切换章节）都从磁盘上的当前值开始编辑
  useEffect(() => {
    if (!chapterId) return
    const c = project.chapters.find((x) => x.id === chapterId)
    setText((project.summaries[chapterId] || c?.summary || '').trim())
    // 只在打开/切换章节时初始化；编辑过程中 project 的其它更新不该覆盖输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId])

  const save = (): void => {
    if (!chapter) return
    const next = text.trim()
    patchChapter(chapter.id, { summary: next })
    patchProject((p) => {
      const summaries = { ...p.summaries }
      if (next) summaries[chapter.id] = next
      else delete summaries[chapter.id]
      return { ...p, summaries }
    })
    toast(next ? '梗概已保存' : '梗概已清空', 'ok')
    onClose()
  }

  return (
    <Modal
      open={Boolean(chapter)}
      onClose={onClose}
      width={640}
      title={
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13.5px] font-semibold truncate">本章梗概</span>
          {chapter && (
            <span className="text-[11.5px] truncate" style={{ color: 'var(--text-faint)' }}>
              第 {index + 1} 章 · {chapter.title || '未命名'}
            </span>
          )}
        </div>
      }
      footer={
        <div className="flex items-center gap-2 w-full">
          <Button
            size="sm"
            variant="ghost"
            disabled={!chapter}
            onClick={() => chapter && onGenerate(chapter.id)}
            title="用 AI 重新通读本章并生成梗概"
          >
            <Sparkles size={12} /> 让 AI 重新生成
          </Button>
          <div className="flex-1" />
          <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {text.trim().length} 字
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!text.trim()}
            onClick={() => setText('')}
            style={{ color: 'var(--danger)' }}
          >
            清空
          </Button>
          <Button size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" variant="primary" disabled={!chapter} onClick={save}>
            保存
          </Button>
        </div>
      }
    >
      <div className="p-4">
        <div className="text-[11.5px] leading-relaxed mb-2" style={{ color: 'var(--text-faint)' }}>
          梗概会作为「更早章节梗概」写进后续章节的提示词，全书体检也会复用它。写得越具体，AI 越不容易忘前情。
        </div>
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="这一章发生了什么：谁做了什么、关键转折、埋下或回收了什么线索。"
          style={{ minHeight: 190, fontSize: 12.5, lineHeight: 1.7 }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              save()
            }
          }}
        />
        <div className="mt-1.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          ⌘↵ 保存 · Esc 关闭
        </div>
      </div>
    </Modal>
  )
}