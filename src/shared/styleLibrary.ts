import type { StyleProfile } from './types'

/**
 * 系统文风分身库（Style Library）—— 设置页里统一管理、所有书共享的文风分身集合。
 *
 * 和书内 `StyleProfile` 的关系是「引用」而不是「拷贝」：
 * - 书里只存 `StyleRef { sourceId }` + 少量本地覆盖；
 * - 生成时按 `sourceId` 回系统库取当前值，所以系统库里改了，所有引用它的书立刻跟着变；
 * - 系统库里删了，书里那条会显示「来源已删除」并临时回落到本地覆盖字段，不会静默丢文风。
 *
 * 为什么不把库塞进 config.json：100 位作者 + 特征卡 + 用户自建分身轻松几百 KB，
 * 而 config 每次改主题/排版都要整体重写。单独一个文件也让「备份/还原/重置」互不牵连。
 */

export type StyleCategory = 'classics' | 'webnovel' | 'romance' | 'suspense' | 'history' | 'newtype' | 'custom'

export const STYLE_CATEGORIES: { id: StyleCategory; label: string; desc: string; color: string }[] = [
  { id: 'classics', label: '传统文学', desc: '现当代文学正典：句法、镜头、意象体系', color: '#8a6a3b' },
  { id: 'webnovel', label: '网文金牌', desc: '商业连载顶流：黄金三章、爽点密度、章末钩子', color: '#b7791f' },
  { id: 'romance', label: '言情女性向', desc: '情感推进、心理密度、糖虐配比', color: '#9b4d6b' },
  { id: 'suspense', label: '悬疑科幻', desc: '线索公平、悬念回收、设定自洽', color: '#1d4ed8' },
  { id: 'history', label: '历史武侠', desc: '史料密度、江湖格局、权谋调度', color: '#2f8a5b' },
  { id: 'newtype', label: '新类型', desc: '无限流、短剧爽文、种田、现实题材', color: '#6d28d9' },
  { id: 'custom', label: '自定义', desc: '你自己创建或 AI 生成的分身', color: '#3a7d7d' }
]

export const CATEGORY_LABELS: Record<StyleCategory, string> = Object.fromEntries(
  STYLE_CATEGORIES.map((c) => [c.id, c.label])
) as Record<StyleCategory, string>

export function categoryColor(id: StyleCategory): string {
  return STYLE_CATEGORIES.find((c) => c.id === id)?.color ?? 'var(--text-faint)'
}

/** 一个系统文风分身 */
export interface StylePersona {
  id: string
  name: string
  category: StyleCategory
  /** 2–5 个风格标签，用于筛选 */
  tags: string[]
  /** 一句话风格摘要，展示用，也会进提示词 */
  summary: string
  /** 6–8 条可执行文风特征 */
  traits: string[]
  /** 代表作书名，仅作辨识，不是原文样本 */
  refs: string[]
  /** 用户可补的原文样本（默认空：种子库不内置名家原文） */
  samples: string[]
  /** 内置种子（false = 用户自建或 AI 生成） */
  builtin: boolean
  /** 被 AI 生成/改写过的痕迹，便于用户区分 */
  aiAssisted?: boolean
  createdAt: number
  updatedAt: number
}

export interface StyleLibrary {
  version: number
  /** 种子库版本：用于判断是否已经补种过 */
  seedVersion: number
  personas: StylePersona[]
}

/**
 * 书里对系统分身的引用。
 *
 * `snapshot` 是「引用时看到的样子」，只在系统库那边已经找不到 `sourceId` 时兜底用，
 * 保证删库不会让已经写了一半的书突然失去文风。
 */
export interface StyleRef {
  /** 系统库里的 StylePersona.id */
  sourceId: string
  /** 引用时刻的名称快照，用于来源失联时显示 */
  snapshotName?: string
}

/* ───────────────────── 查询 / 过滤 ───────────────────── */

export interface PersonaFilter {
  query?: string
  category?: StyleCategory | 'all'
  tag?: string | 'all'
}

/**
 * 搜索：名字、标签、摘要、特征、代表作都参与匹配。
 * 中文不分词，所以用「包含」而不是整词匹配——搜「短句」也要能命中标签。
 */
export function matchPersona(p: StylePersona, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [p.name, p.summary, ...p.tags, ...p.traits, ...p.refs, ...p.samples.slice(0, 1)]
    .join('\n')
    .toLowerCase()
  // 多关键词：空格分词后要求全部命中，方便「古龙 短句」这种组合收窄
  return q.split(/\s+/).every((k) => haystack.includes(k))
}

export function filterPersonas(list: StylePersona[], f: PersonaFilter): StylePersona[] {
  return list.filter((p) => {
    if (f.category && f.category !== 'all' && p.category !== f.category) return false
    if (f.tag && f.tag !== 'all' && !p.tags.includes(f.tag)) return false
    if (f.query && !matchPersona(p, f.query)) return false
    return true
  })
}

/** 统计标签频次，按出现次数降序；用于生成标签筛选条 */
export function tagCounts(list: StylePersona[]): { tag: string; count: number }[] {
  const map = new Map<string, number>()
  for (const p of list) for (const t of p.tags) map.set(t, (map.get(t) ?? 0) + 1)
  return [...map.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'))
}

export function findPersona(list: StylePersona[], id: string): StylePersona | undefined {
  return list.find((p) => p.id === id)
}

/* ───────────────────── 引用解析 ───────────────────── */

/**
 * 把书里的引用解析成「实际生效的文风」。
 *
 * - 找到了：用系统库当前值（实时跟随）；
 * - 没找到：回落到本地覆盖字段（traits/samples/summary 仍在书里），并标记 missing，
 *   这样 UI 能提示「来源已删除」，但生成不会因此变成裸写。
 */
export interface ResolvedStyle {
  name: string
  summary: string
  traits: string[]
  samples: string[]
  refs: string[]
  /** 来源是否还在系统库里 */
  missing: boolean
}

export function resolveRef(
  ref: StyleRef,
  local: Pick<StyleProfile, 'name' | 'traits' | 'samples'> & { summary?: string },
  library: StylePersona[] | null | undefined
): ResolvedStyle {
  const hit = library ? findPersona(library, ref.sourceId) : undefined
  if (hit) {
    // 样本取并集：系统分身里的样本优先，书里自己补的接在后面。
    // 一开始只取系统库那份，结果「引用后又补了样本」的用户会以为自己的样本丢了——
    // 样本本来就是 few-shot 素材，多给几段只会更准，没有「稀释」的问题。
    const merged = [...hit.samples.filter((x) => x.trim()), ...(local.samples ?? []).filter((x) => x.trim() && !hit.samples.includes(x))]
    return {
      name: hit.name,
      summary: hit.summary,
      traits: hit.traits.filter(Boolean),
      samples: merged,
      refs: hit.refs,
      missing: false
    }
  }
  return {
    name: ref.snapshotName || local.name || '已删除的文风分身',
    summary: local.summary ?? '',
    traits: (local.traits ?? []).filter(Boolean),
    samples: (local.samples ?? []).filter((x) => x.trim()),
    refs: [],
    missing: true
  }
}

/** 从系统分身生成一个可存进书里的引用 + 兜底快照 */
export function personaToRef(p: StylePersona): { ref: StyleRef; local: Omit<StyleProfile, 'id' | 'active'> } {
  return {
    ref: { sourceId: p.id, snapshotName: p.name },
    local: {
      name: p.name,
      summary: p.summary,
      traits: [...p.traits],
      samples: [...p.samples]
    }
  }
}