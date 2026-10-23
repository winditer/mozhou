/**
 * Markdown 导出
 *
 * 用 turndown 把每章 HTML 转成 Markdown，再按「书名 → 日期 → 章节」的
 * 结构拼成一份完整文稿。
 */
import TurndownService from 'turndown'
import { formatExportDate, stripDuplicateTitle } from './html'

/** 单章数据（与 index.ts 的 ExportItem 结构一致） */
export interface MarkdownChapter {
  title: string
  content: string
}

/** 空段落（含只有 <br> / &nbsp; 的段落）——作者用它表示空行 */
const EMPTY_PARAGRAPH_RE = /<p\b[^>]*>(?:\s|<br\b[^>]*>|&nbsp;|\u00A0)*<\/p>/gi
/** 零宽空格：让空段落在 Markdown 里留下一个不会被清洗掉的空行 */
const BLANK_MARK = '\u200B'

/**
 * turndown 会把「空白节点」直接交给 blankReplacement（自定义规则来不及生效），
 * 所以先给空段落塞一个零宽空格，让它作为一个正常段落进入规则流程。
 */
function markEmptyParagraphs(html: string): string {
  return html.replace(EMPTY_PARAGRAPH_RE, `<p>${BLANK_MARK}</p>`)
}

/** 组装 turndown 服务：统一标题/代码块/列表符号 */
function createService(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    hr: '---'
  })

  // 空 <p></p>（已被标记）→ 一个空行
  service.addRule('blankParagraph', {
    filter: (node) => node.nodeName === 'P' && node.textContent !== null && node.textContent.includes(BLANK_MARK),
    replacement: () => `\n\n${BLANK_MARK}\n\n`
  })

  // 脚本与样式没有任何正文价值
  service.remove(['script', 'style', 'noscript'])
  return service
}

/** 收尾：统一列表缩进、压掉多余空行 */
function tidy(markdown: string): string {
  return markdown
    // turndown 默认把列表符号和正文对齐（"-   xxx"），这里统一成 "- xxx" / "1. xxx"
    .replace(/^([ \t]*)[-*+][ \t]{2,}/gm, '$1- ')
    .replace(/^([ \t]*)(\d+\.)[ \t]{2,}/gm, '$1$2 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 生成 Markdown 文稿 */
export function renderMarkdown(title: string, items: readonly MarkdownChapter[]): string {
  const service = createService()
  const head = `# ${title}\n\n> 由墨舟 Mozhou 导出 · ${formatExportDate()}`

  const chapters = items.map((item) => {
    const source = stripDuplicateTitle(item.content ?? '', item.title)
    const markdown = tidy(service.turndown(markEmptyParagraphs(source)))
    return markdown === '' ? `## ${item.title}` : `## ${item.title}\n\n${markdown}`
  })

  return `${[head, ...chapters].join('\n\n---\n\n')}\n`
}