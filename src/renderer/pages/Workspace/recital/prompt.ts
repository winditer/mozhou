/**
 * 评书稿的提示词与风格表。
 *
 * 为什么单独拆成纯函数：风格约束是这一页最容易「越改越飘」的地方——加一句
 * 「要有画面感」，模型就会开始复述原文；几种风格互相抄，最后五档听起来一样。
 * 把约束写成可测的数据与可拼接的字符串，测试才能钉住「每种风格都还认得自己」。
 */
import type { Chapter, Project } from '@shared/types'
import { stripHtml } from '@shared/utils'

export interface RecitalStyle {
  id: RecitalStyleId
  name: string
  /** 一句话说明，给作者选的时候看 */
  desc: string
  /** 注入系统提示词的风格约束，每条都要能落到「怎么写」上 */
  constraints: string[]
}

export type RecitalStyleId = 'classic' | 'beijing' | 'fast' | 'suspense' | 'kids'

export const RECITAL_STYLES: RecitalStyle[] = [
  {
    id: 'classic',
    name: '单田芳式',
    desc: '沙哑苍劲、短句多、爱用「话说」「且说」',
    constraints: [
      '按单田芳的路子说：嗓音沙哑苍劲、节奏顿挫，句子短、收得住。',
      '多用「话说」「且说」「您猜怎么着」「书中暗表」这类说书人的套话开场与转场。',
      '口气要像一个人坐在你对面拍桌子讲事，而不是念稿。'
    ]
  },
  {
    id: 'beijing',
    name: '老北京说书',
    desc: '京腔口语、夹叙夹议、俏皮',
    constraints: [
      '用老北京的京腔口语，允许儿化音与「您」「得嘞」「您猜」这类说法，但别堆成相声。',
      '夹叙夹议：讲到哪儿就顺口评一句，评点要俏皮，不能空喊口号。',
      '多用市井比喻，把场面话掰开揉碎讲给听众。'
    ]
  },
  {
    id: 'fast',
    name: '快节奏',
    desc: '两句一个转折，少描写多动作',
    constraints: [
      '快节奏：两句一个转折，三句一个动作，绝不在环境与心理上停留。',
      '少描写、多动作与对白，把形容词砍掉一半。',
      '每段都要往前推事件，宁可粗一点，不能慢下来。'
    ]
  },
  {
    id: 'suspense',
    name: '悬疑夜场',
    desc: '压低嗓子、慢、专在关键处停',
    constraints: [
      '压低嗓子说，语速偏慢，声音要沉，像半夜电台里的讲述。',
      '专在关键处停顿：把最要紧的那个词单拎出来，停一拍再往下说。',
      '多用「他不知道的是」「门后头有人」「可这时候」这类吊着人的句子。'
    ]
  },
  {
    id: 'kids',
    name: '少儿故事',
    desc: '句子短、解释多、不用生僻词',
    constraints: [
      '给孩子讲：句子短，一句只说一件事，语气亲切。',
      '遇到生僻词、成语、复杂官职，直接用大白话解释一句，不许留给孩子自己猜。',
      '多用提问与互动（「你说他怕不怕？」），恐怖、血腥的地方要淡化。'
    ]
  }
]

export function findRecitalStyle(id: string): RecitalStyle {
  return RECITAL_STYLES.find((s) => s.id === id) ?? RECITAL_STYLES[0]
}

/** 口播每分钟约 260 字（说书比朗读略快，且评书稿里有停顿句）。 */
export const WORDS_PER_MINUTE = 260

export type RecitalMinutes = 1 | 3 | 5

export const RECITAL_DURATIONS: { value: RecitalMinutes; label: string }[] = [
  { value: 1, label: '1 分钟' },
  { value: 3, label: '3 分钟' },
  { value: 5, label: '5 分钟' }
]

/** 时长 → 目标字数。1/3/5 分钟对应 260/780/1300 字。 */
export function targetWordsForMinutes(minutes: number): number {
  const m = Number.isFinite(minutes) ? minutes : 3
  return Math.round(m * WORDS_PER_MINUTE)
}

/** 单章正文喂给模型的字数上限：再长就掐中段、保首尾——章末的钩子不能丢。 */
const MAX_SOURCE_CHARS = 6000
const HEAD_CHARS = 3500
const TAIL_CHARS = 2500

function clipSource(text: string): string {
  if (text.length <= MAX_SOURCE_CHARS) return text
  return `${text.slice(0, HEAD_CHARS)}\n……（中略）……\n${text.slice(text.length - TAIL_CHARS)}`
}

const OUTPUT_CONTRACT = `输出必须严格按下面四段，用中文方头括号做标记，段与段之间空一行：

【回目】第七回 灰线尽头
【定场诗】一张图纸千条线，线线都通鬼门关。
【正文】
话说……
【收尾】欲知后事如何，且听下回分解。

约定：
- 【回目】只写一行，像「第七回 灰线尽头」这样的回目名，不许换行。
- 【定场诗】一到两句，七言或顺口溜都行。
- 【正文】是最主要的部分，分行分段写。
- 【收尾】一句勾人的落句。
- 只输出这四段，前后不要任何解释、不要标题、不要 Markdown 代码围栏。`

export function buildRecitalMessages(
  project: Project,
  chapter: Chapter,
  style: RecitalStyle,
  targetWords: number
): { system: string; user: string } {
  const total = Math.max(1, project.chapters.length)
  const idx = project.chapters.findIndex((c) => c.id === chapter.id)
  const order = idx >= 0 ? idx + 1 : 1
  const source = clipSource(stripHtml(chapter.content || ''))

  const system = [
    '你是一位经验老到的评书艺人，专门把小说改成能上台「说」的评书稿。',
    '你的活儿不是复述原文，而是重新讲一遍：书面语拆成能出口的短句，说书人替听众把话说明白，还要留扣子让人想听下一回。',
    '',
    '铁律：',
    '- 全程口语，一句话一个意思，能断就断，不许写长句。',
    '- 禁止逐字复述原文：不许成段照抄原句、原文对白，要改成说书人的口气重新讲，允许补白与评点。',
    '- 每隔一两段设一个扣子（悬念、反常、提问），章末一定要留勾子。',
    '- 只用给定的四段标记，不输出任何解释性文字。',
    '',
    `【本次风格：${style.name}】`,
    ...style.constraints.map((c) => `- ${c}`)
  ].join('\n')

  const head: (string | null)[] = [
    `书名：《${project.title || '未命名作品'}》`,
    project.brief?.logline ? `一句话简介：${project.brief.logline}` : null,
    '',
    `本章是全书第 ${order} 章（共 ${total} 章），章名：${chapter.title}`,
    `目标字数：正文约 ${targetWords} 字（口播 ${Math.round((targetWords / WORDS_PER_MINUTE) * 10) / 10} 分钟，每分钟约 ${WORDS_PER_MINUTE} 字）。字数按中文字符算，允许上下浮动 15%。`,
    '',
    '以下是本章原文，只作为讲这段故事的依据，不要照抄：',
    '————',
    source || '（本章正文为空）',
    '————',
    '',
    OUTPUT_CONTRACT
  ]

  // 只滤掉「没有这一项」的 null，空串是有意的空行（段落分隔），不能一起删
  const user = head.filter((line) => line !== null).join('\n')

  return { system, user }
}