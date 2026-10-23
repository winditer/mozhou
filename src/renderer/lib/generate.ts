import type { Channel, Chapter, Project, TaskKind } from '@shared/types'
import type { StyleLibrary } from '@shared/styleLibrary'
import { countWords, stripHtml, truncate } from '@shared/utils'
import { sendChat } from './ai'
import {
  buildDraftMessages,
  buildSelectionMessages,
  buildSummaryMessages,
  buildSystemPrompt,
  contextToText,
  assembleContext,
  tokensForWords
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
  onDelta: (d: string) => void
  /** 思考增量（reasoning_content 等），只用于进度展示，不属于正文 */
  onThought?: (d: string) => void
  onStage?: (stage: string) => void
}

export interface DraftGenParams extends GenParams {
  instruction: string
  targetWords: number
  lengthGuard: boolean
  selection?: string
  /** 半句续写起点：光标之前已经写下的文字 */
  anchorText?: string
  /** 光标之后同段里已经写下的文字（续写要接回它） */
  tailText?: string
  /** 「重写本段」时被整段替换掉的原文 */
  rewriteParagraph?: string
}

/**
 * 长度守护：生成不足目标 85% 时自动续写（最多 3 轮），
 * 每轮都通过 onDelta 继续追加到界面上，用户看到的是连贯的流。
 */
export async function generateDraft(p: DraftGenParams): Promise<string> {
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
    p.library
  )
  let text = ''
  p.onStage?.('正在生成…')
  const first = await sendChat({
    channel: p.channel,
    model: p.model,
    messages,
    task: p.task,
    temperature: p.temperature,
    maxTokens: tokensForWords(p.targetWords),
    onDelta: (d) => {
      text += d
      p.onDelta(d)
    },
    onThought: p.onThought
  })
  text = first.text || text

  if (!p.lengthGuard) return text

  let rounds = 0
  while (rounds < 3 && countWords(text) < p.targetWords * 0.85) {
    rounds++
    p.onStage?.(`篇幅不足（${countWords(text)} / ${p.targetWords} 字），正在补写第 ${rounds} 轮…`)
    const cont = await sendChat({
      channel: p.channel,
      model: p.model,
      messages: [
        ...messages,
        { role: 'assistant', content: text },
        {
          role: 'user',
          content: `请紧接上文继续写下去，补充约 ${Math.max(200, p.targetWords - countWords(text))} 字。不要重复已有情节，不要总结，不要重新开头，直接续写正文。${
            p.tailText?.trim() ? `（写到你认为可以收束时，自然衔接回「${truncate(p.tailText.trim(), 200)}」。）` : ''
          }`
        }
      ],
      task: p.task,
      temperature: p.temperature,
      maxTokens: tokensForWords(Math.max(400, p.targetWords - countWords(text))),
      onDelta: (d) => {
        text += d
        p.onDelta(d)
      },
      onThought: p.onThought
    })
    text = cont.text || text
  }
  p.onStage?.('已完成')
  return text
}

export async function generateSelection(
  p: GenParams & { selection: string; instruction: string }
): Promise<string> {
  const messages = buildSelectionMessages(p.project, p.chapter, p.selection, p.instruction, p.library)
  const r = await sendChat({
    channel: p.channel,
    model: p.model,
    messages,
    task: 'polish',
    temperature: p.temperature,
    maxTokens: tokensForWords(Math.max(300, countWords(p.selection) * 2)),
    onDelta: p.onDelta,
    onThought: p.onThought
  })
  return r.text
}

export async function generateSummary(
  p: GenParams & { chapter: Chapter }
): Promise<string> {
  const messages = buildSummaryMessages(p.project, p.chapter)
  const r = await sendChat({
    channel: p.channel,
    model: p.model,
    messages,
    task: 'summary',
    temperature: 0.3,
    maxTokens: 600,
    onDelta: p.onDelta,
    onThought: p.onThought
  })
  return r.text.trim()
}

export async function generateChatReply(
  p: GenParams & {
    history: { role: 'user' | 'assistant'; content: string }[]
    question: string
    /** 系统文风分身库：对话也要跟书内生成用同一套生效文风 */
    library?: StyleLibrary | null
  }
): Promise<string> {
  // 对话时必须能看到「当前这一章」的正文，否则模型只会拿到前文/设定
  const ctx = assembleContext(p.project, p.chapter, 20000, { includeCurrent: true })
  const system = `${buildSystemPrompt(p.project, 'prose', p.library)}\n\n你现在是作者的写作搭档，正在和作者讨论这本书的写法。回答要具体、可执行，不要泛泛而谈。`
  const ctxText = contextToText(ctx)
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: `【作品资料】\n${ctxText}` },
    ...p.history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: p.question }
  ]
  const r = await sendChat({
    channel: p.channel,
    model: p.model,
    messages,
    task: 'chat',
    temperature: p.temperature,
    maxTokens: 3000,
    onDelta: p.onDelta,
    onThought: p.onThought
  })
  return r.text
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
    maxTokens: p.maxTokens ?? 3000,
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