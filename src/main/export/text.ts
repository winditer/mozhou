/**
 * 纯文本导出
 *
 * 书名与章标题用固定分隔线装饰，正文由 htmlToText 生成（段落之间空一行）。
 */
import { htmlToText, stripDuplicateTitle } from './html'

/** 单章数据（与 index.ts 的 ExportItem 结构一致） */
export interface TextChapter {
  title: string
  content: string
}

/** 固定长度的装饰线 */
const RULE = '='.repeat(40)

/** 生成 TXT 文稿 */
export function renderText(title: string, items: readonly TextChapter[]): string {
  const lines: string[] = [title, RULE, '']

  for (const item of items) {
    lines.push(item.title, '')
    // 正文开头若重复了章标题先去掉；多个空段落压成最多两个空行
    const body = htmlToText(stripDuplicateTitle(item.content ?? '', item.title))
      .replace(/\n{4,}/g, '\n\n\n')
      .trim()
    if (body !== '') {
      lines.push(body, '')
    }
  }

  // 收尾分隔线
  lines.push(RULE, '')
  return lines.join('\n')
}