/**
 * 正文 HTML 与段落之间的那点事。
 *
 * 原本这套函数长在 `Workspace/audit/apply.ts` 里（体检改写用），
 * 对话改稿要按 anchor 回正文定位段落，用的是**同一套**切段规则——
 * 两处各写一份，迟早出现「体检能定位到、对话定位不到」这种莫名其妙的分叉。
 * 所以抽到这里，apply.ts 改为 re-export，既有 import 一行没动。
 *
 * 只认块级标签（p / div / h1-h6 / li / blockquote）：正文是这台编辑器产出的，
 * 结构就是这一套；用完整 DOM 解析反而会在渲染进程里引入额外依赖。
 */

/** 正文按 <p> 切段后的一个段落 */
export interface BodyParagraph {
  /** 在原始 HTML 里的起止位置，用来原位替换 */
  start: number
  end: number
  /** 段落纯文本（已去掉标签） */
  text: string
  /** 完整 HTML 片段（含 <p> 标签） */
  html: string
}

const HTML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => HTML_ESCAPE[c] as string)
}

export function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/**
 * 把章节 HTML 切成段落，保留每段在原串里的位置。
 *
 * 空段（纯 <br> 之类）不参与定位，但位置照样记着，替换时不会错位。
 */
export function splitParagraphs(html: string): BodyParagraph[] {
  const out: BodyParagraph[] = []
  const re = /<(p|div|h[1-6]|li|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const whole = m[0]
    const inner = whole.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '')
    const text = unescapeHtml(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    out.push({ start: m.index, end: m.index + whole.length, text, html: whole })
  }
  return out
}

/** 归一化：去掉空白与常见标点差异，好让「摘录」和「原文」对得上 */
export function normalizeText(s: string): string {
  return s
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？“”‘’（）《》〈〉—…·,.!?;:"'()\[\]<>]/g, '')
}

/** 段落的纯文本是否「够得上」anchor：精确包含，或归一化后包含 */
export function paragraphMatches(paragraphText: string, anchor: string): 'exact' | 'normalized' | null {
  const a = String(anchor ?? '').trim()
  if (!a) return null
  if (paragraphText.includes(a)) return 'exact'
  const na = normalizeText(a)
  if (na && normalizeText(paragraphText).includes(na)) return 'normalized'
  return null
}

/** 纯文本转一个 <p> 段落（转义后包一层），插入正文时用 */
/**
 * 纯文本 → 正文 HTML。
 *
 * 空行/单换行都当分段：模型写多段改写时会用 `\n\n`（或者干脆一行一段），
 * 早期把换行压成空格，结果三段并成一大段——作者看到的是「AI 把段落合并了」。
 * 中文小说里一行就是一段，按行切不会切错。
 */
export function textToParagraph(text: string): string {
  const text2 = String(text ?? '').trim()
  if (!text2) return ''
  const lines = text2
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
}