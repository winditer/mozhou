import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleStop, Sparkles, Trash } from 'lucide-react'
import type { OutlineNode, Project } from '@shared/types'
import { Button, Field, Input, Modal, Segmented, Textarea } from '../../../components/ui'
import { buildOutlineMessages } from '../../../lib/prompt'
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, resolveBudget } from '@shared/budgets'
import { taskModelLabel, useApp } from '../../../store/app'
import { useAiText } from '../useAiText'
import { countChapterMarkers, parseOutlineText } from './parse'

const DEFAULT_INSTRUCTION = '为这本书生成第一卷的 10 章大纲，每章一句话情节点，并标注每章的推进作用。'

/** 从「生成 10 章」这类要求里解析期望章节数，用来校验模型有没有偷工减料 */
function expectedChapters(instruction: string): number {
  const arabic = instruction.match(/(\d{1,3})\s*[章回]/)
  if (arabic) return Number(arabic[1])
  const cn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const m = instruction.match(/([一二三四五六七八九十]{1,2})\s*[章回]/)
  if (!m) return 0
  const v = m[1]
  if (v.length === 1) return cn[v] ?? 0
  if (v.startsWith('十')) return 10 + (cn[v[1]] ?? 0)
  return (cn[v[0]] ?? 0) * 10 + (cn[v[1]] ?? 0)
}

type Phase = 'input' | 'streaming' | 'preview'

export function GenOutlineModal({
  open,
  onClose,
  project
}: {
  open: boolean
  onClose: () => void
  project: Project
}): ReactNode {
  const config = useApp((s) => s.config)
  const budgets = useApp((s) => s.config?.settings.tokenBudgets) ?? DEFAULT_TOKEN_BUDGETS
  const toast = useApp((s) => s.toast)
  const patchProject = useApp((s) => s.patchProject)

  const [instruction, setInstruction] = useState(DEFAULT_INSTRUCTION)
  const [phase, setPhase] = useState<Phase>('input')
  const [draft, setDraft] = useState<OutlineNode[]>([])
  const [mode, setMode] = useState<'replace' | 'append'>('replace')
  /** 模型原文：章节数对不上时可以直接在这里手工补齐再解析 */
  const [rawText, setRawText] = useState('')
  const [rawOpen, setRawOpen] = useState(false)
  /** 补全进度提示（模型章节数不够时自动追写） */
  const [stageNote, setStageNote] = useState('')
  const ai = useAiText()
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    setPhase('input')
    setDraft([])
    setRawText('')
    setRawOpen(false)
    setStageNote('')
    setMode(project.outline.length ? 'append' : 'replace')
    ai.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [ai.text, ai.thought, phase])

  const modelLabel = taskModelLabel(config, project, 'outline')
  const configured = modelLabel.indexOf('未配置') === -1

  const start = async (): Promise<void> => {
    if (!configured) {
      toast('请先到设置 → 渠道与模型里配置一个模型', 'error')
      return
    }
    const text = instruction.trim()
    if (!text) {
      toast('请先写一句大纲要求', 'info')
      return
    }
    setPhase('streaming')
    setStageNote('')
    const messages = buildOutlineMessages(project, text)
    // 按 3200 字估（10 章大纲）走 outline.generate；思考模型的推理也吃 max_tokens，预算里已含 thinkPad
    const maxTokens = resolveBudget(budgets, BUDGET_KEYS.outlineGenerate, 3200)
    let result = await ai.run({ task: 'outline', messages, maxTokens, temperature: 0.75 })
    if (!result) {
      setPhase('input')
      return
    }

    const want = expectedChapters(text)
    let parsed = parseOutlineText(result)
    let got = parsed.reduce((n, v) => n + v.children.length, 0)

    // 章节数不够时自动追写（最多两轮），避免「要 10 章只给 1 章」还要用户自己再点一次
    for (let round = 0; want && got > 0 && got < want && round < 2; round++) {
      setStageNote(`已拿到 ${got}/${want} 章，正在补全第 ${got + 1}–${want} 章…`)
      const more = await ai.run({
        task: 'outline',
        messages: [
          ...messages,
          { role: 'assistant' as const, content: result },
          {
            role: 'user' as const,
            content: `你只写到了第 ${got} 章。请继续补完第 ${got + 1} 到第 ${want} 章，格式与前面完全一致（第X章 章名：一句话情节点），一行一章，不要重复已写过的章节，不要解释。`
          }
        ],
        maxTokens,
        temperature: 0.75
      })
      if (!more) break
      result = `${result.trimEnd()}\n${more.trim()}`
      parsed = parseOutlineText(result)
      const next = parsed.reduce((n, v) => n + v.children.length, 0)
      if (next <= got) break
      got = next
    }
    setStageNote('')
    setRawText(result)
    if (!parsed.length) {
      toast('没能从返回结果里解析出大纲，原文已保留，可手工整理后重新解析', 'error')
      setPhase('input')
      return
    }
    if (want && got < want) {
      // 章节数明显不足：多半是被 max_tokens 截断，或模型自己省略了
      const marks = countChapterMarkers(result)
      const why = marks >= want ? `原文里有 ${marks} 个章节标记，但只解析出 ${got} 章` : `模型只写了 ${marks} 个章节`
      toast(`要求 ${want} 章，实际只拿到 ${got} 章（${why}）。可展开原文手工补齐后重新解析。`, 'error')
      setRawOpen(true)
    }
    setDraft(parsed)
    setPhase('preview')
  }

  const apply = (): void => {
    const nodes = draft.filter((n) => n.title.trim() || n.children.some((c) => c.title.trim()))
    if (!nodes.length) {
      toast('预览里没有可用节点', 'info')
      return
    }
    const cleaned = nodes.map((v) => ({
      ...v,
      children: v.children.filter((c) => c.title.trim())
    }))
    const total = cleaned.reduce((s, v) => s + v.children.length, 0)
    patchProject((p) => ({
      ...p,
      outline: mode === 'replace' ? cleaned : [...p.outline, ...cleaned]
    }))
    toast(mode === 'replace' ? `已替换大纲：${cleaned.length} 卷 / ${total} 章` : `已追加大纲：${cleaned.length} 卷 / ${total} 章`, 'ok')
    onClose()
  }

  const updateDraft = (volId: string, patch: Partial<OutlineNode>): void => {
    setDraft((list) => list.map((v) => (v.id === volId ? { ...v, ...patch } : v)))
  }

  const updateChild = (volId: string, chId: string, patch: Partial<OutlineNode>): void => {
    setDraft((list) =>
      list.map((v) => (v.id === volId ? { ...v, children: v.children.map((c) => (c.id === chId ? { ...c, ...patch } : c)) } : v))
    )
  }

  const removeVolume = (volId: string): void => setDraft((list) => list.filter((v) => v.id !== volId))
  const removeChapter = (volId: string, chId: string): void =>
    setDraft((list) => list.map((v) => (v.id === volId ? { ...v, children: v.children.filter((c) => c.id !== chId) } : v)))

  const footer =
    phase === 'input' ? (
      <>
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" onClick={() => void start()} disabled={!configured}>
          <Sparkles size={13} /> 生成
        </Button>
      </>
    ) : phase === 'streaming' ? (
      <>
        <span className="mr-auto text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          正在接收…（可随时停止）
        </span>
        <Button variant="danger" onClick={ai.stop}>
          <CircleStop size={13} /> 停止
        </Button>
      </>
    ) : (
      <>
        <span className="mr-auto text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          共 {draft.length} 卷 / {draft.reduce((s, v) => s + v.children.length, 0)} 章
        </span>
        <Button onClick={() => setPhase('input')}>重新生成</Button>
        <Button variant="primary" onClick={apply}>
          导入大纲
        </Button>
      </>
    )

  return (
    <Modal open={open} onClose={onClose} title="AI 生成大纲" width={780} footer={footer}>
      {phase === 'input' && (
        <div className="space-y-3">
          <Field
            label="你想让 AI 怎么排这一卷？"
            hint={`当前模型：${modelLabel}${configured ? '' : ' · 请先到设置 → 渠道与模型配置'}`}
          >
            <Textarea
              rows={4}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={DEFAULT_INSTRUCTION}
              className="text-[12.5px]"
            />
          </Field>
          <div className="rounded-md p-2.5 text-[11.5px] leading-relaxed" style={{ background: 'var(--panel-2)', color: 'var(--text-dim)' }}>
            生成结果是两级结构：<b>卷</b>（第X卷）与其下的<b>章</b>（第X章）。每行写成「标题：一句话情节点」效果最好；导入前可以逐行修改，也可以选择覆盖或追加到现有大纲。
          </div>
        </div>
      )}

      {phase === 'streaming' && (
        <div className="space-y-2">
          <div
            ref={scrollRef}
            className="rounded-md p-3 overflow-auto scroll-thin selectable"
            style={{
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
              maxHeight: 420,
              minHeight: 220,
              fontFamily: "'SF Mono', Menlo, monospace",
              fontSize: 11.5,
              lineHeight: 1.75,
              whiteSpace: 'pre-wrap',
              color: ai.text ? 'var(--text-dim)' : 'var(--text-faint)'
            }}
          >
            {ai.text || ai.thought || '正在等待模型响应…'}
            {ai.running && <span className="pulse">▍</span>}
          </div>
          <div className="flex items-center justify-between text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            <span>
              {stageNote ||
                (ai.text
                  ? `已收到 ${ai.text.length} 字`
                  : ai.thought
                    ? `模型正在思考…（已 ${ai.thought.length} 字）`
                    : '已连接，等待模型吐出第一段内容…')}
            </span>
            <span>已等待 {Math.round(ai.elapsedMs / 1000)} 秒</span>
          </div>
        </div>
      )}

      {phase === 'preview' && (
        <div className="space-y-3">
          <div className="rounded-md" style={{ border: '1px solid var(--border)', background: 'var(--panel-2)' }}>
            <button
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px]"
              style={{ color: 'var(--text-dim)' }}
              onClick={() => setRawOpen((v) => !v)}
            >
              <span>{rawOpen ? '▾' : '▸'}</span>
              <span>模型原文（{rawText.length} 字）</span>
              <span className="ml-auto" style={{ color: 'var(--text-faint)' }}>
                章节数对不上时，可直接在这里补齐再重新解析
              </span>
            </button>
            {rawOpen && (
              <div className="px-2.5 pb-2.5">
                <Textarea
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  rows={8}
                  className="text-[11.5px]"
                  style={{ fontFamily: "'SF Mono', Menlo, monospace", lineHeight: 1.7 }}
                />
                <div className="mt-1.5 flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      const p2 = parseOutlineText(rawText)
                      const c = p2.reduce((n, v) => n + v.children.length, 0)
                      if (!p2.length) {
                        toast('这段文本里还是没解析出大纲节点', 'error')
                        return
                      }
                      setDraft(p2)
                      toast(`已重新解析：${p2.length} 卷 / ${c} 章`, 'ok')
                    }}
                  >
                    按原文重新解析
                  </Button>
                  <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                    支持「第X章 标题：情节点」、数字编号、表格
                  </span>
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Segmented
              value={mode}
              options={[
                { value: 'replace', label: '替换现有大纲' },
                { value: 'append', label: '追加到后面' }
              ]}
              onChange={(v) => setMode(v)}
            />
            <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              逐行可改；标题留空的行会被丢弃
            </span>
          </div>

          <div className="space-y-3">
            {draft.map((vol) => (
              <div key={vol.id} className="rounded-md p-2.5" style={{ border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2">
                  <span className="chip chip-accent shrink-0">卷</span>
                  <Input
                    value={vol.title}
                    onChange={(e) => updateDraft(vol.id, { title: e.target.value })}
                    className="h-[28px] py-0 text-[12.5px] font-medium"
                  />
                  <Button size="sm" variant="ghost" onClick={() => removeVolume(vol.id)} title="移除本卷">
                    <Trash size={13} />
                  </Button>
                </div>
                <Input
                  value={vol.summary}
                  onChange={(e) => updateDraft(vol.id, { summary: e.target.value })}
                  placeholder="本卷目标（可留空）"
                  className="mt-1.5 h-[26px] py-0 text-[11.5px]"
                />
                <div className="mt-2 space-y-1.5">
                  {vol.children.map((ch) => (
                    <div key={ch.id} className="flex items-start gap-2">
                      <span className="chip shrink-0" style={{ height: 20, marginTop: 3 }}>
                        章
                      </span>
                      <Input
                        value={ch.title}
                        onChange={(e) => updateChild(vol.id, ch.id, { title: e.target.value })}
                        className="h-[26px] py-0 text-[12px]"
                        style={{ maxWidth: 240 }}
                      />
                      <Input
                        value={ch.summary}
                        onChange={(e) => updateChild(vol.id, ch.id, { summary: e.target.value })}
                        placeholder="一句话情节点"
                        className="h-[26px] py-0 text-[11.5px] flex-1"
                      />
                      <Button size="sm" variant="ghost" onClick={() => removeChapter(vol.id, ch.id)} title="移除本章">
                        <Trash size={12} />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  )
}