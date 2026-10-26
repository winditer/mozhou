/**
 * AI 一键开书
 *
 * 五步流水线：书名简介 → 核心设定 → 分卷大纲 → 首卷章纲 → 首章正文。
 * 每步都是「流式生成 + 容错解析 + 可编辑产物卡」，可重跑、可中断；
 * 全部完成后一次性装配成 Project 落到书架。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleStop, RotateCcw, Settings2, Shuffle, Sparkles } from 'lucide-react'
import type { ChatRequest, PromptMessage, TaskKind } from '@shared/types'
import { GENRES } from '@shared/genres'
import { SCENES, getScene } from '@shared/scenes'
import { clamp, countWords, estimateTokens, stripHtml, truncate, uid } from '@shared/utils'
import { abortChat, sendChat } from '../../lib/ai'
import { topUpDraft, type TopUpResult } from '../../lib/generate'
import { buildDraftMessages } from '../../lib/prompt'
import { isAbortMessage, streamStatus, useElapsed } from '../../lib/stream'
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, resolveBudget, type BudgetKey, type TokenBudgets } from '@shared/budgets'
import { resolveTaskModel, useApp } from '../../store/app'
import { Button, Field, Input, Modal, Select, Spinner, Textarea } from '../../components/ui'
import {
  AddRow,
  CardShell,
  DraftPreview,
  LineRow,
  SettingRow,
  StepBar,
  StreamBox,
  TokenUsage
} from './quickstart/steps'
import {
  assembleProject,
  chaptersMessages,
  firstChapterMessages,
  messagesTokens,
  parseChaptersOutput,
  parseSettingsOutput,
  parseTitleOutput,
  parseVolumesOutput,
  settingsMessages,
  titleMessages,
  volumesMessages,
  type ChapterItem,
  type QuickStartProduct,
  type SettingItem,
  type StepStatus,
  type TitleItem,
  type VolumeItem,
  looksSubstantial,
  looksLikeTitle
} from './quickstart/pipeline'

/** 五步的初始状态 */
const INITIAL_STATUS: Record<number, StepStatus> = { 1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending' }

const DEFAULT_SCENE = 'long-novel'

/* ───────────────────── 首章「补字」 ─────────────────────

   为什么要有这一段：正文那条路的长度守护以前只在 project.settings.lengthMode === 'strict'
   时生效，而一键开书这会书还没建出来、压根没有 project —— 于是首章永远只跑一轮
   sendChat，maxTokens 按字数给死后模型吐多少算多少。目标 2500 字只出来 800 字，
   用户拿到的是个残缺首章，还以为模型就这点产能。

   补写循环本身已沉到 generate.ts 的 topUpDraft（正文生成也用同一套），这里只做两件事：
   把首章的消息/预算/中止标志喂进去，再把结果按 quickstart 的界面约定落地。 */

/** runStep 的首轮上下文，交给 followUp 钩子继续往下写（目前只有首章补字用它） */
interface FollowUpCtx {
  messages: PromptMessage[]
  /** 首轮拿到的正文 */
  text: string
  /** 首轮流式累积的正文（渠道不回 text 时兜底） */
  streamText: string
  channel: ChatRequest['channel']
  model: string
  temperature: number
  budgets: TokenBudgets
  /** 每轮补写开始前检查：用户点了停止就别再发请求 */
  aborted: () => boolean
  onDelta: (delta: string) => void
  onThought: (delta: string) => void
  onStage: (stage: string) => void
  onUsage: (tokens: number) => void
}

interface FollowUpResult {
  /** 完整正文（首轮 + 所有补写轮），为空表示没拿到东西 */
  text: string
  /** 补写中途被用户停止 */
  aborted: boolean
  /** 没写够/没写成时给用户看的一句话；空串表示不用提示 */
  note: string
}

interface FormState {
  idea: string
  sceneId: string
  genreId: string
  perChapter: number
}

function defaultForm(): FormState {
  return {
    idea: '',
    sceneId: DEFAULT_SCENE,
    genreId: '',
    perChapter: getScene(DEFAULT_SCENE).defaultChapterWords
  }
}

export function QuickStart({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const config = useApp((s) => s.config)
  const newProject = useApp((s) => s.newProject)
  const toast = useApp((s) => s.toast)
  const setView = useApp((s) => s.setView)

  const [form, setForm] = useState<FormState>(defaultForm)
  const [title, setTitle] = useState<TitleItem | null>(null)
  const [settings, setSettings] = useState<SettingItem[]>([])
  const [volumes, setVolumes] = useState<VolumeItem[]>([])
  const [chapters, setChapters] = useState<ChapterItem[]>([])
  const [chapterText, setChapterText] = useState('')

  const [statuses, setStatuses] = useState<Record<number, StepStatus>>({ ...INITIAL_STATUS })
  const [errs, setErrs] = useState<Record<number, string>>({})
  const [raws, setRaws] = useState<Record<number, string>>({})
  const [maxStep, setMaxStep] = useState(1)
  const [runningStep, setRunningStep] = useState<number | null>(null)
  const [streamText, setStreamText] = useState('')
  /** 思考增量（思考类模型可能一两分钟只吐思考，得让用户看见） */
  const [streamThought, setStreamThought] = useState('')
  /**
   * 「阶段文案」，目前只有首章补字用：
   * 补写那几十秒里正文增量很少，光靠 streamStatus 会一直显示「已收到 820 字」像是卡死，
   * 得有一条「正在补写第 1 轮」把原因说清楚。空串表示没有阶段信息，退回 streamStatus。
   */
  const [streamStage, setStreamStage] = useState('')
  const [usedTokens, setUsedTokens] = useState(0)
  const [creating, setCreating] = useState(false)

  const abortRef = useRef(false)
  const runningRef = useRef(false)
  const streamRef = useRef('')
  const thoughtRef = useRef('')

  // 秒级计时，跑到多久都继续等（renderer 不设硬超时，靠文案说明模型在动）
  const elapsed = useElapsed(runningStep !== null)
  const liveStatus = streamStage || streamStatus({ text: streamText, thought: streamThought, elapsedMs: elapsed })

  const outlineModel = resolveTaskModel(config, null, 'outline')
  const draftModel = resolveTaskModel(config, null, 'draft')
  /** 策划类步骤用 outline 模型，正文用 draft 模型；任一缺失都要给出明确提示 */
  const missingModel = !outlineModel || !draftModel

  const scene = getScene(form.sceneId)

  /* 每次打开都从干净状态开始 */
  useEffect(() => {
    if (!open) return
    setForm(defaultForm())
    setTitle(null)
    setSettings([])
    setVolumes([])
    setChapters([])
    setChapterText('')
    setStatuses({ ...INITIAL_STATUS })
    setErrs({})
    setRaws({})
    setMaxStep(1)
    setRunningStep(null)
    setStreamText('')
    setStreamThought('')
    setStreamStage('')
    setUsedTokens(0)
    setCreating(false)
    abortRef.current = false
    runningRef.current = false
    streamRef.current = ''
    thoughtRef.current = ''
  }, [open])

  /* 组件卸载时中断未完成的请求，避免后台空跑 */
  useEffect(
    () => () => {
      if (runningRef.current) {
        abortRef.current = true
        abortChat()
      }
    },
    []
  )

  const setStatus = useCallback((step: number, status: StepStatus): void => {
    setStatuses((prev) => ({ ...prev, [step]: status }))
  }, [])
  const setErr = useCallback((step: number, message: string): void => {
    setErrs((prev) => ({ ...prev, [step]: message }))
  }, [])
  const setRaw = useCallback((step: number, text: string): void => {
    setRaws((prev) => ({ ...prev, [step]: text }))
  }, [])

  /* ───────────────────── 通用：跑一步 ───────────────────── */

  /**
   * 每步的输出预算由设置里各组预算决定（书名/设定/分卷/章纲/首章各一个 key），
   * 不再写死数字。
   *
   * 配置里那条经验仍然成立：推理类模型（deepseek-reasoner、o 系列等）的思考过程
   * **也计入 max_tokens**，思考把预算吃光时正文就是空字符串。早先设定卡 2600、
   * 章纲卡 2200，正是「解析失败 / 一片空白」的主因。所以调低这几项前先确认模型不推理，
   * 按字数估算的那些 key 也已经含 thinkPad 余量。
   *
   * 目标字数一律由调用方传进来，不在这个 useCallback 里读 form：它的依赖数组里没有
   * form / config，直接读会拿到旧值（改完「每章字数」再跑第 5 步，预算仍按老数字算）。
   * 调用点是每次渲染重建的，从那里传入永远是最新的。
   *
   * `opts.followUp` 是一段「首轮跑完之后、判 apply 之前」的钩子，只有首章正文用它做补字：
   * 补字存在的唯一理由就是别让用户拿到残缺首章，所以它必须能**改掉要 apply 的 text**，
   * 也得能告诉调用方「用户中途停了」——那种情况下即使字不够也不能报错、不能丢内容。
   */
  const runStep = useCallback(
    async (
      step: number,
      task: TaskKind,
      build: () => PromptMessage[],
      budgetKey: BudgetKey,
      apply: (text: string) => boolean,
      targetWords?: number,
      opts?: {
        followUp?: (ctx: FollowUpCtx) => Promise<FollowUpResult>
      }
    ): Promise<boolean> => {
      const picked = resolveTaskModel(useApp.getState().config, null, task)
      const budgets = useApp.getState().config?.settings.tokenBudgets ?? DEFAULT_TOKEN_BUDGETS
      if (!picked) {
        useApp.getState().toast('请先到「设置 → 渠道与模型」配置一个可用模型', 'error')
        return false
      }

      abortRef.current = false
      runningRef.current = true
      streamRef.current = ''
      thoughtRef.current = ''
      setStatus(step, 'running')
      setErr(step, '')
      setStreamText('')
      setStreamThought('')
      setStreamStage('')
      setRunningStep(step)

      try {
        const messages = build()
        // 首章走 draft 温度，与 generate.ts 里正文那条路一致
        const temperature = task === 'draft' ? 0.86 : 0.78
        const res = await sendChat({
          channel: picked.channel,
          model: picked.model,
          messages,
          task,
          temperature,
          // 预算按 key 现算：只有首章是「按字数」的，其余几步是固定额度
          maxTokens: resolveBudget(budgets, budgetKey, targetWords),
          onDelta: (delta) => {
            if (abortRef.current) return
            streamRef.current += delta
            setStreamText(streamRef.current)
          },
          onThought: (delta) => {
            if (abortRef.current) return
            thoughtRef.current += delta
            setStreamThought(thoughtRef.current)
          }
        })

        let text = res.text || streamRef.current
        setStreamText(text)
        // 渠道不回 usage 时用本地估算兜底
        const promptTokens = res.promptTokens || messagesTokens(messages)
        const completionTokens = res.completionTokens || estimateTokens(text)
        setUsedTokens((v) => v + promptTokens + completionTokens)

        // 补字没写够时要留一条说明：字数不达标的话，用户得知道为什么
        let topUpNote = ''

        // 首轮失败/中断交给下面的 abort / apply 分支报错，钩子只在拿到正文之后接手
        if (opts?.followUp && text.trim() && !abortRef.current) {
          const follow = await opts.followUp({
            messages,
            text,
            streamText: streamRef.current,
            channel: picked.channel,
            model: picked.model,
            temperature,
            budgets,
            aborted: () => abortRef.current,
            onDelta: (delta) => {
              if (!delta) return
              streamRef.current += delta
              setStreamText(streamRef.current)
            },
            onThought: (delta) => {
              thoughtRef.current += delta
              setStreamThought(thoughtRef.current)
            },
            onStage: (stage) => setStreamStage(stage),
            onUsage: (tokens) => setUsedTokens((v) => v + tokens)
          })
          setStreamStage('')
          // 以钩子返回的 text 为准（它含首轮 + 全部补写轮），别再退回 res.text 把补的部分丢掉
          if (follow.text.trim()) text = follow.text
          setStreamText(text)
          // 停止与失败都要保住正文：用户已经看着这些字流出来了，不能因为补写出问题就清空
          setRaw(step, text)
          if (follow.aborted) {
            if (apply(text)) setMaxStep((m) => Math.max(m, Math.min(5, step + 1)))
            setStatus(step, 'pending')
            useApp.getState().toast('已停止生成', 'info')
            return false
          }
          topUpNote = follow.note
        }

        if (abortRef.current) {
          setStatus(step, 'pending')
          useApp.getState().toast('已停止生成', 'info')
          return false
        }

        setStreamText(text)
        setRaw(step, text)

        if (!apply(text)) {
          setStatus(step, 'error')
          // 分清两种失败：模型根本没吐正文 vs 吐了但结构没解析出来。
          // 前者要提示加预算或换模型，后者才谈手工整理——否则用户会一直改一个空框。
          const hadThought = (thoughtRef.current ?? '').trim().length > 0
          setErr(
            step,
            !text.trim()
              ? hadThought
                ? '模型只输出了思考过程，没有吐正文就结束了。多半是 max tokens 被思考耗尽：请到「设置 → 渠道与模型」换一个非推理模型，或把该渠道的最大输出调大后重试。'
                : '模型没有返回任何内容就结束了。请重试；若反复如此，检查该渠道的模型名与余额。'
              : '没能从返回内容里解析出结构。可以在下方原文里手工整理成 JSON 或「标题：内容」后点「重新解析」。'
          )
          useApp.getState().toast(text.trim() ? '解析失败，原文已保留，可手工修改' : '模型没有返回正文', 'error')
          return false
        }

        setStatus(step, 'done')
        // 补字没达标/失败的那条说明要留着，否则用户只看到「完成」却字不够
        setErr(step, topUpNote)
        setMaxStep((m) => Math.max(m, Math.min(5, step + 1)))
        return true
      } catch (e) {
        const message = (e as Error).message || '调用失败'
        // 用户主动停止（abortRef 或 main 抛的「已中止」）都按 info 收尾，不报红
        if (abortRef.current || isAbortMessage(message)) {
          setStatus(step, 'pending')
          useApp.getState().toast('已停止生成', 'info')
          return false
        }
        setStatus(step, 'error')
        setErr(step, message)
        useApp.getState().toast(`第 ${step} 步生成失败：${message}`, 'error')
        return false
      } finally {
        runningRef.current = false
        setRunningStep(null)
        setStreamStage('')
      }
    },
    [setErr, setRaw, setStatus]
  )

  const stop = (): void => {
    abortRef.current = true
    abortChat()
  }

  const close = (): void => {
    if (runningRef.current) {
      abortRef.current = true
      abortChat()
    }
    onClose()
  }

  /* ───────────────────── 各步解析后的写入 ───────────────────── */

  const applyTitle = useCallback((text: string): boolean => {
    const parsed = parseTitleOutput(text)
    if (!parsed.title) return false
    setTitle({ title: parsed.title, intro: parsed.intro })
    return true
  }, [])

  const applySettings = useCallback((text: string): boolean => {
    const items = parseSettingsOutput(text)
    // 空壳也要拦住：只有标题没有内容的条目等于没生成
    if (items.length === 0 || !looksSubstantial(items)) return false
    setSettings(items)
    return true
  }, [])

  const applyVolumes = useCallback((text: string): boolean => {
    const items = parseVolumesOutput(text)
    if (items.length === 0) return false
    setVolumes(items)
    return true
  }, [])

  const applyChapters = useCallback((text: string): boolean => {
    const items = parseChaptersOutput(text)
    if (items.length === 0 || !looksSubstantial(items)) return false
    setChapters(items)
    return true
  }, [])

  const applyFirstChapter = useCallback((text: string): boolean => {
    const body = text.trim()
    if (!body) return false
    setChapterText(body)
    return true
  }, [])

  /* ───────────────────── 五个步骤的生成器 ───────────────────── */

  // 带上设置里的题材公约：一键开书是「书还没建」的阶段，拿不到 project 上的设置，
  // 只能从全局 config 取，否则开出来的书按内置公约定调、后续正文按自定义公约写，前后不一。
  const idea = {
    idea: form.idea.trim(),
    sceneId: form.sceneId,
    genreId: form.genreId,
    conventions: config?.settings.genreConventions
  }

  const runTitle = (): Promise<boolean> =>
    runStep(1, 'outline', () => titleMessages(idea), BUDGET_KEYS.quickstartTitle, applyTitle)

  const runSettings = (): Promise<boolean> => {
    if (!title) return Promise.resolve(false)
    return runStep(2, 'outline', () => settingsMessages({ ...idea, title, perChapter: form.perChapter }), BUDGET_KEYS.quickstartSettings, applySettings)
  }

  const runVolumes = (): Promise<boolean> => {
    if (!title) return Promise.resolve(false)
    return runStep(3, 'outline', () => volumesMessages({ ...idea, title, settings }), BUDGET_KEYS.quickstartVolumes, applyVolumes)
  }

  const runChapters = (): Promise<boolean> => {
    if (!title) return Promise.resolve(false)
    return runStep(4, 'outline', () => chaptersMessages({ ...idea, title, settings, volumes }), BUDGET_KEYS.quickstartChapters, applyChapters)
  }

  const productNow = (firstChapter: string): QuickStartProduct => ({
    idea: form.idea.trim(),
    sceneId: form.sceneId,
    genreId: form.genreId,
    perChapter: form.perChapter,
    title: title ?? { title: '', intro: '' },
    settings,
    volumes,
    chapters,
    firstChapter
  })

  /** 补写要用的「本章约定」：首章标题 + 它的情节点，取不到就退化成整段章纲列表 */
  const firstChapterConvention = (): string => {
    const first = chapters[0]
    if (first && first.summary.trim()) return `本章约定：${first.title} —— ${first.summary.trim()}`
    const list = chapters
      .slice(0, 3)
      .map((c) => `- ${c.title}：${c.summary}`)
      .join('\n')
    return list ? `本章约定（首章为第一条）：\n${list}` : ''
  }

  /**
   * 补字轮的上下文消息：`[system, user(首章原始要求), user(本章约定 + 已写正文)]`。
   *
   * 两件事必须踩住：
   * 一、**已写正文放 user 轮，不放 assistant 轮**。放 assistant 轮会让模型顺着自己
   *    刚写的结尾再「续」一遍，越补越水——这是补写循环里踩过的坑。
   * 二、**正文自己带上「【已经写出来的正文】」标题**。因为调用 topUpDraft 时传了
   *    messagesAlreadyIncludeText: true，它不会再补这个标题，只会在末尾追加
   *    「【本次任务】只补差额」的指令。不自己标出材料段，模型分不清哪段是正文、哪段是要求。
   *
   * 这是**单轮**上下文，只描述「现在写到哪了」。真正的循环控制（轮数、递减预算、
   * 空正文重试、单轮无进展就收尾、末尾那条补差额指令）全部交给 topUpDraft。
   */
  const firstChapterTopUpMessages = (
    messages: PromptMessage[],
    written: string
  ): PromptMessage[] => {
    const convention = firstChapterConvention()
    const body = stripHtml(written).trim()
    return [
      ...messages,
      {
        role: 'user' as const,
        content: [
          convention,
          body ? `【已经写出来的正文】\n${truncate(body, 6000)}` : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ]
  }

  /**
   * 补字没写够时的一句话：走 setErr(5, ...)，因为「完成但有缺口」和「失败」在界面上
   * 都是同一个 error 提示位，用户在首章卡片上才看得到。
   * thoughtStarved 要单独说：那是推理模型把额度吃光，换模型或调预算才解决，
   * 跟「模型今天偷懒」是两回事。
   */
  const topUpNote = (r: TopUpResult): string => {
    const total = countWords(r.text)
    const target = form.perChapter
    if (r.stop === 'done') return ''
    if (r.stop === 'error') {
      return `正文已保留，但补写失败（${r.error?.message || '未知错误'}）。当前 ${total} / ${target} 字，可以点「重新写」再来一次。`
    }
    if (r.stop === 'empty') {
      return r.thoughtStarved
        ? `正文已保留，但模型把输出额度全用在思考上了，补写写不出字。当前 ${total} / ${target} 字：请到「设置 → 渠道与模型」换一个非推理模型，或调大该渠道的最大输出。`
        : `正文已保留，但补写的模型没有产出任何内容。当前 ${total} / ${target} 字，可以点「重新写」。`
    }
    if (r.stop === 'noProgress') return `已保留现有正文：最后几轮补写几乎没有新增字数（${total} / ${target} 字），不再继续尝试。`
    return `已补写 ${r.rounds.length} 轮，篇幅仍略短（${total} / ${target} 字）。可以先采纳，再用正文页的「续写」往下补。`
  }

  /**
   * 首章多发一步「补字」：正文那条路的长度守护默认开启，但一键开书这会儿书还没建出来、
   * 压根没有 project，于是首章永远只跑一轮 —— 目标 2500 字常常只拿到 800 字。
   * 这里把 topUpDraft 接上，跟正文生成用同一套判定与预算递减。
   *
   * 中止：topUpDraft 内部不检查中止标志，靠的是 onDelta/onStage 里先看 abortRef；
   * 中止时 sendChat 抛「已中止」，topUpDraft 收进 stop: 'error' 并**保留 r.text**，
   * 所以这里用 isAbortMessage 区分「用户点了停止」和「真失败」，前者按 info 收尾。
   */
  const runFirstChapter = (): Promise<boolean> =>
    runStep(
      5,
      'draft',
      () =>
        firstChapterMessages(
          productNow(''),
          useApp.getState().styleLibrary,
          useApp.getState().config?.settings.genreConventions,
          useApp.getState().skillLibrary,
          useApp.getState().config?.settings.defaultSkillIds
        ),
      BUDGET_KEYS.quickstartFirstChapter,
      applyFirstChapter,
      form.perChapter,
      {
        followUp: async (ctx) => {
          const target = form.perChapter
          // 首章从零开始，existingWords 固定 0：字数完全由这次生成的正文决定
          const res = await topUpDraft({
            // topUpDraft 继承 GenParams，可它整个循环只用 channel/model/task/onDelta/onStage，
            // project 与 chapter 一次都没读（消息由下面的 messages 全权决定）。
            // 这里仍按契约传齐：草稿 project 是「这本书现在长什么样」的真实快照，
            // 哪天 topUpDraft 真的用它算上下文，一键开书也不会递个空对象进去。
            // chapter 给 null 是因为首章还没落库，而草稿 project 里那章本来就是空正文，
            // 正对应「这一章一个字都还没写」，比塞一个假 chapter 更接近事实。
            project: assembleProject(productNow('')),
            chapter: null,
            channel: ctx.channel,
            model: ctx.model,
            task: 'draft',
            temperature: ctx.temperature,
            library: useApp.getState().styleLibrary,
            conventions: useApp.getState().config?.settings.genreConventions,
            budgets: ctx.budgets,
            // 首章补写吃首章自己的预算项：用户在设置页调了「首章正文」的额度，
            // 补写轮也得跟着走，否则配了等于没配
            continueBudgetKey: BUDGET_KEYS.quickstartFirstChapter,
            messages: firstChapterTopUpMessages(ctx.messages, ctx.text) as ReturnType<typeof buildDraftMessages>,
            // 正文已经由 firstChapterTopUpMessages 拼进 messages，内部别再塞一遍，
            // 只留末尾那条「只补差额」的指令
            messagesAlreadyIncludeText: true,
            // topUpDraft 是按这个 text 算字数与差额的，必须给最准的那份：
            // ctx.text 是首轮的回包，首轮中断/回包为空时用流里累积的正文兜底
            text: ctx.text || ctx.streamText,
            targetWords: target,
            existingWords: 0,
            onDelta: (d) => {
              if (ctx.aborted()) return
              ctx.onDelta(d)
            },
            onThought: (d) => {
              if (ctx.aborted()) return
              ctx.onThought(d)
            },
            onStage: (stage) => {
              if (ctx.aborted()) return
              ctx.onStage(stage)
            }
          })
          const aborted =
            ctx.aborted() ||
            (res.stop === 'error' && isAbortMessage(res.error?.message ?? ''))
          return { text: res.text || ctx.text, aborted, note: aborted ? '' : topUpNote(res) }
        }
      }
    )

  const runner = (step: number): Promise<boolean> => {
    switch (step) {
      case 1:
        return runTitle()
      case 2:
        return runSettings()
      case 3:
        return runVolumes()
      case 4:
        return runChapters()
      default:
        return runFirstChapter()
    }
  }

  const dataReady = (step: number): boolean => {
    switch (step) {
      case 1:
        return Boolean(title && title.title.trim())
      case 2:
        return settings.length > 0
      case 3:
        return volumes.length > 0
      case 4:
        return chapters.length > 0
      default:
        return chapterText.trim().length > 0
    }
  }

  /** 采用当前步产物，直接开下一步 */
  const accept = (step: number): void => {
    if (step >= 5) return
    void runner(step + 1)
  }

  /** 解析失败时用（可能被手工改过的）原文再试一次 */
  const reparse = (step: number, apply: (text: string) => boolean): void => {
    const text = raws[step] ?? ''
    if (apply(text)) {
      setStatus(step, 'done')
      setErr(step, '')
      setMaxStep((m) => Math.max(m, Math.min(5, step + 1)))
      toast('已重新解析', 'ok')
    } else {
      toast('仍然解析不出结构，请整理成 JSON 或「标题：内容」格式', 'error')
    }
  }

  const complete = async (): Promise<void> => {
    if (!title || !dataReady(1) || !dataReady(2) || !dataReady(3) || !dataReady(4) || !dataReady(5)) {
      toast('还有步骤没有完成，先把五步走完吧', 'info')
      return
    }
    setCreating(true)
    try {
      const project = assembleProject(productNow(chapterText))
      await newProject(project)
      toast(`《${project.title}》已创建，可以开写了`, 'ok')
      onClose()
    } catch (e) {
      toast(`创建失败：${(e as Error).message}`, 'error')
    } finally {
      setCreating(false)
    }
  }

  /* ───────────────────── 交互小工具 ───────────────────── */

  const shuffleIdea = (): void => {
    const pool = getScene(form.sceneId).examples
    if (pool.length === 0) return
    const current = form.idea.trim()
    const candidates = pool.filter((x) => x !== current)
    const list = candidates.length > 0 ? candidates : pool
    const next = list[Math.floor(Math.random() * list.length)] ?? pool[0] ?? ''
    setForm((f) => ({ ...f, idea: next }))
  }

  const onSceneChange = (id: string): void => {
    const next = getScene(id)
    setForm((f) => ({ ...f, sceneId: id, perChapter: next.defaultChapterWords }))
  }

  const goSettings = (): void => {
    setView('settings')
    onClose()
  }

  const showCard = (step: number): boolean =>
    step <= maxStep || statuses[step] === 'running' || statuses[step] === 'error'

  const doneCount = [1, 2, 3, 4, 5].filter((step) => dataReady(step)).length
  const busy = runningStep !== null || creating
  const tokens = usedTokens + (runningStep !== null ? estimateTokens(streamText) : 0)

  const stepHint = (step: number): string => {
    switch (step) {
      case 1:
        return '书名作为作品名，简介进作品简介'
      case 2:
        return '「世界观」进设定库，「角色」进人物档案'
      case 3:
        return '分卷写进大纲，第一卷挂上章纲'
      case 4:
        return '章纲会同时生成对应章节'
      default:
        return ''
    }
  }

  const footerFor = (step: number): ReactNode => {
    const status = statuses[step] ?? 'pending'
    const running = status === 'running'
    const started = status === 'done' || status === 'error'

    if (running) {
      return (
        <>
          <span className="text-[11.5px] tabular-nums min-w-0 truncate" style={{ color: 'var(--text-faint)' }}>
            {liveStatus}
          </span>
          <Button variant="danger" onClick={stop} type="button">
            <CircleStop size={13} />
            停止
          </Button>
        </>
      )
    }

    if (step === 5) {
      return (
        <>
          <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            {chapterText ? `正文 ${countWords(chapterText)} 字` : '生成后可直接写入书架'}
          </span>
          <div className="flex items-center gap-2">
            <Button onClick={() => void runner(5)} disabled={!draftModel || creating} type="button">
              <RotateCcw size={13} />
              {chapterText ? '重新写' : '生成正文'}
            </Button>
            <Button
              variant="primary"
              onClick={() => void complete()}
              disabled={creating || !dataReady(5)}
              type="button"
            >
              {creating ? <Spinner size={12} /> : <Sparkles size={13} />}
              写入书架并打开
            </Button>
          </div>
        </>
      )
    }

    return (
      <>
        <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          {stepHint(step)}
        </span>
        <div className="flex items-center gap-2">
          {started && (
            <Button onClick={() => void runner(step)} disabled={!outlineModel} type="button">
              <RotateCcw size={13} />
              重新生成
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => (started ? accept(step) : void runner(step))}
            disabled={!outlineModel || (started && !dataReady(step))}
            type="button"
          >
            {started ? '采用并继续' : '开始生成'}
          </Button>
        </div>
      </>
    )
  }

  /* ───────────────────── 渲染 ───────────────────── */

  const genreHints = scene.genreIds

  return (
    <Modal
      open={open}
      onClose={close}
      title="✨ AI 一键开书"
      width={780}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <div className="text-[11.5px] truncate min-w-0 flex-1" style={{ color: 'var(--text-faint)' }}>
            {runningStep !== null
              ? `第 ${runningStep} 步生成中 · ${liveStatus}（可用 ${runningStep === 5 ? draftModel?.label ?? '—' : outlineModel?.label ?? '—'}）`
              : `${doneCount} / 5 步已就绪`}
          </div>
          <div className="flex items-center gap-2">
            {runningStep !== null && (
              <Button variant="danger" onClick={stop} type="button">
                <CircleStop size={13} />
                停止生成
              </Button>
            )}
            <Button onClick={close} disabled={creating} type="button">
              关闭
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <StepBar
          statuses={[statuses[1] ?? 'pending', statuses[2] ?? 'pending', statuses[3] ?? 'pending', statuses[4] ?? 'pending', statuses[5] ?? 'pending']}
          current={runningStep ?? Math.min(5, maxStep)}
        />
        <TokenUsage tokens={tokens} />
      </div>

      {/* 步骤 0：输入 */}
      <div className="card p-4 mb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[13.5px] font-semibold">一句话灵感</div>
          <Button size="sm" variant="ghost" onClick={shuffleIdea} disabled={busy} type="button">
            <Shuffle size={12} />
            换一个
          </Button>
        </div>
        <Textarea
          value={form.idea}
          onChange={(e) => setForm({ ...form, idea: e.target.value })}
          rows={3}
          disabled={busy}
          className="mt-2"
          placeholder="例如：被逐出宗门的杂役弟子，在藏经阁最底层摸到一页会自己改字的残卷"
        />

        <div className="grid gap-2.5 mt-3" style={{ gridTemplateColumns: '1fr 1fr 116px' }}>
          <Field label="场景">
            <Select value={form.sceneId} onChange={(e) => onSceneChange(e.target.value)} disabled={busy}>
              {SCENES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.icon} {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="题材（可选）">
            <Select
              value={form.genreId}
              onChange={(e) => setForm({ ...form, genreId: e.target.value })}
              disabled={busy}
            >
              <option value="">不指定</option>
              {GENRES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {genreHints.includes(item.id) ? '（推荐）' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="每章字数">
            <Input
              type="number"
              value={form.perChapter}
              min={scene.minChapterWords}
              max={scene.maxChapterWords}
              step={100}
              disabled={busy}
              onChange={(e) => setForm({ ...form, perChapter: Number(e.target.value) || scene.defaultChapterWords })}
              onBlur={() =>
                setForm((f) => ({ ...f, perChapter: clamp(f.perChapter, scene.minChapterWords, scene.maxChapterWords) }))
              }
            />
          </Field>
        </div>

        {missingModel && (
          <div
            className="mt-3 flex items-center justify-between gap-2 rounded-md px-2.5 py-2 text-[12px]"
            style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}
          >
            <span style={{ color: 'var(--warn)' }}>
              {!outlineModel && !draftModel
                ? '还没有可用的模型，整条流水线需要模型才能运行'
                : !outlineModel
                  ? '缺少策划用模型（书名/设定/大纲/章纲），请到设置里指定'
                  : '缺少正文用模型（draft），最后一章正文无法生成'}
            </span>
            <Button size="sm" onClick={goSettings} type="button">
              <Settings2 size={12} />
              去设置
            </Button>
          </div>
        )}

        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="text-[11.5px] truncate" style={{ color: 'var(--text-faint)' }}>
            {scene.tagline} · 每章约 {form.perChapter} 字
          </div>
          <Button
            variant="primary"
            onClick={() => void runTitle()}
            disabled={!outlineModel || busy || form.idea.trim().length < 4}
            type="button"
          >
            <Sparkles size={13} />
            生成书名与简介
          </Button>
        </div>
      </div>

      {/* 步骤 1：书名 + 简介 */}
      {showCard(1) && (
        <CardShell
          index={1}
          title="书名与简介"
          status={statuses[1] ?? 'pending'}
          desc="AI 会给出一个主推书名和 100–200 字简介，不合适可以直接改。"
          error={errs[1]}
          raw={raws[1]}
          onRawChange={(v) => setRaw(1, v)}
          onReparse={() => reparse(1, applyTitle)}
          footer={footerFor(1)}
        >
          {statuses[1] === 'running' && <StreamBox text={streamText} />}
          {title && (
            <div className="grid gap-2.5" style={{ marginTop: statuses[1] === 'running' ? 10 : 0 }}>
              <Field label="书名">
                <Input value={title.title} onChange={(e) => setTitle({ ...title, title: e.target.value })} />
              </Field>
              <Field label="简介" hint={`${countWords(title.intro)} 字`}>
                <Textarea rows={4} value={title.intro} onChange={(e) => setTitle({ ...title, intro: e.target.value })} />
              </Field>
            </div>
          )}
        </CardShell>
      )}

      {/* 步骤 2：核心设定 */}
      {showCard(2) && (
        <CardShell
          index={2}
          title="核心设定"
          status={statuses[2] ?? 'pending'}
          desc="6–10 条：世界观、力量/规则体系、主要角色、势力与背景悬案。类型可逐条切换。"
          error={errs[2]}
          raw={raws[2]}
          onRawChange={(v) => setRaw(2, v)}
          onReparse={() => reparse(2, applySettings)}
          footer={footerFor(2)}
        >
          {statuses[2] === 'running' && <StreamBox text={streamText} />}
          {settings.length > 0 && (
            <div style={{ marginTop: statuses[2] === 'running' ? 10 : 0 }}>
              {settings.map((item) => (
                <SettingRow
                  key={item.id}
                  item={item}
                  onChange={(patch) => setSettings((list) => list.map((x) => (x.id === item.id ? { ...x, ...patch } : x)))}
                  onRemove={() => setSettings((list) => list.filter((x) => x.id !== item.id))}
                />
              ))}
              <AddRow
                label="添加一条设定"
                onClick={() => setSettings((list) => [...list, { id: uid('qs'), kind: 'world', title: '', content: '' }])}
              />
            </div>
          )}
        </CardShell>
      )}

      {/* 步骤 3：分卷大纲 */}
      {showCard(3) && (
        <CardShell
          index={3}
          title="分卷大纲"
          status={statuses[3] ?? 'pending'}
          desc="三卷递进：立足 → 扩张 → 掀桌。每卷一句话概要。"
          error={errs[3]}
          raw={raws[3]}
          onRawChange={(v) => setRaw(3, v)}
          onReparse={() => reparse(3, applyVolumes)}
          footer={footerFor(3)}
        >
          {statuses[3] === 'running' && <StreamBox text={streamText} />}
          {volumes.length > 0 && (
            <div style={{ marginTop: statuses[3] === 'running' ? 10 : 0 }}>
              {volumes.map((item) => (
                <LineRow
                  key={item.id}
                  title={item.title}
                  summary={item.summary}
                  summaryRows={2}
                  placeholder="第 X 卷 …"
                  onTitle={(v) => setVolumes((list) => list.map((x) => (x.id === item.id ? { ...x, title: v } : x)))}
                  onSummary={(v) => setVolumes((list) => list.map((x) => (x.id === item.id ? { ...x, summary: v } : x)))}
                  onRemove={() => setVolumes((list) => list.filter((x) => x.id !== item.id))}
                />
              ))}
              <AddRow
                label="添加一卷"
                onClick={() =>
                  setVolumes((list) => [...list, { id: uid('qs'), title: `第 ${list.length + 1} 卷`, summary: '' }])
                }
              />
            </div>
          )}
        </CardShell>
      )}

      {/* 步骤 4：首卷章纲 */}
      {showCard(4) && (
        <CardShell
          index={4}
          title="首卷章纲"
          status={statuses[4] ?? 'pending'}
          desc="8–12 章，每章一句话情节点；每章会同时生成对应章节标题。"
          error={errs[4]}
          raw={raws[4]}
          onRawChange={(v) => setRaw(4, v)}
          onReparse={() => reparse(4, applyChapters)}
          footer={footerFor(4)}
        >
          {statuses[4] === 'running' && <StreamBox text={streamText} />}
          {chapters.length > 0 && (
            <div style={{ marginTop: statuses[4] === 'running' ? 10 : 0 }}>
              {chapters.map((item) => (
                <LineRow
                  key={item.id}
                  title={item.title}
                  summary={item.summary}
                  placeholder="第 X 章 …"
                  onTitle={(v) => setChapters((list) => list.map((x) => (x.id === item.id ? { ...x, title: v } : x)))}
                  onSummary={(v) => setChapters((list) => list.map((x) => (x.id === item.id ? { ...x, summary: v } : x)))}
                  onRemove={() => setChapters((list) => list.filter((x) => x.id !== item.id))}
                />
              ))}
              <AddRow
                label="添加一章"
                onClick={() =>
                  setChapters((list) => [...list, { id: uid('qs'), title: `第 ${list.length + 1} 章`, summary: '' }])
                }
              />
            </div>
          )}
        </CardShell>
      )}

      {/* 步骤 5：首章正文 */}
      {showCard(5) && (
        <CardShell
          index={5}
          title="首章正文"
          status={statuses[5] ?? 'pending'}
          desc={`用前面四步的产物作为上下文，生成约 ${form.perChapter} 字的第一章正文。`}
          error={errs[5]}
          raw={raws[5]}
          onRawChange={(v) => setRaw(5, v)}
          footer={footerFor(5)}
        >
          <DraftPreview text={statuses[5] === 'running' ? streamText : chapterText} />
        </CardShell>
      )}
    </Modal>
  )
}