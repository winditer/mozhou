/**
 * 书稿导入 · 本地解析（零成本、即时、可离线）
 *
 * 这一层的唯一职责是：把一份 txt/md 书稿切成「卷 → 章」两级结构，并猜出书名与作者。
 * 它不碰网络、不碰 React，所以可以直接被 scripts/test-import-book.mjs 打包测试。
 *
 * 为什么不复用 @shared/utils 的 splitChapters：
 * 那个函数把「第X卷」也当成一章（它是给「粘贴正文」这种单层场景写的），
 * 而导入书稿必须区分「卷是分组、章才是章节」，否则几十万字的书会被 3 个卷标记切成 3 章。
 * 这里重新实现，并把卷/章的判定顺序固定为「先卷后章」。
 */
import { countWords } from '@shared/utils'

export type ImportSplitMode = 'volume' | 'chapter' | 'chunk' | 'empty'

export interface ImportVolume {
  index: number
  /** 卷标题，原样保留作者的写法（如「第一卷 十六人抬棺」） */
  title: string
}

export interface ImportChapter {
  /** 全书内从 1 开始的连续序号，导入后就是章节顺序 */
  index: number
  /** 原始标题（含「第X章」这类序号），作为章节名落库 */
  title: string
  /** 去掉序号后的显示名，用于同卷重名判断与大纲展示 */
  name: string
  /** 正文纯文本（空行分段），导入时再转 HTML */
  body: string
  words: number
  /** 所属卷在 volumes 里的下标 */
  volumeIndex: number
}

export interface ImportParseResult {
  title: string
  author: string
  /** 书名候选的来源（head = 正文首行，filename = 文件名，'' = 没有） */
  titleFrom: 'head' | 'filename' | ''
  authorFrom: 'head' | 'filename' | ''
  volumes: ImportVolume[]
  chapters: ImportChapter[]
  totalWords: number
  splitMode: ImportSplitMode
  /** 本地解析阶段要给作者看的提醒（按字数切分、卷缺失等） */
  notices: string[]
}

/** 无任何章节标记时，按这个字数切块 */
const CHUNK_WORDS = 3000

/** 单章标题的最大长度：超过这个长度的「第X章」行基本是正文误伤 */
const MAX_HEADING_LEN = 60

/* ───────────────────────── 文本归一 ───────────────────────── */

function normalizeText(raw: string): string {
  return (raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
}

/** 去掉包裹书名的书名号/引号，模型和作者都爱加 */
function cleanTitle(raw: string): string {
  return (raw ?? '')
    .trim()
    .replace(/^[《「【\["'“”]+/, '')
    .replace(/[》」】\]"'“”]+$/, '')
    .trim()
}

/** 文件名去目录、去扩展名后当书名候选 */
export function titleFromFileName(fileName?: string): string {
  if (!fileName) return ''
  const base = fileName.split(/[\\/]/).pop() ?? ''
  const noExt = base.replace(/\.(txt|md|markdown|text)$/i, '')
  // 「《书名》作者：某某」这种文件名在下载来的稿子里很常见，先按书名号抠
  const quoted = /《(.+?)》/.exec(noExt)
  if (quoted && quoted[1]) return cleanTitle(quoted[1])
  return cleanTitle(noExt.replace(/[-_—\s]*作者.*$/, ''))
}

export function authorFromFileName(fileName?: string): string {
  if (!fileName) return ''
  const base = fileName.split(/[\\/]/).pop() ?? ''
  const m = /作者\s*[:：]?\s*([^\s，,。.、()（）]+)/.exec(base)
  return m && m[1] ? m[1].trim() : ''
}

/* ───────────────────────── 标题 / 作者识别 ───────────────────────── */

const AUTHOR_LINE = /^(?:作\s*者|著\s*者|author|Author)\s*[:：]\s*(.+)$/
const AUTHOR_SUFFIX = /^([^\s，,。:：]{1,20})\s*[（(]?\s*著\s*[）)]?$/

/**
 * 首行是不是一个「像书名」的短行。
 * 判据故意保守：字数短 + 不含句读，否则一句正文开头（「他说，天要下雨了。」）
 * 会被当成书名，作者还得手动改回来。
 */
function looksLikeBookTitleLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (t.length > 30) return false
  if (/[。，、；：！？!?;,.]/.test(t)) return false
  return true
}

interface HeadInfo {
  title: string
  author: string
  /**
   * 候选来自哪里：正文首行是「强证据」（作者自己写的书名），
   * 文件名是「弱证据」（可能是下载时的乱名）。AI 识别结果只在弱证据时才有资格覆盖它。
   */
  titleFrom: 'head' | 'filename' | ''
  authorFrom: 'head' | 'filename' | ''
  /** 被当作元信息吃掉的行号，切章时要跳过它们 */
  consumed: Set<number>
}

/**
 * 从前 8 行里找书名与作者。
 * 只看前 8 行：正文里出现「作者：」这种字样的概率不低（人物对话、引文），
 * 一旦扫全文就会把某句正文当作者名写进作品档案。
 */
export function detectHead(lines: string[], fileName?: string): HeadInfo {
  const consumed = new Set<number>()
  let author = ''
  let title = ''
  const limit = Math.min(lines.length, 8)

  for (let i = 0; i < limit; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const m = AUTHOR_LINE.exec(line)
    if (m && m[1] && !author) {
      author = cleanTitle(m[1].replace(/[，,。.\s]*$/, ''))
      consumed.add(i)
      continue
    }
    const suffix = AUTHOR_SUFFIX.exec(line)
    // 「张三 著」这种落款：只要这行不是章节/卷标记，就当作者
    if (suffix && suffix[1] && !author && !matchVolumeMarker(line) && !matchChapterMarker(line)) {
      author = suffix[1].trim()
      consumed.add(i)
    }
  }

  for (let i = 0; i < limit; i++) {
    if (consumed.has(i)) continue
    const line = lines[i]
    const t = line.trim()
    if (!t) continue
    // Markdown 书稿最常见的样子是「# 书名」+「## 第一章 …」。
    // 这一行虽然会被 matchChapterMarker 当成章（任何 1–3 级标题都算），
    // 但下面还有二级标题、且它自己不带章序号时，它几乎必然是书名。
    const h = stripHeadingMarks(t)
    if (h.heading && h.level === 1 && !isNumberedHeading(h.text) && hasSubHeading(lines, i)) {
      title = cleanTitle(h.text)
      consumed.add(i)
      break
    }
    // 章节/卷标记行不可能是书名：作者常直接把「第一章」放在第一行
    if (matchVolumeMarker(t) || matchChapterMarker(t)) break
    if (!looksLikeBookTitleLine(t)) break
    // 首行常见写法是「# 抬棺人」，书名里不能留 markdown 的井号
    title = cleanTitle(stripHeadingMarks(t).text)
    consumed.add(i)
    break
  }

  let titleFrom: HeadInfo['titleFrom'] = title ? 'head' : ''
  let authorFrom: HeadInfo['authorFrom'] = author ? 'head' : ''
  if (!title) {
    title = titleFromFileName(fileName)
    if (title) {
      titleFrom = 'filename'
    }
  }
  if (!author) {
    author = authorFromFileName(fileName)
    if (author) {
      authorFrom = 'filename'
    }
  }
  return { title, author, titleFrom, authorFrom, consumed }
}

/* ───────────────────────── 卷 / 章 标记 ───────────────────────── */

/** 去掉 markdown 标题前缀，剩下的部分再判断是卷还是章（level 0 表示不是标题行） */
function stripHeadingMarks(line: string): { text: string; heading: boolean; level: number } {
  const m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
  if (!m) return { text: line.trim(), heading: false, level: 0 }
  return { text: (m[2] ?? '').replace(/\s*#+\s*$/, '').trim(), heading: true, level: (m[1] ?? '').length }
}

/** 标题里带序号（第X章 / Chapter 1 / 1.）——这种东西一定是章节，不可能是书名 */
function isNumberedHeading(text: string): boolean {
  return (
    CHAPTER_PATTERNS.some((re) => re.test(text)) ||
    VOLUME_PATTERNS.some((re) => re.test(text)) ||
    /^\d{1,4}\s*[、.．]\s*\S/.test(text)
  )
}

/** 往后找有没有二级标题：有的话，开头的 H1 基本就是书名 */
function hasSubHeading(lines: string[], from: number, limit = 60): boolean {
  const end = Math.min(lines.length, from + limit)
  for (let i = from + 1; i < end; i++) {
    if (/^\s{0,3}##\s+\S/.test(lines[i]!)) return true
  }
  return false
}

const NUM = '[0-9０-９零〇一二三四五六七八九十百千两]'

const VOLUME_PATTERNS: RegExp[] = [
  new RegExp(`^第\\s*${NUM}{1,8}\\s*[卷部]\\s*[：:.、\\-—]?\\s*(.*)$`),
  new RegExp(`^[卷]\s*${NUM}{1,8}\\s*[：:.、\\-—]?\\s*(.*)$`),
  /^(?:Volume|VOLUME|Book|BOOK)\s+[0-9IVXLCivxlc]+[：:.、\-—]?\s*(.*)$/
]

const CHAPTER_PATTERNS: RegExp[] = [
  // 这里刻意不含「卷/部」：那是分组，不是章节（就是 splitChapters 的老缺陷）
  new RegExp(`^第\\s*${NUM}{1,8}\\s*[章节回话]\\s*[：:.、\\-—]?\\s*(.*)$`),
  /^(?:Chapter|CHAPTER|chapter)\s+[0-9IVXLCivxlc]+[：:.、\-—]?\s*(.*)$/,
  /^(?:序章|楔子|尾声|后记|番外)\s*[：:.、\-—]?\s*(.*)$/
]

/** 返回该行是否是一个卷标记（只判卷，不管章） */
export function matchVolumeMarker(line: string): boolean {
  const { text } = stripHeadingMarks(line)
  if (!text || text.length > MAX_HEADING_LEN) return false
  return VOLUME_PATTERNS.some((re) => re.test(text))
}

/** 返回该行是否是一个章标记（不含卷标记） */
export function matchChapterMarker(line: string): boolean {
  const { text, heading, level } = stripHeadingMarks(line)
  if (!text) return false
  if (VOLUME_PATTERNS.some((re) => re.test(text))) return false
  if (CHAPTER_PATTERNS.some((re) => re.test(text))) return true
  // markdown 标题兜底：`# 起棺` 这种没有「第X章」的写法。
  // 只认 1–3 级：4 级往下常被作者当「场景分隔」用，认成章会把一章碎成十几章
  if (heading && level <= 3 && text.length <= MAX_HEADING_LEN && !/[。；;，,]$/.test(text)) return true
  // `1. 起棺` 这种编号行
  if (text.length <= 40 && /^\d{1,4}\s*[、.．]\s*\S/.test(text) && !/[。！？!?]$/.test(text)) return true
  return false
}

/** 去掉「第X章 / 1. / #」这类前缀，得到显示名 */
export function stripChapterNumber(title: string): string {
  const { text } = stripHeadingMarks(title)
  let out = text
  out = out.replace(new RegExp(`^第\\s*${NUM}{1,8}\\s*[章节回话卷部篇集]\\s*[：:.、\\-—]?\\s*`), '')
  out = out.replace(/^(?:Chapter|CHAPTER|chapter)\s+[0-9IVXLCivxlc]+\s*[：:.、\-—]?\s*/, '')
  out = out.replace(/^\d{1,4}\s*[、.．]\s*/, '')
  out = out.replace(/^[《「【"'“”]+/, '').replace(/[》」】"'“”]+$/, '')
  return out.trim()
}

/* ───────────────────────── 切分 ───────────────────────── */

interface RawChapter {
  title: string
  name: string
  lines: string[]
  volumeIndex: number
}

/** 把正文行按「先卷后章」组装成两级结构 */
function splitByMarkers(lines: string[]): { volumes: ImportVolume[]; raw: RawChapter[]; hadVolumeMarker: boolean } {
  const volumes: ImportVolume[] = []
  const raw: RawChapter[] = []
  let hadVolumeMarker = false
  let currentVolume = -1
  let current: RawChapter | null = null

  const pushVolume = (title: string): void => {
    volumes.push({ index: volumes.length, title: title || `第 ${volumes.length + 1} 卷` })
    currentVolume = volumes.length - 1
  }
  const flush = (): void => {
    if (current) {
      raw.push(current)
      current = null
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      if (current) current.lines.push('')
      continue
    }

    if (matchVolumeMarker(trimmed)) {
      flush()
      hadVolumeMarker = true
      const { text } = stripHeadingMarks(trimmed)
      pushVolume(text)
      continue
    }

    if (matchChapterMarker(trimmed)) {
      flush()
      // 卷标记之前的章节归入「第一卷」——这是作者最常犯的排版顺序
      if (currentVolume < 0) pushVolume('第一卷')
      const { text } = stripHeadingMarks(trimmed)
      current = { title: text, name: stripChapterNumber(text) || text, lines: [], volumeIndex: currentVolume }
      continue
    }

    if (current) current.lines.push(line)
    // 卷标记之后、第一个章标记之前的文字（卷首语）直接丢弃：
    // 它不属于任何一章，硬塞进第一章会污染正文
  }
  flush()
  return { volumes, raw, hadVolumeMarker }
}

/** 没有章节标记时的降级：按空行聚合成约 3000 字一块 */
function chunkByWords(lines: string[]): { title: string; body: string }[] {
  const text = lines.join('\n').trim()
  if (!text) return []
  const paras = text.split(/\n{2,}/).filter((p) => p.trim())
  const chunks: string[] = []
  let buf = ''
  for (const p of paras) {
    if (buf && buf.length + p.length > CHUNK_WORDS) {
      chunks.push(buf.trim())
      buf = ''
    }
    buf += p + '\n\n'
  }
  if (buf.trim()) chunks.push(buf.trim())
  return chunks.map((body, i) => ({ title: `第 ${i + 1} 节`, body }))
}

/** 正文行 → 纯文本：收掉行尾空白，把 3 个以上连续空行压成 2 个 */
function joinBody(lines: string[]): string {
  return lines
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 解析一份书稿：返回书名/作者候选、卷章结构、统计与提醒。
 * 结果永远可用（解析不出章节时返回空 chapters + notices），由界面决定怎么提示。
 */
export function parseImportText(raw: string, opts: { fileName?: string } = {}): ImportParseResult {
  const text = normalizeText(raw)
  const lines = text.split('\n')
  const head = detectHead(lines, opts.fileName)

  // 元信息行从正文里剔除；其余行原样参与切分
  const bodyLines = lines.filter((_, i) => !head.consumed.has(i))

  const notices: string[] = []
  const { volumes, raw: rawChapters, hadVolumeMarker } = splitByMarkers(bodyLines)

  const chapters: ImportChapter[] = []
  const keptVolumes: ImportVolume[] = []

  if (rawChapters.length === 0) {
    const chunks = chunkByWords(bodyLines)
    if (chunks.length === 0) {
      return {
        title: head.title || '未命名作品',
        author: head.author,
        titleFrom: head.titleFrom,
        authorFrom: head.authorFrom,
        volumes: [],
        chapters: [],
        totalWords: 0,
        splitMode: 'empty',
        notices: ['文件里没有可导入的正文，请确认选的是纯文本或 Markdown 书稿']
      }
    }
    keptVolumes.push({ index: 0, title: '第一卷' })
    chunks.forEach((c) => {
      const body = c.body
      chapters.push({
        index: chapters.length + 1,
        title: c.title,
        name: c.title,
        body,
        words: countWords(body),
        volumeIndex: 0
      })
    })
    notices.push('没识别到章节标记，已按约 3000 字切分，可在预览里改名')
    return {
      title: head.title || '未命名作品',
      author: head.author,
      titleFrom: head.titleFrom,
      authorFrom: head.authorFrom,
      volumes: keptVolumes,
      chapters,
      totalWords: chapters.reduce((s, c) => s + c.words, 0),
      splitMode: 'chunk',
      notices
    }
  }

  // 空章不导入：只有标题没有正文的章（目录、卷首语）对写作者毫无价值
  const keptRaw = rawChapters.filter((c) => joinBody(c.lines).length > 0)
  if (keptRaw.length < rawChapters.length) {
    notices.push(`有 ${rawChapters.length - keptRaw.length} 个标题下没有正文，已跳过`)
  }

  // 卷只保留真正带章的那些，并重排索引
  const volumeRemap = new Map<number, number>()
  for (const c of keptRaw) {
    if (!volumeRemap.has(c.volumeIndex)) {
      volumeRemap.set(c.volumeIndex, keptVolumes.length)
      keptVolumes.push(volumes[c.volumeIndex] ?? { index: keptVolumes.length, title: `第 ${keptVolumes.length + 1} 卷` })
    }
  }
  keptVolumes.forEach((v, i) => {
    v.index = i
  })

  for (const c of keptRaw) {
    const body = joinBody(c.lines)
    chapters.push({
      index: chapters.length + 1,
      title: c.title,
      name: c.name,
      body,
      words: countWords(body),
      volumeIndex: volumeRemap.get(c.volumeIndex) ?? 0
    })
  }

  if (!hadVolumeMarker) {
    notices.push('没有找到卷标记，全部章节先归入「第一卷」')
  }

  return {
    title: head.title || '未命名作品',
    author: head.author,
    titleFrom: head.titleFrom,
    authorFrom: head.authorFrom,
    volumes: keptVolumes,
    chapters,
    totalWords: chapters.reduce((s, c) => s + c.words, 0),
    splitMode: hadVolumeMarker ? 'volume' : 'chapter',
    notices
  }
}