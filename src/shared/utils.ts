export function uid(prefix = ''): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6)
  return prefix ? `${prefix}_${raw}` : raw
}

const ENTITY: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&mdash;': '—',
  '&hellip;': '…'
}

/** HTML → 纯文本（块级元素转换行） */
export function stripHtml(html: string): string {
  if (!html) return ''
  let s = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<[^>]+>/g, '')
  s = s.replace(/&[a-z#0-9]+;/gi, (m) => ENTITY[m] ?? m)
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 中文字数统计：中日韩字符按 1 字计，连续的拉丁字母/数字按 1 词计，
 * 标点与空白不计。这是中文写作软件通行的「字数」口径。
 */
export function countWords(input: string): number {
  const text = /<[a-z][\s\S]*>/i.test(input) ? stripHtml(input) : input
  if (!text) return 0
  const cjk = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g)
  const latin = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)
  return (cjk?.length ?? 0) + (latin?.length ?? 0)
}

export function formatNumber(n: number): string {
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(2).replace(/\.?0+$/, '') + ' 亿'
  if (n >= 10_000) return (n / 10_000).toFixed(1).replace(/\.0$/, '') + ' 万'
  return String(n)
}

export function formatDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return formatDate(ts)
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function truncate(s: string, n: number): string {
  if (!s) return ''
  return s.length <= n ? s : s.slice(0, n) + '…'
}

export function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 粗略 token 估算：中文约 1 字 = 0.7 token，英文约 4 字符 = 1 token */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/g) ?? []).length
  const rest = text.length - cjk
  return Math.ceil(cjk * 0.75 + rest / 3.5)
}

/** 按目标字数与篇幅档位给出档位名 */
export function lengthTier(words: number): { key: string; label: string } {
  if (words < 300) return { key: 'micro', label: '微文案' }
  if (words < 3000) return { key: 'short', label: '短篇' }
  if (words < 20000) return { key: 'medium', label: '中篇' }
  if (words < 500000) return { key: 'long', label: '长篇' }
  return { key: 'epic', label: '超长篇' }
}

/** 从纯文本/markdown 文本智能分章 */
export function splitChapters(raw: string): { title: string; body: string }[] {
  const text = raw.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const patterns = [
    /^\s{0,3}#{1,3}\s+(.+?)\s*$/,
    /^\s{0,3}第[零一二三四五六七八九十百千0-9]{1,8}[章节回卷篇]\s*[：:.、-]?\s*(.*)$/,
    /^\s{0,3}(?:Chapter|CHAPTER)\s+[0-9IVXLC]+\s*[：:.]?\s*(.*)$/,
    /^\s{0,3}[\d]{1,4}[、.]\s*(.{1,40})$/
  ]
  const out: { title: string; body: string }[] = []
  let current: { title: string; body: string } | null = null
  for (const line of lines) {
    let matched: string | null = null
    for (const re of patterns) {
      const m = line.match(re)
      if (m) {
        matched = (m[1] || line.trim()).trim() || line.trim()
        break
      }
    }
    if (matched) {
      if (current) out.push(current)
      current = { title: matched, body: '' }
    } else if (current) {
      current.body += line + '\n'
    }
  }
  if (current) out.push(current)
  if (out.length === 0) {
    // 没有章节标记：按空行分成若干块，每 3000 字一块
    const paras = text.split(/\n{2,}/).filter((p) => p.trim())
    const chunks: string[] = []
    let buf = ''
    for (const p of paras) {
      if (buf.length + p.length > 3000 && buf) {
        chunks.push(buf)
        buf = ''
      }
      buf += p + '\n\n'
    }
    if (buf.trim()) chunks.push(buf)
    return chunks.map((c, i) => ({ title: `第 ${i + 1} 节`, body: c.trim() }))
  }
  return out.map((c) => ({ title: c.title, body: c.body.trim() }))
}

/** 简单文本/markdown → HTML（用于导入） */
export function plainToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return text
    .split(/\n{2,}/)
    .map((block) => {
      const t = block.trim()
      if (!t) return ''
      let s = esc(t)
      s = s.replace(/^#{1,6}\s+(.*)$/gm, '<strong>$1</strong>')
      s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      s = s.replace(/\n/g, '<br>')
      return `<p>${s}</p>`
    })
    .filter(Boolean)
    .join('\n')
}