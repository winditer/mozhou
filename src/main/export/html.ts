/**
 * HTML 处理工具（主进程使用，不依赖 DOM）
 *
 * 章节正文是 Tiptap 生成的富文本 HTML。这里用「正则分词 + 标签栈」做一次
 * 轻量扫描：既能拿到纯文本，也能拿到带行内样式的段落块（供 docx 使用），
 * 不引入 jsdom 之类的新依赖，遇到脏 HTML 也不会抛错（最多降级）。
 */

/* ────────────────────────────── 对外类型 ────────────────────────────── */

export type Run = {
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
}

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string; runs: Run[] }
  | { type: 'paragraph'; text: string; runs: Run[] }
  | { type: 'bullet'; text: string; runs: Run[] }
  | { type: 'ordered'; text: string; runs: Run[] }
  | { type: 'quote'; text: string; runs: Run[] }
  | { type: 'hr' }

/* ────────────────────────────── 实体与转义 ────────────────────────────── */

/** 常用命名实体；未命中的实体原样保留，避免吃掉作者内容 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  middot: '\u00B7',
  bull: '\u2022',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  times: '\u00D7',
  divide: '\u00F7',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  deg: '\u00B0',
  plusmn: '\u00B1'
}

/** 解码 HTML 实体：命名实体 + 十进制/十六进制数字实体 */
export function decodeEntities(s: string): string {
  if (!s) return ''
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole: string, body: string) => {
    if (body.charAt(0) === '#') {
      const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X'
      const digits = isHex ? body.slice(2) : body.slice(1)
      const code = Number.parseInt(digits, isHex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()]
    return hit ?? whole
  })
}

/** 反转义：把文本安全地放进 HTML 文本节点 / 属性值 */
export function escapeHtml(s: string): string {
  if (!s) return ''
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 导出用的本地日期，形如 2026-10-22 */
export function formatExportDate(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 去掉正文开头与章标题重复的 <h1>。
 * Tiptap 正文里常把章标题也存成 h1，导出时会和「章标题」重复一次。
 */
export function stripDuplicateTitle(html: string, title: string): string {
  if (!html) return ''
  const m = /^\s*<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  if (!m) return html
  const text = decodeEntities(m[1].replace(/<[^>]*>/g, '')).trim()
  if (text === '' || text !== title.trim()) return html
  return html.slice(m[0].length)
}

/* ────────────────────────────── 扫描器内部结构 ────────────────────────────── */

type HeadingLevel = 1 | 2 | 3 | 4
type BlockKind = 'heading' | 'paragraph' | 'bullet' | 'ordered' | 'quote'

/** 扫描过程中的半成品段落 */
interface DraftBlock {
  kind: BlockKind
  level?: HeadingLevel
  runs: Run[]
  /** 是否由显式块级标签（<p>/<li>/<h1>…）开启，用于保留作者的空白行 */
  explicit: boolean
}

interface Flags {
  bold: boolean
  italic: boolean
  strike: boolean
  code: boolean
}

/** 逐个匹配注释、声明、标签、文本 */
const TOKEN_RE = /<!--[\s\S]*?-->|<![^>]*>|<[^>]*>|[^<]+/g
/** 标签名（不解析属性，属性对导出没有意义） */
const TAG_RE = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)/

/** 自闭合 / 空元素 */
const VOID_TAGS = new Set([
  'br',
  'hr',
  'img',
  'input',
  'meta',
  'link',
  'source',
  'col',
  'area',
  'base',
  'embed',
  'param',
  'track',
  'wbr'
])

/** 只起换行作用、自身无内容的块级标签 */
const BLOCK_TAGS = new Set([
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'figure',
  'figcaption',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'dl',
  'dt',
  'dd',
  'address',
  'center',
  'form',
  'fieldset'
])

/** 需要连同内容一起丢掉的标签 */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template'])

/* ────────────────────────────── 扫描实现 ────────────────────────────── */

/** 解析标签 token，失败返回 null（当作文本处理） */
function parseTag(token: string): { closing: boolean; name: string; selfClosing: boolean } | null {
  const m = TAG_RE.exec(token)
  if (!m) return null
  const name = m[2].toLowerCase()
  return {
    closing: m[1] === '/',
    name,
    selfClosing: token.endsWith('/>') || VOID_TAGS.has(name)
  }
}

/** 从标签栈推导当前文本的行内样式 */
function flagsFromStack(stack: readonly string[]): Flags {
  const flags: Flags = { bold: false, italic: false, strike: false, code: false }
  for (const name of stack) {
    if (name === 'strong' || name === 'b') flags.bold = true
    else if (name === 'em' || name === 'i') flags.italic = true
    else if (name === 's' || name === 'del' || name === 'strike') flags.strike = true
    else if (name === 'code' || name === 'kbd' || name === 'samp') flags.code = true
  }
  return flags
}

/** 样式相同则合并，减少 run 数量 */
function sameFlags(run: Run, flags: Flags): boolean {
  return Boolean(run.bold) === flags.bold && Boolean(run.italic) === flags.italic && Boolean(run.strike) === flags.strike && Boolean(run.code) === flags.code
}

function pushRun(block: DraftBlock, text: string, flags: Flags): void {
  if (!text) return
  const last = block.runs[block.runs.length - 1]
  if (last && sameFlags(last, flags)) {
    last.text += text
    return
  }
  const run: Run = { text }
  if (flags.bold) run.bold = true
  if (flags.italic) run.italic = true
  if (flags.strike) run.strike = true
  if (flags.code) run.code = true
  block.runs.push(run)
}

/** 去掉块首尾的空白（HTML 里的缩进换行不应变成正文空白） */
function trimRuns(runs: readonly Run[]): Run[] {
  const out = runs.map((r) => ({ ...r }))
  while (out.length > 0 && out[0].text.trim() === '') out.shift()
  while (out.length > 0 && out[out.length - 1].text.trim() === '') out.pop()
  if (out.length === 0) return []
  out[0].text = out[0].text.replace(/^\s+/, '')
  const last = out.length - 1
  out[last].text = out[last].text.replace(/\s+$/, '')
  return out.filter((r) => r.text !== '')
}

/** 栈式扫描：把 HTML 拆成 Block 序列 */
function scan(html: string): Block[] {
  const blocks: Block[] = []
  /** 已打开的标签名，用于行内样式判定与容错弹栈 */
  const stack: string[] = []
  /** 列表栈，用于区分 ul / ol */
  const lists: Array<'ul' | 'ol'> = []
  let current: DraftBlock | null = null
  let quoteDepth = 0
  /** <pre> 内的文本要保留原始换行，不折叠空白 */
  let preDepth = 0
  let skipping: string | null = null

  const openBlock = (kind: BlockKind, level?: HeadingLevel): void => {
    // 引用块内的段落/标题统一用引用样式（列表项保留自己的类型）
    const inQuote = quoteDepth > 0 && lists.length === 0
    const resolved: BlockKind = inQuote && (kind === 'paragraph' || kind === 'heading') ? 'quote' : kind
    current = { kind: resolved, level, runs: [], explicit: true }
  }

  const flush = (): void => {
    const block = current
    current = null
    if (!block) return
    const runs = trimRuns(block.runs)
    const text = runs.map((r) => r.text).join('')
    if (text === '') {
      // 空段落是作者主动留的空行，必须保留；其它空块直接丢弃
      if (block.kind === 'paragraph' && block.explicit) {
        blocks.push({ type: 'paragraph', text: '', runs: [] })
      }
      return
    }
    switch (block.kind) {
      case 'heading':
        blocks.push({ type: 'heading', level: block.level ?? 1, text, runs })
        break
      case 'bullet':
        blocks.push({ type: 'bullet', text, runs })
        break
      case 'ordered':
        blocks.push({ type: 'ordered', text, runs })
        break
      case 'quote':
        blocks.push({ type: 'quote', text, runs })
        break
      default:
        blocks.push({ type: 'paragraph', text, runs })
    }
  }

  const appendText = (raw: string): void => {
    if (!raw) return
    // <pre> 里保持原样；其余按 HTML 规则折叠空白
    const text = preDepth > 0 ? raw : raw.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ')
    if (!text) return
    const block = current
    if (block) {
      pushRun(block, text, flagsFromStack(stack))
      return
    }
    // 没有块级标签包裹的裸文本，隐式开一个段落
    if (text.trim() === '') return
    const draft: DraftBlock = { kind: quoteDepth > 0 ? 'quote' : 'paragraph', runs: [], explicit: false }
    current = draft
    pushRun(draft, text, flagsFromStack(stack))
  }

  const appendBreak = (): void => {
    const block = current
    if (!block) return
    pushRun(block, '\n', { bold: false, italic: false, strike: false, code: preDepth > 0 })
  }

  const popTag = (name: string): void => {
    const idx = stack.lastIndexOf(name)
    if (idx >= 0) stack.length = idx
  }

  for (const token of html.match(TOKEN_RE) ?? []) {
    if (skipping) {
      if (token.charAt(0) === '<' && token.charAt(1) === '/') {
        const parsed = parseTag(token)
        if (parsed && parsed.name === skipping) skipping = null
      }
      continue
    }
    if (token.charAt(0) !== '<') {
      appendText(decodeEntities(token))
      continue
    }
    if (token.startsWith('<!--') || token.startsWith('<!')) continue

    const tag = parseTag(token)
    if (!tag) {
      appendText(decodeEntities(token))
      continue
    }
    const { name, closing, selfClosing } = tag

    if (closing) {
      switch (name) {
        case 'p':
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
        case 'li':
          flush()
          break
        case 'blockquote':
          flush()
          if (quoteDepth > 0) quoteDepth -= 1
          break
        case 'pre':
          flush()
          if (preDepth > 0) preDepth -= 1
          break
        case 'ul':
        case 'ol':
          flush()
          lists.pop()
          break
        case 'td':
        case 'th':
          appendText(' ')
          break
        default:
          if (BLOCK_TAGS.has(name)) flush()
      }
      popTag(name)
      continue
    }

    switch (name) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4': {
        flush()
        openBlock('heading', Number(name.charAt(1)) as HeadingLevel)
        break
      }
      case 'h5':
      case 'h6': {
        // 只有四级标题，降级为普通段落
        flush()
        openBlock('paragraph')
        break
      }
      case 'p': {
        flush()
        openBlock('paragraph')
        break
      }
      case 'li': {
        flush()
        openBlock(lists[lists.length - 1] === 'ol' ? 'ordered' : 'bullet')
        break
      }
      case 'ul':
      case 'ol': {
        flush()
        lists.push(name === 'ol' ? 'ol' : 'ul')
        break
      }
      case 'blockquote': {
        flush()
        quoteDepth += 1
        break
      }
      case 'pre': {
        flush()
        preDepth += 1
        openBlock('paragraph')
        break
      }
      case 'hr': {
        flush()
        blocks.push({ type: 'hr' })
        break
      }
      case 'br': {
        appendBreak()
        break
      }
      case 'td':
      case 'th': {
        appendText(' ')
        break
      }
      case 'img': {
        // 图片不参与文本导出，保留 alt 文案以免丢信息
        const alt = /\balt\s*=\s*"([^"]*)"/i.exec(token)?.[1]
        if (alt) appendText(`[${alt}]`)
        break
      }
      default:
        if (SKIP_TAGS.has(name)) {
          skipping = name
          break
        }
        if (BLOCK_TAGS.has(name)) flush()
    }
    if (!selfClosing) stack.push(name)
  }

  flush()
  return blocks
}

/* ────────────────────────────── 对外接口 ────────────────────────────── */

/** HTML → Block[]，供 docx 生成真正带样式的段落 */
export function htmlToBlocks(html: string): Block[] {
  if (typeof html !== 'string' || html.trim() === '') return []
  return scan(html)
}

/** 给无序/有序/引用块的续行加前缀 */
function prefixLines(text: string, first: string, rest: string): string {
  const lines = text.split('\n')
  return lines.map((line, i) => `${i === 0 ? first : rest}${line}`).join('\n')
}

/** 单个块 → 纯文本行（列表/引用块带前缀） */
function renderBlock(block: Block, orderedIndex: number): string {
  switch (block.type) {
    case 'hr':
      return '---'
    case 'bullet':
      return prefixLines(block.text, '- ', '  ')
    case 'ordered':
      return prefixLines(block.text, `${orderedIndex}. `, '   ')
    case 'quote':
      return prefixLines(block.text, '    ', '    ')
    default:
      return block.text
  }
}

/** HTML → 纯文本：块级元素转换行，段落之间空一行，列表项之间紧凑排列 */
export function htmlToText(html: string): string {
  const blocks = htmlToBlocks(html)
  let out = ''
  let previous: Block['type'] | null = null
  let orderedIndex = 0

  for (const block of blocks) {
    orderedIndex = block.type === 'ordered' ? orderedIndex + 1 : 0
    // 同类列表项、连续引用之间只换行，不空行
    const tight = block.type === previous && (block.type === 'bullet' || block.type === 'ordered' || block.type === 'quote')
    const separator = out === '' ? '' : tight ? '\n' : '\n\n'
    out += separator + renderBlock(block, orderedIndex)
    previous = block.type
  }

  // 空段落最多留两个空行，避免导出后出现大片空白
  return out.replace(/\n{4,}/g, '\n\n\n')
}

/* ────────────────────────────── 完整 HTML 文档 ────────────────────────────── */

/** 单章数据（与 index.ts 的 ExportItem 结构一致） */
export interface HtmlChapter {
  title: string
  content: string
}

/** buildHtml 的排版选项 */
export interface HtmlStyleOptions {
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
}

/**
 * 生成用于 PDF 打印 / .html 导出的完整 HTML 文档。
 * 打印边距交给 printToPDF 的 margins 参数，因此 @page margin 保持 0，
 * 仅在屏幕阅读时用 .book 容器提供留白。
 */
export function buildHtmlDocument(title: string, chapters: readonly HtmlChapter[], opts: HtmlStyleOptions = {}): string {
  const fontFamily = opts.fontFamily ?? '"Songti SC","Noto Serif SC",serif'
  const fontSize = opts.fontSize ?? 16
  const lineHeight = opts.lineHeight ?? 1.9
  const meta = `由墨舟 Mozhou 导出 · ${formatExportDate()}`

  const css = `
    @page { size: A4; margin: 0 }
    * { box-sizing: border-box }
    html, body { margin: 0; padding: 0; background: #ffffff }
    body {
      color: #1a1a1a;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .book { max-width: 820px; margin: 0 auto; padding: 56px 64px }
    .book-title {
      margin: 0;
      font-family: ${fontFamily};
      font-size: 30px;
      font-weight: 700;
      line-height: 1.45;
      letter-spacing: 0.08em;
      text-align: center;
      word-break: break-word;
    }
    .book-meta {
      margin: 12px 0 0;
      text-align: center;
      font-size: 13px;
      letter-spacing: 0.04em;
      color: #8a8a8a;
    }
    .book-divider {
      height: 0;
      margin: 30px 0 40px;
      border: 0;
      border-top: 1px solid #dcdcdc;
    }
    .chapter {
      font-family: ${fontFamily};
      font-size: ${fontSize}px;
      line-height: ${lineHeight};
      text-align: justify;
      text-justify: inter-ideograph;
      orphans: 2;
      widows: 2;
    }
    .chapter-title {
      margin: 0 0 1.2em;
      font-family: ${fontFamily};
      font-size: 1.35em;
      font-weight: 700;
      line-height: 1.5;
      letter-spacing: 0.06em;
      text-align: center;
      break-before: page;
      page-break-before: always;
    }
    .chapter.first .chapter-title {
      break-before: auto;
      page-break-before: auto;
    }
    .chapter-body > *:first-child { margin-top: 0 }
    .chapter-body p {
      margin: 0 0 0.6em;
      text-indent: 2em;
      orphans: 2;
      widows: 2;
    }
    .chapter-body p:empty { height: 1em; text-indent: 0 }
    .chapter-body h1,
    .chapter-body h2,
    .chapter-body h3,
    .chapter-body h4 {
      margin: 1.2em 0 0.6em;
      font-weight: 700;
      text-align: left;
      text-indent: 0;
      break-after: avoid;
      page-break-after: avoid;
    }
    .chapter-body blockquote {
      margin: 0.8em 0;
      padding: 0.2em 0 0.2em 1em;
      border-left: 3px solid #d0d0d0;
      color: #555555;
      text-indent: 0;
    }
    .chapter-body blockquote p { text-indent: 0 }
    .chapter-body ul,
    .chapter-body ol { margin: 0.4em 0 0.8em; padding-left: 1.8em }
    .chapter-body li { margin: 0.2em 0; text-indent: 0 }
    .chapter-body hr { margin: 1.6em 0; border: 0; border-top: 1px solid #e2e2e2 }
    .chapter-body code {
      font-family: "SF Mono", Menlo, Consolas, "Courier New", monospace;
      font-size: 0.92em;
    }
    .chapter-body pre {
      margin: 0.8em 0;
      padding: 0.8em 1em;
      background: #f6f6f6;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
      text-indent: 0;
    }
    .chapter-body pre code { font-size: 0.9em }
    .chapter-body strong { font-weight: 700 }
    @media print {
      body { background: #ffffff }
      .book { max-width: none; width: auto; margin: 0; padding: 0 }
    }
  `

  const sections = chapters
    .map((chapter, index) => {
      const cls = index === 0 ? 'chapter first' : 'chapter'
      return `    <section class="${cls}">
      <h2 class="chapter-title">${escapeHtml(chapter.title)}</h2>
      <div class="chapter-body">${stripDuplicateTitle(chapter.content ?? '', chapter.title)}</div>
    </section>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${css}</style>
</head>
<body>
  <article class="book">
    <h1 class="book-title">${escapeHtml(title)}</h1>
    <p class="book-meta">${escapeHtml(meta)}</p>
    <hr class="book-divider">
${sections}
  </article>
</body>
</html>
`
}