import type { Character, WorldCategory, WorldEntry } from '@shared/types'
import { uid } from '@shared/utils'

/** 去掉列表符号、编号、加粗等装饰 */
function cleanLine(input: string): string {
  return input
    .replace(/^[\s\u3000]+/, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*•·–—+]\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/\*\*/g, '')
    .trim()
}

/** 按 | ｜ ｜ \t 切分（AI 有时会用全角竖线或制表符） */
function cells(line: string): string[] {
  return line
    .split(/[|｜\t]+/)
    .map((s) => s.trim())
    .map((s) => s.replace(/^["“”']|["“”']$/g, '').trim())
}

/** 把「姓名：张三」这类前缀去掉，只留值 */
function stripKey(s: string): string {
  return s.replace(/^[^：:]{1,8}[：:]\s*/, '').trim()
}

const ROLE_SET = new Set(['主角', '配角', '反派', '龙套', '群像', '次要角色'])

/** 字段名——AI 常把表头或「定位：xxx」这类字段行一起吐出来，需要过滤 */
const FIELD_WORDS = new Set([
  '姓名',
  '名字',
  '角色',
  '人物',
  '定位',
  '年龄',
  '身份',
  '外貌',
  '性格',
  '动机',
  '缺陷',
  '人物弧光',
  '弧光',
  '说话方式',
  '备注',
  '关系',
  '分类',
  '类别',
  '类型',
  '标题',
  '内容',
  '说明',
  '设定'
])

function isFieldOnly(cell: string): boolean {
  return FIELD_WORDS.has(cell.replace(/[：:【】\[\]\s]/g, ''))
}

/** 判断是否是表头行（每一格都是字段名，且没有实际内容） */
function isHeaderRow(parts: string[]): boolean {
  if (parts.length < 2) return false
  const named = parts.filter((p) => isFieldOnly(p) || p === '').length
  return named >= Math.min(2, parts.length) && parts.every((p) => p.length <= 10)
}
const WORLD_KEYS: WorldCategory[] = ['world', 'power', 'faction', 'place', 'item', 'rule', 'other']

const WORLD_ALIAS: Record<string, WorldCategory> = {
  世界观: 'world',
  世界: 'world',
  力量体系: 'power',
  力量: 'power',
  体系: 'power',
  势力组织: 'faction',
  势力: 'faction',
  组织: 'faction',
  地点场景: 'place',
  地点: 'place',
  场景: 'place',
  关键物品: 'item',
  物品: 'item',
  道具: 'item',
  规则禁忌: 'rule',
  规则: 'rule',
  禁忌: 'rule',
  其它: 'other',
  其他: 'other',
  world: 'world',
  power: 'power',
  faction: 'faction',
  place: 'place',
  item: 'item',
  rule: 'rule',
  other: 'other'
}

export function toCategory(raw: string): WorldCategory {
  const key = raw.trim().replace(/[【】\[\]]/g, '')
  return WORLD_ALIAS[key] ?? 'other'
}

export function isWorldCategory(v: string): v is WorldCategory {
  return WORLD_KEYS.indexOf(v as WorldCategory) >= 0
}

/**
 * 解析 AI 返回的人物列表。
 * 主格式（每行一人，竖线分隔）：
 *   姓名 | 定位 | 年龄 | 身份 | 外貌 | 性格 | 动机 | 缺陷 | 人物弧光 | 说话方式
 * 兜底：若没有竖线，则尝试 `【姓名】定位：xxx` 或 `姓名：xxx` 形式。
 */
export function parseCharacters(raw: string): Character[] {
  const out: Character[] = []
  for (const rawLine of raw.replace(/\r\n/g, '\n').split('\n')) {
    const line0 = rawLine.trim()
    if (!line0) continue
    if (/^```/.test(line0)) continue
    const line = cleanLine(line0)
    if (!line) continue
    if (/^(【?姓名\]?|人物列表|主要人物|以下是)/.test(line) && line.length < 12) continue

    let parts = cells(line)
    if (isHeaderRow(parts)) continue
    if (parts.length > 0 && isFieldOnly(parts[0] ?? '')) continue
    if (parts.length < 2) {
      const m = line.match(/^【(.+?)】\s*(.*)$/)
      if (m) {
        const rest = m[2] ?? ''
        const role = (rest.match(/^(主角|配角|反派|龙套|群像)/) ?? [])[1] ?? ''
        const identity = stripKey(rest.replace(/^(主角|配角|反派|龙套|群像)[：:、\s]*/, ''))
        out.push(buildChar({ name: m[1] ?? '', role, identity }))
        continue
      }
    }
    if (parts.length === 1) {
      out.push(buildChar({ name: stripKey(parts[0] ?? '') }))
      continue
    }

    const name = stripKey(parts[0] ?? '').replace(/^\d+[.、)．]\s*/, '')
    if (!name) continue
    const roleRaw = (parts[1] ?? '').replace(/[：:]/g, '')
    out.push(
      buildChar({
        name,
        role: ROLE_SET.has(roleRaw) ? roleRaw : roleRaw || '配角',
        age: stripKey(parts[2] ?? ''),
        identity: stripKey(parts[3] ?? ''),
        appearance: stripKey(parts[4] ?? ''),
        personality: stripKey(parts[5] ?? ''),
        motivation: stripKey(parts[6] ?? ''),
        flaw: stripKey(parts[7] ?? ''),
        arc: stripKey(parts[8] ?? ''),
        speechStyle: stripKey(parts[9] ?? '')
      })
    )
  }
  return out
}

function buildChar(patch: Partial<Character>): Character {
  return {
    id: uid('ch'),
    name: patch.name ?? '',
    role: patch.role ?? '配角',
    age: patch.age ?? '',
    identity: patch.identity ?? '',
    appearance: patch.appearance ?? '',
    personality: patch.personality ?? '',
    motivation: patch.motivation ?? '',
    flaw: patch.flaw ?? '',
    arc: patch.arc ?? '',
    speechStyle: patch.speechStyle ?? '',
    relations: [],
    hidden: false,
    notes: ''
  }
}

/**
 * 解析世界观条目。主格式（每行一条）：
 *   分类 | 标题 | 内容
 */
export function parseWorld(raw: string): WorldEntry[] {
  const out: WorldEntry[] = []
  for (const rawLine of raw.replace(/\r\n/g, '\n').split('\n')) {
    const line0 = rawLine.trim()
    if (!line0) continue
    if (/^```/.test(line0)) continue
    const line = cleanLine(line0)
    if (!line) continue
    const parts = cells(line)
    if (isHeaderRow(parts)) continue

    if (parts.length >= 3) {
      const category = toCategory(parts[0] ?? '')
      const title = stripKey(parts[1] ?? '').replace(/^\d+[.、)．]\s*/, '')
      const content = parts.slice(2).join(' ').trim()
      if (!title && !content) continue
      out.push({ id: uid('w'), category, title: title || content.slice(0, 12), content, visible: true })
      continue
    }

    if (parts.length === 2) {
      const title = stripKey(parts[0] ?? '')
      if (!title) continue
      out.push({ id: uid('w'), category: toCategory(''), title, content: parts[1] ?? '', visible: true })
      continue
    }

    // 单段文本：`【势力组织】青云宗：xxxx`
    const m = line.match(/^【(.+?)】\s*(.+)$/)
    if (m) {
      const category = toCategory(m[1] ?? '')
      const rest = m[2] ?? ''
      const sep = rest.match(/^(.{1,30}?)[：:]\s*([\s\S]+)$/)
      out.push({
        id: uid('w'),
        category,
        title: sep ? (sep[1] ?? '') : rest.slice(0, 16),
        content: sep ? (sep[2] ?? '') : rest,
        visible: true
      })
    }
  }
  return out
}

/** 当前设定摘要（用于把已有内容喂给 AI，避免它重复造轮子） */
export function bibleDigest(project: {
  brief: { logline: string; premise: string; keywords: string[] }
  bible: {
    characters: Character[]
    world: WorldEntry[]
    terms: { term: string }[]
    threads: { title: string }[]
  }
}): string {
  const lines: string[] = []
  if (project.brief.logline) lines.push(`一句话前提：${project.brief.logline}`)
  if (project.brief.premise) lines.push(`故事梗概：${project.brief.premise.slice(0, 600)}`)
  if (project.brief.keywords.length) lines.push(`关键词：${project.brief.keywords.join('、')}`)
  if (project.bible.characters.length) {
    lines.push(`已有人物：${project.bible.characters.map((c) => `${c.name}（${c.role}${c.identity ? `·${c.identity}` : ''}）`).join('、')}`)
  }
  if (project.bible.world.length) {
    lines.push(`已有设定：${project.bible.world.map((w) => w.title).join('、')}`)
  }
  if (project.bible.terms.length) {
    lines.push(`已有术语：${project.bible.terms.map((t) => t.term).join('、')}`)
  }
  if (project.bible.threads.length) {
    lines.push(`已有伏笔：${project.bible.threads.map((t) => t.title).join('、')}`)
  }
  return lines.join('\n')
}