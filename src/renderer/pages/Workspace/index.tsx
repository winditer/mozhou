import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Editor } from '@tiptap/react'
import type { Chapter } from '@shared/types'
import { useApp, resolveTaskModel } from '../../store/app'
import { getScene } from '@shared/scenes'
import { getGenre } from '@shared/genres'
import { countWords, estimateTokens, formatNumber, stripHtml } from '@shared/utils'
import { BookEditor, readCaretContext, type CaretContext } from '../../components/BookEditor'
import { AIPanel } from '../../components/AIPanel'
import { GenModal, type GenConfig } from '../../components/GenModal'
import { ChapterList } from './ChapterList'
import { ChapterSummaryModal } from './ChapterSummaryModal'
import { ProofreadPanel } from './ProofreadPanel'
import { SearchPanel } from './SearchPanel'
import { collectBlocks, plainOffsetToPos, type SearchHit } from '../../lib/search'
import { OutlineTab } from './OutlineTab'
import { BibleTab } from './BibleTab'
import { IdeasTab } from './IdeasTab'
import { StatsTab } from './StatsTab'
import { StyleTab } from './StyleTab'
import { AuditTab } from './AuditTab'
import { Button, Progress } from '../../components/ui'
import { BarChart3, Download, FileSearch, Fingerprint, Info, Lightbulb, ListTree, Maximize2, PenLine, Search, Sparkles, Stethoscope, Users, Wand2 } from 'lucide-react'
import { ProjectInfoModal } from '../../components/ProjectInfoModal'
import { generateDraft, generateSelection, generateSummary, textToParagraphHtml } from '../../lib/generate'
import { DE_AI_INSTRUCTION, summarizeProof } from '../../lib/textcraft'
import { abortChat } from '../../lib/ai'
import { mz } from '../../lib/bridge'

const RAIL: { key: 'write' | 'outline' | 'bible' | 'ideas' | 'style' | 'audit' | 'stats'; label: string; icon: ReactNode }[] = [
  { key: 'write', label: '写作', icon: <PenLine size={17} /> },
  { key: 'outline', label: '大纲', icon: <ListTree size={17} /> },
  { key: 'bible', label: '设定', icon: <Users size={17} /> },
  { key: 'ideas', label: '灵感', icon: <Lightbulb size={17} /> },
  { key: 'style', label: '文风', icon: <Fingerprint size={17} /> },
  { key: 'audit', label: '体检', icon: <Stethoscope size={17} /> },
  { key: 'stats', label: '统计', icon: <BarChart3 size={17} /> }
]

export function Workspace(): ReactNode {
  const project = useApp((s) => s.project)
  const tab = useApp((s) => s.tab)
  const setTab = useApp((s) => s.setTab)
  const config = useApp((s) => s.config)
  /** 系统文风分身库：正文/改写都要用它解析引用型分身，否则会退回引用时的旧快照 */
  const styleLibrary = useApp((s) => s.styleLibrary)
  const activeChapterId = useApp((s) => s.activeChapterId)
  const aiPanelOpen = useApp((s) => s.aiPanelOpen)
  const toggleAiPanel = useApp((s) => s.toggleAiPanel)
  const patchSettings = useApp((s) => s.patchSettings)
  const patchChapter = useApp((s) => s.patchChapter)
  const patchProject = useApp((s) => s.patchProject)
  const flush = useApp((s) => s.flush)
  const toast = useApp((s) => s.toast)

  const editorRef = useRef<Editor | null>(null)
  const [sel, setSel] = useState<{ text: string; from: number; to: number } | null>(null)
  const [caret, setCaret] = useState<CaretContext | null>(null)
  const [proofOpen, setProofOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [gen, setGen] = useState<GenConfig | null>(null)
  /** 正在查看/编辑梗概的章节 id（null = 弹窗关闭） */
  const [summaryFor, setSummaryFor] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  /** 进入沉浸前的系统全屏状态，退出时还原 */
  const wasFullscreenRef = useRef(false)

  const focusMode = config?.settings.focusMode ?? false

  const chapter = useMemo(
    () => project?.chapters.find((c) => c.id === activeChapterId) ?? null,
    [project, activeChapterId]
  )

  const setFocusMode = useCallback(
    async (next: boolean): Promise<void> => {
      if (next) {
        try {
          wasFullscreenRef.current = await mz.app.isFullScreen()
        } catch {
          wasFullscreenRef.current = false
        }
        mz.app.setFullScreen(true)
      } else {
        mz.app.setFullScreen(wasFullscreenRef.current)
      }
      void patchSettings({ focusMode: next })
    },
    [patchSettings]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      // ⌘J 统一由 App 全局处理（所有页面一致），这里只管沉浸与 Esc
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        void setFocusMode(!focusMode)
        return
      }
      // ⌘F / Ctrl+F 打开搜索：全书与本章共用同一个面板，范围在里面切
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        setProofOpen(false)
        return
      }
      if (e.key !== 'Escape' || !focusMode) return
      // 有弹窗时让弹窗先处理 Esc；沉浸里的 AI 浮层优先关掉
      if (document.querySelector('[data-mz-modal]')) return
      if (aiPanelOpen) {
        toggleAiPanel()
        return
      }
      void setFocusMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusMode, aiPanelOpen, setFocusMode, toggleAiPanel])

  // 菜单「视图 → 沉浸写作」走主进程快捷键，这里接事件
  useEffect(() => mz.app.onToggleFocus(() => void setFocusMode(!useApp.getState().config?.settings.focusMode)), [setFocusMode])

  const onEditorReady = useCallback((ed: Editor | null) => {
    editorRef.current = ed
  }, [])

  const insertHtml = useCallback(
    (text: string, mode: 'cursor' | 'end' | 'replace') => {
      const ed = editorRef.current
      if (!ed || !chapter) return
      const html = textToParagraphHtml(text)
      if (!html) return
      if (mode === 'replace' && sel) {
        ed.chain().focus().insertContentAt({ from: sel.from, to: sel.to }, html).run()
      } else if (mode === 'end') {
        ed.chain().focus().insertContentAt(ed.state.doc.content.size, html).run()
      } else if (mode === 'cursor') {
        // 光标位置插入：写到半句话卡住时，续写应该接在这半句后面，
        // 而不是另起一段。但当前段落已经有后半句时，插入点要放在**本段末尾**，
        // 否则新文字会把原有的后半句从中间劈开。
        const c = readCaretContext(ed)
        if (c && c.tailText.trim()) {
          ed.chain().focus().insertContentAt({ from: c.to, to: c.to }, html).run()
        } else {
          ed.chain().focus().insertContent(html).run()
        }
      } else {
        ed.chain().focus().insertContent(html).run()
      }
      setSel(null)
    },
    [chapter, sel]
  )

  /**
   * 跳到某条搜索结果。
   *
   * 跨章时要先切章，等编辑器把内容换过来再定位——直接设光标会被
   * BookEditor 里「换章同步内容」的 effect 覆盖掉。所以这里用一次
   * requestAnimationFrame 兜住那一帧。
   */
  const jumpToHit = useCallback(
    (hit: SearchHit) => {
      const go = (): void => {
        const ed = editorRef.current
        if (!ed) return
        const blocks = collectBlocks(ed.state.doc)
        const pos = plainOffsetToPos(blocks, hit.start)
        if (pos < 0) {
          toast('这一处已经不在原文里了（可能刚改过）', 'error')
          return
        }
        const end = plainOffsetToPos(blocks, hit.end)
        ed.chain()
          .focus()
          .setTextSelection({ from: pos, to: end > pos ? end : pos })
          .scrollIntoView()
          .run()
      }
      const st = useApp.getState()
      if (hit.chapterId !== st.activeChapterId) {
        st.setActiveChapter(hit.chapterId)
        requestAnimationFrame(() => requestAnimationFrame(go))
      } else {
        go()
      }
    },
    [toast]
  )

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-[13px]" style={{ color: 'var(--text-faint)' }}>
          没有打开的作品
        </div>
      </div>
    )
  }

  const scene = getScene(project.sceneId)
  const genre = project.genreId ? getGenre(project.genreId) : undefined
  const totalWords = project.chapters.reduce((s, c) => s + c.words, 0)
  // 校读只看正文：标题行自带"第 1 章 xxx"的排版空格，不是笔误。
  // 这里按段落切开后丢掉第一行标题，再交给校读。
  const chapterPlain = chapter
    ? stripHtml(chapter.content)
        .split(/\n+/)
        .slice(1)
        .join('\n')
        .replace(/\n/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    : ''
  const proofCount = chapterPlain ? summarizeProof(chapterPlain).total : 0

  const needModel = (task: 'draft' | 'polish' | 'summary' | 'outline'): { channel: any; model: string; label: string } | null => {
    const r = resolveTaskModel(config, project, task)
    if (!r) {
      toast('还没有可用模型。请到「设置 → 渠道与模型」添加一个渠道并填写 API Key。', 'error')
      return null
    }
    return r
  }

  const startDraft = (instruction: string, mode: 'append' | 'replace', caretAtLaunch?: CaretContext | null): void => {
    const r = needModel('draft')
    if (!r || !chapter) return
    const target = chapter.targetWords || project.settings.targetWordsPerChapter || 2000
    // 半句续写：光标停在段落中间（段首之外、后面还有没写完的字或另一个段落）时，
    // 把「光标前的半句话」作为续写起点交给模型，生成结果插在光标处。
    const c = caretAtLaunch ?? null
    const midSentence = mode === 'append' && !!c && c.anchorText.trim().length > 0
    const anchorText = midSentence ? c!.anchorText : undefined
    const tailText = midSentence && c!.tailText.trim() ? c!.tailText : undefined
    // 长度守护的口径是「整章」，所以要把本章已经写下的字数交出去：
    // 接着半句写时，目标 2500 字的章里已有 2000 字，这次只该补 500，而不是再写 2500。
    const existingWords = mode === 'append' ? countWords(stripHtml(chapter.content)) : 0
    const remaining = Math.max(0, target - existingWords)
    setGen({
      title: mode === 'append' ? (midSentence ? '接着这半句写' : '续写本章') : '生成内容',
      hint: `模型：${r.label} · 目标约 ${formatNumber(target)} 字${
        mode === 'append' && existingWords > 0 ? `（本章已有 ${formatNumber(existingWords)} 字，还差约 ${formatNumber(remaining)} 字）` : ''
      }${midSentence ? ' · 从光标处接续' : ''} · 不足会自动补写`,
      expectWords: mode === 'append' && existingWords > 0 ? Math.max(120, remaining) : target,
      acceptLabel: mode === 'append' ? (midSentence ? '接到光标处' : '追加到正文') : '替换选区',
      run: (onDelta, onStage, onThought) =>
        generateDraft({
          project,
          chapter,
          channel: r.channel,
          model: r.model,
          task: 'draft',
          temperature: config?.settings.temperature ?? 0.85,
          library: styleLibrary,
          conventions: config?.settings.genreConventions,
          budgets: config?.settings.tokenBudgets,
          instruction: midSentence
            ? `${instruction}\n（注意：作者的句子只写了一半，你要顺着这半句话写下去，不要另起一段，也不要重写已经写出的部分。）`
            : instruction,
          targetWords: target,
          existingWords,
          selection: mode === 'replace' ? sel?.text : undefined,
          anchorText,
          tailText,
          onDelta,
          onThought,
          onStage
        })
    })
  }

  /** 重写光标所在段落：不是往文末追加，而是整段换掉 */
  const startRewriteParagraph = (caretAtLaunch: CaretContext | null): void => {
    const r = needModel('draft')
    if (!r || !chapter || !caretAtLaunch) return
    const original = caretAtLaunch.paragraph.trim()
    if (!original) {
      toast('这一段还是空的，先写点东西再让 AI 重写', 'error')
      return
    }
    const target = Math.max(120, countWords(original))
    const range = { from: caretAtLaunch.from, to: caretAtLaunch.to }
    setGen({
      title: '重写本段',
      hint: `原文 ${countWords(original)} 字 · 模型：${r.label} · 只替换这一段`,
      expectWords: target,
      acceptLabel: '替换本段',
      run: (onDelta, onStage, onThought) =>
        generateDraft({
          project,
          chapter,
          channel: r.channel,
          model: r.model,
          task: 'draft',
          temperature: config?.settings.temperature ?? 0.85,
          library: styleLibrary,
          conventions: config?.settings.genreConventions,
          budgets: config?.settings.tokenBudgets,
          instruction: '把这一段重写得更好：节奏更紧，句子更有张力，不要丢掉原有的情节信息。',
          targetWords: target,
          // 整段重写是「替换」，篇幅本来就该贴着原文走，强撑长度反而会把这一段灌水
          lengthGuard: false,
          rewriteParagraph: original,
          onDelta,
          onThought,
          onStage
        }),
      // 把整段范围记在弹窗上，采纳时用它替换而不是插入
      replaceRange: range
    })
  }

  const startSelection = (instruction: string, label: string): void => {
    if (!sel?.text) {
      toast('请先在正文里选中一段文字', 'error')
      return
    }
    const r = needModel('polish')
    if (!r) return
    const captured = sel.text
    setGen({
      title: label,
      hint: `已选中 ${countWords(captured)} 字 · 模型：${r.label}`,
      acceptLabel: '替换选中的文字',
      run: (onDelta, _onStage, onThought) =>
        generateSelection({
          project,
          chapter,
          channel: r.channel,
          model: r.model,
          task: 'polish',
          temperature: 0.7,
          library: styleLibrary,
          conventions: config?.settings.genreConventions,
          selection: captured,
          instruction,
          onDelta,
          onThought
        })
    })
  }

  const startSummary = (target?: Chapter | null): void => {
    const r = needModel('summary')
    const ch = target ?? chapter
    if (!r || !ch) return
    setGen({
      title: '生成本章梗概',
      hint: '梗概会用于后续章节的上下文，帮助 AI 记住前情。',
      acceptLabel: '保存为本章梗概',
      summaryChapterId: ch.id,
      run: (onDelta, _onStage, onThought) =>
        generateSummary({
          project,
          chapter: ch,
          channel: r.channel,
          model: r.model,
          task: 'summary',
          temperature: 0.3,
          onDelta,
          onThought
        })
    })
  }

  const exportAs = async (kind: 'md' | 'txt' | 'html' | 'docx' | 'pdf'): Promise<void> => {
    setExportOpen(false)
    const items = project.chapters.map((c) => ({ title: c.title, content: c.content || '<p></p>' }))
    if (!items.length) {
      toast('还没有章节可以导出', 'error')
      return
    }
    try {
      const res = await mz.io.exportFile({ kind, title: project.title, items })
      if (res?.message) toast(`导出失败：${res.message}`, 'error')
      else if (!res?.canceled) toast(`已导出到 ${res?.path ?? ''}`, 'ok')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const importDoc = async (): Promise<void> => {
    setExportOpen(false)
    try {
      const picked = await mz.io.importFile()
      if (picked?.canceled) return
      if (!picked?.content) {
        toast(picked?.message || '没有读取到文件内容', 'error')
        return
      }
      const chapters = await mz.io.importChapters(picked.content)
      if (!chapters?.length) {
        toast('没有解析出章节，请确认文件是纯文本或 Markdown', 'error')
        return
      }
      patchProject((prev) => ({ ...prev, chapters: [...prev.chapters, ...chapters] }))
      toast(`已导入 ${chapters.length} 章，共 ${formatNumber(chapters.reduce((a, c) => a + c.words, 0))} 字`, 'ok')
    } catch (e) {
      toast(`导入失败：${(e as Error).message}`, 'error')
    }
  }

  const ctxTokens = estimateTokens(
    [project.brief.logline, project.brief.premise, ...project.chapters.slice(-2).map((c) => c.content)].join('')
  )

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧图标导航 */}
      <div
        className="flex flex-col items-center py-2 shrink-0"
        style={{
          width: 54,
          background: 'var(--sidebar)',
          borderRight: '1px solid var(--border)',
          display: focusMode ? 'none' : undefined
        }}
      >
        {RAIL.map((r) => (
          <button
            key={r.key}
            onClick={() => setTab(r.key)}
            className="flex flex-col items-center justify-center gap-0.5 rounded-lg mb-1 transition-colors"
            style={{
              width: 42,
              height: 44,
              background: tab === r.key ? 'var(--accent-soft)' : 'transparent',
              color: tab === r.key ? 'var(--accent)' : 'var(--text-faint)'
            }}
            title={r.label}
          >
            {r.icon}
            <span className="text-[9.5px]">{r.label}</span>
          </button>
        ))}
        <div className="flex-1" />
        <button
          className="flex flex-col items-center justify-center rounded-lg"
          style={{ width: 42, height: 40, color: 'var(--text-faint)' }}
          title="作品信息"
          onClick={() => setInfoOpen(true)}
        >
          <Info size={16} />
        </button>
        <button
          className="flex flex-col items-center justify-center rounded-lg"
          style={{ width: 42, height: 40, color: 'var(--text-faint)' }}
          title="导出整本"
          onClick={() => setExportOpen((v) => !v)}
        >
          <Download size={16} />
        </button>
      </div>

      {tab === 'write' && !focusMode && (
        <ChapterList project={project} onEditSummary={(id) => setSummaryFor(id)} />
      )}

      {/* 主区域 */}
      <div className="flex-1 min-w-0 flex flex-col" style={{ background: 'var(--editor-bg)' }}>
        {tab === 'write' && (
          <>
            <div
              className="flex items-center gap-2 px-4 h-11 shrink-0"
              style={{
                display: focusMode ? 'none' : undefined,
                background: 'var(--panel)',
                borderBottom: '1px solid var(--border)'
              }}
            >
              <input
                value={chapter?.title ?? ''}
                onChange={(e) => chapter && patchChapter(chapter.id, { title: e.target.value })}
                placeholder="章节标题"
                className="bg-transparent outline-none text-[13.5px] font-medium min-w-0 flex-1"
                style={{ color: 'var(--text)' }}
              />
              <span className="text-[11px] shrink-0" style={{ color: 'var(--text-faint)' }}>
                {scene.name}
                {genre ? ` · ${genre.name}` : ''}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSearchOpen(!searchOpen)
                    if (!searchOpen) setProofOpen(false)
                  }}
                  title="搜索正文 ⌘F（本章 / 全书）"
                >
                  <Search size={13} /> 搜索
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setProofOpen(!proofOpen)
                    if (!proofOpen) setSearchOpen(false)
                  }}
                  title="正文校读：标点、空格、重复词"
                >
                  <FileSearch size={13} /> 校读{proofCount > 0 ? ` ${proofCount}` : ''}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => startSummary()} title="用 AI 生成本章梗概">
                  本章梗概
                </Button>
                <Button size="sm" variant="ghost" disabled={!sel} onClick={() => startSelection('润色这段文字，保持原意与信息量，提升可读性与画面感。', '润色')}>
                  润色
                </Button>
                <Button
                  size="sm"
                  onClick={() => startDraft('接着本章已写的内容往下写，保持节奏与文风，不要重复前文，也不要写总结。', 'append', caret)}
                  title={caret?.anchorText.trim() ? '从光标处接着这半句写' : '在章末续写'}
                >
                  <Sparkles size={13} /> {caret?.anchorText.trim() ? '接着这半句' : '续写'}
                </Button>
                {caret?.paragraph.trim() ? (
                  <Button size="sm" variant="ghost" onClick={() => startRewriteParagraph(caret)} title="整段重写光标所在的这一段">
                    <Wand2 size={13} /> 重写本段
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => void setFocusMode(true)} title="沉浸写作（⌘⇧F）">
                  <Maximize2 size={13} /> 沉浸
                </Button>
              </div>
            </div>

            {sel && (
              <div
                className="flex items-center gap-2 px-4 h-9 shrink-0 text-[11.5px]"
                style={{ background: 'var(--accent-soft)', borderBottom: '1px solid var(--border)' }}
              >
                <span style={{ color: 'var(--accent)' }}>已选中 {countWords(sel.text)} 字</span>
                <div className="flex-1" />
                {[
                  { label: '扩写', ins: '把这段内容扩写得更细致，补充动作、环境与心理细节，篇幅约为原文的 1.8 倍。' },
                  { label: '精简', ins: '精简这段文字，删掉冗余修辞与重复信息，保留所有关键情节，篇幅压缩到原文的 60%。' },
                  { label: '改写', ins: '在保持情节不变的前提下重写这段，换一种表达方式，让节奏更紧、句子更有张力。' },
                  { label: '去 AI 味', ins: DE_AI_INSTRUCTION },
                  ...scene.actions.slice(0, 3).map((a) => ({ label: a.label, ins: a.instruction }))
                ].map((a) => (
                  <button
                    key={a.label}
                    className="px-2 h-6 rounded transition-colors"
                    style={{ background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text-dim)' }}
                    onClick={() => startSelection(a.ins, a.label)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}

            <BookEditor
              chapter={chapter}
              focusMode={config?.settings.focusMode ?? false}
              typewriter={config?.settings.typewriter ?? false}
              dimUnfocused={config?.settings.typography.dimUnfocused ?? false}
              onChange={(html) => chapter && patchChapter(chapter.id, { content: html })}
              onReady={onEditorReady}
              onSelectionChange={setSel}
              onCaretChange={setCaret}
            />

            {(config?.settings.showWordCountBar ?? true) && !focusMode && (
              <div
                className="flex items-center gap-3 px-4 h-8 shrink-0 text-[11px]"
                style={{ background: 'var(--panel)', borderTop: '1px solid var(--border)', color: 'var(--text-faint)' }}
              >
                <span>
                  本章 <strong style={{ color: 'var(--text-dim)' }}>{formatNumber(chapter?.words ?? 0)}</strong> 字
                  {chapter?.targetWords ? ` / 目标 ${formatNumber(chapter.targetWords)}` : ''}
                </span>
                {chapter?.targetWords ? (
                  <div style={{ width: 90 }}>
                    <Progress value={chapter.words} max={chapter.targetWords} height={4} />
                  </div>
                ) : null}
                <span>全书 {formatNumber(totalWords)} 字</span>
                <div className="flex-1" />
                <span>上下文约 {formatNumber(ctxTokens)} tk</span>
                <span>· 自动保存已开启</span>
              </div>
            )}
          </>
        )}

        {tab === 'outline' && (
          <div className="flex-1 min-h-0 overflow-auto">
            <OutlineTab />
          </div>
        )}
        {tab === 'bible' && (
          <div className="flex-1 min-h-0 overflow-auto">
            <BibleTab />
          </div>
        )}
        {tab === 'ideas' && (
          <div className="flex-1 min-h-0">
            <IdeasTab project={project} />
          </div>
        )}
        {tab === 'style' && (
          <div className="flex-1 min-h-0">
            <StyleTab project={project} />
          </div>
        )}
        {tab === 'audit' && (
          <div className="flex-1 min-h-0">
            <AuditTab project={project} />
          </div>
        )}
        {tab === 'stats' && (
          <div className="flex-1 min-h-0">
            <StatsTab project={project} />
          </div>
        )}
      </div>

      {tab === 'write' && searchOpen && !focusMode && (
        <div
          className="shrink-0 h-full flex flex-col"
          style={{ width: 320, background: 'var(--sidebar)', borderLeft: '1px solid var(--border)' }}
        >
          <SearchPanel
            project={project}
            chapterId={chapter?.id ?? null}
            onJump={jumpToHit}
            onClose={() => setSearchOpen(false)}
          />
        </div>
      )}

      {tab === 'write' && proofOpen && !searchOpen && !focusMode && (
        <div
          className="shrink-0 h-full flex flex-col"
          style={{ width: 320, background: 'var(--sidebar)', borderLeft: '1px solid var(--border)' }}
        >
          <ProofreadPanel
            editor={editorRef.current}
            chapterKey={chapter?.id}
            onJump={(issue) => {
              const ed = editorRef.current
              if (!ed || !issue.snippet) return
              // 把光标移到这一处，作者能立刻看到上下文再决定改不改
              let found = -1
              ed.state.doc.descendants((node, pos) => {
                if (found >= 0) return false
                if (!node.isTextblock) return true
                const local = node.textContent.indexOf(issue.snippet)
                if (local >= 0) {
                  found = pos + 1 + local
                  return false
                }
                return true
              })
              if (found < 0) return
              ed.chain().focus().setTextSelection(found).run()
            }}
          />
        </div>
      )}

      {tab === 'write' && aiPanelOpen && !focusMode && (
        <AIPanel project={project} chapter={chapter} onInsertText={(t) => insertHtml(t, 'cursor')} />
      )}

      {/* 沉浸模式：AI 面板浮在右上，不占正文宽度 */}
      {tab === 'write' && aiPanelOpen && focusMode && (
        <div
          className="fixed z-40 rounded-xl overflow-hidden fade-in"
          style={{
            top: 52,
            right: 14,
            bottom: 52,
            width: 372,
            boxShadow: 'var(--shadow)',
            border: '1px solid var(--border)',
            background: 'var(--sidebar)'
          }}
        >
          <AIPanel project={project} chapter={chapter} onInsertText={(t) => insertHtml(t, 'cursor')} />
        </div>
      )}

      {/* 沉浸模式：浮动退出入口 */}
      {focusMode && (
        <div className="fixed z-50 flex items-center gap-2 fade-in" style={{ top: 14, left: 14 }}>
          <Button size="sm" onClick={() => void setFocusMode(false)} title="退出沉浸（Esc）">
            退出沉浸 <span className="opacity-60 ml-0.5">Esc</span>
          </Button>
          <span className="text-[11px] px-2 py-1 rounded-md" style={{ color: 'var(--text-faint)', background: 'var(--panel-2)' }}>
            {chapter ? `${chapter.title || '未命名'} · ${formatNumber(chapter.words)} 字` : ''}
            {aiPanelOpen ? ' · ⌘J 收起 AI' : ' · ⌘J 唤起 AI'}
          </span>
        </div>
      )}

      {exportOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
          <div
            className="fixed z-50 card p-1"
            style={{ left: 60, bottom: 56, width: 176, background: 'var(--panel)', boxShadow: 'var(--shadow)' }}
          >
            {(
              [
                ['md', 'Markdown (.md)'],
                ['txt', '纯文本 (.txt)'],
                ['docx', 'Word (.docx)'],
                ['pdf', 'PDF (.pdf)'],
                ['html', '网页 (.html)']
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                className="w-full text-left px-2.5 py-1.5 rounded text-[12px] surface-hover"
                onClick={() => void exportAs(k)}
              >
                {label}
              </button>
            ))}
            <div className="divider" />
            <button
              className="w-full text-left px-2.5 py-1.5 rounded text-[12px] surface-hover"
              onClick={() => {
                setExportOpen(false)
                void flush()
                toast('已保存', 'ok')
              }}
            >
              立即保存
            </button>
            <div className="divider" />
            <button
              className="w-full text-left px-2.5 py-1.5 rounded text-[12px] surface-hover"
              onClick={() => void importDoc()}
            >
              导入 TXT / Markdown
            </button>
          </div>
        </>
      )}

      <ProjectInfoModal
        open={infoOpen}
        project={project}
        onSave={async (next) => {
          patchProject(() => next)
          await flush()
        }}
        onClose={() => setInfoOpen(false)}
      />

      {summaryFor && (
        <ChapterSummaryModal
          project={project}
          chapterId={summaryFor}
          onClose={() => setSummaryFor(null)}
          onGenerate={(id) => {
            const target = project.chapters.find((c) => c.id === id) ?? null
            setSummaryFor(null)
            if (target) startSummary(target)
          }}
        />
      )}

      <GenModal
        config={gen}
        onClose={() => {
          abortChat()
          setGen(null)
        }}
        onAccept={(text) => {
          if (!gen) return
          if (gen.acceptLabel === '保存为本章梗概') {
            // 从章节列表里对某一章点「重新生成」时，要写回那一章，而不是碰巧打开的活动章
            const targetId = gen.summaryChapterId ?? chapter?.id
            if (!targetId) return
            const next = text.trim()
            patchChapter(targetId, { summary: next })
            patchProject((p) => {
              const summaries = { ...p.summaries }
              if (next) summaries[targetId] = next
              else delete summaries[targetId]
              return { ...p, summaries }
            })
            toast(next ? '梗概已保存' : '梗概已清空', 'ok')
            return
          }
          if (gen.replaceRange) {
            // 「重写本段」：整段换掉，不是追加
            const ed = editorRef.current
            const html = textToParagraphHtml(text)
            if (ed && html) {
              const size = ed.state.doc.content.size
              const from = Math.min(gen.replaceRange.from, size)
              const to = Math.min(gen.replaceRange.to, size)
              ed.chain().focus().insertContentAt({ from, to }, html).run()
            }
            return
          }
          if (gen.acceptLabel === '替换选区' || gen.acceptLabel === '替换选中的文字') insertHtml(text, 'replace')
          else if (gen.acceptLabel === '接到光标处') insertHtml(text, 'cursor')
          else insertHtml(text, 'end')
        }}
      />
    </div>
  )
}