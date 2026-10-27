/**
 * 把「体检建议」真正落到正文上。
 *
 * 体检给出的每条问题都带着 `evidence`（从正文摘出的片段）和 `suggestion`（该怎么改）。
 * 这里负责三件事，且只做这三件：
 *
 *   1. 定位：拿 evidence 回正文里找出它所在的段落。找不到就**如实报告找不到**，
 *      绝不退化成「整章重写」——那会把作者没被指出的地方也一起改掉，是越权。
 *   2. 改写：只把这几段交给 AI 重写，并把作者其他段落的原样文本作为上下文。
 *   3. 替换：把改好的段落原位换回 HTML，前后段落逐字不动。
 *
 * 为什么不整章重写：一章几千字，AI 重写整章必然顺手改掉一批没问题的地方，
 * 用户在对比预览里根本审不过来。只改被点名的段落，diff 才看得清、才敢点确认。
 */

import type { PromptMessage } from '@shared/types'
import {
  type BodyParagraph,
  escapeHtml,
  normalizeText,
  splitParagraphs,
  unescapeHtml
} from '../../../lib/paragraphs'

/* 切段与正则归一化搬去了 lib/paragraphs.ts：对话改稿要按 anchor 定位段落，
   必须和体检用同一套规则，两处各写一份迟早分叉。这里 re-export，既有 import 不用改。 */
export type { BodyParagraph }
export { splitParagraphs }

/** 归一化：去掉空白与常见标点差异，好让「摘录」和「原文」对得上 */
const normalize = normalizeText

export interface LocateResult {
  /** 命中的段落下标（升序去重） */
  indexes: number[]
  /** 是精确命中（evidence 完整出现在段落里）还是只命中了一部分 */
  exact: boolean
}

/**
 * 用 evidence 找它落在哪几段。
 *
 * evidence 是模型从正文里摘的，可能：
 *   - 完整落在某一段里（最常见）；
 *   - 跨段摘录（模型把两段拼在一起）；
 *   - 有细微改动（多一个字、少个标点、全半角差异）。
 * 所以先试整串，再退回「最长公共子串」式的逐段打分，取分数够高的段落。
 */
export function locateEvidence(paragraphs: BodyParagraph[], evidence: string): LocateResult {
  const needle = normalize(evidence)
  if (!needle) return { indexes: [], exact: false }

  // 标题段（h1–h6）永远不作为改写目标：那是章节名，改掉会破坏文档结构。
  // 梗概与 evidence 常常包含章节标题，不排除的话很容易把章名当成正文改掉。
  const isHeading = (i: number): boolean => /^<(h[1-6])\b/i.test(paragraphs[i].html)

  // 1) 整串落在某段里
  const exactHits: number[] = []
  for (let i = 0; i < paragraphs.length; i++) {
    if (isHeading(i)) continue
    if (normalize(paragraphs[i].text).includes(needle)) exactHits.push(i)
  }
  if (exactHits.length) return { indexes: exactHits, exact: true }

  // 2) 跨段：把相邻几段拼起来再找。
  //    取**段落数最少**的那个匹配：同一段摘录可能被多个起点包含（比如从第 1 段开始
  //    拼到第 3 段也能匹配），取最窄的那个才不会把无辜段落一起改掉。
  let bestSpan: number[] | null = null
  for (let i = 0; i < paragraphs.length; i++) {
    if (isHeading(i)) continue
    let joined = normalize(paragraphs[i].text)
    const span: number[] = [i]
    if (joined.includes(needle)) {
      if (!bestSpan || span.length < bestSpan.length) bestSpan = [...span]
      continue
    }
    for (let j = i + 1; j < Math.min(i + 4, paragraphs.length); j++) {
      joined += normalize(paragraphs[j].text)
      span.push(j)
      if (joined.includes(needle)) {
        if (!bestSpan || span.length < bestSpan.length) bestSpan = [...span]
        break
      }
    }
  }
  if (bestSpan) return { indexes: bestSpan, exact: true }

  // 3) 退化匹配：按 evidence 里连续出现的字串片段给每段打分
  //    阈值取得高一些（0.55），宁可报「找不到」也不改错段落
  const grams = new Set<string>()
  const step = 4
  for (let i = 0; i + step <= needle.length; i += 2) grams.add(needle.slice(i, i + step))
  if (!grams.size) return { indexes: [], exact: false }

  const scored = paragraphs.map((p, i) => {
    if (isHeading(i)) return { i, score: 0 }
    const body = normalize(p.text)
    let hit = 0
    for (const g of grams) if (body.includes(g)) hit++
    return { i, score: hit / grams.size }
  })
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a), { i: -1, score: 0 })
  if (best.i >= 0 && best.score >= 0.55) {
    // 把紧邻的、分数也过线一半的段落一并纳入，跨段问题才改得全
    const idx = scored.filter((x) => x.score >= best.score * 0.5).map((x) => x.i)
    return { indexes: [...new Set(idx)].sort((a, b) => a - b), exact: false }
  }
  return { indexes: [], exact: false }
}

export interface RewriteInput {
  /** 要改的那几段纯文本 */
  targets: string[]
  /** 前后的段落，作为语气和上下文参考（不改） */
  before: string[]
  after: string[]
  /** 体检给出的问题描述与修改建议 */
  title: string
  detail: string
  suggestion: string
}

export function buildRewriteMessages(i: RewriteInput): PromptMessage[] {
  const system = `你是小说作者的改稿助手。作者已经确认了体检指出的一处问题，要你只改被点名的段落。
你的改写必须做到：
- 只解决被指出的问题，不要顺手做其他润色、不要调整叙事顺序、不要增删情节。
- 保持原有文风、人称、时态、语气和叙述距离，读起来要和上下文无缝衔接。
- 保持与原段落大致相同的长度（允许 ±30%），不要把它扩写成一大段。
- 只输出改写后的段落正文，一段一行，不要编号、不要解释、不要 markdown。
- 段落数量和输入完全一致：输入几段就输出几段。`

  const parts: string[] = []
  if (i.before.length) parts.push(`【上文（只作参考，不要改、不要输出）】\n${i.before.join('\n')}`)
  parts.push(`【要改的段落】\n${i.targets.join('\n')}`)
  if (i.after.length) parts.push(`【下文（只作参考，不要改、不要输出）】\n${i.after.join('\n')}`)
  parts.push(`【体检指出的问题】\n${i.title}${i.detail ? `\n${i.detail}` : ''}`)
  parts.push(`【修改建议】\n${i.suggestion || '按上述问题自行调整，使前后一致。'}`)
  parts.push(`【输出要求】\n只输出改写后的 ${i.targets.length} 段正文，一段一行，不要任何其他内容。`)

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') }
  ]
}

/** 把模型返回的多行文本对齐到被改的段落数（多截少补） */
export function alignRewrite(raw: string, count: number): string[] {
  const lines = raw
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/```$/,'')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\d+[.、)]|[-*])\s*/, '').trim())
    .filter(Boolean)
  if (lines.length === count) return lines
  if (lines.length > count) {
    // 模型多给了：把多出来的并回最后一段，避免丢内容
    return [...lines.slice(0, count - 1), lines.slice(count - 1).join('')]
  }
  // 少给了：缺的段落保持原样（返回空串表示不改）
  return [...lines, ...Array.from({ length: count - lines.length }, () => '')]
}

/**
 * 把改写结果替换回章节 HTML。
 *
 * 只动被点名的段落，其余字节完全不变——包括标签属性、空白、其它段落。
 * 从后往前替换，避免前面的改动让后面的 start/end 偏移。
 */
export function applyParagraphRewrite(
  html: string,
  paragraphs: BodyParagraph[],
  indexes: number[],
  rewritten: string[]
): string {
  const pairs = indexes
    .map((pi, k) => ({ p: paragraphs[pi], text: rewritten[k] ?? '' }))
    .filter((x): x is { p: BodyParagraph; text: string } => Boolean(x.p) && x.text.trim().length > 0)
    .sort((a, b) => b.p.start - a.p.start)

  let out = html
  for (const { p, text } of pairs) {
    // 沿用原段落的标签，只换内容：<p class="x">…</p> 的 class 保留
    const open = p.html.match(/^<([a-z0-9]+)\b[^>]*>/i)
    const openTag = open ? open[0] : '<p>'
    const closeTag = `</${open ? open[1] : 'p'}>`
    const body = text
      .split(/\n+/)
      .map((t) => escapeHtml(t.trim()))
      .filter(Boolean)
      .join('')
    out = out.slice(0, p.start) + openTag + body + closeTag + out.slice(p.end)
  }
  return out
}
/* ────────────────────── 全书一致性：跨章定位与协同改写 ────────────────────── */

/**
 * 跨章定位的结果：每个被命中的章节各有哪些段落。
 *
 * 全书一致性体检的证据是从**章节梗概**里摘的，不是正文原话，所以直接拿 evidence
 * 去正文里找多半落空。这里多做一步：先在涉及章节的正文里按相似度找出最可能的段落，
 * 再把这件事如实告诉作者——「本书里我找到了这几段，请确认」比「找不到」有用，
 * 但也绝不能假装确定。
 */
export interface ChapterHits {
  chapterId: string
  chapterTitle: string
  indexes: number[]
  exact: boolean
  /** 该章里最像的那一段，用来给作者看「我猜的是这里」 */
  best: string
  /** 相似度 0~1，用于排序与展示 */
  score: number
}

/**
 * 在一章的正文里找与 evidence 最相关的段落。
 *
 * 和 locateEvidence 的区别：那个要求基本命中才算数（单章体检的证据是正文原话），
 * 这个允许「最像就算候选」——因为全书体检的证据本来就是梗概里的话，和正文永远
 * 不会一字不差。所以这里只负责**找候选**，采不采用由作者在预览里决定。
 */
export function candidateParagraphs(paragraphs: BodyParagraph[], evidence: string, max = 2): {
  indexes: number[]
  exact: boolean
  score: number
} {
  // 标题（h1–h6）不能作为改写目标：它是章节名，改掉会破坏结构，
  // 而且梗概里的标题几乎必然与 evidence 有重叠，很容易被误当成目标段。
  const isHeading = (i: number): boolean => /^<(h[1-6])\b/i.test(paragraphs[i].html)

  const strict = locateEvidence(paragraphs, evidence)
  const strictBody = strict.indexes.filter((i) => !isHeading(i))
  if (strictBody.length) return { indexes: strictBody, exact: strict.exact, score: 1 }

  const needle = normalize(evidence)
  if (needle.length < 4) return { indexes: [], exact: false, score: 0 }

  const anchors = keyTerms(evidence)
  // 一条证据如果连一个专名/实词锚点都提不出来，就没有可信的定位依据。
  // 这种情况下宁可报「找不到」，也不要靠零散字的重合去猜段落。
  if (!anchors.length) return { indexes: [], exact: false, score: 0 }

  const grams = new Set<string>()
  const step = 3
  for (let i = 0; i + step <= needle.length; i += 1) grams.add(needle.slice(i, i + step))
  if (!grams.size) return { indexes: [], exact: false, score: 0 }

  const scored = paragraphs
    .map((p, i) => {
      if (isHeading(i)) return { i, score: 0, anchorHit: 0, anchorCover: 0 }
      const body = normalize(p.text)
      if (!body) return { i, score: 0, anchorHit: 0, anchorCover: 0 }
      let hit = 0
      for (const g of grams) if (body.includes(g)) hit++
      // 锚点命中用「字符覆盖度」而不是「整串出现」。
      //
      // 整串匹配太严：全书体检的证据摘自章节梗概，梗概是转述，
      // 「陈屿醒来后把苏念当成了已故的妻子周予安」和正文
      // 「陈屿在急诊留观室醒来，把苏念认作亡妻周予安」说的是同一件事，
      // 却没有一个锚点能整串对上，于是大量本该能改的问题都被判「定位不到」。
      // 改为看锚点里的字有多少落在这一段里，允许措辞出入。
      let coverSum = 0
      for (const a of anchors) {
        const chars = [...a]
        let c = 0
        for (const ch of chars) if (body.includes(ch)) c++
        coverSum += chars.length ? c / chars.length : 0
      }
      const anchorCover = anchors.length ? coverSum / anchors.length : 0
      return { i, score: hit / grams.size, anchorHit: 0, anchorCover }
    })
    /**
     * 候选判定：既要「这一段确实在讲证据里的事」，又要防止只凭一个地名就认领。
     *
     * 两重条件缺一不可：
     *  1. 锚点覆盖度够高（说明整句话的内容大体都在这段里，不是只沾了个边）；
     *  2. gram 分数够高（说明有连续的字面重合，不是靠零散常见字凑出来的）。
     *
     * 之所以不能只看锚点：一条证据里的地名（比如「急诊留观室」）会让两段
     * 无关正文都拿到不错的覆盖度，结果去改只提到急诊室的章节，改完只是润色。
     * 之所以不能只看 gram：梗概是转述，字面重合天然偏低，只看它会把真问题漏掉。
     */
    // gram 门槛不能高：梗概是转述，字面连续重合天然少
    // （「当成了已故的妻子」vs 正文「认作亡妻」，只有「周予安」三个字连续对上）。
    // 真正防误伤的是锚点覆盖度——它要求整句内容大体都在这一段里。
    .filter((x) => x.anchorCover >= 0.55 && x.score >= 0.1)
    .sort((a, b) => b.score + b.anchorCover - (a.score + a.anchorCover))

  if (!scored.length) return { indexes: [], exact: false, score: 0 }
  const picked = scored.slice(0, max)
  return {
    indexes: picked.map((x) => x.i).sort((a, b) => a - b),
    exact: false,
    score: picked[0].score
  }
}

/**
 * 从证据里提取「锚点」：人名、地名、专有说法等实词。
 *
 * 中文没有空格，无法靠分词库（项目不引额外依赖），所以用启发式：
 * 按标点切成小句，再去掉虚词和单字，留下 2–6 字的连续片段作为锚点。
 * 目的不是完美分词，而是拿到「这段话在说什么东西」的骨架——
 * 比较两段文字是否在讲同一件事，锚点比字面重合可靠得多。
 */
export function keyTerms(evidence: string): string[] {
  const STOP = new Set([
    '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '但', '却', '把', '被', '让', '给', '对', '从',
    '将', '于', '为', '向', '往', '以', '及', '或', '这', '那', '有', '没', '不', '很', '还', '又', '再',
    '他', '她', '它', '我', '你', '们', '个', '次', '里', '上', '下', '中', '后', '前', '时', '候', '说', '到',
    '一', '二', '三', '两', '几', '些', '已', '经', '并', '则', '其', '之', '所', '者'
  ])
  const isContentful = (t: string): boolean => [...t].some((ch) => !STOP.has(ch))

  // 按标点切成语义单元。标点处是天然的语义边界，切出来的块通常就是一个「说法」。
  const chunks = String(evidence)
    .split(/[\s，。、；：！？,.;:!?"'“”‘’（）()【】\[\]《》<>—\-…·]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && isContentful(x))

  /**
   * 每个语义单元只取**一个**代表锚点：能覆盖最长内容的那一段，而不是滑窗切出
   * 一堆互相重叠的 2–4 字片段。
   *
   * 重叠片段会把分母撑大：「第七十三封信」滑窗能切出 4 个片段，正文命中其中
   * 任何一个都只算 1 分，于是明明讲的是同一件事也会因为「命中率不够」被拒。
   * 一个单元一个锚点，命中即代表该单元出现，判断才准确。
   */
  const out: string[] = []
  for (const c of chunks) {
    if (c.length <= 6) {
      out.push(c)
      continue
    }
    // 长句：取首尾各一段代表。锚点要短（4 字）——太长的锚点跨不过标点，
    // 梗概写「第七十三封信」而正文是「第七十三封。」，6 字锚点就永远匹配不上。
    const head = c.slice(0, 4)
    const tail = c.slice(-4)
    if (isContentful(head)) out.push(head)
    if (tail !== head && isContentful(tail)) out.push(tail)
  }

  return [...new Set(out)].slice(0, 10)
}

/**
 * 多章协同改写的提示词。
 *
 * 全书问题常常是「A 章说二十岁、C 章说二十五岁」这种跨章矛盾，只改一侧会让
 * 矛盾变成另一种形式。所以一次把涉及的各章片段都给它，要求**统一口径**，
 * 并且仍然只输出被点名的段落。
 */
export function buildCrossChapterMessages(input: {
  groups: { chapterTitle: string; targets: string[] }[]
  title: string
  detail: string
  suggestion: string
}): PromptMessage[] {
  const system = `你是小说作者的改稿助手。作者确认了体检在全书范围内指出的一处前后矛盾，要你在涉及的几章之间统一口径。
你的改写必须做到：
- 只解决被指出的这处矛盾，让各章说法一致；不要顺手做其他润色、不要调整叙事顺序、不要增删情节。
- 保持原有文风、人称、时态与叙述距离，改完要和上下文无缝衔接。
- 每段保持与原段落大致相同的长度（允许 ±30%）。
- 按输入顺序逐段输出，不要编号、不要章节标题、不要解释、不要 markdown。
- 段落总数必须与输入完全一致。`

  const parts: string[] = []
  let n = 1
  for (const g of input.groups) {
    parts.push(`【《${g.chapterTitle}》要改的段落】`)
    for (const t of g.targets) parts.push(`${n++}. ${t}`)
  }
  parts.push(`【体检指出的问题】\n${input.title}${input.detail ? `\n${input.detail}` : ''}`)
  parts.push(`【修改建议】\n${input.suggestion || '统一各章口径，消除矛盾。'}`)
  const total = input.groups.reduce((s, g) => s + g.targets.length, 0)
  parts.push(`【输出要求】\n只按上面的顺序输出改写后的 ${total} 段正文，一段一行，不要任何其他内容。`)

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') }
  ]
}

/**
 * 判断这次改写到底有没有「动到矛盾本身」。
 *
 * 模型的常见失败模式是：它看不懂跨章矛盾，于是把段落通顺地重述一遍
 * （「刚换班」→「刚换过班」、「二十」→「二十」），diff 非空、看起来改了，
 * 但矛盾一个字都没解决。作者点「写入正文」后问题还在。
 *
 * 这里用最朴素的办法兜住：建议里明确要改掉的说法（例如「把亡妻改为妻子」），
 * 若改写后仍在文本里留着，就说明没改到点子上。
 * 返回 null 表示看不出问题；返回字符串表示要提醒作者的话。
 */
export function checkRewriteTouchesIssue(
  before: string[],
  after: string[],
  suggestion: string
): string | null {
  if (!suggestion) return null
  // 「把X改为Y」「将X改作Y」「X→Y」这类明确替换指令
  const rules: { from: string; to: string }[] = []
  const re = /(?:把|将)?[「“"]?([^」「“”"，。]{1,12})[」”"]?\s*(?:改为|改成|改作|换成|替换为|→)\s*[「“"]?([^」「“”"，。]{1,12})[」”"]?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(suggestion))) {
    const from = m[1].trim()
    const to = m[2].trim()
    if (from && to) rules.push({ from, to })
  }
  if (!rules.length) return null

  const joined = after.join('\n')
  const orig = before.join('\n')
  for (const r of rules) {
    const stillThere = joined.includes(r.from) && !joined.includes(r.to)
    const wasThere = orig.includes(r.from)
    if (wasThere && stillThere) {
      return `建议要求把「${r.from}」改为「${r.to}」，但改写结果里「${r.from}」还在、也没出现「${r.to}」——这次的改动可能只是润色，没解决矛盾。请仔细看下面的对比。`
    }
  }
  return null
}
