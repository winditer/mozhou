/**
 * 极简 Markdown → HTML。
 *
 * 为什么不用第三方库：这个 App 的回答里有 `[1]` 这类来源编号、有 mz-edit 改稿块、
 * 还有中文标点紧贴 `**` 的写法，一个通用解析器会顺手改掉很多东西（比如把 [1] 当链接引用
 * 去查、把 `**路**人**` 拆错）。这里只支持对话里真会出现的语法，其余原样输出。
 *
 * 安全：先整体 HTML 转义，再做行内替换。因此输入里写 <script> 只会显示成文字；
 * 链接只认 http/https，`javascript:` 直接降级成纯文本。
 */

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c])
}

/** 行内：`code`、**粗**、*斜*、~~删~~、[文字](链接) */
function inline(text: string): string {
  // 先把行内代码整段摘走，避免里面的 ** 被当成加粗
  const parts = text.split(/(`[^`\n]+`)/g)
  return parts
    .map((seg) => {
      if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
        return `<code>${seg.slice(1, -1)}</code>`
      }
      let s = seg
      // 链接：只允许 http/https，其余保持原文（不生成 a 标签）
      s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
        if (!/^https?:\/\//i.test(href)) return `[${label}](${href})`
        return `<a href="${href}" title="${href}">${label}</a>`
      })
      s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      // 斜体只认两侧不是 * 的单星，避免把 **粗** 的残余当成斜体
      s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      return s
    })
    .join('')
}

/** 一行是不是表格的「分隔行」：| --- | :---: | ---: | */
function isTableSep(line: string): boolean {
  const t = line.trim()
  if (!t.includes('-') || !t.includes('|')) return false
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(t)
}

/** 把 | a | b | 拆成 ['a','b']，两侧的竖线不算空列 */
function cells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map((c) => c.trim())
}

/** 对齐：:--- 左、:---: 居中、---: 右 */
function alignOf(sep: string): 'left' | 'center' | 'right' {
  const t = sep.trim()
  if (/^:.*:$/.test(t)) return 'center'
  if (/:$/.test(t)) return 'right'
  return 'left'
}

/**
 * 块级解析。支持的块：围栏代码、标题、引用、有序/无序列表、分隔线、段落。
 * 对话里够用了；表格之类不处理，原样输出（至少不会错乱）。
 */
export function mdToHtml(src: string): string {
  const lines = escapeHtml(String(src ?? '').replace(/\r\n?/g, '\n')).split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let quote: string[] = []
  let code: string[] | null = null
  let codeLang = ''

  const closeList = (): void => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }
  const closeQuote = (): void => {
    if (quote.length) {
      out.push(`<blockquote>${quote.map((q) => inline(q)).join('<br>')}</blockquote>`)
      quote = []
    }
  }
  const flush = (): void => {
    closeList()
    closeQuote()
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (code) {
      if (/^```\s*$/.test(raw.trim())) {
        out.push(`<pre><code data-lang="${escapeHtml(codeLang)}">${code.join('\n')}</code></pre>`)
        code = null
        codeLang = ''
      } else {
        code.push(raw)
      }
      continue
    }

    const fence = /^```(\w*)\s*$/.exec(raw.trim())
    if (fence) {
      flush()
      code = []
      codeLang = fence[1] || ''
      continue
    }

    if (!raw.trim()) {
      flush()
      continue
    }

    /*
     * 表格：当前行含 |，下一行是分隔行。
     * 只认这种「表头 + 分隔行」的组合——正文里偶尔出现的单个 | 不能变成表格。
     */
    if (raw.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush()
      const head = cells(raw)
      const sep = cells(lines[i + 1])
      const aligns = sep.map(alignOf)
      let j = i + 2
      const rows: string[][] = []
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
        rows.push(cells(lines[j]))
        j++
      }
      const cell = (tag: 'th' | 'td', text: string, col: number): string =>
        `<${tag} style="text-align:${aligns[col] ?? 'left'}">${inline(text)}</${tag}>`
      const thead = `<thead><tr>${head.map((c, ci) => cell('th', c, ci)).join('')}</tr></thead>`
      const tbody = rows.length
        ? `<tbody>${rows
            .map((r) => `<tr>${head.map((_h, ci) => cell('td', r[ci] ?? '', ci)).join('')}</tr>`)
            .join('')}</tbody>`
        : ''
      // 窄面板里表格会横向溢出，套一层可横向滚动的容器
      out.push(`<div class="md-table-wrap"><table>${thead}${tbody}</table></div>`)
      i = j - 1
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (h) {
      flush()
      const level = Math.min(4, Math.max(3, h[1].length + 2))
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`)
      continue
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(raw)) {
      flush()
      out.push('<hr>')
      continue
    }

    const bq = /^\s*&gt;\s?(.*)$/.exec(raw)
    if (bq) {
      closeList()
      quote.push(bq[1])
      continue
    }
    closeQuote()

    const ul = /^\s*[-*•]\s+(.*)$/.exec(raw)
    if (ul) {
      if (list !== 'ul') {
        closeList()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${inline(ul[1])}</li>`)
      continue
    }

    const ol = /^\s*(\d{1,2})[.)]\s+(.*)$/.exec(raw)
    if (ol) {
      if (list !== 'ol') {
        closeList()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${inline(ol[2])}</li>`)
      continue
    }

    closeList()
    // 中文写作很少在段落里换行，单个换行按 <br> 处理（原来是 whitespace-pre-wrap）
    out.push(`<p>${inline(raw)}</p>`)
  }

  if (code) out.push(`<pre><code>${code.join('\n')}</code></pre>`)
  flush()
  return out.join('\n')
}