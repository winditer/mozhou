import type { Chapter, Project, PromptMessage } from '@shared/types'
import { getScene } from '@shared/scenes'
import { getGenre, resolveGenreConvention } from '@shared/genres'
import type { GenreConventionOverrides } from '@shared/genres'
import { resolveRef } from '@shared/styleLibrary'
import type { StyleLibrary } from '@shared/styleLibrary'
import { countWords, estimateTokens, stripHtml, truncate } from '@shared/utils'

/* ───────────────────── 系统提示词 ───────────────────── */

/**
 * 「【题材】玄幻。…公约…」这一段的唯一真相。
 *
 * 注入（buildSystemPrompt）和右侧上下文面板的展示都走这里，
 * 否则面板上写「已注入」而提示词里其实是空的，或者两处字数对不上——
 * 这类不一致在作者眼里就是「面板骗人」，比不显示更糟。
 *
 * 返回空串表示这段不该出现（没选题材 / 题材 id 已失效 / 开关关掉了）。
 */
export function renderGenreBlock(
  genreId: string | undefined | null,
  conventions?: GenreConventionOverrides | null
): string {
  if (!genreId) return ''
  const genre = getGenre(genreId)
  // 题材名和公约任一缺失都不注入：只剩「【题材】。」比不写更容易带偏模型
  if (!genre) return ''
  const convention = resolveGenreConvention(genreId, conventions)
  if (!convention) return ''
  return `【题材】${genre.name}。${convention}`
}

/**
 * 把生效文风渲染成提示词块。试写页（style/prompts.ts 的 styleBlock）用的是同一套格式，
 * 两处必须一致，否则「试写看到的」和「真正生成出来的」就不是一回事。
 *
 * 有特征时：标题 + 「本分身取法」摘要 + 逐条编号特征 + 样本；
 * 没特征时退回「严格贴合样本」，此时摘要挂在标题下一行，避免只挂摘要、模型拿不到可执行约束。
 */
export function renderStyleBlock(style: { summary?: string; traits: string[]; samples: string[] }): string {
  const summary = (style.summary ?? '').trim()
  const traits = style.traits.filter(Boolean)
  const samples = style.samples.filter((x) => x && x.trim())
  if (!traits.length && !samples.length) return ''

  // 三种顺序拼装：标题 → 「本分身取法」摘要 → 编号特征 → 样本。
  // 摘要必须在特征之前：它先说「这套文风怎么取法」的总纲，再给可逐条核对的细则。
  const title = traits.length ? '【文风要求 —— 必须严格遵守】' : '【文风要求 —— 严格贴合下方样本】'
  const intro = summary ? `\n本分身取法：${summary}` : ''
  const list = traits.length ? `\n${traits.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : ''
  const body = samples.length
    ? `\n下面是作者的原文样本，请仔细体会其句子节奏、用词习惯与叙述密度，写作时保持同样的笔感：\n\n${samples
        .slice(0, 3)
        .map((x, i) => `〈样本 ${i + 1}〉\n${truncate(x, 1600)}`)
        .join('\n\n')}`
    : ''

  return `${title}${intro}${list}${body}`
}

/**
 * `library` 是系统文风分身库：只有当本书激活的 profile 处于「引用态」（有 sourceRef）时才用得上。
 * 传 null/undefined 不是错误——那表示库还没载入或已损坏，此时 resolveRef 会回落到书内的本地覆盖字段，
 * 生成照常进行，只是文风停在引用那一刻的样子。
 */
export function buildSystemPrompt(
  project: Project,
  mode: 'prose' | 'outline' = 'prose',
  library?: StyleLibrary | null,
  /** 设置里的题材公约覆盖表；不传就只吃内置默认值（试写页 / 测试就是这种情形） */
  conventions?: GenreConventionOverrides | null
): string {
  const scene = getScene(project.sceneId)
  const s = project.settings
  const parts: string[] = []

  parts.push(scene.systemPrompt)

  if (s.context.genre !== false) {
    const block = renderGenreBlock(project.genreId, conventions)
    if (block) parts.push(block)
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
    // 引用系统分身时以库里的当前值为准（系统库改了，所有书立刻跟着变）；
    // 来源已被删除时 resolveRef 会回落成本地覆盖字段并标记 missing——这里照常注入，
    // 因为「文风暂时停在旧样子」远好过「突然变成裸写」。
    const resolved = style.sourceRef ? resolveRef(style.sourceRef, style, library?.personas) : null
    // 未引用系统分身时就是书内自建：用 profile 自己的字段，summary 可能是空的
    const effective = resolved ?? { summary: style.summary, traits: style.traits, samples: style.samples }
    const block = renderStyleBlock(effective)
    if (block) parts.push(block)
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
  /** 设置里的题材公约覆盖表，用于解析出真正生效的公约正文 */
  conventions?: GenreConventionOverrides | null
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

  // 题材公约排在第一位：它在提示词里位于系统提示词段（scene 之后、写作规范之前），
  // 上下文面板也按这个顺序列，作者看到的先后与模型吃到的先后一致。
  // 注意它是「预览」：真实注入文本在 buildSystemPrompt 里由 renderGenreBlock 生成，
  // 两边共用同一个函数，所以这里的字数和提示词里的字数必然对得上。
  // 题材公约不进 budget 裁剪（它在 system 段，永远不会被丢），但会计入总量统计。
  push('genre', '题材公约', renderGenreBlock(project.genreId, opts.conventions), ctx.genre)

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
  // genre 故意不在 dropOrder 里：它属于系统提示词段，永远整条注入，不该被当成可裁的正文资料。
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
    // genre 块只是给面板看的预览，真实注入发生在 buildSystemPrompt 的 system 段。
    // 这里若也拼进去，题材公约就会在提示词里出现两遍，白烧 token 还会稀释约束力。
    .filter((b) => b.text && b.key !== 'genre')
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

export function buildDraftMessages(
  project: Project,
  chapter: Chapter | null,
  opts: DraftOptions,
  library?: StyleLibrary | null,
  conventions?: GenreConventionOverrides | null
): PromptMessage[] {
  const system = buildSystemPrompt(project, 'prose', library, conventions)
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
  instruction: string,
  library?: StyleLibrary | null,
  conventions?: GenreConventionOverrides | null
): PromptMessage[] {
  const system = buildSystemPrompt(project, 'prose', library, conventions)
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

export function buildOutlineMessages(
  project: Project,
  instruction: string,
  library?: StyleLibrary | null,
  conventions?: GenreConventionOverrides | null
): PromptMessage[] {
  const system = buildSystemPrompt(project, 'outline', library, conventions)
  const ctx = assembleContext(project, null)
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `${contextToText(ctx) ? `【作品资料】\n${contextToText(ctx)}\n\n` : ''}【任务】${instruction}\n\n请只输出大纲，格式为纯文本列表，每行一个节点，用「卷」和「章」两级缩进表示层级。任务里要求的章节数必须写满，不要用「略」「同上」「其余类似」省略任何一章。`
    }
  ]
}

export function countGenerated(text: string): number {
  return countWords(text)
}

export function estimateContext(project: Project, chapter: Chapter | null): number {
  return assembleContext(project, chapter).totalTokens
}

export { estimateTokens }