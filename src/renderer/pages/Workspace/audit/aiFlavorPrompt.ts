/**
 * 去 AI 味：把本地扫出来的「脏段」交给模型改。
 *
 * 分工是这套设计的关键，和全书一致性体检正好相反：
 *
 *   - 全书一致性：模型负责**找**问题（它读梗概，本地判不了），本地负责定位段落。
 *   - 去 AI 味：本地负责**找**问题（正则会数，且比模型数得准），模型只负责**改**。
 *
 * 为什么必须这样分：AI 味是句子级现象，用词和句式都可数。让模型去找，
 * 它既数不清「这一章有多少个仿佛」，又会漏掉自己写出来的腔调——它不觉得自己有口音。
 * 而「怎么把它改成人写的」恰恰是模型擅长的。所以这里送进去的永远是
 * **已经确认有问题的段落原文 + 它具体犯了哪几条**，模型没有判断权，只有改写权。
 *
 * 提示词的写法不是重新发明一套标准，而是复用 textcraft.ts 的 DE_AI_INSTRUCTION——
 * 那是选区「去 AI 味」按钮用的同一份指令。两边一旦分叉，作者会发现同一段文字
 * 从选区走一遍和从体检走一遍，改出来的手感不一样，而他说不清哪里不对。
 */

import type { Chapter, Project, PromptMessage } from '@shared/types'
import { DE_AI_INSTRUCTION } from '../../../lib/textcraft'
import { FLAVOR_KIND_HINT, FLAVOR_KIND_LABEL, describeHits, type ParagraphFlavor } from '../../../lib/aiFlavor'

/* ────────────────────────── 送给模型的目标段 ────────────────────────── */

export interface FlavorTarget {
  /** 该段在原章里的序号（从 1 开始），回写时按它定位 */
  index: number
  /** 段落原文 */
  text: string
  /** 本地判定它犯了哪些毛病，拼成一句给人/模型看的描述 */
  symptoms: string
  /** 命中涉及的维度 */
  kinds: ParagraphFlavor['hits'][number]['kind'][]
}

/**
 * 把本地检测结果翻成提示词里的「待改段落清单」。
 *
 * 带上是哪一段的「症状」，是因为模型如果只知道「这段有 AI 味」，
 * 它会按自己脑内对 AI 味的理解重写一遍，往往改成另一种腔调；
 * 明确告诉它「这句是万能修饰词、那段是段末升华」，它才知道只拆哪一处。
 */
export function toFlavorTargets(paragraphs: ParagraphFlavor[]): FlavorTarget[] {
  return paragraphs.map((p) => ({
    index: p.index,
    text: p.text,
    symptoms: describeHits(p),
    kinds: [...new Set(p.hits.map((h) => h.kind))]
  }))
}

/* ────────────────────────── 提示词 ────────────────────────── */

const FLAVOR_SYSTEM = `你是一位帮作者"去机器腔"的老编辑。你不负责判断哪里有问题——哪些段落有问题、犯了哪几条毛病，作者已经用工具查好并交给你了。你只负责把这几段改到看不出是机器写的。

你的改写必须守住三条底线：
一、只改被点名的段落，一个字都不要动到别处的意思。段落数量和顺序与输入完全一致。
二、不得增删任何情节信息。人名、地名、数字、道具、时间、对话内容全部保留；不新增动作、不补充设定、不改结局。
三、长度与原段大致相当（允许 ±15%）。去 AI 味不是缩写，也不是扩写。

你的改写要解决的问题就是下面这些毛病（这是本书统一的去 AI 味标准，逐条照做）：
${DE_AI_INSTRUCTION}

只输出改写后的段落正文，一段一行，不要编号、不要解释、不要 markdown 代码块、不要写"以下是"。`

/**
 * 组一封「改这几段」的请求。
 *
 * 上下文刻意只给「相邻一两段」而不是整章：整章几千字塞进去，
 * 模型会开始按整章的调子重写，被点名的那几段反而改成另一副面孔；
 * 而相邻段落足以让它接住人称、语气与叙述距离。
 */
export function buildFlavorRewriteMessages(
  project: Project,
  chapter: Chapter,
  targets: FlavorTarget[],
  neighborText: { before: string[]; after: string[] }
): PromptMessage[] {
  const parts: string[] = []

  // 只在有内容时给作品前提：一句提示足够定住腔调，正文资料给多了反而会串味。
  const logline = project.brief.logline.trim()
  if (logline) parts.push(`【本书一句话前提】\n${logline}`)

  if (neighborText.before.length) {
    parts.push(`【上文（只作参考，不要改、不要输出）】\n${neighborText.before.join('\n')}`)
  }

  const block = targets
    .map((t, i) => {
      const kinds = t.kinds.map((k) => FLAVOR_KIND_LABEL[k]).join('、')
      const hints = [...new Set(t.kinds.map((k) => FLAVOR_KIND_HINT[k]))].join('；')
      return `【第 ${i + 1} 段｜原第 ${t.index} 段｜问题：${kinds}】\n原文：${t.text}\n症状：${t.symptoms || '机器腔明显'}\n改法：${hints}`
    })
    .join('\n\n')
  parts.push(`【待改段落｜共 ${targets.length} 段，按顺序对应】\n${block}`)

  if (neighborText.after.length) {
    parts.push(`【下文（只作参考，不要改、不要输出）】\n${neighborText.after.join('\n')}`)
  }

  parts.push(
    `【输出要求】\n只输出改写后的 ${targets.length} 段正文，一段一行，顺序与上面完全一致。不要输出段号、不要输出原文、不要任何说明。`
  )

  return [
    { role: 'system', content: FLAVOR_SYSTEM },
    { role: 'user', content: parts.join('\n\n') }
  ]
}

/* ────────────────────────── 结果对齐 ────────────────────────── */

/**
 * 把模型返回的多行文本对齐到目标段数。
 *
 * 和 audit/apply.ts 的 alignRewrite 分开实现，是因为这里的语义不同：
 * 那边「少给」要保留原文（返回空串表示不改），这里也一样，但**多给**时
 * 不能把多余的并进最后一段——段落合并会把两段正文压成一段，改了文章结构。
 * 所以这边多给就丢弃多余部分，宁少勿乱。
 */
export function alignFlavorRewrite(raw: string, count: number): string[] {
  const lines = raw
    .replace(/^\s*```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .split('\n')
    // 模型常自作主张加「1. 」「- 」这类前缀
    .map((l) => l.replace(/^\s*(?:\d+[.、)]|第\s*\d+\s*段[：:]?|[-*•])\s*/, '').trim())
    .filter(Boolean)

  if (lines.length === count) return lines
  if (lines.length > count) return lines.slice(0, count)
  // 少给了：缺的段落留空串，调用方据此保留原文，绝不拿错位的段落顶上
  return [...lines, ...Array.from({ length: count - lines.length }, () => '')]
}

/**
 * 改写后的段落是否「改坏了」。
 *
 * 这道检查存在的理由：提示词写得再硬，模型仍会偶尔把三段并成两段、
 * 把 300 字压成 80 字、或者把对话全删掉。作者在预览里能看出来，但那时候
 * 已经改了七八段，逐段核对成本很高。
 *
 * 所以这里在生成后立刻判一次：**字数偏离超过 40%** 的段落打上警告，
 * 让界面直接提示「这一段可能改写过头了」，而不是悄悄混进对比列表。
 * 阈值取 40% 而不是提示词里的 15%：提示词是要求，这里是兜底，
 * 兜底只拦真正的失控，不拦正常的措辞长短变化。
 */
export function flavorRewriteWarning(before: string, after: string): string | null {
  const b = Array.from(before.replace(/\s+/g, '')).length
  const a = Array.from(after.replace(/\s+/g, '')).length
  if (!a) return '模型没有返回这一段，将保留原文'
  if (b === 0) return null
  const diff = (a - b) / b
  if (diff > 0.4) return `字数从 ${b} 变成 ${a}，扩写过多，可能掺进了原文没有的内容`
  if (diff < -0.4) return `字数从 ${b} 变成 ${a}，压缩过多，可能删掉了情节信息`
  return null
}