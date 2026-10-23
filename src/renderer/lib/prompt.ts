import type { Chapter, Project, PromptMessage } from '@shared/types'
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, resolveBudget, type TokenBudgets } from '@shared/budgets'
import { getScene } from '@shared/scenes'
import { getGenre } from '@shared/genres'
import { countWords, estimateTokens, stripHtml, truncate } from '@shared/utils'

/* ───────────────────── 系统提示词 ───────────────────── */

export function buildSystemPrompt(project: Project, mode: 'prose' | 'outline' = 'prose'): string {
  const scene = getScene(project.sceneId)
  const genre = project.genreId ? getGenre(project.genreId) : undefined
  const s = project.settings
  const parts: string[] = []

  parts.push(scene.systemPrompt)

  if (genre && s.context.genre !== false) {
    parts.push(`【题材】${genre.name}。${genre.convention}`)
  }

  const rules: string[] = []
  if (s.pov) rules.push(`叙事视角：${s.pov}`)
  if (s.tense) rules.push(`时态：${s.tense}`)
  if (s.audience) rules.push(`目标读者：${s.audience}`)
  if (s.tone?.length) rules.push(`整体语气：${s.tone.join('、')}`)
  if (rules.length) parts.push(`【本书写作规范】\n${rules.map((r) => `- ${r}`).join('\n')}`)

  if (s.extraRules?.trim()) parts.push(`【作者额外要求（最高优先级）】\n${s.extraRules.trim()}`)

  const style = project.styleProfiles.find((x) => x.active)
  if (style && s.context.style !== false) {
    const traits = style.traits.filter(Boolean)
    const samples = style.samples.filter((x) => x && x.trim())
    if (traits.length || samples.length) {
      const head = traits.length
        ? `【文风要求 —— 必须严格遵守】\n${traits.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
        : '【文风要求 —— 严格贴合下方样本】'
      const body = samples.length
        ? `\n下面是作者的原文样本，请仔细体会其句子节奏、用词习惯与叙述密度，写作时保持同样的笔感：\n\n${samples
            .slice(0, 3)
            .map((x, i) => `〈样本 ${i + 1}〉\n${truncate(x, 1600)}`)
            .join('\n\n')}`
        : ''
      parts.push(head + body)
    }
  }

  // 大纲任务和正文任务的输出纪律完全不同：正文禁止标题编号，大纲反而必须逐行编号，
  // 之前共用一套「只输出正文」的规则，模型容易把 10 章压缩成一段。
  const discipline =
    mode === 'outline'
      ? `【输出纪律】
- 只输出大纲列表，一行一个节点，不要写正文、不要解释、不要寒暄或开场白。
- 卷写成「第X卷 卷名」，章写成「第X章 章名：一句话情节点（含推进作用）」。
- 要求多少章就输出多少行，不许省略、合并、缩写，也不要用表格或把多章挤在一行。
- 不要写「（略）」「以此类推」「其余章节类似」之类的占位。`
      : `【输出纪律】
- 只输出作品正文本身，不要写任何解释、说明、标题编号、Markdown 代码块标记或"以下是"之类的开场白。
- 不要复述或总结用户提供的大纲，直接进入正文。
- 不要使用"AI 腔"套话（如"在这个瞬间""不禁陷入了沉思"），避免四字成语堆砌与过度比喻。
- 人物对话要符合每个角色的身份与口癖，不要所有角色一个腔调。`
  parts.push(discipline)

  return parts.join('\n\n')
}

/* ───────────────────── 上下文装配 ───────────────────── */

export interface ContextBlock {
  key: string
  label: string
  text: string
  tokens: number
  enabled: boolean
}

export interface AssembledContext {
  blocks: ContextBlock[]
  totalTokens: number
  budget: number
  trimmed: boolean
}

const CHARS_PER_TOKEN = 1.35

function tok(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN)
}

export interface ContextOptions {
  /**
   * 把当前章节的正文也装进上下文。
   * 写作类任务不需要（正文会单独以「本章已经写了…」给出），
   * 但「和 AI 讨论本章」时必须带上，否则模型根本看不到这一章写了什么。
   */
  includeCurrent?: boolean
}

export function assembleContext(
  project: Project,
  chapter: Chapter | null,
  budget = 24000,
  opts: ContextOptions = {}
): AssembledContext {
  const s = project.settings
  const ctx = s.context
  const blocks: ContextBlock[] = []

  const push = (key: string, label: string, text: string, enabled: boolean): void => {
    const t = text?.trim() ?? ''
    blocks.push({ key, label, text: t, tokens: t ? tok(t) : 0, enabled })
  }

  if (ctx.brief) {
    const b = [
      project.brief.logline ? `一句话前提：${project.brief.logline}` : '',
      project.brief.premise ? `故事梗概：${project.brief.premise}` : '',
      project.brief.keywords.length ? `关键词：${project.brief.keywords.join('、')}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    push('brief', '作品简介', b, true)
  }

  if (ctx.characters) {
    const chars = project.bible.characters.filter((c) => !c.hidden)
    if (chars.length) {
      const text = chars
        .map((c) => {
          const lines = [`【${c.name}】${c.role || ''}`]
          if (c.identity) lines.push(`身份：${c.identity}`)
          if (c.personality) lines.push(`性格：${c.personality}`)
          if (c.motivation) lines.push(`动机：${c.motivation}`)
          if (c.speechStyle) lines.push(`说话方式：${c.speechStyle}`)
          if (c.arc) lines.push(`人物弧光：${c.arc}`)
          if (c.relations?.length) lines.push(`关系：${c.relations.map((r) => `${r.name}（${r.desc}）`).join('；')}`)
          return lines.join('\n')
        })
        .join('\n\n')
      push('characters', '角色档案', text, true)
    }
  }

  if (ctx.bible) {
    const entries = project.bible.world.filter((w) => w.visible)
    if (entries.length) {
      const text = entries.map((w) => `【${w.title}】${w.content}`).join('\n\n')
      push('bible', '世界观设定', text, true)
    }
    if (project.bible.terms.length) {
      push('terms', '术语表', project.bible.terms.map((t) => `${t.term}：${t.definition}`).join('\n'), true)
    }
    const openThreads = project.bible.threads.filter((t) => t.status === 'open')
    if (openThreads.length) {
      push('threads', '未回收伏笔', openThreads.map((t) => `· ${t.title}：${t.setup}${t.payoff ? `（计划回收：${t.payoff}）` : ''}`).join('\n'), true)
    }
  }

  if (ctx.outline) {
    const lines: string[] = []
    for (const vol of project.outline) {
      lines.push(`〔${vol.title}〕${vol.summary || ''}`)
      for (const ch of vol.children) {
        lines.push(`  - ${ch.title}：${ch.summary || '（待补充）'}`)
      }
    }
    if (lines.length) push('outline', '大纲', lines.join('\n'), true)
  }

  if (opts.includeCurrent && chapter) {
    const body = stripHtml(chapter.content).trim()
    if (body) {
      push('current', `当前章节〈${chapter.title || '未命名'}〉正文`, truncate(body, 8000), true)
    }
  }

  if (ctx.previous && chapter) {
    const idx = project.chapters.findIndex((c) => c.id === chapter.id)
    if (idx > 0) {
      const n = Math.max(1, s.previousChapters || 2)
      const start = Math.max(0, idx - n)
      const recent = project.chapters.slice(start, idx)
      if (recent.length) {
        push(
          'previous',
          `前文（最近 ${recent.length} 章）`,
          recent
            .map((c) => `〈${c.title}〉\n${truncate(stripHtml(c.content), 6000)}`)
            .join('\n\n'),
          true
        )
      }
      const earlier = project.chapters.slice(0, start)
      if (earlier.length) {
        const summaries = earlier
          .map((c) => {
            const sm = project.summaries[c.id] || c.summary || truncate(stripHtml(c.content), 120)
            return `- ${c.title}：${sm}`
          })
          .join('\n')
        push('earlier', '更早章节梗概', summaries, true)
      }
    }
  }

  // 预算裁剪：按优先级丢内容（远期梗概 → 设定全文 → 前文）
  let total = blocks.reduce((sum, b) => sum + b.tokens, 0)
  let trimmed = false
  const dropOrder = ['earlier', 'terms', 'threads', 'bible', 'previous', 'characters', 'current']
  for (const key of dropOrder) {
    if (total <= budget) break
    const b = blocks.find((x) => x.key === key)
    if (!b || !b.text) continue
    trimmed = true
    if (key === 'bible' || key === 'previous' || key === 'current') {
      b.text = truncate(b.text, Math.floor(b.text.length * 0.45))
      b.tokens = tok(b.text)
    } else {
      b.text = ''
      b.tokens = 0
    }
    total = blocks.reduce((sum, x) => sum + x.tokens, 0)
  }

  return { blocks, totalTokens: total, budget, trimmed }
}

export function contextToText(assembled: AssembledContext): string {
  return assembled.blocks
    .filter((b) => b.text)
    .map((b) => `【${b.label}】\n${b.text}`)
    .join('\n\n')
}

/* ───────────────────── 任务消息构造 ───────────────────── */

export interface DraftOptions {
  instruction: string
  targetWords: number
  selection?: string
  chapterTitle?: string
  /**
   * 续写起点：光标所在段落里、光标之前已经写下的文字。
   * 作者真正卡住的地方往往在半句话中间，所以必须让模型接着这半句写，
   * 而不是从章末另起一段。
   */
  anchorText?: string
  /** 光标之后同一段落里已经写下的文字（续写要设法接回它，不能把它冲掉） */
  tailText?: string
  /** 「重写本段」时被替换掉的整段原文 */
  rewriteParagraph?: string
}

export function buildDraftMessages(project: Project, chapter: Chapter | null, opts: DraftOptions): PromptMessage[] {
  const system = buildSystemPrompt(project)
  const ctx = assembleContext(project, chapter)
  const contextText = contextToText(ctx)
  const existing = chapter ? stripHtml(chapter.content).trim() : ''

  const userParts: string[] = []
  if (contextText) userParts.push(`以下是这本书的设定资料，供你写作时参考：\n\n${contextText}`)

  if (opts.chapterTitle) userParts.push(`本章标题：${opts.chapterTitle}`)

  if (existing) {
    userParts.push(`本章已经写了以下内容（请在它之后自然接续，不要重复已有内容，不要重新开头）：\n\n${truncate(existing, 8000)}`)
  }

  if (opts.selection) {
    userParts.push(`需要处理的原文片段：\n「${opts.selection}」`)
  }

  // 半句续写：作者的光标停在段落中间，模型必须从这半句话接下去，而不是另起一段。
  if (opts.anchorText?.trim()) {
    const tail = opts.tailText?.trim()
    userParts.push(
      [
        `【续写起点】作者的笔停在这里，光标正好在下面这段文字的末尾：`,
        `「…${truncate(opts.anchorText.trim(), 600)}」`,
        `你必须接着这半句话往下写：第一个字要能直接连在这句话后面读通，不要重复这半句，不要另起一个开头，不要补一个句号就把话题截断。`,
        tail
          ? `注意：这句话后面原本还跟着「${truncate(tail, 300)}」，你写的这段要能自然接回到它前面。`
          : ''
      ]
        .filter(Boolean)
        .join('\n')
    )
  }

  // 重写本段：整段替换，不是追加
  if (opts.rewriteParagraph?.trim()) {
    userParts.push(
      `【需要重写的原段落】\n「${truncate(opts.rewriteParagraph.trim(), 1500)}」\n\n请整段重写它，保持原有的情节信息与前后衔接，不要保留原文句式，也不要只写一小截。`
    )
  }

  userParts.push(
    `【本次任务】\n${opts.instruction}\n\n篇幅要求：约 ${opts.targetWords} 字（±15%）。可直接开始写正文。`
  )

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n\n') }
  ]
}

export function buildSelectionMessages(
  project: Project,
  chapter: Chapter | null,
  selection: string,
  instruction: string
): PromptMessage[] {
  const system = buildSystemPrompt(project)
  const ctx = assembleContext(project, chapter)
  const contextText = contextToText(ctx)
  const user = `${contextText ? `【作品资料】\n${contextText}\n\n` : ''}【原文片段】\n${selection}\n\n【处理要求】\n${instruction}\n\n只输出处理后的文本，不要任何说明。`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

export function buildSummaryMessages(project: Project, chapter: Chapter): PromptMessage[] {
  const text = truncate(stripHtml(chapter.content), 12000)
  return [
    {
      role: 'system',
      content: '你是小说编辑，擅长把一章内容压缩成精准的剧情摘要。只输出摘要正文，不要任何解释。'
    },
    {
      role: 'user',
      content: `请用 100–160 字概括本章（《${chapter.title}》）的关键剧情：谁做了什么、发生了什么变化、留下了什么悬念。\n\n本章正文：\n${text}`
    }
  ]
}

export function buildOutlineMessages(project: Project, instruction: string): PromptMessage[] {
  const system = buildSystemPrompt(project, 'outline')
  const ctx = assembleContext(project, null)
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `${contextToText(ctx) ? `【作品资料】\n${contextToText(ctx)}\n\n` : ''}【任务】${instruction}\n\n请只输出大纲，格式为纯文本列表，每行一个节点，用「卷」和「章」两级缩进表示层级。任务里要求的章节数必须写满，不要用「略」「同上」「其余类似」省略任何一章。`
    }
  ]
}

/**
 * 按目标字数给出输出预算（兼容用：旧有的按字数估算入口）。
 *
 * 公式本身已经搬进 @shared/budgets 的 draft.generate 预算项：
 * 正文按 2.2 倍留（中文一字约 0.75–1.5 token，2.2 倍已有余量），
 * 再额外加 1024 给思考，最后夹到 [2048, 16000]。
 * 加 1024 是因为思考过程也计入 max_tokens，预算被思考吃光后正文就是空的或半截。
 *
 * 保留这个函数是给还按「字数」思考的调用点用的：
 * 不传 budgets 时走的正是默认值，结果与改造前逐字一致。
 * 调用份额类的场景请直接用 resolveBudget + BUDGET_KEYS。
 */
export function tokensForWords(words: number, budgets: TokenBudgets = DEFAULT_TOKEN_BUDGETS): number {
  return resolveBudget(budgets, BUDGET_KEYS.draftGenerate, words)
}

export function countGenerated(text: string): number {
  return countWords(text)
}

export function estimateContext(project: Project, chapter: Chapter | null): number {
  return assembleContext(project, chapter).totalTokens
}

export { estimateTokens }