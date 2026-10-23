/**
 * DOCX 导出
 *
 * 用 docx 生成真正的 Word 文档：标题页 + 每章另起一页 + 中文排版
 * （宋体正文 / 黑体标题 / 1.5 倍行距 / 首行缩进 2 字符）。
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun
} from 'docx'
import { formatExportDate, htmlToBlocks, stripDuplicateTitle, type Block, type Run } from './html'

/** 单章数据（与 index.ts 的 ExportItem 结构一致） */
export interface DocxChapter {
  title: string
  content: string
}

/* docx 的 run.font 支持 { ascii, hAnsi, eastAsia }，可以直接指定中文字体，
 * 因此下面这些常量不需要 as any。 */
const BODY_FONT = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '宋体' }
const HEADING_FONT = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '黑体' }
const CODE_FONT = { ascii: 'Courier New', hAnsi: 'Courier New', eastAsia: '宋体' }

/** 字号以「半磅」为单位：24 = 12pt */
const BODY_SIZE = 24
/** 行距 1.5 倍 = 360（twips） */
const LINE_SPACING = 360
/** 首行缩进 2 字符 = 480（twips） */
const FIRST_LINE_INDENT = 480
/** 有序列表的编号引用名 */
const ORDERED_REFERENCE = 'mozhou-ordered'

/** 章内小标题的样式：级别 → Word 样式 + 字号 */
const INNER_HEADING: Record<1 | 2 | 3 | 4, { heading: (typeof HeadingLevel)[keyof typeof HeadingLevel]; size: number }> = {
  1: { heading: HeadingLevel.HEADING_2, size: 30 },
  2: { heading: HeadingLevel.HEADING_3, size: 28 },
  3: { heading: HeadingLevel.HEADING_4, size: 26 },
  4: { heading: HeadingLevel.HEADING_4, size: 26 }
}

interface RunStyle {
  font?: typeof BODY_FONT
  size?: number
  bold?: boolean
  italics?: boolean
}

/** Block 的 runs → docx TextRun（保留加粗/斜体/删除线/等宽，换行转成分行符） */
function runsToTextRuns(runs: readonly Run[], style: RunStyle = {}): TextRun[] {
  const font = style.font ?? BODY_FONT
  const size = style.size ?? BODY_SIZE
  const out: TextRun[] = []

  for (const run of runs) {
    const lines = run.text.split('\n')
    lines.forEach((line, index) => {
      if (index > 0) out.push(new TextRun({ break: 1 }))
      if (line === '') return
      out.push(
        new TextRun({
          text: line,
          bold: style.bold === true || run.bold === true,
          italics: style.italics === true || run.italic === true,
          strike: run.strike === true,
          font: run.code === true ? CODE_FONT : font,
          size
        })
      )
    })
  }

  // 空段落也要有一个 run，Word 才会把它当一行空行渲染
  return out.length > 0 ? out : [new TextRun({ text: '', font, size, bold: style.bold, italics: style.italics })]
}

/** 章节正文块 → 段落数组 */
function blocksToParagraphs(blocks: readonly Block[], chapterIndex: number): Paragraph[] {
  const paragraphs: Paragraph[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const conf = INNER_HEADING[block.level]
        paragraphs.push(
          new Paragraph({
            heading: conf.heading,
            spacing: { before: 240, after: 120, line: LINE_SPACING },
            keepNext: true,
            children: [new TextRun({ text: block.text, bold: true, font: HEADING_FONT, size: conf.size })]
          })
        )
        break
      }
      case 'paragraph': {
        if (block.text === '') {
          // 作者手动留出的空行
          paragraphs.push(
            new Paragraph({
              spacing: { line: LINE_SPACING },
              children: [new TextRun({ text: '', font: BODY_FONT, size: BODY_SIZE })]
            })
          )
          break
        }
        paragraphs.push(
          new Paragraph({
            alignment: AlignmentType.BOTH,
            spacing: { line: LINE_SPACING },
            indent: { firstLine: FIRST_LINE_INDENT },
            children: runsToTextRuns(block.runs)
          })
        )
        break
      }
      case 'bullet': {
        paragraphs.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { line: LINE_SPACING },
            children: runsToTextRuns(block.runs)
          })
        )
        break
      }
      case 'ordered': {
        paragraphs.push(
          new Paragraph({
            // instance 让每章的有序列表各自从 1 开始
            numbering: { reference: ORDERED_REFERENCE, level: 0, instance: chapterIndex + 1 },
            spacing: { line: LINE_SPACING },
            children: runsToTextRuns(block.runs)
          })
        )
        break
      }
      case 'quote': {
        paragraphs.push(
          new Paragraph({
            spacing: { before: 120, after: 120, line: LINE_SPACING },
            indent: { left: 480 },
            border: {
              left: { style: BorderStyle.SINGLE, size: 12, color: 'BFBFBF', space: 8 }
            },
            children: runsToTextRuns(block.runs, { italics: true })
          })
        )
        break
      }
      case 'hr': {
        paragraphs.push(new Paragraph({ thematicBreak: true, spacing: { before: 120, after: 120 } }))
        break
      }
    }
  }

  return paragraphs
}

/** 生成 .docx 二进制 */
export async function renderDocx(title: string, items: readonly DocxChapter[]): Promise<Buffer> {
  const children: Paragraph[] = [
    // ── 标题页 ──
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { before: 1200, after: 240 },
      children: [new TextRun({ text: title, bold: true, font: HEADING_FONT, size: 56 })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 480 },
      children: [new TextRun({ text: `由墨舟 Mozhou 导出 · ${formatExportDate()}`, font: BODY_FONT, size: 22, color: '888888' })]
    })
  ]

  items.forEach((item, index) => {
    // 每章另起一页：分页属性挂在本章标题段落上，避免额外多出一个空行
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        pageBreakBefore: index > 0,
        spacing: { after: 240 },
        keepNext: true,
        children: [new TextRun({ text: item.title, bold: true, font: HEADING_FONT, size: 36 })]
      })
    )
    children.push(...blocksToParagraphs(htmlToBlocks(stripDuplicateTitle(item.content ?? '', item.title)), index))
  })

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: BODY_SIZE },
          paragraph: { spacing: { line: LINE_SPACING } }
        }
      }
    },
    numbering: {
      config: [
        {
          reference: ORDERED_REFERENCE,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } }
            }
          ]
        }
      ]
    },
    sections: [{ properties: {}, children }]
  })

  return Packer.toBuffer(doc)
}