/**
 * 导出模块统一入口
 *
 * 章节正文以 HTML（Tiptap 富文本）保存在本地，这里把多章合并成一份文稿，
 * 支持 Markdown / TXT / HTML / DOCX / PDF 五种格式。
 */
import { buildHtmlDocument } from './html'
import { renderDocx } from './docx'
import { renderMarkdown } from './markdown'
import { renderPdf } from './pdf'
import { renderText } from './text'

/** 待导出的一章 */
export interface ExportItem {
  title: string
  content: string // HTML
}

/** buildHtml 的排版选项 */
export interface ExportHtmlOptions {
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
}

/** 生成 Markdown 文稿 */
export function buildMarkdown(title: string, items: ExportItem[]): string {
  return renderMarkdown(title, items)
}

/** 生成纯文本文稿 */
export function buildText(title: string, items: ExportItem[]): string {
  return renderText(title, items)
}

/** 生成完整的 HTML 文档（用于 .html 导出与 PDF 打印） */
export function buildHtml(title: string, items: ExportItem[], opts?: ExportHtmlOptions): string {
  return buildHtmlDocument(title, items, opts)
}

/** 生成 .docx 二进制 */
export async function buildDocx(title: string, items: ExportItem[]): Promise<Buffer> {
  return renderDocx(title, items)
}

/** 把 HTML 文档打印成 PDF 二进制 */
export async function buildPdf(html: string): Promise<Buffer> {
  return renderPdf(html)
}