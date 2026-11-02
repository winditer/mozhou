import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import { Bold, Italic, Heading1, Heading2, List, ListOrdered, Quote, Redo2, Strikethrough, Undo2 } from 'lucide-react'
import type { Chapter } from '@shared/types'
import { IconButton } from './ui'
import { useApp } from '../store/app'

/** 光标在段落里的断点：用来做「半句续写」与「重写本段」 */
export interface CaretContext {
  /** 光标之前、同一段落里已经写下的文字 */
  anchorText: string
  /** 光标之后、同一段落里已经写下的文字 */
  tailText: string
  /** 光标所在段落的整段原文 */
  paragraph: string
  /** 段落内容的绝对起点（重写本段时整段替换用） */
  from: number
  /** 段落内容的绝对终点（不含） */
  to: number
  /** 光标是否停在段首 */
  atParagraphStart: boolean
}

/** 从编辑器状态里读出光标所在段落的断点信息 */
export function readCaretContext(ed: Editor): CaretContext | null {
  const { $from, from } = ed.state.selection
  const depth = $from.depth
  if (depth < 1) return null
  const start = $from.start(depth)
  const paragraph = $from.parent.textContent
  const offset = Math.min(Math.max(0, from - start), paragraph.length)
  // 段落的绝对范围：start 是段内容起点，end 是段内容终点
  const paraFrom = start - 1
  const paraTo = start + $from.parent.content.size
  return {
    anchorText: paragraph.slice(0, offset),
    tailText: paragraph.slice(offset),
    paragraph,
    from: paraFrom,
    to: paraTo,
    atParagraphStart: offset === 0
  }
}

export function BookEditor({
  chapter,
  focusMode,
  typewriter,
  dimUnfocused,
  onChange,
  onReady,
  onSelectionChange,
  onCaretChange
}: {
  chapter: Chapter | null
  focusMode: boolean
  typewriter: boolean
  dimUnfocused: boolean
  onChange: (html: string) => void
  onReady?: (editor: Editor | null) => void
  onSelectionChange?: (sel: { text: string; from: number; to: number } | null) => void
  /**
   * 光标所在段落的断点信息。作者真正卡住的地方往往在半句话中间，
   * 所以写作台需要知道：光标前写了什么、光标后还剩什么、整段是什么。
   */
  onCaretChange?: (caret: CaretContext | null) => void
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false
      }),
      // showOnlyCurrent: false → 不只看光标所在段落，空文档里的任何空段落都能出提示；
      // emptyNodeClass 让 CSS 有稳定的钩子（.is-empty），不依赖 :first-child
      Placeholder.configure({
        placeholder: '在这里开始写。也可以先让 AI 起个头 —— 选中文字或点右侧「续写」。',
        showOnlyCurrent: false,
        emptyNodeClass: 'is-empty'
      }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight
    ],
    content: chapter?.content || '<p></p>',
    editorProps: {
      attributes: {
        spellcheck: 'false',
        class: 'focus:outline-none'
      }
    },
    onUpdate: ({ editor: ed }) => {
      onChange(ed.getHTML())
    },
    onSelectionUpdate: ({ editor: ed }) => {
      const { from, to } = ed.state.selection
      if (to > from) {
        onSelectionChange?.(ed.state.doc.textBetween(from, to, '\n').trim() ? { text: ed.state.doc.textBetween(from, to, '\n'), from, to } : null)
      } else {
        onSelectionChange?.(null)
      }
      onCaretChange?.(readCaretContext(ed))
      if (!typewriter) return
      const container = scrollRef.current
      if (!container) return
      try {
        const { from } = ed.state.selection
        const coords = ed.view.coordsAtPos(from)
        const box = container.getBoundingClientRect()
        const target = coords.top - box.top - box.height * 0.42
        if (Math.abs(target) > 24) container.scrollBy({ top: target, behavior: 'smooth' })
      } catch {
        /* 忽略 */
      }
    }
  })

  useEffect(() => {
    onReady?.(editor)
  }, [editor, onReady])

  // 切换章节时同步内容（只依赖章节 id，避免输入时被打断）。
  // externalEditRev：对话改稿 / 撤销这类**非打字**的外部改动会自增，
  // 让「正在编辑的这一章」也能立刻刷新——否则会出现「数据改了、屏幕上还是旧文」。
  const chapterId = chapter?.id ?? null
  const externalEditRev = useApp((s) => s.externalEditRev)
  useEffect(() => {
    if (!editor) return
    const html = chapter?.content || '<p></p>'
    if (editor.getHTML() !== html) {
      editor.commands.setContent(html, { emitUpdate: false })
    }
    if (externalEditRev === 0) scrollRef.current?.scrollTo({ top: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, editor, externalEditRev])

  /*
   * 正文列的居中偏移。
   *
   * 主区宽度会随「AI 面板 / 搜索 / 旁批 / 章节列表 / 图标栏」开关而变化，而 CSS 的
   * margin:auto 居中是不可过渡的——面板一关，正文是「瞬移」过去的，看起来像位置算错了。
   * 这里把「(可用宽 - 页宽)/2」算成 px，交给 CSS transition 去滑动。
   */
  const [shift, setShift] = useState(0)
  const [shiftReady, setShiftReady] = useState(false)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => {
      const pageW = parseFloat(getComputedStyle(el).getPropertyValue('--editor-width')) || 760
      // clientWidth 已排除滚动条；页宽比可用宽还大时贴左（此时 max-width 自然收窄）
      setShift(Math.max(0, Math.round((el.clientWidth - pageW) / 2)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 首次量完再开过渡，避免启动时正文从左边滑进来
  useEffect(() => {
    const id = requestAnimationFrame(() => setShiftReady(true))
    return () => cancelAnimationFrame(id)
  }, [])

  if (!chapter) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-[13px]" style={{ color: 'var(--text-faint)' }}>
          在左侧选择或新建一章开始写作
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col" style={{ background: 'var(--editor-bg)' }}>
      {!focusMode && (
        <div
          className="flex items-center gap-0.5 px-3 h-9 shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <IconButton
            onClick={() => editor?.chain().focus().toggleBold().run()}
            active={editor?.isActive('bold')}
            title="加粗 ⌘B"
          >
            <Bold size={14} />
          </IconButton>
          <IconButton
            onClick={() => editor?.chain().focus().toggleItalic().run()}
            active={editor?.isActive('italic')}
            title="斜体 ⌘I"
          >
            <Italic size={14} />
          </IconButton>
          <IconButton
            onClick={() => editor?.chain().focus().toggleStrike().run()}
            active={editor?.isActive('strike')}
            title="删除线"
          >
            <Strikethrough size={14} />
          </IconButton>
          <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
          <IconButton
            onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
            active={editor?.isActive('heading', { level: 1 })}
            title="一级标题"
          >
            <Heading1 size={14} />
          </IconButton>
          <IconButton
            onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
            active={editor?.isActive('heading', { level: 2 })}
            title="二级标题"
          >
            <Heading2 size={14} />
          </IconButton>
          <IconButton
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
            active={editor?.isActive('blockquote')}
            title="引用"
          >
            <Quote size={14} />
          </IconButton>
          <IconButton
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
            active={editor?.isActive('bulletList')}
            title="无序列表"
          >
            <List size={14} />
          </IconButton>
          <IconButton
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
            active={editor?.isActive('orderedList')}
            title="有序列表"
          >
            <ListOrdered size={14} />
          </IconButton>
          <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
          <IconButton
            onClick={() => editor?.chain().focus().undo().run()}
            disabled={!editor?.can().undo()}
            title="撤销 ⌘Z"
          >
            <Undo2 size={14} />
          </IconButton>
          <IconButton
            onClick={() => editor?.chain().focus().redo().run()}
            disabled={!editor?.can().redo()}
            title="重做 ⇧⌘Z"
          >
            <Redo2 size={14} />
          </IconButton>
        </div>
      )}

      <div
        ref={scrollRef}
        className={`flex-1 min-h-0 overflow-auto scroll-thin mz-editor ${dimUnfocused ? 'dim-unfocused' : ''} ${typewriter ? 'typewriter' : ''} ${shiftReady ? 'shift-ready' : ''}`}
        style={{ '--editor-shift': `${shift}px` } as CSSProperties}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}