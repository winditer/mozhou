/**
 * AI 味本地检测：不调用模型，随打字/随排查，纯函数。
 *
 * 为什么要有本地这一层（而不是直接把正文丢给模型判）：
 *
 * 一、全书排查必须先知道「哪几章值得花钱改」。一次全书 AI 味审查按章节跑模型，
 *    几十万字就是几十次调用；而 AI 味恰恰是**句子级现象**，用词和句式都是可数的。
 *    先在本地把密度算出来，作者看到的是「第 37 章最脏、脏在万能副词」，而不是
 *    先等三分钟再收一份 12 条上限的问题清单。
 *
 * 二、从这里能数的东西，比模型能数得更稳。模型数不清「这一章里有多少个『仿佛』」，
 *    正则不会漏也不会多。所以本地负责**事实与计数**，模型只负责**怎么改**。
 *
 * 三、口径必须与 textcraft.ts 的 DE_AI_INSTRUCTION 一致。那份指令已经把 AI 味
 *    定义为「一组具体的坏习惯」并逐条列了出来；这里检测的就是同一批坏习惯。
 *    两边一改就散，所以 DETECTORS 的每条都注明了对应指令里的哪一条。
 *
 * 立场：宁可漏报，不报假的。一处正常修辞被标红，作者就会关掉这个功能；
 * 漏掉一处，他下次还会扫。所以每条规则的阈值都偏保守，误报由「作者可忽略」兜底。
 */

/* ────────────────────────── 类型 ────────────────────────── */

/**
 * 检测维度。与 DE_AI_INSTRUCTION 的六条禁令一一对应（外加两条可量化的句式指标）：
 *
 * - adverb   解释性副词与万能形容词：「不禁」「仿佛」「微微」「缓缓」……
 * - explain  替读者下结论的句子：动作/对话后面紧跟的心理注解
 * - elevate  段末升华点题：「而这一切，才刚开始」
 * - abstract 抽象名词代替具体画面：「一种复杂的情绪」
 * - uniform  句子长度过于整齐（AI 偏爱等长句与平行排比）
 * - dialog   台词交代设定（对话里塞说明文）
 */
export type FlavorKind = 'adverb' | 'explain' | 'elevate' | 'abstract' | 'uniform' | 'dialog'

export const FLAVOR_KIND_LABEL: Record<FlavorKind, string> = {
  adverb: '万能修饰词',
  explain: '替读者下结论',
  elevate: '段末升华',
  abstract: '抽象代替具体',
  uniform: '句式整齐',
  dialog: '对话交代设定'
}

/** 哪一个手段最能把这一处改好，给了它就等于给了「去哪条按钮」 */
export const FLAVOR_KIND_HINT: Record<FlavorKind, string> = {
  adverb: '删掉修饰词，改成具体动作',
  explain: '把心理注解删掉，让动作自己说话',
  elevate: '最后一句写完就停，别升华',
  abstract: '换成看得见的名词与动作',
  uniform: '拆掉三分之一复句，插进短句',
  dialog: '把说明挪进叙述，台词只留人会说的话'
}

export interface FlavorHit {
  kind: FlavorKind
  /** 命中的词或整句，展示与定位都用它 */
  text: string
  /** 在所属文本里的字符下标 */
  at: number
  /** 一句话说明为什么算 AI 味 */
  why: string
}

/** 一个段落的检测结果 */
export interface ParagraphFlavor {
  /** 段落序号，从 1 开始（与界面上的段落一一对应） */
  index: number
  /** 段落纯文本 */
  text: string
  /** 字数（中文按字计） */
  words: number
  hits: FlavorHit[]
  /**
   * 段落密度分 0–100。不是「命中数×10」这种线性累加：
   * 一段里出现 5 个「仿佛」和 2 个，「脏」的程度差别只有那么大，
   * 而段落越长同样的命中越不说明问题。所以按「每千字命中数」折成密度，
   * 再按段落长度给一个可信度权重（太短的段落密度不稳定）。
   */
  score: number
}

/** 一次检测的汇总 */
export interface FlavorReport {
  /** 全书（或单章）加权密度 0–100 */
  score: number
  /** 总字数 */
  words: number
  /** 各维度命中次数 */
  byKind: Record<FlavorKind, number>
  /** 总命中次数 */
  total: number
  /** 逐段结果（只含有命中或得分 > 0 的段落，按原序） */
  paragraphs: ParagraphFlavor[]
}

/* ────────────────────────── 规则集 ────────────────────────── */

/**
 * 一、万能修饰词。
 *
 * 这批词单独出现都不算错，但它们是 AI 写作最高频的填充物：删掉几乎不影响信息，
 * 留下的只是「写虚了」的痕迹。所以只收那些**删掉不会改变句意**的词——
 * 「忽然」「突然」故意不收，它们承载了事件性，删了会改情节。
 */
const ADVERB_WORDS = [
  '不禁',
  '不由得',
  '情不自禁',
  '仿佛',
  '似乎',
  '宛如',
  '犹如',
  '微微',
  '缓缓',
  '深深',
  '悄然',
  '默默',
  '静静',
  '轻声',
  '淡淡',
  '轻轻',
  '莫名',
  '说不清',
  '隐约',
  '些许',
  '一抹',
  '一丝',
  '一缕',
  '一股'
]

/**
 * 二、替读者下结论。
 *
 * 形态固定：一个动作/对话之后紧跟一句「他终于明白了」「这一刻她忽然意识到」
 * 「某种说不清的情绪涌上来」。这是 AI 最标志性的写法——它不信任读者能自己
 * 读出来，所以每写一个动作就要配一句注解。
 *
 * 用正则而不是词表，是因为这类句子主语和动词的组合太多，但「终于+明白/意识」
 * 这类**结论动词**是稳定的锚点。
 */
const EXPLAIN_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /(这一刻|那一瞬间|一瞬间|恍然|猛然|忽然|终于)[^。！？\n]{0,12}(意识到|明白了|懂得了|醒悟|察觉)/g, why: '动作后面紧跟心理注解，替读者下了结论' },
  { re: /(某种|一种)[^。！？\n]{0,8}(情绪|感觉|滋味|失落|空虚|情愫)[^。！？\n]{0,10}(涌上|漫上|升起|扩散|蔓延)/g, why: '用「某种情绪」概括感受，读者看不到具体的东西' },
  { re: /(心中|心里|内心深处)[^。！？\n]{0,6}(一紧|一沉|一暖|一酸|泛起|涌起)/g, why: '心理状态直接交代，没有落到动作上' },
  { re: /(他|她|它)[^。！？\n]{0,10}(知道|明白|清楚)[，,]\s*(这|那)[^。！？\n]{0,16}(意味着|将是|已经)/g, why: '叙述者替角色和读者同时下判断' }
]

/**
 * 三、段末升华点题。
 *
 * AI 特别爱在段落最后一句拔高、点题、留悬念。人类写网文当然也留钩子，
 * 但不会每一段都留。所以这里只抓**最典型的升华句**，并要求它落在段末。
 */
const ELEVATE_PATTERN = /(才刚开始|才刚刚开始|从这一刻起|从这天起|而他不知道|而她不知道|没有人知道|殊不知|命运的齿轮|一切都会|再也回不去了|故事远没有结束)/

/**
 * 四、抽象代替具体。
 *
 * 「一种复杂的情绪」「无法言喻的感受」「难以名状的感觉」——这些词的问题不是
 * 俗，是**信息量为零**：读者读完不知道发生了什么。
 */
const ABSTRACT_PATTERN = /(复杂的|莫名的|难以言喻|无法形容|难以名状|说不清道不明|种种)[^。！？\n]{0,6}(情绪|感受|感觉|滋味|心绪)/g

/**
 * 五、对话里交代设定。
 *
 * 台词里出现「你是说，三年前那场大火……」，后面跟着一长串解释性从句，
 * 是 AI 最常用的设定输送方式。人说话不会这样整建制地复述背景。
 * 判据：引号内长度超过 DIALOG_INFO_MIN 且含说明性连接词。
 */
const DIALOG_INFO_MIN = 42
const DIALOG_INFO_PATTERN = /(因为|所以|据说|根据|按照规定|也就是说|换句话说|你应该知道|众所周知|据我所知)/

/* ────────────────────────── 文本工具 ────────────────────────── */

function stripTags(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(p|div|br|h[1-6]|li|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 纯文本段落切分：按换行分，去掉空段与标题行。
 *
 * ⚠️ 只用于「拿到一段段纯文本」的场合（如外部工具的粗略预览）。
 * **不要用它来给段落编号**——它会丢掉标题行，编出来的序号和正文 HTML 块序列
 * 差了一位，而回写是按 HTML 块序列走的。要编号请用 splitBodyBlocks。
 * 这条教训是真实踩出来的，见 splitBodyBlocks 的注释。
 */
export function splitBodyParagraphs(content: string): string[] {
  return stripTags(content)
    .split(/\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
    // 「第 12 章 xxx」这类标题行不算正文，统计进去会把密度拉偏
    .filter((s) => !/^第\s*[0-9一二三四五六七八九十百千]+\s*章/.test(s))
}

/**
 * 与「改写回写」共用的段落切分。
 *
 * 这个函数存在的唯一理由是一个真实踩过的坑：`splitBodyParagraphs` 会丢掉标题行
 * （统计密度时标题不该算进去），但回写用的 `audit/apply.ts:splitParagraphs` 是按
 * HTML 块级标签切、**保留** h1–h6。两套切法各干各的活没问题，可一旦段号跨用就会
 * 整体错位一位——正文写成「<h1>第 2 章</h1><p>…</p>」，扫描说「第 4 段」，
 * 回写时按第 4 个 HTML 块去替换，改的其实是第 5 段的内容。
 *
 * 所以：**段号一律由 HTML 块序列决定**。标题块留在序列里占位（永不作为改写目标），
 * 每个块的文本交给 scanParagraph 统计，标题块的命中直接丢弃。
 * 这样「第 N 段」在扫描侧和回写侧永远是同一个块。
 */
export interface BodyBlock {
  /** 在块序列里的序号，从 1 开始 */
  index: number
  /** 块内纯文本 */
  text: string
  /** 是否标题块（h1–h6）：占位但不可改写 */
  heading: boolean
}

/**
 * 按 HTML 块级标签切块，保留标题占位。
 *
 * 只认 p / div / h1-h6 / li / blockquote——与 apply.ts 的 splitParagraphs 同一套规则，
 * 两处必须一起改；这条注释就是为了让下一个改这个正则的人看见另一头。
 */
export function splitBodyBlocks(html: string): BodyBlock[] {
  const out: BodyBlock[] = []
  const re = /<(p|div|h[1-6]|li|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const whole = m[0]
    const tag = m[1].toLowerCase()
    const inner = whole.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '')
    const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    out.push({ index: out.length + 1, text, heading: /^h[1-6]$/.test(tag) })
  }

  // 没有块级标签的输入（纯文本稿件、导入的 TXT）按行切。
  // 这种情况必须单独兜住：否则正则一块都切不出来，整本书会被判成「0 字、没有 AI 味」，
  // 作者会以为功能坏了。标题行照样占位不检测，保持与 HTML 路径一致的语义。
  if (!out.length) {
    return html
      .split(/\n+/)
      .map((s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0)
      .map((text, i) => ({
        index: i + 1,
        text,
        heading: /^第\s*[0-9一二三四五六七八九十百千]+\s*[章回节]/.test(text)
      }))
  }

  return out
}

/** 解开实体：纯文本检测也要能看到真正的字符，否则「&quot;」会把引号检测搅乱 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 中文按字计：去掉空白与标点后数长度。
 * 不用 split('') 再过滤，因为要用 length 判断会不会把 emoji 之类切坏——
 * 正文里出现一个 emoji 不会影响密度，直接用 Array.from 稳妥。
 */
function countChars(text: string): number {
  return Array.from(text.replace(/[\s\u3000]/g, '')).length
}

/** 句子切分：按中文句末标点切，保留分隔符后面的内容从新句开始 */
function splitSentences(text: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of text) {
    cur += ch
    if ('。！？…'.includes(ch)) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur.trim()) out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** 句子长度的标准差 / 均值，用于判断「句式是否过于整齐」 */
function lengthVariation(sentences: string[]): { mean: number; cv: number } {
  const lens = sentences.map((s) => countChars(s))
  if (lens.length < 2) return { mean: lens[0] ?? 0, cv: 1 }
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length
  if (mean <= 0) return { mean: 0, cv: 1 }
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length
  return { mean, cv: Math.sqrt(variance) / mean }
}

/* ────────────────────────── 单段检测 ────────────────────────── */

/**
 * 一句话式密度分：命中数折成「每千字命中数」，再映射到 0–100。
 *
 * 为什么要按千字而不是按命中数：一段 200 字里出现 2 个「仿佛」和一段 40 字里
 * 出现 2 个「仿佛」，后者才是真脏。用密度才能把长短段放在同一把尺子上比。
 *
 * 折算曲线取 min(100, 每千字命中 × 7)：
 * 每千字 10 处命中 ≈ 70 分（明显脏），每千字 3 处 ≈ 21 分（可接受）。
 * 这个系数是照着真实网文调出来的：口语化网文常见 1–3 处/千字，
 * AI 生成稿多在 8–15 处/千字，中间需要分得开。
 */
function densityScore(hitCount: number, words: number): number {
  if (words <= 0 || hitCount <= 0) return 0
  /**
   * 分母带一个下限，是为了让短段落不在「每千字」这把尺子上虚高：
   * 20 字里命中 1 次按原样算是每千字 50 次，直接顶格。
   *
   * 下限取 150 而不是更小的值，是因为一段正常的正文段落大约 100–200 字。
   * 尽管理论上「一段话里有一处机器腔」也算问题，但它是**改一句就好的局部问题**，
   * 不该和「通篇都是万能副词」拿到同一个 100 分。150 让 47 字这样的小段
   * 落在 40–50 分区间（确实值得看一眼，但不至于像整段重写过一样红）。
   */
  const effective = Math.max(words, 150)
  const perKilo = (hitCount / effective) * 1000
  return Math.round(Math.max(0, Math.min(100, perKilo * 6)))
}

/** 检测一个段落，返回命中列表与密度分 */
export function scanParagraph(text: string, index: number): ParagraphFlavor {
  const hits: FlavorHit[] = []
  const words = countChars(text)

  /* 一、万能修饰词 */
  for (const w of ADVERB_WORDS) {
    let at = text.indexOf(w)
    while (at >= 0) {
      hits.push({ kind: 'adverb', text: w, at, why: `「${w}」删掉不改变句意，是填充用的修饰词` })
      at = text.indexOf(w, at + w.length)
    }
  }

  /* 二、替读者下结论 */
  for (const { re, why } of EXPLAIN_PATTERNS) {
    for (const m of text.matchAll(re)) {
      hits.push({ kind: 'explain', text: m[0], at: m.index ?? 0, why })
    }
  }

  /* 三、段末升华：只看最后一句 */
  const sentences = splitSentences(text)
  const last = sentences[sentences.length - 1] ?? ''
  const elev = last.match(ELEVATE_PATTERN)
  if (elev) {
    const at = text.lastIndexOf(elev[0])
    hits.push({ kind: 'elevate', text: last, at: at >= 0 ? at : 0, why: `段末用「${elev[0]}」升华点题，最后一句写完就该停` })
  }

  /* 四、抽象代替具体 */
  for (const m of text.matchAll(ABSTRACT_PATTERN)) {
    hits.push({ kind: 'abstract', text: m[0], at: m.index ?? 0, why: '用抽象名词概括感受，读者看不到具体画面' })
  }

  /* 五、对话交代设定 */
  for (const m of text.matchAll(/[“"]([^”"]{8,})[”"]/g)) {
    const line = m[1]
    if (countChars(line) >= DIALOG_INFO_MIN && DIALOG_INFO_PATTERN.test(line)) {
      hits.push({
        kind: 'dialog',
        text: line.slice(0, 40),
        at: (m.index ?? 0) + 1,
        why: '台词里塞了大段说明文，人说话不会这样交待背景'
      })
    }
  }

  /* 六、句式过于整齐：独立成条，因为它不该按「命中次数」算 */
  // 门槛：至少 4 句、且不低于 60 字。
  // 句子太少算不出「整齐」——两句话无论怎么写都可能是同长，
  // 硬算会把「他来了。她没抬头。」这种正常短段判脏。
  // 60 字是照着中文四句排比的真实规模定的：四句排比通常在 60–80 字之间，
  // 门槛移到 120 会漏掉整整一类典型排比（AI 写的整齐段往往不长，长了就散了）。
  if (words >= 60 && sentences.length >= 4) {
    const { cv } = lengthVariation(sentences)
    // cv（变异系数）低于 0.28 说明句子长短几乎一样，是平行排比腔的典型形态。
    // 中文正常叙述的 cv 多在 0.4–0.8，AI 稿常在 0.2–0.35。
    if (cv < 0.28) {
      hits.push({
        kind: 'uniform',
        text: `本段 ${sentences.length} 句，长度变异系数 ${cv.toFixed(2)}`,
        at: 0,
        why: '句子长短过于整齐，是平行排比的机器腔；拆掉部分复句、插进短句'
      })
    }
  }

  return { index, text, words, hits, score: densityScore(hits.length, words) }
}

/* ────────────────────────── 整篇检测 ────────────────────────── */

/** 各维度在总分里的权重：只有句式整齐不给满分，它对误报最敏感 */
const KIND_WEIGHT: Record<FlavorKind, number> = {
  adverb: 1,
  explain: 1.2,
  elevate: 1,
  abstract: 1,
  uniform: 0.6,
  dialog: 0.8
}

const EMPTY_BY_KIND = (): Record<FlavorKind, number> => ({
  adverb: 0,
  explain: 0,
  elevate: 0,
  abstract: 0,
  uniform: 0,
  dialog: 0
})

/**
 * 汇总分：按**权重加成后的命中数**折算成千字密度，再缩到 0–100。
 *
 * 单独抽出来，是因为 scanFlavor 和 scanBook 必须用同一把尺子——
 * 两处各写一份公式，改了一边忘了另一边，章节排行和全书总分就会互相矛盾，
 * 而这种矛盾在界面上表现为「全书 40 分，但排行里每章都是 60 分」，很难查。
 *
 * 系数 6 与段落层的 7 不同：整篇汇总里「句式整齐」这类低频维度被稀释，
 * 用略低的系数才不会把正常的长篇判成高危。
 */
function aggregateScore(weightedHits: number, words: number): number {
  if (words <= 0) return 0
  const perKilo = (weightedHits / Math.max(words, 60)) * 1000
  return Math.round(Math.max(0, Math.min(100, perKilo * 6)))
}

/**
 * 检测整章 / 整篇正文。
 *
 * 总分是**按段落长度加权的命中密度**，不是各段分数的平均：
 * 平均会把「十段干净 + 一段极脏」拉成 10 分，读起来像没事，
 * 而实际上作者只要修那一段就够了。加权后能真实反映「通篇有多少机器腔」。
 */
export function scanFlavor(content: string): FlavorReport {
  const blocks = splitBodyBlocks(content)
  const byKind = EMPTY_BY_KIND()
  const scanned: ParagraphFlavor[] = []
  let words = 0
  let weightedHits = 0

  for (const block of blocks) {
    // 标题块占位但不检测：章名里带「第 2 章」之类内容，标记成 AI 味纯属误报，
    // 而且标题永远不参与改写（改掉会破坏文档结构）。
    if (block.heading) continue
    // 空块（纯 <br>）也跳过，但它的序号照样被后面的块占用，编号不会塌缩
    if (!block.text) continue
    const p = scanParagraph(block.text, block.index)
    words += p.words
    if (!p.hits.length) continue
    for (const h of p.hits) {
      byKind[h.kind]++
      weightedHits += KIND_WEIGHT[h.kind]
    }
    scanned.push(p)
  }

  const total = Object.values(byKind).reduce((a, b) => a + b, 0)

  return {
    score: aggregateScore(weightedHits, words),
    words,
    byKind,
    total,
    paragraphs: scanned.sort((a, b) => a.index - b.index)
  }
}

/**
 * 把一段分数翻成人话。
 * 分档线是照着「作者愿意花多少时间」定的，不是均匀分布：
 * 30 分以下不值得动，60 分以上一趟改完明显不一样。
 */
export function flavorLevel(score: number): { label: string; tone: 'ok' | 'warn' | 'danger' } {
  if (score < 30) return { label: '干净', tone: 'ok' }
  if (score < 60) return { label: '轻微', tone: 'warn' }
  if (score < 80) return { label: '明显', tone: 'danger' }
  return { label: '很重', tone: 'danger' }
}

/* ────────────────────────── 全书排行 ────────────────────────── */

export interface ChapterFlavor {
  id: string
  title: string
  /** 在全书里的位置，从 1 开始 */
  order: number
  words: number
  score: number
  total: number
  byKind: Record<FlavorKind, number>
  /** 最脏的那几段，直接拿去给模型改 */
  worst: ParagraphFlavor[]
}

export interface BookFlavorReport {
  /** 全书加权密度 */
  score: number
  words: number
  chapters: ChapterFlavor[]
  /** 按分数降序，只含「值得改」的章节 */
  ranking: ChapterFlavor[]
  byKind: Record<FlavorKind, number>
  total: number
}

/**
 * 全书扫描与排行。
 *
 * 为什么排行是核心而不是附赠：全书去 AI 味真正的成本不是算力，是**作者的注意力**。
 * 一本书三十万字，全改一遍既贵又累；而实际收益高度集中在少数几章——
 * 通常是快速赶出来的过渡章、一次性写完没回看的章节。
 * 排行把「今天该修哪三章」直接摆出来，作者才愿意用这个功能。
 *
 * 排序依据是**章节密度分**，不是命中总数：
 * 命中多可能只是因为这章长，密度才说明这章的机器腔有多浓。
 */
export function scanBook(
  chapters: { id: string; title: string; content: string }[],
  options: { minScore?: number; topWorst?: number } = {}
): BookFlavorReport {
  const minScore = options.minScore ?? 30
  const topWorst = options.topWorst ?? 3

  const list: ChapterFlavor[] = []
  const byKind = EMPTY_BY_KIND()
  let words = 0
  let weightedHits = 0

  chapters.forEach((c, i) => {
    const r = scanFlavor(c.content)
    words += r.words
    for (const k of Object.keys(byKind) as FlavorKind[]) byKind[k] += r.byKind[k]
    for (const p of r.paragraphs) for (const h of p.hits) weightedHits += KIND_WEIGHT[h.kind]

    list.push({
      id: c.id,
      title: c.title,
      order: i + 1,
      words: r.words,
      score: r.score,
      total: r.total,
      byKind: r.byKind,
      worst: [...r.paragraphs]
        .filter((p) => p.hits.length > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, topWorst)
    })
  })

  const total = Object.values(byKind).reduce((a, b) => a + b, 0)

  return {
    score: aggregateScore(weightedHits, words),
    words,
    chapters: list,
    // 只把达标的排进去，并且必须是真正「有正文」的章：
    // 空章密度恒为 0，排进榜只会挤占位置，让作者以为没什么可改。
    ranking: list
      .filter((c) => c.words > 0 && c.score >= minScore)
      .sort((a, b) => b.score - a.score || b.total - a.total || a.order - b.order),
    byKind,
    total
  }
}

/**
 * 给模型用的「该改哪些段」清单。
 *
 * 只送最脏的几段 + 每段的具体症状，而不是整章丢过去：
 * 一章几千字里真正需要动的大概就是那几段，全文重写会把干净的地方也改掉，
 * 而且成本高得多。段落序号用原章的序号，改完才能按号回写。
 */
export interface RewriteTarget {
  index: number
  text: string
  score: number
  kinds: FlavorKind[]
}

/** 从检测结果里挑出要送去改写的段落 */
export function pickRewriteTargets(report: FlavorReport, max = 5, minScore = 35): RewriteTarget[] {
  return report.paragraphs
    .filter((p) => p.hits.length > 0 && p.score >= minScore)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .map((p) => ({
      index: p.index,
      text: p.text,
      score: p.score,
      kinds: [...new Set(p.hits.map((h) => h.kind))]
    }))
    .sort((a, b) => a.index - b.index)
}

/** 把命中的词去重后拼成一句症状描述，给提示词用 */
export function describeHits(p: ParagraphFlavor, limit = 6): string {
  const seen = new Set<string>()
  const bits: string[] = []
  for (const h of p.hits) {
    const key = `${h.kind}:${h.text}`
    if (seen.has(key)) continue
    seen.add(key)
    bits.push(`「${h.text}」（${h.why}）`)
    if (bits.length >= limit) break
  }
  return bits.join('；')
}