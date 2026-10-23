import { useState, type ReactNode } from 'react'
import type { Project } from '@shared/types'
import { relativeTime, uid } from '@shared/utils'
import { resolveTaskModel, useApp } from '../../store/app'
import { generateCustom } from '../../lib/generate'
import { abortChat } from '../../lib/ai'
import { isAbortMessage, streamStatus, useElapsed } from '../../lib/stream'
import { Button, Textarea } from '../../components/ui'
import { CircleStop, Lightbulb, Pin, Sparkles, Trash2 } from 'lucide-react'

export function IdeasTab({ project }: { project: Project }): ReactNode {
  const { patchProject, config, toast } = useApp()
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamed, setStreamed] = useState('')
  const [thought, setThought] = useState('')
  const elapsed = useElapsed(loading)

  const add = (): void => {
    const t = text.trim()
    if (!t) return
    patchProject((p) => ({ ...p, ideas: [{ id: uid('i'), text: t, at: Date.now(), pinned: false }, ...p.ideas] }))
    setText('')
  }

  const draw = async (): Promise<void> => {
    const resolved = resolveTaskModel(config, project, 'naming')
    if (!resolved) {
      toast('还没有可用模型，请先到设置里配置渠道', 'error')
      return
    }
    setLoading(true)
    setStreamed('')
    setThought('')
    try {
      const sys = '你是资深故事策划，擅长给出具体、有画面感、能立刻开写的故事灵感。'
      const user = `这本书的设定：${project.brief.logline || project.title}。${project.brief.premise || ''}
请给出 5 条「可以直接开写」的桥段灵感，每条一句话，不超过 40 字，要具体（有人物、有场景、有意外），不要抽象概念。用编号列表输出。`
      const out = await generateCustom({
        project,
        chapter: null,
        channel: resolved.channel,
        model: resolved.model,
        task: 'naming',
        system: sys,
        user,
        maxTokens: 900,
        temperature: 1.0,
        onDelta: (d) => setStreamed((t) => t + d),
        onThought: (d) => setThought((t) => t + d)
      })
      const lines = out
        .split('\n')
        .map((l) => l.replace(/^\s*[\d]+[.、)]\s*/, '').trim())
        .filter((l) => l.length > 4)
      if (!lines.length) {
        toast('AI 没有返回可用内容', 'error')
        return
      }
      patchProject((p) => ({
        ...p,
        ideas: [...lines.map((l) => ({ id: uid('i'), text: l, at: Date.now(), pinned: false })), ...p.ideas]
      }))
      toast(`抽到 ${lines.length} 条灵感`, 'ok')
    } catch (e) {
      const msg = (e as Error).message
      // 主动停止不算错误
      if (!isAbortMessage(msg)) toast(msg, 'error')
    } finally {
      setLoading(false)
      setStreamed('')
      setThought('')
    }
  }

  return (
    <div className="h-full overflow-auto scroll-thin">
      <div className="max-w-[820px] mx-auto px-8 py-7">
        <div className="flex items-center gap-2 mb-4">
          <Lightbulb size={16} style={{ color: 'var(--accent)' }} />
          <h2 className="text-[15px] font-semibold">灵感收集箱</h2>
          <span className="chip">{project.ideas.length}</span>
          <div className="flex-1" />
          <Button size="sm" onClick={() => void draw()} disabled={loading}>
            <Sparkles size={13} /> {loading ? '抽卡中…' : 'AI 抽卡'}
          </Button>
        </div>

        {loading && (
          <div className="rounded-md p-2.5 mb-4 text-[11.5px] leading-relaxed" style={{ background: 'var(--panel-2)', color: 'var(--text-dim)' }}>
            <div className="flex items-center justify-between gap-3">
              <span style={{ color: 'var(--text-faint)' }}>{streamStatus({ text: streamed, thought, elapsedMs: elapsed })}</span>
              <Button size="sm" variant="ghost" onClick={() => abortChat()}>
                <CircleStop size={12} /> 停止
              </Button>
            </div>
            {(streamed || thought) && (
              <div className="mt-1.5 selectable" style={{ color: 'var(--text-faint)', whiteSpace: 'pre-wrap' }}>
                {(streamed || thought).slice(-220)}
              </div>
            )}
          </div>
        )}

        <div className="card p-3 mb-5">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="想到什么就先记下来，一句话也行。⌘↵ 快速保存。"
            style={{ minHeight: 60, border: 'none', background: 'transparent', padding: 0, boxShadow: 'none' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                add()
              }
            }}
          />
          <div className="flex justify-end">
            <Button size="sm" variant="primary" disabled={!text.trim()} onClick={add}>
              收进箱子里
            </Button>
          </div>
        </div>

        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {project.ideas.map((idea) => (
            <div
              key={idea.id}
              className="card px-3 py-2.5 group relative"
              style={{ borderColor: idea.pinned ? 'var(--accent)' : 'var(--border)' }}
            >
              <div className="text-[12.5px] leading-relaxed selectable whitespace-pre-wrap">{idea.text}</div>
              <div className="flex items-center gap-2 mt-2 text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                <span>{relativeTime(idea.at)}</span>
                <div className="flex-1" />
                <button
                  className="opacity-0 group-hover:opacity-100"
                  style={{ color: idea.pinned ? 'var(--accent)' : 'var(--text-faint)' }}
                  onClick={() =>
                    patchProject((p) => ({
                      ...p,
                      ideas: p.ideas.map((x) => (x.id === idea.id ? { ...x, pinned: !x.pinned } : x))
                    }))
                  }
                  title="置顶"
                >
                  <Pin size={11} />
                </button>
                <button
                  className="opacity-0 group-hover:opacity-100"
                  style={{ color: 'var(--text-faint)' }}
                  onClick={() => patchProject((p) => ({ ...p, ideas: p.ideas.filter((x) => x.id !== idea.id) }))}
                  title="删除"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {project.ideas.length === 0 && (
          <div className="text-center py-16 text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
            箱子里还是空的。写下第一个念头，或者点「AI 抽卡」。
          </div>
        )}
      </div>
    </div>
  )
}