import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleStop, Sparkles, Trash } from 'lucide-react'
import type { Character, Project, WorldCategory, WorldEntry } from '@shared/types'
import { WORLD_CATEGORY_LABELS } from '@shared/types'
import { Button, Field, Input, Modal, Segmented, Select, Textarea } from '../../../components/ui'
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, resolveBudget } from '@shared/budgets'
import { taskModelLabel, useApp } from '../../../store/app'
import { useAiText } from '../useAiText'
import { bibleDigest, parseCharacters, parseWorld } from './parse'

export type BibleAiKind = 'characters' | 'world'

const SYSTEM: Record<BibleAiKind, string> = {
  characters:
    '你是资深小说策划与人物设计师。你熟悉中文网文的读者期待，擅长把人物写出可执行的反差与动机链条：每个人物都要有想要的东西、怕失去的东西、以及一个会把自己逼到墙角的缺陷。你只输出结构化数据，不写解释。',
  world:
    '你是资深小说世界观架构师。你擅长设计有代价、有边界的设定：力量体系必须能被量化并有明确上限，势力必须有利益冲突，地点必须能承载情节。你只输出结构化数据，不写解释。'
}

const DEFAULT_INSTRUCTION: Record<BibleAiKind, string> = {
  characters:
    '基于这本书的题材与前提，设计 5 个核心人物：1 名主角、2 名重要配角、1 名反派、1 名带来转折的次要角色。要求每个人的欲望与缺陷能互相咬合，反派要有让人认同的部分。',
  world:
    '基于这本书的题材与前提，补齐 6 条关键设定：2 条力量/规则体系、2 条势力组织、2 条地点场景。要求有明确代价与边界，能直接支撑情节冲突。'
}

const FORMAT_HINT: Record<BibleAiKind, string> = {
  characters: '每行一个人物，字段用 | 分隔，依次为：姓名|定位|年龄|身份|外貌|性格|动机|缺陷|人物弧光|说话方式',
  world: '每行一条设定，字段用 | 分隔，依次为：分类|标题|内容；分类只能是 世界观/力量体系/势力组织/地点场景/关键物品/规则禁忌/其它'
}

const CATEGORIES: WorldCategory[] = ['world', 'power', 'faction', 'place', 'item', 'rule', 'other']

type Phase = 'input' | 'streaming' | 'preview'

export function BibleAiModal({
  open,
  kind,
  project,
  onClose
}: {
  open: boolean
  kind: BibleAiKind
  project: Project
  onClose: () => void
}): ReactNode {
  const config = useApp((s) => s.config)
  const budgets = useApp((s) => s.config?.settings.tokenBudgets) ?? DEFAULT_TOKEN_BUDGETS
  const toast = useApp((s) => s.toast)
  const patchProject = useApp((s) => s.patchProject)

  const [instruction, setInstruction] = useState(DEFAULT_INSTRUCTION[kind])
  const [phase, setPhase] = useState<Phase>('input')
  const [chars, setChars] = useState<Character[]>([])
  const [world, setWorld] = useState<WorldEntry[]>([])
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const ai = useAiText()
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    setInstruction(DEFAULT_INSTRUCTION[kind])
    setPhase('input')
    setChars([])
    setWorld([])
    setMode('append')
    ai.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [ai.text, ai.thought, phase])

  const modelLabel = taskModelLabel(config, project, 'outline')
  const configured = modelLabel.indexOf('未配置') === -1
  const title = kind === 'characters' ? 'AI 帮我补全 · 角色' : 'AI 帮我补全 · 世界观'

  const start = async (): Promise<void> => {
    if (!configured) {
      toast('请先到设置 → 渠道与模型里配置一个模型', 'error')
      return
    }
    const digest = bibleDigest(project)
    const user = [
      digest ? `【已有设定，请勿重复，可在其基础上补充】\n${digest}\n` : '',
      `【任务】${instruction.trim()}`,
      `【输出格式】\n${FORMAT_HINT[kind]}\n只输出数据行，不要表头、不要序号、不要任何解释或 Markdown 代码块。`
    ]
      .filter(Boolean)
      .join('\n\n')

    setPhase('streaming')
    const result = await ai.run({
      task: 'outline',
      messages: [
        { role: 'system', content: SYSTEM[kind] },
        { role: 'user', content: user }
      ],
      // 角色 5 个约 900 字、世界观 6 条约 800 字，各自走自己的 key
      maxTokens: resolveBudget(
        budgets,
        kind === 'characters' ? BUDGET_KEYS.bibleEntry : BUDGET_KEYS.bibleEntryShort,
        kind === 'characters' ? 900 : 800
      ),
      temperature: 0.85
    })
    if (!result) {
      setPhase('input')
      return
    }
    if (kind === 'characters') {
      const parsed = parseCharacters(result)
      if (!parsed.length) {
        toast('没能解析出人物，请检查返回格式', 'error')
        setPhase('input')
        return
      }
      setChars(parsed)
    } else {
      const parsed = parseWorld(result)
      if (!parsed.length) {
        toast('没能解析出设定条目，请检查返回格式', 'error')
        setPhase('input')
        return
      }
      setWorld(parsed)
    }
    setPhase('preview')
  }

  const apply = (): void => {
    if (kind === 'characters') {
      const list = chars.filter((c) => c.name.trim())
      if (!list.length) {
        toast('预览里没有可用人物', 'info')
        return
      }
      patchProject((p) => ({
        ...p,
        bible: {
          ...p.bible,
          characters: mode === 'replace' ? list : [...p.bible.characters, ...list]
        }
      }))
      toast(`已加入 ${list.length} 个人物`, 'ok')
    } else {
      const list = world.filter((w) => w.title.trim())
      if (!list.length) {
        toast('预览里没有可用条目', 'info')
        return
      }
      patchProject((p) => ({
        ...p,
        bible: {
          ...p.bible,
          world: mode === 'replace' ? list : [...p.bible.world, ...list]
        }
      }))
      toast(`已加入 ${list.length} 条设定`, 'ok')
    }
    onClose()
  }

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
          正在生成…（可随时停止）
        </span>
        <Button variant="danger" onClick={ai.stop}>
          <CircleStop size={13} /> 停止
        </Button>
      </>
    ) : (
      <>
        <span className="mr-auto text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          共 {kind === 'characters' ? chars.length : world.length} 条
        </span>
        <Button onClick={() => setPhase('input')}>重新生成</Button>
        <Button variant="primary" onClick={apply}>
          确认插入
        </Button>
      </>
    )

  return (
    <Modal open={open} onClose={onClose} title={title} width={820} footer={footer}>
      {phase === 'input' && (
        <div className="space-y-3">
          <Field label="补充要求" hint={`当前模型：${modelLabel}${configured ? '' : ' · 请先到设置 → 渠道与模型配置'}`}>
            <Textarea rows={4} value={instruction} onChange={(e) => setInstruction(e.target.value)} className="text-[12.5px]" />
          </Field>
          <div className="rounded-md p-2.5 text-[11.5px] leading-relaxed" style={{ background: 'var(--panel-2)', color: 'var(--text-dim)' }}>
            AI 会先读一遍你已经写好的简介、人物与设定，避免重复造轮子。解析格式：<code>{FORMAT_HINT[kind]}</code>
            。生成结果会先进入预览，逐条可改，确认后才写入设定库。
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
              minHeight: 200,
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
          {/* 思考类模型会先吐推理内容：明确告诉用户「模型在动」，不是卡住了 */}
          <div className="flex items-center justify-between text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            <span>
              {ai.text
                ? `正文已收到 ${ai.text.length} 字`
                : ai.thought
                  ? `模型正在思考…（已 ${ai.thought.length} 字）`
                  : '已连接，等待模型吐出第一段内容…'}
            </span>
            <span>已等待 {Math.round(ai.elapsedMs / 1000)} 秒</span>
          </div>
        </div>
      )}

      {phase === 'preview' && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Segmented
              value={mode}
              options={[
                { value: 'append', label: '追加到现有' },
                { value: 'replace', label: '覆盖整个分区' }
              ]}
              onChange={(v) => setMode(v)}
            />
            <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              逐条可改；留空的行会被丢弃
            </span>
          </div>

          {kind === 'characters' ? (
            <div className="space-y-2">
              {chars.map((c, i) => (
                <div key={c.id} className="rounded-md p-2.5" style={{ border: '1px solid var(--border)' }}>
                  <div className="flex items-center gap-2">
                    <Input
                      value={c.name}
                      onChange={(e) => setChars((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                      className="h-[27px] py-0 text-[12.5px] font-medium"
                      style={{ maxWidth: 130 }}
                      placeholder="姓名"
                    />
                    <Input
                      value={c.role}
                      onChange={(e) => setChars((list) => list.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
                      className="h-[27px] py-0 text-[12px]"
                      style={{ maxWidth: 90 }}
                      placeholder="定位"
                    />
                    <Input
                      value={c.identity}
                      onChange={(e) => setChars((list) => list.map((x, j) => (j === i ? { ...x, identity: e.target.value } : x)))}
                      className="h-[27px] py-0 text-[12px] flex-1"
                      placeholder="身份"
                    />
                    <Button size="sm" variant="ghost" onClick={() => setChars((list) => list.filter((_, j) => j !== i))} title="移除">
                      <Trash size={12} />
                    </Button>
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-2">
                    <Input
                      value={c.personality}
                      onChange={(e) => setChars((list) => list.map((x, j) => (j === i ? { ...x, personality: e.target.value } : x)))}
                      className="h-[26px] py-0 text-[11.5px]"
                      placeholder="性格"
                    />
                    <Input
                      value={c.motivation}
                      onChange={(e) => setChars((list) => list.map((x, j) => (j === i ? { ...x, motivation: e.target.value } : x)))}
                      className="h-[26px] py-0 text-[11.5px]"
                      placeholder="动机"
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {world.map((w, i) => (
                <div key={w.id} className="rounded-md p-2.5" style={{ border: '1px solid var(--border)' }}>
                  <div className="flex items-center gap-2">
                    <Select
                      value={w.category}
                      onChange={(e) => setWorld((list) => list.map((x, j) => (j === i ? { ...x, category: e.target.value as WorldCategory } : x)))}
                      className="h-[27px] py-0 text-[12px]"
                      style={{ maxWidth: 120 }}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {WORLD_CATEGORY_LABELS[c]}
                        </option>
                      ))}
                    </Select>
                    <Input
                      value={w.title}
                      onChange={(e) => setWorld((list) => list.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                      className="h-[27px] py-0 text-[12.5px] flex-1"
                      placeholder="标题"
                    />
                    <Button size="sm" variant="ghost" onClick={() => setWorld((list) => list.filter((_, j) => j !== i))} title="移除">
                      <Trash size={12} />
                    </Button>
                  </div>
                  <Textarea
                    rows={2}
                    value={w.content}
                    onChange={(e) => setWorld((list) => list.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
                    className="mt-1.5 text-[11.5px]"
                    placeholder="内容"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}