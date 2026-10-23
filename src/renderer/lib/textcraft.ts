/**
 * 文字工艺层：给 AI 的「人味」指令 + 能本地判定的校对规则。
 *
 * 这一层的立场：AI 味不是靠"降低温度"能去掉的，它是一组具体的坏习惯。
 * 所以这里不写"请写得自然一点"，而是把坏习惯一条条列成可执行的禁令，并给出反例。
 */

/* ───────────────────── 一、去 AI 味：规则集 ───────────────────── */

export const DE_AI_INSTRUCTION = `改写选中文字，去掉机器味。这不是润色，是治病，请严格按下面六条执行，宁可改得粗糙也不要留一句总结腔：

- 删掉所有替读者下结论的句子（动作或对话后面紧跟的心理注解、"他终于明白了""这一刻她忽然意识到""某种说不清的情绪"），让前面的动作自己说话。
- 清掉解释性副词与万能形容词："不禁""不由得""仿佛""似乎""微微""缓缓""深深地""莫名地"，一律先删；删掉后读不通，说明原本写虚了，改写成具体动作。
- 句子长度必须长短相间。AI 偏爱等长句子和平行排比，至少拆掉三分之一的复句，允许出现三五个字的短句。
- 用具体名词替换抽象名词：不写"一种复杂的情绪"，写"她把勺子放回碗里，没吃完"。
- 对话按人说话的样子写：允许答非所问、打断、停顿，不许用台词交代设定。
- 段末禁止升华、点题、暗示"这一切才刚开始"。最后一句写完就停。

保持原意与情节信息，只输出改写后的正文，不要任何说明或前后对比。`

/* ───────────────────── 二、本地校读 ───────────────────── */

export type ProofKind = 'punct' | 'width' | 'repeat' | 'space' | 'quote'

export interface ProofIssue {
  id: string
  kind: ProofKind
  /** 面向作者的一句话说明 */
  message: string
  /** 命中的原文片段 */
  snippet: string
  /** 建议替换成什么（无建议时为 null，只提示） */
  suggestion: string | null
  /**
   * 该问题在全文中的精确位置。
   * suggestion 是「这一处应该变成什么」，range 说明从哪改到哪——
   * 有了它就不必靠 snippet 做模糊搜索，也不会误改到别处相同的片段。
   */
  range?: { start: number; end: number }
}

export const PROOF_KIND_LABEL: Record<ProofKind, string> = {
  punct: '标点',
  width: '全角半角',
  repeat: '重复词',
  space: '空格',
  quote: '引号'
}

/** 中文语境下常见的「直角引号 + 半角引号」混用 */
const CJK = /[\u4e00-\u9fa5]/
/**
 * 连续重复片段：贪婪匹配会把"说说说"吃成"说说"，所以匹配后还要往后看一位，
 * 由调用方补判三连。这里只是初筛。
 */
const REPEAT_WORD = /([\u4e00-\u9fa5]{1,4})\1/g

/** 中文段落里夹着半角标点（英文、代码、URL 之外的情况） */
const HALF_PUNCT_IN_CJK = /[\u4e00-\u9fa5]\s*([,;:?!])|([,;:?!])\s*[\u4e00-\u9fa5]/g
const HALF_TO_FULL: Record<string, string> = {
  ',': '，',
  ';': '；',
  ':': '：',
  '?': '？',
  '!': '！'
}

/**
 * ── 重复词判定 ──
 *
 * 早期版本靠"叠词白名单"来排除误报，这是错的路子：中文叠词有上万种
 * （家家户户、一遍一遍、马马虎虎、干干净净、水汪汪……），词表永远补不完，
 * 每补一次还会引出新的漏报。所以这里改成按**语言形态**判断：
 *
 * 中文里正常的重叠几乎都是"有语义的双音节/单音节词重叠"，而打字重复的特点是
 * **功能词成对重复**（的的、了了、是是、在在）或**多字词整段成对重复**（已经已经）。
 * 这两类在正常中文里几乎不成立，拿它们当信号，误报率会低得多。
 */

/** 功能词：这些字重复几乎只可能是手滑，正常中文里不会出现"的的""了了" */
const FUNC_CHARS = new Set('的了是在和与就也都而及或把被给让对从向于以之为其这那他她它我你您很挺更最不没别')

/** 副词的叠用是正常修辞（渐渐、慢慢、刚刚），单字重复时放行 */
const ADVERB_DOUBLE = new Set(
  '慢轻悄静明刚好死狠紧远常往久微缓悠茫沉淡柔暖细高低小大长短厚薄软硬苦甜酸辣香黑白红湿干冷热'
)

/** 量词重叠是正常说法（一个个、一件件、一片片、一阵阵） */
const MEASURE_DOUBLE = new Set('个件片阵条张次回遍声层重分秒天年月日家户盏块根截面场番趟顿吓')

/** 动宾/动作重叠是正常说法（看看、想想、试试、走走、点点头） */
const VERB_DOUBLE = new Set(
  '看想听说问走试动摸瞧坐躺站等聊算找寻找查改读写画玩摇拍敲洗擦扫晃弯伸踢跳眨望盯闻练商量整收放提拿拉推碰转抖捻揉搓抖'
)

/**
 * 判断第 at 个字符处、长度为 len 的词重复是否像手滑。
 * 返回 null 表示是正常重叠，不报。
 */
function classifyRepeat(text: string, at: number, word: string): { ok: boolean; reason: string } {
  const n = word.length
  const before = text.slice(Math.max(0, at - 2), at)
  const after = text.slice(at + n * 2, at + n * 2 + 2)

  // 单字重复：只有功能词才报（的的、了了、是是），虚词叠用一律放行
  if (n === 1) {
    const ch = word
    if (FUNC_CHARS.has(ch)) return { ok: true, reason: 'function-char' }
    // 副词/量词/动词的单字重叠是正常修辞与口语
    if (ADVERB_DOUBLE.has(ch) || MEASURE_DOUBLE.has(ch) || VERB_DOUBLE.has(ch)) return { ok: false, reason: 'lexical' }
    // 其余单字重复：汉语里"人人""处处""渐渐"极常见，默认不报
    // （宁可漏报一个字，也不要把正常叠词指成错误）
    return { ok: false, reason: 'default-single' }
  }

  // 双字及以上整词重复：
  // 「XX的」「XX地」「XX着」多半是正常结构（星星的、慢慢地说）
  if (/^[的地得着了过着呢]/.test(after)) return { ok: false, reason: 'particle-follows' }
  // 「一X一X」式数量对叠（一遍一遍、一盏一盏、一片一片、一步一步）是正常修辞：
  // 本词形如"一字开头"，或前文紧邻"一/不"时，判为正常。
  if (/^[一不]/.test(word) || /[一不没]$/.test(before)) return { ok: false, reason: 'measure-alternation' }
  if (/^(.)\1$/.test(word)) {
    // 本身就是叠词形式（"慢慢""家家"），再叠一次是"慢慢慢慢""家家户户"，正常
    return { ok: false, reason: 'reduplicated-form' }
  }
  // 「AABB」式（干干净净、马马虎虎、家家户户）：整词重复后紧跟另一个叠词，正常
  if (n >= 2 && n <= 4 && isAABBContext(text, at, word)) return { ok: false, reason: 'aabb' }
  // 前后紧跟"的/地/得/了/着"等，通常是正常搭配
  if (/[的地得着了过]$/.test(before)) return { ok: false, reason: 'particle-before' }
  return { ok: true, reason: 'word-repeat' }
}

/** AABB 结构检测：词重复的下一格如果与上一格成对（家家户户、清清楚楚），视为正常叠词 */
function isAABBContext(text: string, at: number, word: string): boolean {
  const n = word.length
  if (n !== 2) return false
  const a = word[0]
  const b = word[1]
  const tail = text.slice(at + 4, at + 6)
  // 形如 aabb：本处是 "abab"，后面还有 "ab" 或已构成 aabb 的 a、b 相叠
  if (a === b) return true
  return tail.length >= 2 && tail[0] === a && tail[1] === b
}

/**
 * 问题指纹：用「类型 + 片段 + 片段在全文中的第几次出现」做 id，**不用字符下标**。
 * 这样作者在上面补了一句话、删了一个字，同一处问题的 id 不会变，
 * 已经忽略的误报也不会因为位置偏移又冒出来。
 */
/** 片段在它之前出现过几次：用于同文多处相同问题时区分彼此 */
function countBefore(text: string, key: string, at: number): number {
  if (!key) return 0
  let n = 0
  let p = text.indexOf(key)
  while (p >= 0 && p < at) {
    n++
    p = text.indexOf(key, p + 1)
  }
  return n
}

function idOf(kind: ProofKind, key: string, ordinal = 0): string {
  return `${kind}:${key}:${ordinal}`
}

/** 同一处问题只报一次 */
function seen(set: Set<string>, key: string): boolean {
  if (set.has(key)) return true
  set.add(key)
  return false
}

/**
 * 纯本地校读：不调用模型，不联网，随打字随查。
 * 只查机器最擅长、人类最容易漏的那几类：混排标点、重复词、多余空格、引号不配。
 */
export function proofread(text: string): ProofIssue[] {
  const issues: ProofIssue[] = []
  const marks = new Set<string>()
  if (!text.trim()) return issues

  // 1. 中文段落里的半角标点
  for (const m of text.matchAll(HALF_PUNCT_IN_CJK)) {
    const ch = m[1] ?? m[2]
    if (!ch) continue
    const idx = m.index ?? 0
    // 匹配里带了中文邻居，所以要在 m[0] 内部定位那个半角标点，不能直接拿 m.index
    const inner = m[0].indexOf(ch)
    if (inner < 0) continue
    const at = idx + inner
    const snippet = text.slice(Math.max(0, at - 6), at + 8)
    if (seen(marks, `p-${at}`)) continue
    issues.push({
      id: idOf('punct', ch, countBefore(text, ch, at)),
      kind: 'punct',
      message: `中文里用了半角标点「${ch}」，应改为全角「${HALF_TO_FULL[ch]}」`,
      snippet,
      suggestion: HALF_TO_FULL[ch],
      // 精确到那一个半角标点，上下文原样保留
      range: { start: at, end: at + 1 }
    })
  }

  // 2. 中文字之间的多余空格。
  //    标题行（第 1 章 …）里的空格是排版习惯，正文里的空格才是笔误，
  //    所以这里只检查正文——传入的 text 已由调用方去掉标题。
  for (const m of text.matchAll(/[\u4e00-\u9fa5][ \t]+[\u4e00-\u9fa5]/g)) {
    const idx = m.index ?? 0
    // 只删中间那一段空白
    const gap = m[0].slice(1, m[0].length - 1)
    const at = idx + 1
    const snippet = text.slice(Math.max(0, idx - 6), idx + 8)
    if (seen(marks, `s-${at}`)) continue
    issues.push({
      id: idOf('space', ` ${gap} `, countBefore(text, ` ${gap} `, at)),
      kind: 'space',
      message: '中文字之间多了空格',
      snippet,
      suggestion: '',
      range: { start: at, end: at + gap.length }
    })
  }

  // 3. 重复词
  for (const m of text.matchAll(REPEAT_WORD)) {
    const word = m[1]
    if (!word) continue
    const at = m.index ?? 0
    const n = word.length

    // 三连及以上（"说说说""的的的"）：正则只吃到前两个字，往后看一位还剩同字即为手滑。
    // 三连在正常中文里不存在，一律报。
    const triple = text.slice(at + n * 2, at + n * 2 + n) === word
    if (triple) {
      if (seen(marks, `r-${at}-${word}`)) continue
      const snippet = text.slice(Math.max(0, at - 6), at + n * 3 + 6)
      issues.push({
        id: idOf('repeat', word.repeat(3), countBefore(text, word.repeat(3), at)),
        kind: 'repeat',
        message: `「${word.repeat(3)}」连续重复了三次`,
        snippet,
        suggestion: word,
        range: { start: at, end: at + n * 3 }
      })
      continue
    }

    const verdict = classifyRepeat(text, at, word)
    if (!verdict.ok) continue

    const snippet = text.slice(Math.max(0, at - 6), at + n * 2 + 6)
    if (seen(marks, `r-${at}-${word}`)) continue
    issues.push({
      id: idOf('repeat', word + word, countBefore(text, word + word, at)),
      kind: 'repeat',
      message: `「${word}${word}」疑似多打了一遍`,
      snippet,
      // 把这两遍压成一遍：直接给出精确区间，面板照着替换即可
      suggestion: word,
      range: { start: at, end: at + n * 2 }
    })
  }

  // 4. 引号不配对
  const opens = (text.match(/[“「]/g) ?? []).length
  const closes = (text.match(/[”」]/g) ?? []).length
  if (opens !== closes) {
    issues.push({
      id: 'quote:unbalanced',
      kind: 'quote',
      message: `引号数量不配对：开引号 ${opens} 个，闭引号 ${closes} 个`,
      snippet: '',
      suggestion: null
    })
  }

  return issues.slice(0, 200)
}

export interface ProofSummary {
  total: number
  byKind: Record<ProofKind, number>
  issues: ProofIssue[]
}

export function summarizeProof(text: string): ProofSummary {
  const issues = proofread(text)
  const byKind: Record<ProofKind, number> = { punct: 0, width: 0, repeat: 0, space: 0, quote: 0 }
  for (const i of issues) byKind[i.kind]++
  return { total: issues.length, byKind, issues }
}