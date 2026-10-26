/**
 * 写作技法卡（CraftSkill）—— 一套可勾选、可叠加、有字数上限的写作方法论。
 *
 * 和已有的四层机制各自负责什么，这里一次说清，免得以后加卡加串了：
 *
 *   场景 systemPrompt   → 这是什么文体（独占，不可叠加：你不能同时是网文责编和论文审稿人）
 *   题材公约            → 这个题材的读者期待什么（独占）
 *   文风分身            → 字写得像谁（独占，笔感层）
 *   技法卡（本文件）    → 这一章怎么组织（可多选，组织层）
 *   输出纪律            → 格式硬底线（独占，永远排最后）
 *
 * 为什么技法卡要**多选但限字数**：
 * 提示词是纯增量成本。叠三五张卡，system prompt 轻松涨一两千字，模型的遵循度
 * 反而下降——它会顾此失彼，把最重要的输出纪律也松掉。这和 1.1.2、1.3.1 里
 * 「思考吃光额度导致正文空白」是同一类病根：预算是有上限的，提示词没有上限，
 * 就等于让提示词去挤占输出额度。所以这里给 totalCharLimit 一个硬上限，
 * 超了按作者勾选顺序截断，并把截断结果如实回报给界面——
 * 面板上写「已注入 N 张」而提示词里其实是空的，比不显示更糟（renderGenreBlock 老教训）。
 *
 * 本文件只能引 @shared/*，不碰 electron / react / node 内置模块：
 * 它要同时编译进主进程、渲染进程，并被 scripts/test-skills.mjs 直接打包测试。
 */

import type { GenreConventionOverrides } from './genres'

/** 技法卡的分类。用于设置页分组与写作台筛选取，不影响注入顺序。 */
export type CraftSkillGroup = 'quality' | 'structure' | 'scene' | 'dialogue' | 'check'

export const CRAFT_SKILL_GROUPS: { id: CraftSkillGroup; label: string; desc: string; color: string }[] = [
  { id: 'quality', label: '去机器腔', desc: '让生成出来的初稿就不像 AI 写的', color: '#8a6a3b' },
  { id: 'structure', label: '结构节奏', desc: '这一章怎么组织：信息、节奏、钩子', color: '#1d4ed8' },
  { id: 'scene', label: '场面调度', desc: '场景、动作、环境怎么写实', color: '#2f8a5b' },
  { id: 'dialogue', label: '对话', desc: '台词怎么像人说的', color: '#9b4d6b' },
  { id: 'check', label: '校验规约', desc: '写完后能本地核对的标准', color: '#6d28d9' }
]

export function groupLabel(id: CraftSkillGroup): string {
  return CRAFT_SKILL_GROUPS.find((g) => g.id === id)?.label ?? '其他'
}

export function groupColor(id: CraftSkillGroup): string {
  return CRAFT_SKILL_GROUPS.find((g) => g.id === id)?.color ?? 'var(--text-faint)'
}

/**
 * 一条技法卡。
 *
 * 字段为什么是这几个：技法卡的本质是「一句可判断的适用条件 + 一组可执行的祈使句」。
 * 少 whenToUse，作者不知道该勾哪张；少 rules 的祈使语气，卡片就退化成「文笔要更好」
 * 这类空话——它会被原样送进 system prompt，只会让模型更散。
 */
export interface CraftSkill {
  id: string
  name: string
  group: CraftSkillGroup
  /** 一句话说明这张卡管什么，写作台列表里显示 */
  tagline: string
  /** 何时该勾它。既是给作者看的判断依据，也是对话模式下唯一会注入的部分 */
  whenToUse: string
  /** 注入正文的可执行法则，必须全是祈使句 */
  rules: string
  /**
   * 反例。负向约束比正向描述有效得多——这是 textcraft.ts 的六条禁令验证过的事。
   * 存的是「错长什么样」，不是「不能写错」这种废话。
   */
  antiPatterns?: string[]
  /**
   * 适配范围。空数组 / 不传 = 不限。
   * 注意这是**硬过滤**：动漫卡不该出现在学术论文的候选列表里，
   * 否则作者勾了发现没生效，会以为功能坏了。
   */
  sceneIds?: string[]
  genreIds?: string[]
  /** 本书每章目标字数低于这个值时，这张卡不出现在候选里（短篇用不上长篇的节奏卡） */
  minChapterWords?: number
  /**
   * 版本号：规则改了就得 +1。
   * 书内记着「上次用的是哪版」，版本不符时界面提示一句「已更新到 vN」，
   * 但**不阻止**生成——作者有权知道自己的方法论在变，也有权继续用新版的。
   */
  version: number
  /** 改动记录。写给作者看的，不是给开发者看的 commit message。 */
  changelog?: { version: number; note: string; at: number }[]
  /** 内置卡（false = 作者自建或改过） */
  builtin: boolean
  /** 已退役：不出现在新建候选里，但已引用它的书照常生效（绝不静默删除） */
  deprecated?: { since: string; reason: string; replacedBy?: string }
  createdAt: number
  updatedAt: number
}

/** 技法卡库，落盘在 userData/skills.json */
export interface SkillLibrary {
  version: number
  /** 种子版本：用于判断是否已补种 */
  seedVersion: number
  skills: CraftSkill[]
}

/* ────────────────────────── 注入总上限 ────────────────────────── */

/**
 * 所有技法卡合起来在 system prompt 里占的字数上限。
 *
 * 取值依据：现有 12 个场景的 systemPrompt 合计 6211 字，单个场景 464–615 字；
 * 文风分身块实测 200–800 字。技法块若超过 1200 字，它在整个 system 段里
 * 就会比「文体定义」本身还显眼，模型会把技法当成最高优先级——
 * 而技法是组织建议，文体才是身份。所以上限卡在略低于单个场景提示词的量级。
 */
export const SKILL_TOTAL_CHAR_LIMIT = 1200

/* ────────────────────────── 候选过滤 ────────────────────────── */

export interface SkillFilterInput {
  sceneId: string
  genreId: string
  /** 本书每章目标字数 */
  targetWords: number
}

/**
 * 这张卡在本书里适不适用（硬条件，与作者勾不勾无关）。
 *
 * 于是一切「不出现在候选列表里」的理由都在这里，界面直接调用，
 * 不各自再写一套判断——两处各写一遍，必然出现「列表里没有但能勾上」这种鬼状态。
 */
export function skillApplicable(skill: CraftSkill, ctx: SkillFilterInput): boolean {
  if (skill.deprecated) return false
  if (skill.sceneIds?.length && !skill.sceneIds.includes(ctx.sceneId)) return false
  if (skill.genreIds?.length && !skill.genreIds.includes(ctx.genreId)) return false
  if (skill.minChapterWords && ctx.targetWords < skill.minChapterWords) return false
  return true
}

/** 本书可选的全部卡（含不适用说明，界面据此灰显） */
export interface SkillCandidate {
  skill: CraftSkill
  applicable: boolean
  /** 不适用的原因，一句话；appliable 时为空串 */
  reason: string
}

export function skillInapplicableReason(skill: CraftSkill, ctx: SkillFilterInput): string {
  if (skill.deprecated) return `已退役：${skill.deprecated.reason}`
  if (skill.sceneIds?.length && !skill.sceneIds.includes(ctx.sceneId)) return '不适配当前写作场景'
  if (skill.genreIds?.length && !skill.genreIds.includes(ctx.genreId)) return '不适配当前题材'
  if (skill.minChapterWords && ctx.targetWords < skill.minChapterWords) {
    return `需要每章 ≥ ${skill.minChapterWords} 字`
  }
  return ''
}

export function listCandidates(library: SkillLibrary | null, ctx: SkillFilterInput): SkillCandidate[] {
  if (!library?.skills?.length) return []
  return library.skills.map((skill) => {
    const reason = skillInapplicableReason(skill, ctx)
    return { skill, applicable: !reason, reason }
  })
}

/* ────────────────────────── 渲染出注入文本 ────────────────────────── */

export interface ResolvedSkills {
  /** 真正会被注入的卡，按作者勾选顺序 */
  applied: CraftSkill[]
  /** 被字数上限截掉的卡 */
  trimmed: CraftSkill[]
  /** 勾了但已失效（被删 / 已退役 / 不适配）的 id */
  missing: string[]
  /** 拼好的提示词块；空串表示这一段不该出现 */
  text: string
  /** 实际占用字数（不含本块标题） */
  chars: number
}

/** 单张卡渲染成文本。带编号是为了让模型能逐条对照，也让作者能指名哪条没做到。 */
function renderOne(skill: CraftSkill): string {
  const lines: string[] = [`〔${skill.name}〕${skill.tagline}`]
  lines.push(skill.rules.trim())
  const anti = (skill.antiPatterns ?? []).filter((x) => x && x.trim())
  if (anti.length) lines.push(`不要写成这样：\n${anti.map((a) => `- ${a.trim()}`).join('\n')}`)
  return lines.join('\n')
}

function blockOf(skills: CraftSkill[]): string {
  if (!skills.length) return ''
  return `【写作技法 —— 请按下列要求组织本章】\n${skills.map(renderOne).join('\n\n')}`
}

/**
 * 按勾选顺序解析出真正要注入的技法块。
 *
 * 三条规则，写在这里免得以后有人「优化」掉：
 * 1. **顺序 = 作者的勾选顺序，绝不自动排序**。自动排序看着聪明，
 *    但会让同样的勾选产生不可复现的结果——作者会以为模型坏了，而不是以为排序变了。
 * 2. **超限时按顺序截断，不压缩**。把多张卡各删一半，等于每张都不完整，
 *    作者更看不出是哪张没生效。宁少一张完整的，不要多几张残的。
 * 3. **截断了要说出来**。trimmed 必须回传给界面，面板如实写「已截断 N 张」。
 *
 * activeIds 里已经失效的 id 不进 applied，而是进 missing——界面据此提示作者重新勾选。
 */
export function resolveSkills(
  activeIds: string[] | undefined | null,
  library: SkillLibrary | null,
  ctx: SkillFilterInput,
  charLimit = SKILL_TOTAL_CHAR_LIMIT
): ResolvedSkills {
  const ids = Array.isArray(activeIds) ? activeIds : []
  const empty: ResolvedSkills = { applied: [], trimmed: [], missing: [], text: '', chars: 0 }
  if (!ids.length || !library?.skills?.length) {
    return { ...empty, missing: ids.slice() }
  }

  const byId = new Map(library.skills.map((s) => [s.id, s]))
  const applied: CraftSkill[] = []
  const trimmed: CraftSkill[] = []
  const missing: string[] = []
  let chars = 0

  for (const id of ids) {
    const skill = byId.get(id)
    // 找不到、已退役、不适配：都不注入。前两者算 missing（要提示作者），
    // 不适配的也进 missing——作者刚把书从长篇改成论文，卡片被默默丢掉才是最糟的。
    if (!skill || !skillApplicable(skill, ctx)) {
      missing.push(id)
      continue
    }
    const len = renderOne(skill).length
    if (chars + len > charLimit && applied.length > 0) {
      trimmed.push(skill)
      continue
    }
    applied.push(skill)
    chars += len
  }

  return { applied, trimmed, missing, text: blockOf(applied), chars }
}

/**
 * 写作搭档对话用的轻量版：只给「标题 + 何时用」。
 *
 * 为什么不给全量 rules：对话是用来**讨论**写法的，不是执行模式。
 * 把六条禁令塞进讨论场景，模型会开始逐条讲解自己的改稿，而不是回答作者的问题。
 * 但它得知道「这本书现在挂了哪几张卡」，否则作者说「按黄金三章的思路聊聊」它接不上。
 */
export function renderSkillsForChat(activeIds: string[] | undefined | null, library: SkillLibrary | null, ctx: SkillFilterInput): string {
  const r = resolveSkills(activeIds, library, ctx)
  if (!r.applied.length) return ''
  return `【本书启用的写作技法（仅作背景，本轮不必逐条执行）】\n${r.applied
    .map((s) => `- ${s.name}：${s.whenToUse}`)
    .join('\n')}`
}

/* ────────────────────────── 书内版本提示 ────────────────────────── */

/**
 * 书里记录的版本与库里当前版本不一致时，给作者一句提示。
 *
 * 只提示、不阻止：内置卡改进后，已建好的书若被悄悄按新版生成，
 * 作者会发现文字手感变了却找不到原因。反过来若强行锁死老版，
 * 功能改进就永远传不到老用户。所以两者都做：告诉他变了，让他决定要不要保留勾选。
 */
export function skillVersionNotice(
  activeIds: string[] | undefined | null,
  knownVersions: Record<string, number> | undefined,
  library: SkillLibrary | null
): string {
  const ids = Array.isArray(activeIds) ? activeIds : []
  const known = knownVersions ?? {}
  const byId = new Map((library?.skills ?? []).map((s) => [s.id, s]))
  const bumped: string[] = []
  for (const id of ids) {
    const skill = byId.get(id)
    const seen = known[id]
    if (skill && typeof seen === 'number' && skill.version > seen) {
      bumped.push(`${skill.name} v${skill.version}`)
    }
  }
  if (!bumped.length) return ''
  return `技法卡已更新：${bumped.join('、')}。本章起按新版规则生成。`
}

/** 当前勾选卡的版本快照，落盘进 project.settings.skillVersions */
export function snapshotSkillVersions(activeIds: string[] | undefined | null, library: SkillLibrary | null): Record<string, number> {
  const ids = Array.isArray(activeIds) ? activeIds : []
  const byId = new Map((library?.skills ?? []).map((s) => [s.id, s]))
  const out: Record<string, number> = {}
  for (const id of ids) {
    const s = byId.get(id)
    if (s) out[id] = s.version
  }
  return out
}

/* 题材公约覆盖表在这个文件里只是为了类型打通，避免调用方各自 import 两个模块 */
export type { GenreConventionOverrides }