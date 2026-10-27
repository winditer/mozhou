import type { Channel, Chapter, Project, TaskKind } from '@shared/types'
import {
  BUDGET_KEYS,
  DEFAULT_TOKEN_BUDGETS,
  budgetHeadroom,
  resolveBudget,
  type BudgetKey,
  type TokenBudgets
} from '@shared/budgets'
import type { StyleLibrary } from '@shared/styleLibrary'
import { renderSkillsForChat, type SkillLibrary } from '@shared/skills'
import type { GenreConventionOverrides } from '@shared/genres'
import { countWords, stripHtml, truncate } from '@shared/utils'
import { sendChat } from './ai'
import {
  buildDraftMessages,
  buildSelectionMessages,
  buildSummaryMessages,
  buildSystemPrompt,
  contextToText,
  assembleContext,
  skillContext
} from './prompt'

export interface GenParams {
  project: Project
  chapter: Chapter | null
  channel: Channel
  model: string
  task: TaskKind
  temperature?: number
  /**
   * 系统文风分身库。放在基类参数上而不是逐处传，是因为「引用型分身」的书
   * 每条生成路径（正文/改写/大纲/对话/一键开书）都必须拿到同一份库，
   * 漏传一处就会退回到引用时的旧快照，写得跟别处不一样却查不出原因。
   */
  library?: StyleLibrary | null
  /**
   * 题材公约的全局覆盖表（设置 → 题材公约）。
   * 同 library 一样挂在基类上：正文/改写/大纲/对话/一键开书任一漏传，
   * 那一路就会用回内置公约，跟别处生成出来的东西不是一套规矩。
   */
  conventions?: GenreConventionOverrides | null
  /**
   * 技法卡库。同 library 一样挂在基类上：正文与一键开书都要拿到同一份库，
   * 漏传一处，那一路就少了技法约束，写出来的手感跟别处不一样却查不出原因。
   */
  skillLibrary?: SkillLibrary | null
  /** 输出预算配置；不传则用默认值（与改造前行为一致） */
  budgets?: TokenBudgets
  onDelta: (d: string) => void
  /** 思考增量（reasoning_content 等），只用于进度展示，不属于正文 */
  onThought?: (d: string) => void
  onStage?: (stage: string) => void
}

export interface DraftGenParams extends GenParams {
  instruction: string
  targetWords: number
  /**
   * 已写正文的词数，补写循环用来算「还差多少」。
   *
   * 为什么需要它：长度守护以前只数「本次生成」，读者真正关心的是**这一章**有没有写够。
   * 从光标处接着半句写时，目标 2500 字的章里已经写了 2000 字，这次只该补 500 字；
   * 不传这个数，守护就会逼模型再写满 2500 字，接出来一节长得离谱。
   */
  existingWords?: number
  /**
   * 是否在不足 85% 时自动补写。默认开启。
   *
   * 早前这项由 project.settings.lengthMode === 'strict' 控制，而出厂默认是 'soft'，
   * 等于**默认所有人生成正文都不守护**——用户反馈「续写字数总是不够」的根因就在这。
   * 目标字数明明写在提示词里（「篇幅要求：约 2500 字」），模型却常常只写一半，
   * 这时候不补写就是直接把半章交给作者。
   */
  lengthGuard?: boolean
  selection?: string
  /** 半句续写起点：光标之前已经写下的文字 */
  anchorText?: string
  /** 光标之后同段里已经写下的文字（续写要接回它） */
  tailText?: string
  /** 「重写本段」时被整段替换掉的原文 */
  rewriteParagraph?: string
}

/** 首轮已达标的比例：90% 以上就算够了，不为最后几十字再烧一轮调用 */
const ENOUGH_RATIO = 0.9
/** 低于这个比例视为「第一轮基本没吐字」，先重试一次再说 */
const EMPTY_RETRY_RATIO = 0.15
/** 补写最多几轮 */
const MAX_TOP_UP_ROUNDS = 3
/** 单轮补写最少要有所进展，否则提前结束，避免一直空转烧钱 */
const MIN_PROGRESS_WORDS = 60

export type TopUpStop = 'done' | 'empty' | 'maxRounds' | 'noProgress' | 'error' | 'aborted'

export interface TopUpRound {
  /** 第几轮（1 起） */
  round: number
  /** 这一轮开始前已写多少字 */
  before: number
  /** 这一轮之后写了多少字 */
  after: number
  /** 这一轮的 finishReason；'length' 说明额度还是不够 */
  finishReason?: string
  /** 这一轮本身有没有吐正文 */
  empty: boolean
  /** 思考把输出额度吃光的典型组合：没吐正文 + 被 max_tokens 截断 */
  thoughtStarved?: boolean
}

export interface TopUpParams extends GenParams {
  /** 首轮的 messages（system + user） */
  messages: ReturnType<typeof buildDraftMessages>
  /** 首轮已经拿到的正文 */
  text: string
  /** 这一整章一共要写多少字 */
  targetWords: number
  /** 首轮之前这一章已经写了多少字 */
  existingWords: number
  /** 光标后半句：补写收束时要能接回它 */
  tailText?: string
  /**
   * 补写轮用哪个预算 key。默认 `draft.continue`（写作台续写就是这个场景）。
   *
   * 为什么开放这个参数：一键开书的「首章正文」有自己的预算项
   * （`quickstart.firstChapter`），补写时却去吃写作台的「长度守护补写」额度，
   * 用户在设置页调了首章的额度却发现补写不跟，等于配置没生效。
   */
  continueBudgetKey?: BudgetKey
  /**
   * 调用方是否已经把「已写正文」拼进 `messages` 了。
   *
   * 默认为 false：内部把已写正文作为 user 消息材料补进去。
   * 传 true 时内部**不再重复塞正文**，只追加一条「只补差额」的指令——
   * 否则同一段正文会在提示词里出现两遍，白烧 token，还容易让模型顺着
   * 自己刚写的结尾再续一遍（那正是补写越补越水的来源）。
   */
  messagesAlreadyIncludeText?: boolean
}

export interface TopUpResult {
  text: string
  stop: TopUpStop
  rounds: TopUpRound[]
  /** 唯一一次异常（stop === 'error' 时有值） */
  error?: Error
  /** 最后一次请求的 finishReason，'length' 表示还被截断 */
  finishReason?: string
  /** 有任意一轮是「思考吃光额度、正文为空」 */
  thoughtStarved?: boolean
}

/**
 * 补写判定：这一章还差多少字才算达标。
 *
 * 口径统一成「整章」——目标字数扣掉补写前已有的部分，再和本次生成的正文相加。
 * 以前只看本次生成，导致「接着半句写」永远补不到目标，补写轮还会把已经写出来的
 * 部分重复算一遍，越补越乱。
 */
function progressOf(existingWords: number, text: string, targetWords: number): number {
  const total = existingWords + countWords(text)
  return targetWords > 0 ? total / targetWords : 1
}

/**
 * 长度守护的补写循环。
 *
 * 三个必须踩住的设计点：
 * 一、**预算随剩余字数递减**。早前按「已经写了多少字」给预算，越补额度越大，
 *    模型拿到大额度反而继续铺陈，收不回来；按差额给，差得越少给得越少。
 * 二、**每轮重开一次干净的多轮对话**，而不是把上一轮自己刚写的正文再喂回去当
 *    assistant 消息——那样模型会顺着自己刚写的结尾继续「续写」，越写越重复。
 *    这里把「已写正文」放在 user 消息里作为材料，指令明确要求只补差额。
 * 三、**思考型模型的空正文要重试**。推理模型会把 maxTokens 全用在 reasoning 上，
 *    正文一个字没有就 stop。这不是致命错误，重试一次（额度已按剩余字数重算）
 *    往往就正常了；直接放弃才是用户看到「思考很久然后空白」的那条路。
 */
export async function topUpDraft(p: TopUpParams): Promise<TopUpResult> {
  const budgets = p.budgets ?? DEFAULT_TOKEN_BUDGETS
  let text = p.text
  const rounds: TopUpRound[] = []
  const target = Math.max(1, p.targetWords)
  let finishReason: string | undefined
  let thoughtStarved = false

  // 首轮一个字都没有：先原地重试一次，换一份干净请求（不带空 assistant 轮）
  if (!countWords(text) && progressOf(p.existingWords, text, target) < EMPTY_RETRY_RATIO) {
    p.onStage?.('模型这次没有吐出正文，正在重试一次…')
    try {
      const retry = await sendChat({
        channel: p.channel,
        model: p.model,
        messages: p.messages,
        task: p.task,
        temperature: p.temperature,
        // 重试时把额度抬高 50%：如果上一次是被思考吃光的，用同一份预算重试只会再空一次
        maxTokens: Math.ceil(resolveBudget(budgets, BUDGET_KEYS.draftGenerate, target) * 1.5),
        onDelta: (d) => {
          text += d
          p.onDelta(d)
        },
        onThought: p.onThought
      })
      // 同补写轮：retry.text 是这一轮的增量，text 已被 onDelta 累加过，不能直接覆盖。
      // 首轮为空时 text 本来就是空串，这条只在「流式增量没走 onDelta」时兜底。
      if (retry.text && text.length < retry.text.length) text = retry.text
      finishReason = retry.finishReason
      thoughtStarved = Boolean(retry.thoughtStarved)
    } catch (error) {
      // 一字未得时的网络/鉴权失败要如实抛给上层；已经有字了就走「保留正文」那条路
      if (!countWords(text)) return { text, stop: 'error', rounds, error: error as Error, finishReason }
    }
    if (!countWords(text)) {
      return { text, stop: 'empty', rounds, finishReason, thoughtStarved }
    }
  }

  for (let round = 1; round <= MAX_TOP_UP_ROUNDS; round++) {
    if (progressOf(p.existingWords, text, target) >= ENOUGH_RATIO) {
      return { text, stop: 'done', rounds, finishReason }
    }
    const before = countWords(text)
    const remaining = Math.max(0, target - p.existingWords - before)
    const h = budgetHeadroom(target, p.existingWords + before)
    p.onStage?.(
      `篇幅不足（${p.existingWords + before} / ${target} 字），正在补写第 ${round} 轮，还差约 ${remaining} 字…`
    )

    // 已写正文作为材料交给模型，但不作为 assistant 轮：避免它顺着自己刚写的
    // 结尾再「续」一遍，那正是补写越补越水的来源。
    //
    // messagesAlreadyIncludeText 为 true 时说明调用方（一键开书）自己已经拼好了
    // 带正文的上下文，这里就**不能再塞一遍**——同一段正文出现两次既烧 token，
    // 也会让模型看到「正文 / 指令 / 正文」这种错位顺序。
    const tail = p.tailText?.trim()
    const instruction = [
      `【本次任务】只补差额。请紧接上文正文的最后一句继续往下写，补充约 ${Math.max(MIN_PROGRESS_WORDS, remaining)} 字。`,
      `不要重复已有情节，不要总结，不要重新开头，不要输出任何标题或说明，直接续写正文。`,
      tail ? `（写到你认为可以收束时，自然衔接回「${truncate(tail, 200)}」。）` : ''
    ]
      .filter(Boolean)
      .join('\n')
    const messages = p.messagesAlreadyIncludeText
      ? [...p.messages, { role: 'user' as const, content: instruction }]
      : [
          ...p.messages,
          {
            role: 'user' as const,
            content: [`【已经写出来的正文】`, truncate(stripHtml(text).trim(), 6000), '', instruction].join('\n')
          }
        ]

    let cont: Awaited<ReturnType<typeof sendChat>>
    try {
      cont = await sendChat({
        channel: p.channel,
        model: p.model,
        messages,
        task: p.task,
        temperature: p.temperature,
        maxTokens: resolveBudget(budgets, p.continueBudgetKey ?? BUDGET_KEYS.draftContinue, target, h),
        onDelta: (d) => {
          text += d
          p.onDelta(d)
        },
        onThought: p.onThought
      })
    } catch (error) {
      // 中断如实上抛：generateDraft 只在「一字未得」时才真的把错误抛给用户，
      // 已经有正文时会保住正文、只把原因带回去（stop === 'error'）。
      return { text, stop: 'error', rounds, error: error as Error, finishReason }
    }
    // 这里**不能**写 `text = cont.text || text`。cont.text 只是这一轮补写的增量，
    // 而 text 已经在 onDelta 里被累加过了；一旦覆盖，前面几轮的正文就全丢了
    // （实测症状：首轮 300 字 + 补写 2000 字，最后只剩 2000 字）。
    // onDelta 全程在回调，正常情况下 text 已经是完整结果；只有在流式增量没走到
    // onDelta 的极端情况下（如网关一次性返回）才需要拿 cont.text 补上。
    if (cont.text && !text.endsWith(cont.text) && text.length < cont.text.length) text = cont.text
    finishReason = cont.finishReason
    const after = countWords(text)
    const gained = after - before
    rounds.push({
      round,
      before,
      after,
      finishReason: cont.finishReason,
      empty: gained <= 0,
      thoughtStarved: cont.thoughtStarved
    })
    if (cont.thoughtStarved) thoughtStarved = true

    // 这一轮一个字没加：多半又是思考吃光额度。再试一轮没意义，提前收尾把
    // 已有的正文交给用户，比空转三轮好。
    if (gained < MIN_PROGRESS_WORDS && round < MAX_TOP_UP_ROUNDS) {
      return { text, stop: gained <= 0 ? 'empty' : 'noProgress', rounds, finishReason, thoughtStarved }
    }
  }

  const ok = progressOf(p.existingWords, text, target) >= ENOUGH_RATIO
  return { text, stop: ok ? 'done' : 'maxRounds', rounds, finishReason, thoughtStarved }
}

/**
 * 生成正文（含长度守护）。
 *
 * 长度守护是**默认行为**：只有显式传 `lengthGuard: false`（如「重写本段」——
 * 整段替换时篇幅不该被强撑）才关掉。这与旧版本相反，旧版本只在 strict 模式下守护，
 * 而 strict 不是出厂默认，结果人人都遇上「写不够」。
 */
export async function generateDraft(p: DraftGenParams): Promise<string> {
  const budgets = p.budgets ?? DEFAULT_TOKEN_BUDGETS
  const messages = buildDraftMessages(
    p.project,
    p.chapter,
    {
      instruction: p.instruction,
      targetWords: p.targetWords,
      selection: p.selection,
      chapterTitle: p.chapter?.title,
      anchorText: p.anchorText,
      tailText: p.tailText,
      rewriteParagraph: p.rewriteParagraph
    },
    p.library,
    p.conventions,
    p.skillLibrary
  )
  let text = ''
  p.onStage?.('正在生成…')
  const first = await sendChat({
    channel: p.channel,
    model: p.model,
    messages,
    task: p.task,
    temperature: p.temperature,
    maxTokens: resolveBudget(budgets, BUDGET_KEYS.draftGenerate, p.targetWords),
    onDelta: (d) => {
      text += d
      p.onDelta(d)
    },
    onThought: p.onThought
  })
  // first.text 是本次增量，text 已由 onDelta 累加；只在增量没走 onDelta 时兜底
  if (first.text && text.length < first.text.length) text = first.text

  if (p.lengthGuard === false) return text

  const r = await topUpDraft({
    ...p,
    messages,
    text,
    targetWords: p.targetWords,
    existingWords: Math.max(0, p.existingWords ?? 0),
    tailText: p.tailText
  })

  // 补写轮出错不该吞掉已经写出来的正文：作者已经看着这些字在界面上流出来了，
  // 抛出去只会让弹窗变成「已中断」而正文消失。只有一字未得时才把错误抛给上层。
  if (r.stop === 'error' && !countWords(r.text)) throw r.error ?? new Error('生成失败')
  if (r.stop === 'empty' && !countWords(r.text)) {
    // 两种空法要分开说：额度被思考吃光（thoughtStarved）能靠调预算/换模型解决，
    // 「想了但没写就收尾」则多半是提示词或该模型本身的问题，笼统一句话会把人带偏。
    p.onStage?.(
      r.thoughtStarved
        ? '模型把输出额度全用在思考上了，正文一个字都没写出来。请换一个非推理模型，或到「设置 → 输出预算 → 正文生成」把额度调大后重试。'
        : '模型没有返回任何正文就结束了。请重试；若反复如此，检查该渠道的模型名与余额。'
    )
  } else if (r.stop === 'maxRounds') {
    p.onStage?.(`已补写 ${r.rounds.length} 轮，篇幅仍略短，可按需继续写或再点一次续写。`)
  } else {
    // 补过写就要说清补了几轮。以前这里不分情况一律「已完成」，用户明明看到
    // 字是分好几段蹦出来的、结果只被告知「生成完成」，既不知道补过写，
    // 也没法判断「这个模型是不是总写不够、要不要换」。
    p.onStage?.(
      r.rounds.length > 0
        ? `已完成（首轮篇幅不足，自动补写 ${r.rounds.length} 轮，本次 ${countWords(r.text)} 字${
            p.existingWords ? `，加本章原有 ${p.existingWords} 字` : ''
          }）`
        : '已完成'
    )
  }
  return r.text
}

/** 给界面用的一句话说明：这次生成到底够不够、为什么 */
export function describeTopUp(r: TopUpResult, targetWords: number, existingWords = 0): string {
  const total = existingWords + countWords(r.text)
  if (r.stop === 'done') return `已写 ${total} / ${targetWords} 字`
  if (r.stop === 'empty') return `只写了 ${total} / ${targetWords} 字：模型这次没有产出正文`
  if (r.stop === 'noProgress') return `已写 ${total} / ${targetWords} 字：补写没有进展，已停在现有内容`
  if (r.stop === 'maxRounds') return `已写 ${total} / ${targetWords} 字：补写 ${r.rounds.length} 轮后仍有差距`
  if (r.stop === 'error') return `已写 ${total} / ${targetWords} 字：补写中断`
  return `已写 ${total} / ${targetWords} 字`
}

export async function generateSelection(
  p: GenParams & { selection: string; instruction: string }
): Promise<string> {
  const budgets = p.budgets ?? DEFAULT_TOKEN_BUDGETS
  const messages = buildSelectionMessages(
    p.project,
    p.chapter,
    p.selection,
    p.instruction,
    p.library,
    p.conventions
  )
  const r = await sendChat({
    channel: p.channel,
    model: p.model,
    messages,
    task: 'polish',
    temperature: p.temperature,
    maxTokens: resolveBudget(budgets, BUDGET_KEYS.draftSelection, Math.max(300, countWords(p.selection) * 2)),
    onDelta: p.onDelta,
    onThought: p.onThought
  })
  return r.text
}

export async function generateSummary(
  p: GenParams & { chapter: Chapter }
): Promise<string> {
  const budgets = p.budgets ?? DEFAULT_TOKEN_BUDGETS
  const messages = buildSummaryMessages(p.project, p.chapter)
  const r = await sendChat({
    channel: p.channel,
    model: p.model,
    messages,
    task: 'summary',
    temperature: 0.3,
    maxTokens: resolveBudget(budgets, BUDGET_KEYS.summaryAuto),
    onDelta: p.onDelta,
    onThought: p.onThought
  })
  return r.text.trim()
}

/**
 * 对话被「思考吃光额度」时的重试下限。
 *
 * 对话不像正文有目标字数，预算只能拍一个固定值。而推理模型的 reasoning_content
 * 同样计入 maxTokens，3000 的额度经常只够它想完、来不及写——用户看到的
 * 就是「AI 说了一半」甚至「一片空白」。所以正文为空时按这个下限抬高一档重试，
 * 而不是拿同一份预算再问一遍（那只会再空一次）。
 */
const CHAT_RETRY_FLOOR = 8192
/** 重试额度的上限，和预算表 clampBudget 的上限保持一致 */
const CHAT_RETRY_CEIL = 32768

export interface ChatReply {
  text: string
  /** 被 max_tokens 截断（有正文，但没写完） */
  truncated: boolean
  /** 一个正文字符都没吐出来 */
  empty: boolean
  /** 空正文 + finish_reason='length'：额度被思考吃掉 */
  thoughtStarved: boolean
  /** 这次实际用的输出额度（发生过重试时为抬高后的值） */
  maxTokens: number
  /** 是否因空正文重试过 */
  retried: boolean
}

export async function generateChatReply(
  p: GenParams & {
    history: { role: 'user' | 'assistant'; content: string }[]
    question: string
    /** 系统文风分身库：对话也要跟书内生成用同一套生效文风 */
    library?: StyleLibrary | null
  }
): Promise<ChatReply> {
  const budgets = p.budgets ?? DEFAULT_TOKEN_BUDGETS
  // 对话时必须能看到「当前这一章」的正文，否则模型只会拿到前文/设定
  const ctx = assembleContext(p.project, p.chapter, 20000, {
    includeCurrent: true,
    conventions: p.conventions
  })
  // 对话不注入技法卡的完整规则：那是执行模式，塞进讨论场景模型会开始逐条讲解
  // 自己的改稿而不是回答问题。只给「本书挂了哪几张卡」，够它接住「按黄金三章的思路聊」。
  const skillHint = renderSkillsForChat(p.project.settings.activeSkillIds, p.skillLibrary ?? null, skillContext(p.project))
  const system = `${buildSystemPrompt(p.project, 'prose', p.library, p.conventions)}${skillHint ? `\n\n${skillHint}` : ''}\n\n你现在是作者的写作搭档，正在和作者讨论这本书的写法。回答要具体、可执行，不要泛泛而谈。`
  const ctxText = contextToText(ctx)
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: `【作品资料】\n${ctxText}` },
    ...p.history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: p.question }
  ]
  const budget = resolveBudget(budgets, BUDGET_KEYS.chatReply)
  let usedMax = budget
  let r = await sendChat({
    channel: p.channel,
    model: p.model,
    messages,
    task: 'chat',
    temperature: p.temperature,
    maxTokens: usedMax,
    onDelta: p.onDelta,
    onThought: p.onThought
  })

  // 空正文：把额度抬高再问一次。首轮一个字都没有时 onDelta 一次也没被调用，
  // 上层累加的 acc 还是空串，所以重试的增量不会和上一轮拼出重复内容。
  let retried = false
  if (r.empty || r.thoughtStarved) {
    const retryMax = Math.min(CHAT_RETRY_CEIL, Math.max(CHAT_RETRY_FLOOR, Math.ceil(budget * 2)))
    if (retryMax > usedMax) {
      p.onStage?.(`模型把 ${usedMax} 的输出额度全用在思考上了，正在用 ${retryMax} 重试…`)
      usedMax = retryMax
      retried = true
      r = await sendChat({
        channel: p.channel,
        model: p.model,
        messages,
        task: 'chat',
        temperature: p.temperature,
        maxTokens: usedMax,
        onDelta: p.onDelta,
        onThought: p.onThought
      })
    }
  }

  return {
    text: r.text,
    truncated: r.finishReason === 'length',
    empty: r.empty || r.text.length === 0,
    thoughtStarved: Boolean(r.thoughtStarved),
    maxTokens: usedMax,
    retried
  }
}

export async function generateCustom(
  p: GenParams & { system: string; user: string; maxTokens?: number }
): Promise<string> {
  const r = await sendChat({
    channel: p.channel,
    model: p.model,
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: p.user }
    ],
    task: p.task,
    temperature: p.temperature,
    maxTokens: p.maxTokens ?? resolveBudget(p.budgets ?? DEFAULT_TOKEN_BUDGETS, BUDGET_KEYS.customDefault),
    onDelta: p.onDelta,
    onThought: p.onThought
  })
  return r.text
}

/** 把 AI 返回的纯文本变成可直接插入编辑器的 HTML 段落 */
export function textToParagraphHtml(text: string): string {
  const clean = text.trim()
  if (!clean) return ''
  return clean
    .split(/\n{1,}/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
    .join('')
}

export function previewOf(text: string, n = 60): string {
  return truncate(stripHtml(text).replace(/\s+/g, ' '), n)
}