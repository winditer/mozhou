import type { Chapter, Project, PromptMessage } from '@shared/types'
import { stripHtml, truncate } from '@shared/utils'

/* ────────────────────────── 共用：资料摘要 ────────────────────────── */

/** 按条数上限拼接，超出上限时给出省略说明，避免把整本书塞进提示词 */
function joinCapped(lines: string[], limit: number): string {
  if (lines.length <= limit) return lines.join('\n')
  const kept = lines.slice(0, limit).join('\n')
  return `${kept}\n（另有 ${lines.length - limit} 条省略）`
}

export function characterDigest(project: Project): string {
  const list = project.bible.characters.filter((c) => !c.hidden && c.name.trim())
  if (!list.length) return ''
  const lines = list.map((c) => {
    const bits = [`【${c.name}】${c.role || '角色'}`]
    if (c.identity) bits.push(`身份：${truncate(c.identity, 60)}`)
    if (c.personality) bits.push(`性格：${truncate(c.personality, 90)}`)
    if (c.motivation) bits.push(`动机：${truncate(c.motivation, 70)}`)
    if (c.speechStyle) bits.push(`说话方式：${truncate(c.speechStyle, 50)}`)
    if (c.arc) bits.push(`人物弧光：${truncate(c.arc, 60)}`)
    if (c.relations.length) {
      bits.push(`关系：${truncate(c.relations.map((r) => `${r.name}（${r.desc}）`).join('；'), 120)}`)
    }
    return bits.join(' | ')
  })
  return joinCapped(lines, 28)
}

export function worldDigest(project: Project): string {
  const list = project.bible.world.filter((w) => w.title.trim())
  if (!list.length) return ''
  const lines = list.map((w) => `【${w.title}】${truncate(w.content.replace(/\s+/g, ' '), 160)}`)
  return joinCapped(lines, 24)
}

export function timelineDigest(project: Project): string {
  const list = project.bible.timeline.filter((t) => t.title.trim() || t.time.trim())
  if (!list.length) return ''
  const lines = list.map((t) => `${t.time || '时间未记'} · ${t.title}${t.desc ? `：${truncate(t.desc, 60)}` : ''}`)
  return joinCapped(lines, 24)
}

export function threadDigest(project: Project): string {
  const list = project.bible.threads
  if (!list.length) return ''
  const lines = list.map(
    (t) => `[${t.status === 'open' ? '未回收' : '已回收'}] ${t.title}：${truncate(t.setup || '（埋设位置未记）', 60)}${
      t.payoff ? ` → 计划回收：${truncate(t.payoff, 50)}` : ''
    }`
  )
  return joinCapped(lines, 30)
}

/** 章节梗概清单：给每章分配同样的字数预算，长篇也不会把提示词撑爆 */
export function chapterDigest(project: Project, summaries: Record<string, string>, budget = 11000): string {
  const chapters = project.chapters
  if (!chapters.length) return ''
  const per = Math.max(60, Math.floor(budget / chapters.length))
  return chapters
    .map((c, i) => {
      const sm = (summaries[c.id] || c.summary || '').trim()
      const body = sm || truncate(stripHtml(c.content).replace(/\s+/g, ' '), per)
      return `${i + 1}. id=${c.id} ｜《${c.title}》｜${body ? truncate(body, per) : '（还没有内容）'}`
    })
    .join('\n')
}

/* ────────────────────────── 检查器 1：全书一致性 ────────────────────────── */

const BOOK_SYSTEM = `你是这本书的责任编辑，做了十几年长篇连载的把关工作。
你的工作不是夸作者写得好，而是像审稿会一样，把前后对不上的地方一条条挑出来：谁在第几章还活着、谁的性格突然变了、哪件道具前后描述不一致、哪条伏笔埋下去再也没有回来。
你只依据给定的资料判断，不脑补资料以外的内容。你的输出必须是可被 JSON.parse 解析的纯数据。`

export function buildBookAuditMessages(
  project: Project,
  summaries: Record<string, string>
): PromptMessage[] {
  const sections: string[] = []
  if (project.brief.logline.trim()) sections.push(`一句话前提：${project.brief.logline.trim()}`)
  if (project.brief.premise.trim()) sections.push(`故事梗概：${truncate(project.brief.premise.trim(), 600)}`)
  if (project.brief.keywords.length) sections.push(`关键词：${project.brief.keywords.join('、')}`)

  const chars = characterDigest(project)
  const world = worldDigest(project)
  const timeline = timelineDigest(project)
  const threads = threadDigest(project)
  const chapters = chapterDigest(project, summaries)

  if (chars) sections.push(`【角色卡】\n${chars}`)
  if (world) sections.push(`【世界观设定】\n${world}`)
  if (timeline) sections.push(`【时间线】\n${timeline}`)
  if (threads) sections.push(`【伏笔台账】\n${threads}`)
  if (chapters) sections.push(`【全部章节梗概】（id 就是 chapterIds 里要填的值）\n${chapters}`)

  const user = `${sections.join('\n\n')}

【审校任务】
只依据上面的资料，找出这本书里真实存在的前后不一致。按下面五类逐一检查：

1. 人物：性格、称呼、身份、年龄、外貌、能力上限、人物关系、说话方式在前后之间是否矛盾；某人是否在已经死亡/离场后再次出现。
2. 时间线：事件先后顺序是否倒置；季节、昼夜、地点距离、人物年龄与时间跨度是否对不上。
3. 设定：力量体系、规则禁忌、地理、组织架构是否被后文破坏；同一物品的描述是否前后不同。
4. 伏笔：台账里标记"未回收"的伏笔是否已经回收却忘了销账；正文里明显埋了但台账没登记的悬念。
5. 逻辑：动机是否成立、信息是否凭空出现（角色知道了不该知道的事）、关键转折是否缺少铺垫。

【输出格式】
严格输出一个 JSON 数组。不要 markdown 代码块包裹，不要在数组前后写任何解释、标题或"以下是"。
数组每个元素必须是下面这个结构：
{"level":"high|medium|low","type":"人物|时间线|设定|伏笔|逻辑","title":"12 字以内的问题标题","detail":"一到两句话说清矛盾在哪，要指出具体是哪两处对不上","evidence":"从上面的梗概里摘出的原文片段，15–40 字；实在摘不出就填空字符串","chapterIds":["上面给出的章节 id"],"suggestion":"具体怎么改，一到两句，可执行"}

要求：
- 共 3–12 条，按严重度从高到低排序（high 在前）。
- 每条必须能对应到至少一个真实存在的章节 id；chapterIds 只能用上面列出的 id，不要编造。
- 只报真实存在的问题。资料不足以下结论的，不要写进来。
- 如果通读后确实没有明显问题，直接输出 []（空数组），不要为了凑数编造问题。`

  return [
    { role: 'system', content: BOOK_SYSTEM },
    { role: 'user', content: user }
  ]
}

/* ────────────────────────── 检查器 2：章节体检 ────────────────────────── */

const CHAPTER_SYSTEM = `你是网络文学平台的资深签约编辑，每天看上百万字的稿子。
你能一眼看出一章里哪里节奏拖了、哪里冲突泄了气、哪里悬念掉了、哪里在注水凑字数。你的评价直接、具体，不说空话。
你只依据给出的章节正文判断。你的输出必须是可被 JSON.parse 解析的纯数据。`

export function buildChapterAuditMessages(project: Project, chapter: Chapter): PromptMessage[] {
  const body = truncate(stripHtml(chapter.content).replace(/\n{3,}/g, '\n\n'), 12000)
  const totalWords = project.chapters.reduce((s, c) => s + (c.words || 0), 0)
  const idx = project.chapters.findIndex((c) => c.id === chapter.id)

  const parts: string[] = []
  if (project.brief.logline.trim()) parts.push(`一句话前提：${project.brief.logline.trim()}`)
  const chars = characterDigest(project)
  if (chars) parts.push(`【角色卡】\n${chars}`)
  const threads = threadDigest(project)
  if (threads) parts.push(`【伏笔台账】\n${threads}`)

  const near = project.chapters
    .slice(Math.max(0, idx - 1), idx)
    .filter((c) => c.summary.trim() || c.content.trim())
    .map((c) => `上一章《${c.title}》梗概：${truncate(c.summary || stripHtml(c.content), 200)}`)
  if (near.length) parts.push(near.join('\n'))

  const user = `【本书资料】
${parts.join('\n\n') || '（作者还没有填设定，请只依据正文本身判断）'}

【待体检章节】
《${chapter.title}》（全书第 ${idx + 1} / ${project.chapters.length} 章，共 ${chapter.words} 字，全书 ${totalWords} 字）

【正文】
${body || '（这一章还没有正文）'}

【体检任务】
从三个维度打分（0–100，50 为及格线），并指出具体问题：
- rhythm 节奏：场景推进是否有效率，有没有该快的地方拖成慢镜头、该停的地方一笔带过。
- conflict 冲突：这一章有没有明确的对抗与压力，主角的目标是否被阻碍，冲突是否在升级。
- suspense 悬念：章末有没有钩子，读者有没有"想翻下一章"的理由。
- water 注水：凑字数程度（环境铺陈、重复心理、无信息量的对话、可删的过渡段）。0 表示几乎没有水分，越高越糟。

【输出格式】
严格输出一个 JSON 对象。不要 markdown 代码块，不要任何解释文字。结构：
{"rhythm":0-100,"conflict":0-100,"suspense":0-100,"water":0-100,"comment":"60–120 字的总体评价，先指出最要紧的一个问题，再给一句可执行的改法","issues":[{"level":"high|medium|low","title":"10 字以内","detail":"具体指出问题在正文哪个位置、是什么问题","evidence":"从正文里摘出的原文片段，15–40 字","suggestion":"具体怎么改"}]}

issues 给 0–4 条，按严重度排序；没问题就给空数组 []。`

  return [
    { role: 'system', content: CHAPTER_SYSTEM },
    { role: 'user', content: user }
  ]
}

/* ────────────────────────── 检查器 3：伏笔猎手 ────────────────────────── */

const THREAD_SYSTEM = `你是连载小说的责任编辑，专门盯"埋了没填的坑"。
你清楚什么样的细节会让读者记住并在评论区追问：反复出现的物件、被刻意回避的名字、说了半句的话、反常的举动、突然被强调的时间点。
你只依据给出的章节梗概判断，不脑补。你的输出必须是可被 JSON.parse 解析的纯数据。`

export function buildThreadHuntMessages(
  project: Project,
  summaries: Record<string, string>
): PromptMessage[] {
  const chapters = chapterDigest(project, summaries)
  const registered = project.bible.threads.length
    ? project.bible.threads
        .map((t) => `· ${t.title}（${t.status === 'open' ? '未回收' : '已回收'}）`)
        .join('\n')
    : '（台账为空）'

  const user = `【已登记的伏笔台账】
${registered}

【全部章节梗概】（id 就是 chapterId 里要填的值）
${chapters || '（还没有章节内容）'}

【任务】
通读上面的章节梗概，找出"读者会记住、并且期待后文解释，但目前没有登记在台账里"的悬念或伏笔。
典型形态：反复出现的物件/记号、被刻意含糊处理的身份、某人说了一半的话、反常的举动、突然被强调的时间或地点、明显不合理的细节。

排除这些，不要报：
- 台账里已经登记过的（无论未回收还是已回收）。
- 纯靠脑补的推测，看不出文本依据的。
- 已经在这一章内解释清楚的。

【输出格式】
严格输出一个 JSON 数组，不要 markdown 代码块，不要任何解释文字：
[{"title":"12 字以内的伏笔名","setup":"这个悬念出现在哪里、以什么形式出现，一到两句","chapterId":"对应章节 id","suggestion":"后面可以怎么回收，一到两句"}]

给 0–8 条。确实没有就输出 []。`

  return [
    { role: 'system', content: THREAD_SYSTEM },
    { role: 'user', content: user }
  ]
}