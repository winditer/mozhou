import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Chapter, Project, ResearchMeta } from '@shared/types'
import { estimateTokens, relativeTime, uid } from '@shared/utils'
import { resolveTaskModel, useApp } from '../store/app'
import { assembleContext } from '../lib/prompt'
import { generateChatReply, generateCustom, generateDraft } from '../lib/generate'
import { research } from '../lib/research'
import { mz } from '../lib/bridge'
import { abortChat } from '../lib/ai'
import { isAbortMessage, streamStatus, useElapsed } from '../lib/stream'
import { Button, IconButton, Segmented, Switch, Textarea } from './ui'
import { ChatEditPreview } from './ChatEditPreview'
import { parseEditBlock } from '@shared/editProtocol'
import { resolveEdits, type ResolvedEdit } from '../lib/applyEdits'
import { runDraftJobs, type DraftJob, type DraftProgress } from '../lib/draftJobs'
import { SkillsPicker } from './SkillsPicker'
import { Check, Eye, EyeOff, MessageSquare, Send, Sparkles, Square, Trash2, Undo2, Wand2 } from 'lucide-react'

/**
 * 「让它重新读这一章再改」用的那句话。
 *
 * 为什么要在提问里再说一遍：模型最信的是它自己上文里那段完整正文，
 * 光靠 system 里的规则压不住。这里把它拽回【作品资料】的当前章节正文。
 */
const EDIT_RETRY_PROMPT =
  '重新摘录一遍改动：你上一批的 anchor 全都对不上书里的正文，多半是用上了你在对话里写过的那一版。请只从【作品资料】里的「当前章节正文」逐字复制 anchor（不要从你自己的上文里抄），对不上的地方直接说明，不要编。'

export function AIPanel({
  project,
  chapter,
  onInsertText
}: {
  project: Project
  chapter: Chapter | null
  onInsertText: (text: string) => void
}): ReactNode {
  const { config, patchProject, toast, patchSettings, applyEditBatch, undoLastEditBatch, lastEditUndo } = useApp()
  const allowEdits = config?.settings.allowChatEdits !== false
  // 预览弹窗用的定位结果：打开那一刻按当时正文算，之后正文再变也不会串
  const [preview, setPreview] = useState<{ msgId: string; edits: ResolvedEdit[] } | null>(null)
  // 撤销入口只在 30 秒内给：这类改动本来就该当场看着不对就撤，久了也没人能判断该不该撤
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!lastEditUndo) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [lastEditUndo])
  const canUndo = Boolean(lastEditUndo && now - lastEditUndo.at < 30_000)
  /**
   * 应用完建章之后去写稿。
   *
   * 章节 id 不能从改动里拿（建章是 applyEditBatch 里现生成的），所以按标题回查——
   * 标题在定位层已经去过重，回查是准的。
   */
  const startDrafts = async (kept: ResolvedEdit[], msgId?: string): Promise<void> => {
    const st = useApp.getState()
    const project0 = st.project
    if (!project0) return
    const jobs: DraftJob[] = []
    for (const e of kept) {
      if (e.draftTarget) {
        const ch = project0.chapters.find((c) => c.title === e.draftTarget?.title)
        if (ch) jobs.push({ chapterId: ch.id, title: ch.title, targetWords: e.draftTarget.targetWords, continueOnly: false })
      } else if (e.writeTarget) {
        const ch = project0.chapters.find((c) => c.id === e.writeTarget?.chapterId)
        jobs.push({
          chapterId: e.writeTarget.chapterId,
          title: ch?.title ?? '这一章',
          targetWords: e.writeTarget.targetWords,
          continueOnly: e.writeTarget.continueOnly
        })
      }
    }
    if (!jobs.length) return

    const picked = resolveTaskModel(st.config, project0, 'draft')
    if (!picked) {
      toast('没有配置起草模型，章建好了但没写稿。去设置里选一个模型，再说「写第 N 章」即可。', 'error')
      return
    }
    const wordsBefore = new Map(project0.chapters.map((c) => [c.id, c.words || 0]))
    stopDraftRef.current = false
    setDrafting({
      chapterId: jobs[0].chapterId,
      title: jobs[0].title,
      written: 0,
      target: jobs[0].targetWords,
      index: 0,
      total: jobs.length
    })
    const res = await runDraftJobs(jobs, {
      generate: (a) =>
        generateDraft({
          project: a.project,
          chapter: a.chapter,
          channel: picked.channel,
          model: picked.model,
          task: 'draft',
          temperature: st.config?.settings.temperature ?? 0.85,
          library: st.styleLibrary,
          skillLibrary: st.skillLibrary,
          conventions: st.config?.settings.genreConventions,
          budgets: st.config?.settings.tokenBudgets,
          instruction: a.instruction,
          targetWords: a.targetWords,
          existingWords: a.existingWords,
          onDelta: a.onDelta,
          onStage: a.onStage,
          onThought: a.onThought
        }),
      getProject: () => useApp.getState().project,
      // 写稿是把正文从外面塞进 store：不 bump externalEditRev，编辑器就还显示建章时的空稿
      patch: (id, patch) => {
        useApp.getState().patchChapter(id, patch)
        useApp.getState().markExternalEdit()
      },
      focus: (id) => useApp.getState().setActiveChapter(id),
      onProgress: (p) => setDrafting(p),
      onStage: (stage) => setDrafting((d) => (d ? { ...d, title: stage } : d)),
      shouldStop: () => stopDraftRef.current,
      flushMs: 500
    })
    setDrafting(null)
    const fin = useApp.getState().project
    const written = jobs.reduce((sum, j) => {
      const w = fin?.chapters.find((c) => c.id === j.chapterId)?.words || 0
      return sum + Math.max(0, w - (wordsBefore.get(j.chapterId) ?? 0))
    }, 0)
    if (written > 0 && msgId) {
      useApp.getState().patchProject((p) => ({
        ...p,
        chat: p.chat.map((m) => (m.id === msgId ? { ...m, draftWords: written } : m))
      }))
    }
    if (res.stopped) toast('写稿已停止，已写的部分留在正文里；说「继续写这一章」可以接着写。', 'error')
    else if (res.failed && !res.ok) toast('写稿失败，章建好了但正文是空的。说「写第 N 章」可以重试。', 'error')
    else if (res.ok) toast(`写完了 ${res.ok} 章初稿，可在章节版本历史里回退。`, 'ok')
  }


  // 写稿任务的进度（null = 没在写）；stopDraftRef 用 ref 是因为停止要给 runDraftJobs 读到最新值
  const [drafting, setDrafting] = useState<DraftProgress | null>(null)
  const stopDraftRef = useRef(false)
  // 标签页是本地 state，但外部（截图脚本、E2E）需要能切到「上下文」去看注入预览。
  // 挂一个只读跳转钩子，行为与点标签页完全一致。
  const [tab, setTab] = useState<'chat' | 'context'>('chat')
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__MZ_AI_PANEL = { go: (id: string) => setTab(id as 'chat' | 'context') }
  }, [])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [thought, setThought] = useState('')
  const [stage, setStage] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const resolved = resolveTaskModel(config, project, 'chat')
  const elapsed = useElapsed(streaming)
  const webSearch = config?.settings.webSearch
  // 本轮是否联网：作者每次发送前显式决定，不做自动判断
  const [withSearch, setWithSearch] = useState(false)
  const [searching, setSearching] = useState('')
  const searchReady = Boolean(webSearch?.enabled && webSearch.channelId)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [project.chat.length, draft])

  const send = async (question: string): Promise<void> => {
    const q = question.trim()
    if (!q || streaming) return
    if (!resolved) {
      toast('还没有可用模型，请到「设置 → 渠道与模型」里添加一个渠道并填写 Key', 'error')
      return
    }
    const history = project.chat.map((m) => ({ role: m.role, content: m.content }))
    const userMsg = { id: uid('m'), role: 'user' as const, content: q, at: Date.now() }
    patchProject((p) => ({ ...p, chat: [...p.chat, userMsg] }))
    setInput('')
    setDraft('')
    setThought('')
    setStage('')
    setStreaming(true)
    try {
      /*
       * 联网检索必须在生成之前：外部资料要作为 messages 的一部分进去。
       * 这里刻意吞掉一切异常——research() 内部已经把失败变成「未取得外部资料」块，
       * 真正抛出来的只可能是意想不到的编码错误，那种情况也不该让作者连问题都问不出去。
       */
      let external = ''
      let researchMeta: ResearchMeta | null = null
      if (withSearch && webSearch?.channelId) {
        setSearching('正在查资料…')
        setStage('正在联网检索…')
        try {
          const outcome = await research(q, {
            channelId: webSearch.channelId,
            maxResults: webSearch.maxResults,
            maxQueries: webSearch.maxQueries,
            run: (req) => mz.search.run(req),
            summarize: webSearch.summarize
              ? async (raw) => {
                  const st = useApp.getState()
                  const r2 = resolveTaskModel(st.config, st.project!, 'chat')
                  if (!r2) return null
                  return generateCustom({
                    project,
                    chapter,
                    channel: r2.channel,
                    model: r2.model,
                    task: 'chat',
                    // 压缩只要准，不要发挥
                    temperature: 0.2,
                    budgets: st.config?.settings.tokenBudgets,
                    system:
                      '你是资料整理员。把检索结果压成中文要点，保留所有数字、专名、单位与年代；不要评论、不要加标题、不要合并条目。每条一段，以 [编号] 开头，编号与输入一致。',
                    user: raw,
                    onDelta: () => {}
                  })
                }
              : undefined
          })
          external = outcome.text
          researchMeta = outcome.meta
          // 这一轮没查（纯创作指令或虚构体系）：说出来。
          // 不说的话作者只看到「联网·开」却没有任何来源，会以为检索静默坏了。
          if (outcome.skipped) {
            toast('这一轮没有联网：判断为创作指令或虚构设定，查到的反而是别人小说里的东西。', 'ok')
          }
        } catch {
          /* 检索整体失败：按未联网处理，下面照常生成 */
        } finally {
          setSearching('')
          setStage('')
        }
      }
      let acc = ''
      const r = await generateChatReply({
        project,
        chapter,
        channel: resolved.channel,
        model: resolved.model,
        task: 'chat',
        // 预算必须从设置里读：不传时 generateChatReply 会退回出厂默认（3000），
        // 于是「设置 → 输出预算 → 对话」改了多少都不生效，长回答永远被截在同一个位置。
        budgets: config?.settings.tokenBudgets,
        history,
        question: q,
        allowEdits,
        external,
        library: useApp.getState().styleLibrary,
        skillLibrary: useApp.getState().skillLibrary,
        conventions: useApp.getState().config?.settings.genreConventions,
        onDelta: (d) => {
          acc += d
          setDraft(acc)
        },
        onThought: (d) => setThought((t) => t + d),
        onStage: (s) => setStage(s)
      })
      const raw = (r.text || acc).trim()
      const parsed = allowEdits ? parseEditBlock(raw) : { text: raw, ops: [], errors: [] }
      const final = (parsed.text || (parsed.ops.length ? '（这一轮只给了改动，没有文字说明）' : '')).trim()
      if (!final) {
        // 一个字都没写：别往对话里塞一个空气泡，那看起来就像「AI 中断了」
        toast(
          r.thoughtStarved
            ? `模型把 ${r.maxTokens} 个输出额度全用在了思考上，没有留下正文。可以换个不思考的模型，或在「设置 → 输出预算 → 对话」里把额度调大（建议 8000 以上）。`
            : '模型这次没有返回任何正文，可以直接重发一次；若反复出现，换一个模型试试。',
          'error'
        )
        return
      }
      patchProject((p) => ({
        ...p,
        chat: [
          ...p.chat,
          {
            id: uid('m'),
            role: 'assistant' as const,
            content: final,
            at: Date.now(),
            model: resolved.model,
            truncated: r.truncated || undefined,
            // 检索痕迹挂在回答上：来源卡是"这句回答的依据"，刷新后要能重现
            research: researchMeta ?? undefined,
            // 改动先存着不落地：是否应用由作者在预览里决定
            edits: parsed.ops.length ? parsed.ops : undefined,
            editsError: parsed.errors.length ? parsed.errors.join('；') : undefined
          }
        ]
      }))
      if (r.truncated) {
        toast(`回答被 ${r.maxTokens} 的输出上限截断，末尾不完整。可在「设置 → 输出预算 → 对话」调大额度。`, 'error')
      } else if (parsed.ops.length) {
        // 顺手先定位一遍：全部落空时别用「提了 3 处修改」这种成功口吻骗作者点开
        const ok = resolveEdits(project, parsed.ops).filter((e) => e.status === 'found').length
        if (ok) toast(`AI 提出了 ${parsed.ops.length} 处修改，点「查看并应用」确认后才会动稿子。`, 'ok')
        else toast(`AI 提了 ${parsed.ops.length} 处改动，但原文都对不上——点开能看到原因，可以让它重新摘录。`, 'error')
      }
    } catch (e) {
      const msg = (e as Error).message
      // 主动停止不算错误
      if (!isAbortMessage(msg)) toast(msg, 'error')
    } finally {
      setStreaming(false)
      setDraft('')
      setThought('')
      setStage('')
    }
  }

  const quick = [
    { label: '接着往下写', q: '根据上文，接着往下写 500 字，保持同样的节奏与语气。' },
    { label: '接下来怎么发展', q: '基于当前冲突，给我 3 个接下来的剧情走向，并说明各自的爽点与风险。' },
    { label: '这段是不是太水', q: '帮我诊断当前章节：有没有注水、节奏拖沓的地方？指出具体段落并给修改建议。' },
    { label: '人物说话不像他', q: '检查本章对话，指出哪些台词不符合角色设定，并给出改写。' }
  ]

  return (
    <div className="flex flex-col h-full" style={{ width: 372, background: 'var(--sidebar)', borderLeft: '1px solid var(--border)' }}>
      {/* 标题栏只放「切换 + 模型 + 清空」：这三样是常驻的，必须一行放得下。
          写稿进度另起一条窄带——它带「停止」按钮，塞进来会把 372px 的标题栏挤到换行。 */}
      <div
        className="flex items-center gap-2 px-3 h-11 shrink-0 min-w-0 overflow-hidden"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="shrink-0">
          <Segmented
            value={tab}
            onChange={(v) => setTab(v)}
            options={[
              { value: 'chat', label: 'AI 对话' },
              { value: 'context', label: '上下文' }
            ]}
          />
        </div>
        <div className="flex-1 min-w-0" />
        <span
          className="chip"
          style={{ maxWidth: 132, minWidth: 0, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={resolved ? `模型：${resolved.model}` : '未配置模型'}
        >
          {resolved ? resolved.label : '未配置模型'}
        </span>
        {canUndo && (
          <button
            className="chip surface-hover shrink-0 whitespace-nowrap"
            style={{ height: 20, padding: '0 7px', fontSize: 10.5 }}
            title="撤销刚才这批对话改稿（正文回到应用之前的样子）"
            onClick={() => {
              undoLastEditBatch()
              toast('已撤销本次改稿', 'ok')
            }}
          >
            <Undo2 size={10} /> 撤销改稿
          </button>
        )}
        {project.chat.length > 0 && tab === 'chat' && (
          <span className="shrink-0">
            <IconButton
              title="清空对话"
              onClick={() => {
                patchProject((p) => ({ ...p, chat: [] }))
                toast('对话已清空', 'ok')
              }}
            >
              <Trash2 size={14} />
            </IconButton>
          </span>
        )}
      </div>
      {drafting && (
        <div
          className="flex items-center gap-2 px-3 h-8 shrink-0"
          style={{ borderBottom: '1px solid var(--border)', background: 'var(--panel-2)' }}
        >
          <span
            className="flex-1 min-w-0 truncate text-[10.5px] tabular-nums"
            style={{ color: 'var(--accent)' }}
            title={drafting.title}
          >
            写作中 {drafting.written}/{drafting.target}
          </span>
          <button
            className="chip surface-hover shrink-0 whitespace-nowrap"
            style={{ height: 20, padding: '0 6px', fontSize: 10.5 }}
            title="停下这次写稿，已写的部分会留在正文里"
            onClick={() => {
              stopDraftRef.current = true
              abortChat()
            }}
          >
            停止
          </button>
        </div>
      )}

      {tab === 'chat' ? (
        <>
          <div ref={listRef} className="flex-1 min-h-0 overflow-auto scroll-thin px-3 py-3">
            {project.chat.length === 0 && !draft && (
              <div className="pt-6">
                <div className="flex items-center gap-2 mb-3" style={{ color: 'var(--text-faint)' }}>
                  <Sparkles size={14} />
                  <span className="text-[12.5px]">让 AI 帮你想想这本书</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {quick.map((q) => (
                    <button
                      key={q.label}
                      onClick={() => void send(q.q)}
                      className="text-left px-3 py-2 rounded-lg text-[12.5px] transition-colors"
                      style={{ background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text-dim)' }}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {project.chat.map((m) => (
              <div key={m.id} className="mb-3 group">
                <div className="flex items-center gap-1.5 mb-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {m.role === 'user' ? <MessageSquare size={11} /> : <Sparkles size={11} />}
                  {m.role === 'user' ? '我' : 'AI'}
                  <span>· {relativeTime(m.at)}</span>
                  {m.truncated && (
                    <span
                      className="chip"
                      title="这条回答被输出上限截断，末尾是断的。可在「设置 → 输出预算 → 对话」调大额度。"
                      style={{ height: 16, fontSize: 10, color: 'var(--warning, #B45309)' }}
                    >
                      已截断
                    </span>
                  )}
                  {m.role === 'assistant' && (
                    <button
                      className="ml-auto opacity-0 group-hover:opacity-100 text-[11px]"
                      style={{ color: 'var(--accent)' }}
                      onClick={() => onInsertText(m.content)}
                    >
                      插入正文
                    </button>
                  )}
                </div>
                <div
                  className="text-[12.5px] leading-relaxed selectable whitespace-pre-wrap rounded-lg px-3 py-2"
                  style={{
                    background: m.role === 'user' ? 'var(--accent-soft)' : 'var(--panel)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)'
                  }}
                >
                  {m.content}
                </div>
                {/* 来源卡：作者要能核对「这句话是从哪来的」，所以标题可点开原文 */}
                {m.research && m.research.hits.length > 0 && (
                  <details
                    className="mt-1 rounded-lg px-2 py-1.5"
                    style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}
                  >
                    <summary className="text-[11px] cursor-pointer" style={{ color: 'var(--text-dim)' }}>
                      来源 {m.research.hits.length} 条{m.research.cached ? '（缓存）' : ''}
                    </summary>
                    <div className="mt-1 flex flex-col gap-1">
                      {m.research.hits.map((h, i) => (
                        <button
                          key={h.url}
                          className="text-left text-[11px] leading-relaxed"
                          style={{ color: 'var(--accent)' }}
                          title={h.url}
                          onClick={() => void mz.app.openExternal(h.url)}
                        >
                          [{i + 1}] {h.title}
                          <span style={{ color: 'var(--text-faint)' }}> · {h.source}</span>
                        </button>
                      ))}
                    </div>
                  </details>
                )}
                {m.role === 'assistant' && (m.edits?.length || m.editsError) && (
                  <div className="mt-1 flex flex-col gap-1">
                    {m.editsError && (
                      <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--warning, #B45309)' }}>
                        改稿块没读懂：{m.editsError}
                      </div>
                    )}
                    {m.edits?.length ? (
                      m.editsAppliedAt ? (
                        <div className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--ok)' }}>
                          <Check size={11} /> 这批修改已应用
                          {m.draftWords ? <span style={{ color: 'var(--text-dim)' }}>· 已写入 {m.draftWords} 字</span> : null}
                        </div>
                      ) : (
                        <button
                          className="self-start flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors"
                          style={{
                            background: 'var(--accent-soft)',
                            border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
                            color: 'var(--accent)'
                          }}
                          onClick={() => setPreview({ msgId: m.id, edits: resolveEdits(project, m.edits ?? []) })}
                        >
                          <Wand2 size={11} /> 查看并应用 {m.edits.length} 处修改
                        </button>
                      )
                    ) : null}
                  </div>
                )}
              </div>
            ))}

            {(streaming || draft) && (
              <div className="mb-3">
                <div className="flex items-center gap-1.5 mb-1 text-[11px]" style={{ color: 'var(--accent)' }}>
                  <Sparkles size={11} className="pulse" /> {draft ? 'AI 正在输入…' : 'AI 正在思考…'}
                </div>
                <div
                  className="text-[12.5px] leading-relaxed whitespace-pre-wrap rounded-lg px-3 py-2"
                  style={{ background: 'var(--panel)', border: '1px solid var(--accent)' }}
                >
                  {draft || (
                    <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>
                      {thought ? thought.slice(-600) : '…'}
                    </span>
                  )}
                </div>
                {/* 思考类模型可能一两分钟只吐思考：把等待进度说清楚 */}
                {streaming && (
                  <div className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                    {stage || streamStatus({ text: draft, thought, elapsedMs: elapsed })}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="shrink-0 p-3" style={{ borderTop: '1px solid var(--border)' }}>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="问问 AI：这段怎么写更好？下一章怎么展开？"
              style={{ minHeight: 66, fontSize: 12.5 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void send(input)
                }
              }}
            />
            <div className="flex items-center justify-between mt-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  ⌘↵ 发送
                </span>
                <button
                  className="chip surface-hover"
                  style={{ height: 18, padding: '0 6px', fontSize: 10, color: allowEdits ? 'var(--accent)' : 'var(--text-faint)' }}
                  title={
                    allowEdits
                      ? '现在允许 AI 在回答里附上可直接应用的改动（会先给你看 diff 才落地）。点一下改成只聊天。'
                      : '现在只聊天，不会提出改动。点一下允许 AI 附上可直接应用的改动。'
                  }
                  onClick={() => void patchSettings({ allowChatEdits: !allowEdits })}
                >
                  {allowEdits ? '可改稿' : '只聊天'}
                </button>
                {webSearch?.enabled && (
                  <button
                    className="chip surface-hover"
                    style={{
                      height: 18,
                      padding: '0 6px',
                      fontSize: 10,
                      color: !searchReady ? 'var(--text-faint)' : withSearch ? 'var(--accent)' : 'var(--text-dim)'
                    }}
                    title={
                      !searchReady
                        ? '还没有配置搜索源，去「设置 → 联网搜索」里加一个'
                        : withSearch
                          ? '这一轮会先联网查资料再回答（消耗搜索额度）。点一下关掉。'
                          : '这一轮先联网查资料再回答，事实类问题（史料、工艺、参数）建议打开。'
                    }
                    onClick={() => {
                      if (!searchReady) {
                        toast('还没有配置搜索源，请到「设置 → 联网搜索」里添加', 'error')
                        return
                      }
                      setWithSearch((v) => !v)
                    }}
                  >
                    {searching || (withSearch ? '联网·开' : '联网')}
                  </button>
                )}
              </div>
              {streaming ? (
                <Button size="sm" onClick={() => abortChat()}>
                  <Square size={12} /> 停止
                </Button>
              ) : (
                <Button size="sm" variant="primary" disabled={!input.trim()} onClick={() => void send(input)}>
                  <Send size={12} /> 发送
                </Button>
              )}
            </div>
          </div>
        </>
      ) : (
        <ContextView project={project} chapter={chapter} />
      )}

      <ChatEditPreview
        open={preview !== null}
        edits={preview?.edits ?? []}
        onClose={() => setPreview(null)}
        onApply={(kept) => {
          const msgId = preview?.msgId
          applyEditBatch(kept)
          if (msgId) {
            patchProject((p) => ({
              ...p,
              chat: p.chat.map((m) => (m.id === msgId ? { ...m, editsAppliedAt: Date.now() } : m))
            }))
          }
          setPreview(null)
          setNow(Date.now())
          toast(`已应用 ${kept.length} 处修改，正文可在章节版本历史里回退。`, 'ok')
          void startDrafts(kept, msgId)
        }}
        onRetry={() => {
          setPreview(null)
          // 这句话会作为一条普通的提问发出去：作者看得到它说了什么，也看得到下一批改动从哪来
          void send(EDIT_RETRY_PROMPT)
        }}
      />
    </div>
  )
}

function ContextView({ project, chapter }: { project: Project; chapter: Chapter | null }): ReactNode {
  const { patchProject } = useApp()
  const conventions = useApp((s) => s.config?.settings.genreConventions)
  const skillLibrary = useApp((s) => s.skillLibrary)
  const ctx = assembleContext(project, chapter, 24000, { includeCurrent: true, conventions, skillLibrary })
  const toggles = project.settings.context
  const keys: { key: keyof typeof toggles; label: string }[] = [
    { key: 'brief', label: '作品简介' },
    { key: 'genre', label: '题材公约' },
    { key: 'characters', label: '角色档案' },
    { key: 'bible', label: '世界观设定' },
    { key: 'outline', label: '大纲' },
    { key: 'previous', label: '前文章节' },
    { key: 'style', label: '文风分身' },
    { key: 'skills', label: '写作技法' }
  ]

  const genreBlock = ctx.blocks.find((b) => b.key === 'genre')

  return (
    <div className="flex-1 min-h-0 overflow-auto scroll-thin px-3 py-3">
      <div className="text-[11.5px] leading-relaxed mb-3" style={{ color: 'var(--text-faint)' }}>
        每次生成时，墨舟会把下面这些资料按顺序装进提示词（对话时额外带上当前章节正文）。总预算约 {ctx.budget.toLocaleString()} tokens，
        当前约 <strong style={{ color: 'var(--text)' }}>{ctx.totalTokens.toLocaleString()}</strong> tokens
        （{Math.round((ctx.totalTokens / ctx.budget) * 100)}%）。
        {ctx.trimmed && <span style={{ color: 'var(--warn)' }}> 已超出预算，较早内容被自动裁剪。</span>}
      </div>

      <div className="card p-2 mb-3">
        {keys.map((k) => (
          <div key={k.key} className="flex items-center justify-between px-1 py-1.5">
            <span className="text-[12px]">{k.label}</span>
            <Switch
              checked={Boolean(toggles[k.key])}
              onChange={(v) =>
                patchProject((p) => ({
                  ...p,
                  settings: { ...p.settings, context: { ...p.settings.context, [k.key]: v } }
                }))
              }
            />
          </div>
        ))}
      </div>

      {/* 技法卡的勾选放在上下文开关下面：它是「这本书用哪几张方法论」的书级设置，
          和上面的注入开关是同一层级的配置，混进预览列表里会显得像只读内容 */}
      {toggles.skills !== false && (
        <div className="mb-3">
          <div className="px-1 mb-1.5 text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>
            写作技法
          </div>
          <SkillsPicker project={project} />
        </div>
      )}

      <div className="flex flex-col gap-2">
        {ctx.blocks.map((b) => (
          <div key={b.key} className="rounded-lg px-2.5 py-2" style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 mb-1">
              {b.text ? <Eye size={11} style={{ color: 'var(--ok)' }} /> : <EyeOff size={11} style={{ color: 'var(--text-faint)' }} />}
              <span className="text-[11.5px] font-medium">{b.label}</span>
              <span className="ml-auto text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                {b.tokens ? `${b.tokens} tk` : '未启用'}
              </span>
            </div>
            {b.text && (
              // 题材公约用完整文本 + 可滚动，不截断：
              // 它是唯一一段「作者可能想逐字核对」的内容（尤其自己改过之后），
              // line-clamp-3 会把「避免开局即巅峰」这类关键约束卡在视野外。
              b.key === 'genre' ? (
                <div
                  className="text-[11px] leading-relaxed selectable overflow-auto scroll-thin"
                  style={{ color: 'var(--text-dim)', maxHeight: 132 }}
                >
                  {b.text}
                </div>
              ) : (
                <div className="text-[11px] line-clamp-3 selectable" style={{ color: 'var(--text-dim)' }}>
                  {b.text}
                </div>
              )
            )}
            {b.key === 'genre' && b.text && (
              <div className="mt-1.5 text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                注入位置：系统提示词（不占正文预算、不会被裁剪）
                {' · '}
                {conventions?.[project.genreId]?.trim() ? '已在设置里自定义' : '内置默认'}
              </div>
            )}
            {b.key === 'genre' && !b.text && (
              <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                {toggles.genre === false
                  ? '开关已关闭，生成时不会注入题材约束'
                  : '这本书还没有选题材，或所选题材没有公约可注入'}
              </div>
            )}
          </div>
        ))}
      </div>

      {(() => {
        // 外部资料不是本书数据，它挂在最近一条带检索痕迹的回答上。
        // 只显示「已注入 3 条」等于把黑箱换了个位置，所以连 query 一起摆出来。
        const last = [...project.chat].reverse().find((m) => m.research?.hits.length)
        if (!last?.research) return null
        const r = last.research
        return (
          <div className="mt-2 rounded-lg px-2.5 py-2" style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 mb-1">
              <Eye size={11} style={{ color: 'var(--ok)' }} />
              <span className="text-[11.5px] font-medium">外部资料</span>
              <span className="ml-auto text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                {r.hits.length} 条{r.cached ? ' · 缓存' : ''}
              </span>
            </div>
            <div className="text-[10.5px] mb-1" style={{ color: 'var(--text-faint)' }}>
              检索：{r.queries.join('；')} · {new Date(r.at).toLocaleString()}
            </div>
            <div className="text-[11px] selectable" style={{ color: 'var(--text-dim)' }}>
              {r.hits.map((h) => h.title).join(' / ')}
            </div>
          </div>
        )
      })()}

      <div className="mt-3 text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
        {genreBlock?.tokens ? `其中题材公约 ${genreBlock.tokens} tokens 位于系统提示词，` : ''}
        提示词整体估算约{' '}
        {estimateTokens(
          ctx.blocks
            .filter((b) => b.key !== 'genre')
            .map((b) => b.text)
            .join('')
        ) + (genreBlock?.tokens ? genreBlock.tokens : 0) + 400}{' '}
        tokens
      </div>
    </div>
  )
}
