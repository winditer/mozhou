import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Project, StyleProfile } from '@shared/types'
import { countWords, uid } from '@shared/utils'
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, resolveBudget } from '@shared/budgets'
import { abortChat, sendChat } from '../../../lib/ai'
import { isAbortMessage, streamStatus, useElapsed } from '../../../lib/stream'
import { resolveTaskModel, useApp } from '../../../store/app'
import { Button, Field, Input, Modal, Progress, Spinner, Textarea } from '../../../components/ui'
import { FileText, Plus, Trash2, Wand2 } from 'lucide-react'
import { TrialCompare } from './TrialCompare'
import {
  MAX_SAMPLES,
  MAX_TOTAL_WORDS,
  SAMPLE_WORDS_HINT,
  TRAIT_RANGE,
  buildTraitMessages,
  cleanList,
  excerptOf,
  FALLBACK_TRAIT,
  parseTraits,
  totalWords
} from './prompts'

type Step = 1 | 2 | 3

const STEPS: { n: Step; label: string; hint: string }[] = [
  { n: 1, label: '喂样本', hint: '2–5 段你写的文字' },
  { n: 2, label: '提炼特征', hint: '3–6 条可执行规则' },
  { n: 3, label: '试写对比', hint: '裸写 vs 带分身' }
]

export function StyleEditorModal({
  open,
  project,
  source,
  initialStep = 1,
  onClose
}: {
  open: boolean
  project: Project
  source: StyleProfile | null
  initialStep?: Step
  onClose: () => void
}): ReactNode {
  const { config, patchProject, toast } = useApp()
  const budgets = useApp((s) => s.config?.settings.tokenBudgets) ?? DEFAULT_TOKEN_BUDGETS
  const [step, setStep] = useState<Step>(initialStep)
  const [name, setName] = useState('')
  const [samples, setSamples] = useState<string[]>([''])
  const [traits, setTraits] = useState<string[]>([])
  const [extracting, setExtracting] = useState(false)
  /** 提炼时的流式正文 / 思考，用来显示进度（解析仍用最终全文） */
  const [streamOut, setStreamOut] = useState('')
  const [streamThought, setStreamThought] = useState('')
  const [pickOpen, setPickOpen] = useState(false)
  const aliveRef = useRef(true)
  const runRef = useRef(false)
  const stoppedRef = useRef(false)

  // 秒级计时 + 思考字数：等 1–2 分钟也不能让用户以为卡死
  const elapsed = useElapsed(extracting)
  const liveStatus = streamStatus({ text: streamOut, thought: streamThought, elapsedMs: elapsed })

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (runRef.current) abortChat()
    }
  }, [])

  // 关闭弹窗时若还在提炼，立即中断，别让请求白跑
  useEffect(() => {
    if (open) return
    if (!runRef.current) return
    runRef.current = false
    stoppedRef.current = true
    abortChat()
    setExtracting(false)
  }, [open])

  // 每次打开时从 source 重置草稿
  useEffect(() => {
    if (!open) return
    setStep(initialStep)
    setName(source?.name ?? '')
    setSamples(source && source.samples.length ? [...source.samples] : [''])
    setTraits(source ? [...source.traits] : [])
    setExtracting(false)
    setStreamOut('')
    setStreamThought('')
    setPickOpen(false)
  }, [open, source, initialStep])

  const resolved = resolveTaskModel(config, project, 'polish')
  const used = useMemo(() => totalWords(samples), [samples])
  const overLimit = used > MAX_TOTAL_WORDS
  const filled = cleanList(samples)
  const canNext = name.trim().length > 0 && filled.length >= 1 && !overLimit
  const withContent = project.chapters.filter((c) => excerptOf(c.content, 40).length > 0)

  const patchSample = (i: number, v: string): void =>
    setSamples((prev) => prev.map((x, idx) => (idx === i ? v : x)))

  const addSample = (text = ''): void => {
    if (samples.length >= MAX_SAMPLES) {
      toast(`最多 ${MAX_SAMPLES} 段样本`, 'info')
      return
    }
    setSamples((prev) => [...prev, text])
  }

  const removeSample = (i: number): void => setSamples((prev) => prev.filter((_, idx) => idx !== i))

  const extract = async (): Promise<void> => {
    if (!resolved) {
      toast('还没有可用模型，请先到设置 → 渠道与模型里配置', 'error')
      return
    }
    if (!filled.length) {
      toast('先喂至少一段文字', 'error')
      return
    }
    setExtracting(true)
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
        messages: buildTraitMessages(samples),
        task: 'polish',
        temperature: 0.35,
        maxTokens: resolveBudget(budgets, BUDGET_KEYS.styleTraits),
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
      if (!aliveRef.current) return
      // 解析仍然只用最终全文，流式内容只负责让用户看到进度
      const parsed = parseTraits(r.text || text)
      if (stoppedRef.current) return
      if (!parsed.length) {
        toast('没能提炼出特征，可以手动添加，或直接跳过提炼', 'info')
        return
      }
      setTraits(parsed)
      toast(`提炼出 ${parsed.length} 条特征，可逐条修改`, 'ok')
    } catch (e) {
      const message = (e as Error).message || '调用失败'
      if (!aliveRef.current || stoppedRef.current) return
      // 用户主动停止（含 main 抛的「已中止」）按 info 处理，不报红
      if (isAbortMessage(message)) {
        toast('已停止提炼', 'info')
        return
      }
      toast(`提炼失败：${message}`, 'error')
    } finally {
      runRef.current = false
      if (aliveRef.current) setExtracting(false)
    }
  }

  const stopExtract = (): void => {
    stoppedRef.current = true
    runRef.current = false
    abortChat()
    setExtracting(false)
    toast('已停止提炼', 'info')
  }

  const save = (bind: boolean): void => {
    const cleanSamples = cleanList(samples)
    if (!cleanSamples.length) {
      toast('至少需要一段样本', 'error')
      return
    }
    // prompt.ts 只在 traits 非空时注入「特征 + 样本」，空特征时补一条兜底规则
    const finalTraits = cleanList(traits)
    if (!finalTraits.length) finalTraits.push(FALLBACK_TRAIT)
    const id = source?.id ?? uid('sp')
    const profile: StyleProfile = {
      id,
      name: name.trim() || '未命名分身',
      samples: cleanSamples,
      traits: finalTraits,
      active: bind ? true : Boolean(source?.active)
    }
    patchProject((p) => {
      const exists = p.styleProfiles.some((x) => x.id === id)
      const list = exists ? p.styleProfiles.map((x) => (x.id === id ? profile : x)) : [...p.styleProfiles, profile]
      return {
        ...p,
        styleProfiles: profile.active ? list.map((x) => ({ ...x, active: x.id === id })) : list
      }
    })
    toast(bind ? `「${profile.name}」已绑定本书，后续生成都会带上它` : '已保存分身', 'ok')
    onClose()
  }

  const goStep = (n: Step): void => {
    if (n === step) return
    if (n > step && !canNext) return
    setStep(n)
  }

  const footer = (
    <>
      {step === 3 ? (
        <>
          <Button onClick={() => setStep(2)}>上一步</Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => save(false)}>
            仅保存
          </Button>
          <Button variant="primary" onClick={() => save(true)}>
            保存并绑定本书
          </Button>
        </>
      ) : step === 2 ? (
        <>
          <Button onClick={() => setStep(1)}>上一步</Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => setStep(3)}>
            跳过，直接试写
          </Button>
          <Button variant="primary" onClick={() => setStep(3)}>
            下一步：试写对比
          </Button>
        </>
      ) : (
        <>
          <Button onClick={onClose}>取消</Button>
          <div className="flex-1" />
          <Button variant="primary" disabled={!canNext} onClick={() => setStep(2)}>
            下一步：提炼特征
          </Button>
        </>
      )}
    </>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={820}
      title={source ? `编辑分身 · ${source.name || '未命名'}` : '新建文风分身'}
      footer={footer}
    >
      {/* 步骤指示 */}
      <div className="flex items-center gap-1.5 mb-4">
        {STEPS.map((s, i) => {
          const active = step === s.n
          const done = step > s.n
          const clickable = s.n < step || (s.n > step && canNext)
          return (
            <div key={s.n} className="flex items-center gap-1.5 min-w-0">
              <button
                className="flex items-center gap-1.5 px-1.5 h-6 rounded-md min-w-0"
                style={{
                  background: active ? 'var(--accent-soft)' : 'transparent',
                  border: 'none',
                  cursor: 'default',
                  opacity: active || done || clickable ? 1 : 0.55
                }}
                onClick={() => clickable && goStep(s.n)}
              >
                <span
                  className="inline-flex items-center justify-center rounded-full text-[10.5px] font-semibold shrink-0"
                  style={{
                    width: 17,
                    height: 17,
                    background: active ? 'var(--accent)' : done ? 'var(--ok)' : 'var(--panel-2)',
                    color: active ? 'var(--accent-text)' : done ? '#fff' : 'var(--text-faint)',
                    border: active || done ? 'none' : '1px solid var(--border-strong)'
                  }}
                >
                  {done ? '✓' : s.n}
                </span>
                <span
                  className="text-[12px] whitespace-nowrap"
                  style={{ color: active ? 'var(--accent)' : 'var(--text-dim)', fontWeight: active ? 600 : 400 }}
                >
                  {s.label}
                </span>
                <span className="text-[10.5px] whitespace-nowrap" style={{ color: 'var(--text-faint)' }}>
                  {s.hint}
                </span>
              </button>
              {i < STEPS.length - 1 && (
                <span style={{ width: 14, height: 1, background: 'var(--border-strong)' }} />
              )}
            </div>
          )
        })}
      </div>

      {step === 1 && (
        <div>
          <Field label="分身名称" className="mb-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：冷峻古言腔 / 贫嘴都市腔（方便以后切换时认得出）"
              style={{ height: 32 }}
            />
          </Field>

          <div className="flex items-center gap-2 mb-2">
            <span className="text-[12px] font-medium">样本</span>
            <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {SAMPLE_WORDS_HINT} · 最多 {MAX_SAMPLES} 段
            </span>
            <div className="flex-1" />
            <span
              className="text-[11px] tabular-nums"
              style={{ color: overLimit ? 'var(--danger)' : 'var(--text-dim)' }}
            >
              已用 {used} / {MAX_TOTAL_WORDS} 字
            </span>
          </div>

          <div className="mb-2">
            <Progress value={Math.min(used, MAX_TOTAL_WORDS)} max={MAX_TOTAL_WORDS} height={4} />
          </div>

          <div className="flex flex-col gap-2.5">
            {samples.map((s, i) => {
              const words = countWords(s)
              return (
                <div key={i} className="card p-2.5" style={{ background: 'var(--panel-2)' }}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>
                      样本 {i + 1}
                    </span>
                    <span className="text-[10.5px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
                      {words} 字
                      {words > 0 && words < 200 && ' · 偏短，建议 200–800 字'}
                      {words > 800 && ' · 偏长，可截取最像你的部分'}
                    </span>
                    <div className="flex-1" />
                    {samples.length > 1 && (
                      <button
                        className="icon-btn"
                        style={{ width: 22, height: 22 }}
                        title="删除这一段"
                        onClick={() => removeSample(i)}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                  <Textarea
                    value={s}
                    rows={4}
                    onChange={(e) => patchSample(i, e.target.value)}
                    placeholder="粘贴一段你自己写的、已经反复改过的文字——不是初稿，是你读着最「像自己」的那一段。"
                    style={{ minHeight: 84, fontSize: 12.5, lineHeight: 1.7 }}
                  />
                </div>
              )
            })}
          </div>

          <div className="flex items-center gap-2 mt-2.5">
            <Button size="sm" onClick={() => addSample()} disabled={samples.length >= MAX_SAMPLES}>
              <Plus size={12} /> 添加一段
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPickOpen((v) => !v)}
              disabled={!withContent.length}
              title={withContent.length ? '从本书已有章节里截一段' : '本书还没有正文'}
            >
              <FileText size={12} /> 从本书正文里取一段
            </Button>
            <div className="flex-1" />
            {overLimit && (
              <span className="text-[11px]" style={{ color: 'var(--danger)' }}>
                超出上限 {used - MAX_TOTAL_WORDS} 字，请删减后再继续
              </span>
            )}
          </div>

          {pickOpen && (
            <div className="card mt-2 overflow-hidden">
              <div
                className="px-3 py-1.5 text-[10.5px]"
                style={{ color: 'var(--text-faint)', borderBottom: '1px solid var(--border)' }}
              >
                点一章，把该章前 600 字填入新样本
              </div>
              <div className="max-h-[168px] overflow-auto scroll-thin">
                {withContent.map((c) => (
                  <button
                    key={c.id}
                    className="w-full text-left px-3 py-1.5 flex items-center gap-2 surface-hover"
                    style={{ border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent' }}
                    onClick={() => {
                      if (samples.length >= MAX_SAMPLES) {
                        toast(`最多 ${MAX_SAMPLES} 段样本`, 'info')
                        return
                      }
                      addSample(excerptOf(c.content, 600))
                      setPickOpen(false)
                    }}
                  >
                    <span className="text-[11.5px] truncate" style={{ color: 'var(--text)' }}>
                      {c.title}
                    </span>
                    <div className="flex-1" />
                    <span className="text-[10.5px] tabular-nums shrink-0" style={{ color: 'var(--text-faint)' }}>
                      {c.words} 字
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div
            className="mt-3 px-2.5 py-2 text-[11px] leading-relaxed"
            style={{
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
              borderRadius: 7,
              color: 'var(--text-dim)'
            }}
          >
            一段对话 + 一段描写 + 一段心理 + 一段叙事推进，<b>覆盖比堆量更有效</b>。别把两种完全不同的腔调塞进同一个分身——
            早期沙雕文和现在的正剧腔混在一起，提炼出的特征会互相打架；真要两种腔调，就建两个分身。
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <div className="flex items-center gap-2 mb-2.5">
            <span className="text-[12px] font-medium">文风特征</span>
            <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {TRAIT_RANGE}，每条都要能被编辑逐条核对
            </span>
            <div className="flex-1" />
            {extracting ? (
              <Button size="sm" variant="danger" onClick={stopExtract}>
                停止
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={!resolved} onClick={() => void extract()}>
                <Wand2 size={12} /> {traits.length ? '重新提炼' : '提炼文风特征'}
              </Button>
            )}
          </div>

          {!resolved && (
            <div className="text-[11px] mb-2" style={{ color: 'var(--warn)' }}>
              未配置模型，无法提炼。可以手动写几条，或直接跳过提炼（仅样本注入也能用）。
            </div>
          )}

          {extracting && (
            <div
              className="px-3 py-2.5 mb-2.5"
              style={{ background: 'var(--accent-soft)', borderRadius: 7, color: 'var(--accent)' }}
            >
              <div className="flex items-center gap-2 text-[11.5px] flex-wrap">
                <Spinner size={12} />
                <span>正在读你的样本，提炼句子节奏与用词习惯…</span>
                <span className="tabular-nums" style={{ color: 'var(--text-dim)' }}>
                  {liveStatus}
                </span>
              </div>
              {streamOut && (
                <div
                  className="mt-2 rounded-md p-2.5 text-[11.5px] whitespace-pre-wrap selectable scroll-thin"
                  style={{
                    maxHeight: 140,
                    overflow: 'auto',
                    background: 'var(--panel)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-dim)',
                    lineHeight: 1.7,
                    fontFamily: 'var(--editor-font)',
                    wordBreak: 'break-word'
                  }}
                >
                  {streamOut}
                </div>
              )}
            </div>
          )}

          {traits.length === 0 && !extracting ? (
            <div
              className="text-[11.5px] leading-relaxed px-3 py-6 text-center"
              style={{ background: 'var(--panel-2)', borderRadius: 7, color: 'var(--text-faint)' }}
            >
              还没有特征。点「提炼文风特征」让 AI 读一遍你的样本，
              <br />
              也可以直接手写几条——或者跳过这一步，只靠样本注入。
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {traits.map((t, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span
                    className="text-[10.5px] tabular-nums w-4 text-right shrink-0"
                    style={{ color: 'var(--text-faint)' }}
                  >
                    {i + 1}
                  </span>
                  <Input
                    value={t}
                    onChange={(e) =>
                      setTraits((prev) => prev.map((x, idx) => (idx === i ? e.target.value : x)))
                    }
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
          )}

          <div className="flex items-center gap-2 mt-2">
            <Button size="sm" variant="ghost" onClick={() => setTraits((prev) => [...prev, ''])}>
              <Plus size={12} /> 加一条
            </Button>
            <div className="flex-1" />
            <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
              {cleanList(traits).length
                ? `${cleanList(traits).length} 条生效`
                : '未提炼特征 · 保存时自动补一条兜底规则，样本照常注入'}
            </span>
          </div>

          <div
            className="mt-3 px-2.5 py-2 text-[11px] leading-relaxed"
            style={{
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
              borderRadius: 7,
              color: 'var(--text-dim)'
            }}
          >
            特征卡会进入每次生成的系统提示词，样本则不重新训练模型——它只是被塞进上下文（few-shot），
            所以即建即用、随改随生效。提炼失败或跳过都不影响使用，只是效果弱一点。
          </div>
        </div>
      )}

      {step === 3 && (
        <TrialCompare project={project} name={name} samples={samples} traits={traits} />
      )}
    </Modal>
  )
}