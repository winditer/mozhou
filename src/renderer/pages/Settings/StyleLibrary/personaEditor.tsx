import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PromptMessage } from '@shared/types'
import { STYLE_CATEGORIES, type StyleCategory, type StylePersona } from '@shared/styleLibrary'
import { countWords, uid } from '@shared/utils'
import { abortChat, sendChat } from '../../../lib/ai'
import { isAbortMessage, streamStatus, useElapsed } from '../../../lib/stream'
import { resolveTaskModel, useApp } from '../../../store/app'
import { Button, Field, Input, Modal, Select, Spinner, Textarea } from '../../../components/ui'
import { Plus, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { buildPersonaMessages, parsePersonaDraft, type PersonaDraft } from './personaAi'

/**
 * 新建 / 编辑一个系统文风分身。
 *
 * 和书内的 StyleEditorModal 的区别：
 * - 书内是「三步向导」（喂样本 → 提炼 → 试写），面向作者自己的笔；
 * - 这里是「一张表单」，因为在设置页管理 100 位作者时，向导会显得啰嗦。
 *   但样本和 AI 提炼这两件真正有用的事都保留了。
 */

const MAX_TRAITS = 12

export function PersonaEditor({
  open,
  source,
  onClose,
  onSave
}: {
  open: boolean
  source: StylePersona | null
  onClose: () => void
  onSave: (p: StylePersona) => void
}): ReactNode {
  const { config, toast } = useApp()
  const [name, setName] = useState('')
  const [category, setCategory] = useState<StyleCategory>('custom')
  const [tagText, setTagText] = useState('')
  const [summary, setSummary] = useState('')
  const [traits, setTraits] = useState<string[]>([''])
  const [refsText, setRefsText] = useState('')
  const [samples, setSamples] = useState('')
  /** AI 辅助：用户描述「想要什么味道」，AI 产出整套草稿 */
  const [brief, setBrief] = useState('')
  const [generating, setGenerating] = useState(false)
  const [streamOut, setStreamOut] = useState('')
  const [streamThought, setStreamThought] = useState('')
  const aliveRef = useRef(true)
  const stoppedRef = useRef(false)
  const runRef = useRef(false)

  const elapsed = useElapsed(generating)
  const liveStatus = streamStatus({ text: streamOut, thought: streamThought, elapsedMs: elapsed })
  const resolved = resolveTaskModel(config, null, 'polish')

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (runRef.current) abortChat()
    }
  }, [])

  // 每次打开重置：source 有值就是编辑，否则是新建（新建默认落到「自定义」分类）
  useEffect(() => {
    if (!open) return
    setName(source?.name ?? '')
    setCategory(source?.category ?? 'custom')
    setTagText((source?.tags ?? []).join(' '))
    setSummary(source?.summary ?? '')
    setTraits(source && source.traits.length ? [...source.traits] : [''])
    setRefsText((source?.refs ?? []).join(' '))
    setSamples((source?.samples ?? []).join('\n\n'))
    setBrief('')
    setGenerating(false)
    setStreamOut('')
    setStreamThought('')
    stoppedRef.current = false
  }, [open, source])

  const cleanTraits = useMemo(() => traits.map((t) => t.trim()).filter(Boolean), [traits])
  const cleanTags = useMemo(
    () =>
      tagText
        .split(/[\s,，、]+/)
        .map((t) => t.replace(/^#/, '').trim())
        .filter(Boolean)
        .slice(0, 8),
    [tagText]
  )
  const cleanRefs = useMemo(
    () =>
      refsText
        .split(/[\s,，、]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 6),
    [refsText]
  )
  const cleanSamples = useMemo(
    () => samples.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean),
    [samples]
  )

  const canSave = name.trim().length > 0 && cleanTraits.length > 0

  /** 把当前表单喂给 AI 让它改写：有样本就读样本，没样本就按名字/描述写 */
  const runAi = async (mode: 'draft' | 'polish'): Promise<void> => {
    if (!resolved) {
      toast('还没有可用模型，请先到「渠道与模型」配置', 'error')
      return
    }
    const seed: PersonaDraft = {
      name: name.trim(),
      category,
      summary,
      tags: cleanTags,
      traits: cleanTraits,
      refs: cleanRefs,
      samples: cleanSamples
    }
    if (mode === 'draft' && !seed.name && !brief.trim()) {
      toast('先填作者/分身名称，或写一句你想要的文风描述', 'error')
      return
    }
    setGenerating(true)
    runRef.current = true
    stoppedRef.current = false
    setStreamOut('')
    setStreamThought('')
    let text = ''
    let thought = ''
    try {
      const r = await sendChat({
        channel: resolved.channel,
        model: resolved.model,
        messages: buildPersonaMessages(mode, seed, brief.trim()) as PromptMessage[],
        task: 'polish',
        temperature: mode === 'draft' ? 0.6 : 0.4,
        maxTokens: 1200,
        onDelta: (d) => {
          if (!aliveRef.current || stoppedRef.current) return
          text += d
          setStreamOut(text)
        },
        onThought: (d) => {
          if (!aliveRef.current || stoppedRef.current) return
          thought += d
          setStreamThought(thought)
        }
      })
      if (!aliveRef.current || stoppedRef.current) return
      const draft = parsePersonaDraft(r.text || text)
      if (!draft) {
        toast('AI 返回的内容没能解析成结构，可以重试或手动填写', 'info')
        return
      }
      // 只覆盖 AI 确实给出的字段，用户已填的名称/分类不轻易被冲掉
      if (draft.summary) setSummary(draft.summary)
      if (draft.tags.length) setTagText(draft.tags.join(' '))
      if (draft.traits.length) setTraits(draft.traits)
      if (draft.refs.length && !cleanRefs.length) setRefsText(draft.refs.join(' '))
      toast(`已生成 ${draft.traits.length} 条特征，可逐条再改`, 'ok')
    } catch (e) {
      const message = (e as Error).message || '调用失败'
      if (!aliveRef.current || stoppedRef.current) return
      if (isAbortMessage(message)) {
        toast('已停止生成', 'info')
        return
      }
      toast(`生成失败：${message}`, 'error')
    } finally {
      runRef.current = false
      if (aliveRef.current) setGenerating(false)
    }
  }

  const stop = (): void => {
    stoppedRef.current = true
    runRef.current = false
    abortChat()
    setGenerating(false)
    toast('已停止生成', 'info')
  }

  const save = (): void => {
    if (!canSave) return
    const now = Date.now()
    const next: StylePersona = {
      id: source?.id ?? uid('sp-lib'),
      name: name.trim(),
      category,
      tags: cleanTags,
      summary: summary.trim(),
      traits: cleanTraits.slice(0, MAX_TRAITS),
      refs: cleanRefs,
      samples: cleanSamples,
      // 内置分身被用户改过之后仍然标 builtin（决定它能否被「恢复出厂」找回），
      // 但 updatedAt 变化能让 UI 显示「已修改」。
      builtin: source?.builtin ?? false,
      aiAssisted: source?.aiAssisted || generating || Boolean(streamOut),
      createdAt: source?.createdAt || now,
      updatedAt: now
    }
    onSave(next)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={860}
      title={source ? `编辑分身 · ${source.name || '未命名'}` : '新建文风分身'}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <div className="flex-1" />
          <Button variant="primary" disabled={!canSave} onClick={save}>
            {source ? '保存修改' : '保存分身'}
          </Button>
        </>
      }
    >
      {/* AI 辅助条 */}
      <div
        className="px-3 py-2.5 mb-3.5"
        style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8 }}
      >
        <div className="flex items-center gap-2 mb-1.5">
          <Sparkles size={13} style={{ color: 'var(--accent)' }} />
          <span className="text-[12px] font-medium">AI 辅助</span>
          <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            描述你想要的味道，AI 直接产出特征卡；填了样本则按样本提炼
          </span>
        </div>
        <Textarea
          value={brief}
          rows={2}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="例如：想要一个古龙式的江湖腔，短句多、留白多、气氛冷；或：照下面这段我自己的文字提炼"
          style={{ minHeight: 52, fontSize: 12.5, lineHeight: 1.65 }}
        />
        <div className="flex items-center gap-2 mt-2">
          {generating ? (
            <Button size="sm" variant="danger" onClick={stop}>
              停止
            </Button>
          ) : (
            <>
              <Button size="sm" variant="primary" disabled={!resolved} onClick={() => void runAi('draft')}>
                <Wand2 size={12} /> {cleanTraits.length ? '重新生成整套' : '生成特征卡'}
              </Button>
              {cleanTraits.length > 0 && (
                <Button size="sm" disabled={!resolved} onClick={() => void runAi('polish')}>
                  <Sparkles size={12} /> 按样本优化
                </Button>
              )}
            </>
          )}
          <div className="flex-1" />
          {generating && (
            <span className="text-[11px] flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}>
              <Spinner size={11} />
              <span className="tabular-nums">{liveStatus}</span>
            </span>
          )}
          {!resolved && (
            <span className="text-[11px]" style={{ color: 'var(--warn)' }}>
              未配置模型，只能手填
            </span>
          )}
        </div>
        {generating && streamOut && (
          <div
            className="mt-2 rounded-md p-2 text-[11px] whitespace-pre-wrap selectable scroll-thin"
            style={{
              maxHeight: 110,
              overflow: 'auto',
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              color: 'var(--text-dim)',
              lineHeight: 1.65
            }}
          >
            {streamOut}
          </div>
        )}
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 200px' }}>
        <Field label="名称" hint="作者名或分身名，书内引用时就显示这个名字">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：古龙 / 冷峻权谋腔"
            style={{ height: 32 }}
          />
        </Field>
        <Field label="分类">
          <Select value={category} onChange={(e) => setCategory(e.target.value as StyleCategory)} style={{ height: 32 }}>
            {STYLE_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid gap-3 mt-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Field label="标签" hint="空格或逗号分隔，最多 8 个；书内按标签筛选靠它">
          <Input
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            placeholder="短句 冷峻 江湖"
            style={{ height: 32 }}
          />
        </Field>
        <Field label="代表作" hint="仅作辨识，不是原文样本">
          <Input
            value={refsText}
            onChange={(e) => setRefsText(e.target.value)}
            placeholder="《多情剑客无情剑》"
            style={{ height: 32 }}
          />
        </Field>
      </div>

      <Field label="风格摘要" className="mt-3" hint="40–70 字，会作为「本分身取法」注入提示词">
        <Textarea
          value={summary}
          rows={2}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="短句留白，氛围冷硬，江湖孤寂感强；适合写对峙、独行与杀机将起的场面。"
          style={{ minHeight: 54, fontSize: 12.5, lineHeight: 1.65 }}
        />
      </Field>

      <div className="mt-3">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[12px] font-medium">文风特征</span>
          <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            6–8 条最佳；必须写清句长、对话密度、镜头距离，能被子编辑逐条核对
          </span>
          <div className="flex-1" />
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
            {cleanTraits.length} 条生效
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          {traits.map((t, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-[10.5px] tabular-nums w-4 text-right shrink-0" style={{ color: 'var(--text-faint)' }}>
                {i + 1}
              </span>
              <Input
                value={t}
                onChange={(e) => setTraits((prev) => prev.map((x, idx) => (idx === i ? e.target.value : x)))}
                placeholder="例如：短句为主，一句话很少超过 20 字"
                style={{ height: 30, fontSize: 12.5 }}
              />
              <button
                className="icon-btn"
                style={{ width: 24, height: 24 }}
                title="删除这条"
                onClick={() => setTraits((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="mt-1.5"
          disabled={traits.length >= MAX_TRAITS}
          onClick={() => setTraits((prev) => [...prev, ''])}
        >
          <Plus size={12} /> 加一条
        </Button>
      </div>

      <Field
        label="原文样本（可选）"
        className="mt-3"
        hint="种子库不内置名家原文（版权考虑）。想更贴近，可以自己粘作者原文或你自己的文字，段落间空一行"
      >
        <Textarea
          value={samples}
          rows={4}
          onChange={(e) => setSamples(e.target.value)}
          placeholder="粘贴原文样本，每段之间空一行。总量建议 ≤ 5000 字。"
          style={{ minHeight: 90, fontSize: 12.5, lineHeight: 1.7 }}
        />
      </Field>
      {cleanSamples.length > 0 && (
        <div className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {cleanSamples.length} 段 · 共 {cleanSamples.reduce((s, x) => s + countWords(x), 0)} 字
          {cleanSamples.reduce((s, x) => s + countWords(x), 0) > 5000 && (
            <span style={{ color: 'var(--warn)' }}> · 超出 5000 字，生成时会只取前 3 段</span>
          )}
        </div>
      )}
    </Modal>
  )
}