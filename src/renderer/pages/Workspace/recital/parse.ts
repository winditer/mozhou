/**
 * 评书稿解析。
 *
 * 为什么容错写得这么啰嗦：模型对「四个方头括号标记」的遵守程度很低——常见的
 * 有加代码围栏、前面来一句「好的，以下是评书稿：」、把【正文】省掉直接写，
 * 或者干脆一个标记都没写。这些都不该让作者看到「解析失败」，而是尽量把能用的
 * 稿子捞出来，同时用 warnings 如实说明省了什么。
 *
 * 只有一个字都没有时才报错。把空稿落盘是最坏的结果：作者以为生成成功了，
 * 点开却是一片空白。
 */

export interface ParsedRecital {
  /** 回目名；模型没给就用章名兜底 */
  title: string
  /** 落盘与朗读用的全文：定场诗 + 正文 + 收尾，去掉所有标记，空行分段 */
  script: string
  /** 解析时做过的降级处理，界面上要如实告诉作者 */
  warnings: string[]
}

/** 空稿专用文案，界面直接显示这句 */
export const EMPTY_RECITAL_MESSAGE = '模型没给出评书稿'

type SectionName = '回目' | '定场诗' | '正文' | '收尾'

const NAMES = ['回目', '定场诗', '正文', '收尾'] as const

/**
 * 一次扫出两种写法：
 *  - 规范：【回目】… （也容忍【回目】：、** 【回目】 **）
 *  - 退化：行首的「回目：」「正文：」
 * 退化写法只在行首认，否则正文里随便一句「他说正文里写了」就会被当成段落标记。
 */
const MARKER_RE = new RegExp(
  [
    '(?:[ \\t>*#_`-]*【[ \\t]*(' + NAMES.join('|') + ')[ \\t]*】[ \\t]*[:：]?)',
    '(?:^[ \\t>*#_`-]*(' + NAMES.join('|') + ')[ \\t]*[:：])'
  ].join('|'),
  'gm'
)

interface Segment {
  name: SectionName
  body: string
}

/** 去掉代码围栏行（保留内容）与 \r，围栏最常出现在模型「贴心地」包一层 json 时 */
function stripFences(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/^[ \t]*(```|~~~)[^\n]*$/gm, '')
}

function scan(text: string): { preamble: string; segments: Segment[] } {
  const hits: { name: SectionName; start: number; end: number }[] = []
  MARKER_RE.lastIndex = 0
  for (let m = MARKER_RE.exec(text); m; m = MARKER_RE.exec(text)) {
    const name = (m[1] ?? m[2]) as SectionName | undefined
    if (!name) continue
    let end = m.index + m[0].length
    const nl = text.indexOf('\n', end)
    // 标记独占一行时，内容从下一行开始；否则同一行后面就是内容（【回目】第七回 灰线尽头）
    if (nl !== -1 && text.slice(end, nl).trim() === '') end = nl + 1
    hits.push({ name, start: m.index, end })
    // 防止零长度匹配把 exec 卡死（极端输入下的保险，正常匹配都吃掉了冒号或括号）
    if (m[0].length === 0) MARKER_RE.lastIndex++
  }
  if (!hits.length) return { preamble: text, segments: [] }

  const preamble = text.slice(0, hits[0].start)
  const segments: Segment[] = hits.map((h, i) => {
    const next = hits[i + 1]
    return { name: h.name, body: text.slice(h.end, next ? next.start : text.length).trim() }
  })
  return { preamble, segments }
}

/** 同名标记出现多次时（模型自我重复）全并上，别把后半篇稿子截断 */
function bodies(segments: Segment[], name: SectionName): string[] {
  return segments
    .filter((s) => s.name === name)
    .map((s) => s.body.trim())
    .filter(Boolean)
}

/** 清掉标题行上的装饰（#、**、【】、引号、重复的「回目：」） */
function cleanTitle(line: string): string {
  return line
    .split('\n')[0]
    .replace(/^[ \t>*#_`-]+/, '')
    .replace(/\*+/g, '')
    .replace(/^[《【「『]+/, '')
    .replace(/[》】」』]+$/, '')
    .replace(/^回目[ \t]*[:：][ \t]*/, '')
    .replace(/[，,。；;、]+$/, '')
    .trim()
}

/**
 * 模型讲完书爱补一句「希望您喜欢」「以上是本章评书稿」。
 * 这些话要是留在稿子里，导出会带上、朗读还会念出来，所以按抬头词掐掉。
 * 只掐收尾之后的部分，正文里正常出现「希望」不受影响。
 */
const CHATTER_HEAD = /^(希望|以上|如需|如果|若有|需要我|祝|感谢|谢谢|满意|好的|当然|另外|备注|注[:：]|[（(]注|字数|全文约|本章评书)/

function trimChatter(text: string): { text: string; cut: boolean } {
  const lines = text.split('\n')
  const keep: string[] = []
  let cut = false
  for (let i = 0; i < lines.length; i++) {
    // 第一行一定是收尾本身，不做判断，免得把「希望你好好的」这句正经落句掐掉
    if (i > 0 && CHATTER_HEAD.test(lines[i].trim())) {
      cut = true
      break
    }
    keep.push(lines[i])
  }
  return { text: keep.join('\n').trim(), cut }
}

export function parseRecital(raw: string, chapterTitle: string): ParsedRecital {
  const warnings: string[] = []
  const text = stripFences(raw ?? '').trim()
  if (!text) throw new Error(EMPTY_RECITAL_MESSAGE)

  const { preamble, segments } = scan(text)

  // 没有任何标记：整篇当正文，标题用章名。这是唯一不丢内容的处理方式。
  if (!segments.length) {
    warnings.push('模型没按【回目】【正文】分段，已把全部内容当正文')
    if (!preamble.trim()) throw new Error(EMPTY_RECITAL_MESSAGE)
    return {
      title: cleanTitle(chapterTitle) || chapterTitle,
      script: preamble.trim(),
      warnings
    }
  }

  // 标记之前的话（「好的，以下是评书稿」）丢掉，但要说一声
  if (preamble.trim()) warnings.push('已忽略【回目】之前多出来的文字')

  const titleSource = bodies(segments, '回目')[0] ?? ''
  let title = cleanTitle(titleSource)
  if (!title) {
    title = cleanTitle(chapterTitle) || chapterTitle
    warnings.push('模型没给出回目，已用章名代替')
  }

  const poet = bodies(segments, '定场诗').join('\n\n').trim()
  if (!poet) warnings.push('模型没给出【定场诗】，这段开场空着')

  let body = bodies(segments, '正文').join('\n\n').trim()

  const endingParas = bodies(segments, '收尾')
  let ending = endingParas.join('\n\n').trim()
  if (endingParas.length > 1) {
    // 收尾按契约就一句；后面再起一段，多半是「希望您喜欢」之类的客套
    ending = endingParas[0]
    warnings.push('【收尾】之后多出来的文字已忽略')
  }
  if (ending) {
    const trimmed = trimChatter(ending)
    ending = trimmed.text
    if (trimmed.cut) warnings.push('【收尾】后面的客套话已忽略')
  }

  if (!body) {
    // 没写【正文】标记：定场诗那一块很可能「诗 + 正文」混在一起，把首行当诗
    const poetBlock = bodies(segments, '定场诗').join('\n\n').trim()
    const lines = poetBlock.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length > 1) {
      body = lines.slice(1).join('\n')
      warnings.push('模型没写【正文】标记，已把定场诗之后的内容当正文')
    }
    if (!body) {
      // 再退一步：除了回目与收尾，剩下的所有内容都当正文。
      // 回目那一块本身可能「回目 + 正文」挤在一起，首行已经当过标题了，取它后面的行。
      body = segments
        .filter((s) => s.name !== '收尾')
        .map((s) => (s.name === '回目' ? s.body.split('\n').slice(1).join('\n') : s.body))
        .join('\n\n')
        .trim()
      if (body) warnings.push('模型没写【正文】标记，已把剩余文字当正文')
    }
  }

  const parts = [poet, body, ending].filter((p) => p && p.trim())
  const script = parts.join('\n\n').trim()
  if (!script) throw new Error(EMPTY_RECITAL_MESSAGE)

  return { title, script, warnings }
}