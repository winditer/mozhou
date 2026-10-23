import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Chapter, Project } from '@shared/types'
import { estimateTokens, relativeTime, uid } from '@shared/utils'
import { resolveTaskModel, useApp } from '../store/app'
import { assembleContext } from '../lib/prompt'
import { generateChatReply } from '../lib/generate'
import { abortChat } from '../lib/ai'
import { isAbortMessage, streamStatus, useElapsed } from '../lib/stream'
import { Button, IconButton, Segmented, Switch, Textarea } from './ui'
import { Eye, EyeOff, MessageSquare, Send, Sparkles, Square, Trash2 } from 'lucide-react'

export function AIPanel({
  project,
  chapter,
  onInsertText
}: {
  project: Project
  chapter: Chapter | null
  onInsertText: (text: string) => void
}): ReactNode {
  const { config, patchProject, toast } = useApp()
  const [tab, setTab] = useState<'chat' | 'context'>('chat')
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [thought, setThought] = useState('')
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
    setStreaming(true)
    try {
      let acc = ''
      const text = await generateChatReply({
        project,
        chapter,
        channel: resolved.channel,
        model: resolved.model,
        task: 'chat',
        history,
        question: q,
        onDelta: (d) => {
          acc += d
          setDraft(acc)
        },
        onThought: (d) => setThought((t) => t + d)
      })
      const final = text || acc
      patchProject((p) => ({
        ...p,
        chat: [
          ...p.chat,
          { id: uid('m'), role: 'assistant' as const, content: final, at: Date.now(), model: resolved.model }
        ]
      }))
    } catch (e) {
      const msg = (e as Error).message
      // 主动停止不算错误
      if (!isAbortMessage(msg)) toast(msg, 'error')
    } finally {
      setStreaming(false)
      setDraft('')
      setThought('')
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
                    {streamStatus({ text: draft, thought, elapsedMs: elapsed })}
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
              <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                ⌘↵ 发送
              </span>
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
    </div>
  )
}

function ContextView({ project, chapter }: { project: Project; chapter: Chapter | null }): ReactNode {
  const { patchProject } = useApp()
  const ctx = assembleContext(project, chapter, 24000, { includeCurrent: true })
  const toggles = project.settings.context
  const keys: { key: keyof typeof toggles; label: string }[] = [
    { key: 'brief', label: '作品简介' },
    { key: 'genre', label: '题材公约' },
    { key: 'characters', label: '角色档案' },
    { key: 'bible', label: '世界观设定' },
    { key: 'outline', label: '大纲' },
    { key: 'previous', label: '前文章节' },
    { key: 'style', label: '文风分身' }
  ]

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
              <div className="text-[11px] line-clamp-3 selectable" style={{ color: 'var(--text-dim)' }}>
                {b.text}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
        提示词整体估算约 {estimateTokens(ctx.blocks.map((b) => b.text).join('')) + 400} tokens
      </div>
    </div>
  )
}