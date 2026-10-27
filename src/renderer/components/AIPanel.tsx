import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Chapter, Project } from '@shared/types'
import { estimateTokens, relativeTime, uid } from '@shared/utils'
import { resolveTaskModel, useApp } from '../store/app'
import { assembleContext } from '../lib/prompt'
import { generateChatReply } from '../lib/generate'
import { abortChat } from '../lib/ai'
import { isAbortMessage, streamStatus, useElapsed } from '../lib/stream'
import { Button, IconButton, Segmented, Switch, Textarea } from './ui'
import { ChatEditPreview } from './ChatEditPreview'
import { parseEditBlock } from '@shared/editProtocol'
import { resolveEdits, type ResolvedEdit } from '../lib/applyEdits'
import { SkillsPicker } from './SkillsPicker'
import { Check, Eye, EyeOff, MessageSquare, Send, Sparkles, Square, Trash2, Undo2, Wand2 } from 'lucide-react'

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
      <div className="flex items-center gap-2 px-3 h-11 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Segmented
          value={tab}
          onChange={(v) => setTab(v)}
          options={[
            { value: 'chat', label: 'AI 对话' },
            { value: 'context', label: '上下文' }
          ]}
        />
        <div className="flex-1" />
        <span className="chip" title={resolved ? `模型：${resolved.model}` : '未配置模型'}>
          {resolved ? resolved.label : '未配置模型'}
        </span>
        {canUndo && (
          <button
            className="chip surface-hover"
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
          <IconButton
            title="清空对话"
            onClick={() => {
              patchProject((p) => ({ ...p, chat: [] }))
              toast('对话已清空', 'ok')
            }}
          >
            <Trash2 size={14} />
          </IconButton>
        )}
      </div>

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
