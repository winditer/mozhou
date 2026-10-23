import type { Chapter, Project, PromptMessage } from '@shared/types'
import { stripHtml, truncate } from '@shared/utils'
import { characterDigest, threadDigest } from './prompts'

/**
 * 段落侧批：不改稿，只在段落旁边写一句话。
 *
 * 这是编辑真正干的事——红笔不是用来替作者写的，是用来让作者看见自己没看见的东西。
 * 所以这里的输出被刻意约束成「一句一句的批注」，不是整段改写，也不是打分。
 */

const MARGIN_SYSTEM = `你是一位在稿纸上用红笔写批注的老编辑。你带过作者，也退过无数稿子。
你的批注有三条规矩：
一、只说这一处，不总结全章，不夸人，不做总体评价。
二、每条批注必须指向一个具体的词、一句动作或一句对话，能让人一眼找到你说的是哪里。不写"这里可以更生动"这种空话。
三、宁少勿多。一趟批注里，没毛病的地方就跳过；批注超过六条，作者就不会看了。
你只说问题，也顺带说清怎么改，但绝不替作者把那段重写一遍。
你的输出必须是可被 JSON.parse 解析的纯数据。`

export interface MarginNote {
  /** 段落序号，从 1 开始 */
  index: number
  /** 批注类型 */
  kind: '删' | '改' | '慢' | '快' | '虚' | '偏'
  /** 一句话批注，控制在 40 字以内 */
  note: string
}

/** 把正文切成段落，过滤空段，保证序号与界面上的段落一一对应 */
export function splitParagraphs(chapter: Chapter | null): string[] {
  if (!chapter) return []
  return stripHtml(chapter.content)
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function buildMarginNoteMessages(project: Project, chapter: Chapter): PromptMessage[] {
  const paras = splitParagraphs(chapter)
  const numbered = paras.map((p, i) => `${i + 1}. ${p}`).join('\n\n')

  const parts: string[] = []
  if (project.brief.logline.trim()) parts.push(`一句话前提：${project.brief.logline.trim()}`)
  const chars = characterDigest(project)
  if (chars) parts.push(`【角色卡】\n${chars}`)
  const threads = threadDigest(project)
  if (threads) parts.push(`【伏笔台账】\n${threads}`)

  const user = `${parts.length ? `${parts.join('\n\n')}\n\n` : ''}【本章〈${chapter.title}〉分段正文】
${truncate(numbered, 14000)}

【批注任务】
逐段读，只给真正需要动的地方写批注。每条批注必须是下面六种之一：

- "删"：这句是多余的注释、重复信息、或替读者下结论。例："这个心理注解删掉，前面的动作已经说完了。"
- "改"：这句写得别扭、用词不准、或不像这个人会说的话。例："'孩提时代'不像她会用的词，换成她真会说的说法。"
- "慢"：该停下来的地方写快了，细节不够，情绪没落地。
- "快"：该过去的写慢了，在拖。
- "虚"：写了抽象的感受而不是具体的画面。例："'心里一阵酸楚'是虚的，写她手上的动作。"
- "偏"：这一处偏离了人物、设定或前后文（前后矛盾、人物说了不该知道的事、腔调突然变）。

【输出格式】
严格输出一个 JSON 数组，不要 markdown 代码块包裹，不要在前后写任何解释：
[{"index":1,"kind":"删","note":"一句话批注，40 字以内"}]

要求：
- index 必须是对应段落的序号，只能使用上面实际存在的序号。
- 最多 6 条，按重要程度从高到低排。宁可只给 2 条最有用的，也不要凑满。
- note 要具体到那一句，不要泛泛而谈；不要出现"建议对……进行优化"这种腔调。
- 如果整章都很干净，直接输出 []。`

  return [
    { role: 'system', content: MARGIN_SYSTEM },
    { role: 'user', content: user }
  ]
}

/** 从模型输出里抠出批注数组，容错各种多余包裹 */
export function parseMarginNotes(raw: string, paragraphCount: number): MarginNote[] {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let arr: unknown
  try {
    arr = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const kinds = new Set(['删', '改', '慢', '快', '虚', '偏'])
  const out: MarginNote[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const index = Number(o.index)
    const note = typeof o.note === 'string' ? o.note.trim() : ''
    if (!Number.isFinite(index) || index < 1 || index > paragraphCount || !note) continue
    const kind = typeof o.kind === 'string' && kinds.has(o.kind) ? (o.kind as MarginNote['kind']) : '改'
    out.push({ index: Math.round(index), kind, note })
  }
  const seen = new Set<number>()
  return out.filter((n) => {
    if (seen.has(n.index)) return false
    seen.add(n.index)
    return true
  })
}