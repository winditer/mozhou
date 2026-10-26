import type { CraftSkill, SkillLibrary } from '@shared/skills'
import { SKILL_TOTAL_CHAR_LIMIT } from '@shared/skills'
import { SEED_SKILLS, SKILL_SEED_VERSION } from '@shared/skillSeeds'
import { skillLibraryFile } from '../paths'
import { readJson, writeJsonAtomic } from './jsonStore'

/**
 * 写作技法卡库的持久化。
 *
 * 三条承诺，与 styleLibrary 保持一致（那是同一类资产的同一类坑）：
 *
 * 1. **首次启动补种，之后不动用户数据**。作者改过的内置卡不会被升级覆盖——
 *    只有 `seedVersion` 变大时，才把「库里完全没有的新种子」按 id 补进来，
 *    已存在的 id 一律保留用户版本。
 * 2. **删掉的内置卡不会自己回来**。删内置卡时把 id 记进 `deletedBuiltin`，
 *    补种时跳过。否则作者删完下次启动又长回来，是很挫伤人信任的事。
 * 3. **原子写 + .bak**。写坏一次等于作者的技法库全丢。
 *
 * 和 styleLibrary 的一处**刻意差异**：这里读盘时会把规则字数为 0 的卡丢掉。
 * 技法卡的全部价值就是那段 rules，一个没有规则的卡在提示词里只占位不干活，
 * 留着它只会在设置页里显示成一张「勾了但没反应」的空卡。
 */

interface SkillFile extends SkillLibrary {
  /** 用户主动删除的内置卡 id：补种时跳过 */
  deletedBuiltin?: string[]
}

let cache: SkillFile | null = null

function path(): string {
  return skillLibraryFile()
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 校验/修补一条卡。坏数据宁可补齐也不要整库读不出来。 */
function normalizeSkill(raw: Partial<CraftSkill> | null | undefined): CraftSkill | null {
  if (!raw || typeof raw !== 'object') return null
  const id = str(raw.id).trim()
  if (!id) return null
  const rules = str(raw.rules)
  // 没有规则的卡等于空卡：不留在库里
  if (!rules.trim()) return null

  const groups = ['quality', 'structure', 'scene', 'dialogue', 'check'] as const
  const group = groups.includes(raw.group as (typeof groups)[number]) ? (raw.group as CraftSkill['group']) : 'quality'

  const changelog = Array.isArray(raw.changelog)
    ? raw.changelog
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          version: typeof c.version === 'number' ? c.version : 1,
          note: str(c.note),
          at: typeof c.at === 'number' ? c.at : 0
        }))
    : undefined

  const dep = raw.deprecated
  const deprecated =
    dep && typeof dep === 'object' && str(dep.reason).trim()
      ? { since: str(dep.since), reason: str(dep.reason), replacedBy: dep.replacedBy ? str(dep.replacedBy) : undefined }
      : undefined

  const now = Date.now()
  return {
    id,
    name: str(raw.name).trim() || '未命名技法卡',
    group,
    tagline: str(raw.tagline),
    whenToUse: str(raw.whenToUse),
    rules,
    antiPatterns: strList(raw.antiPatterns).filter((x) => x.trim()),
    sceneIds: Array.isArray(raw.sceneIds) ? strList(raw.sceneIds) : undefined,
    genreIds: Array.isArray(raw.genreIds) ? strList(raw.genreIds) : undefined,
    minChapterWords: typeof raw.minChapterWords === 'number' && raw.minChapterWords > 0 ? raw.minChapterWords : undefined,
    version: typeof raw.version === 'number' && raw.version > 0 ? Math.floor(raw.version) : 1,
    changelog,
    builtin: raw.builtin === true,
    deprecated,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now
  }
}

function normalizeLibrary(raw: Partial<SkillFile>): SkillFile {
  const skills = (raw.skills ?? [])
    .map(normalizeSkill)
    .filter((s): s is CraftSkill => Boolean(s))
  // 同 id 只留一张：重复 id 会让 resolveSkills 的 Map 静默取后者，
  // 作者在列表里看到两张一样的卡却是同一个 id，改了第一张不生效
  const seen = new Set<string>()
  const dedup = skills.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    seedVersion: typeof raw.seedVersion === 'number' ? raw.seedVersion : 0,
    skills: dedup,
    deletedBuiltin: strList(raw.deletedBuiltin)
  }
}

/** 复制一张种子卡（避免整库共享同一批对象，用户就地改会污染种子常量） */
function cloneSeed(seed: CraftSkill): CraftSkill {
  return {
    ...seed,
    antiPatterns: seed.antiPatterns ? [...seed.antiPatterns] : undefined,
    sceneIds: seed.sceneIds ? [...seed.sceneIds] : undefined,
    genreIds: seed.genreIds ? [...seed.genreIds] : undefined,
    changelog: seed.changelog ? seed.changelog.map((c) => ({ ...c })) : undefined
  }
}

/** 补种：只补「库里没有、也没被作者删过」的内置卡。 */
function seedMissing(lib: SkillFile): boolean {
  if (lib.seedVersion >= SKILL_SEED_VERSION) return false
  const had = new Set(lib.skills.map((s) => s.id))
  const deleted = new Set(lib.deletedBuiltin ?? [])
  for (const seed of SEED_SKILLS) {
    if (had.has(seed.id) || deleted.has(seed.id)) continue
    lib.skills.push(cloneSeed(seed))
  }
  lib.seedVersion = SKILL_SEED_VERSION
  return true
}

export async function loadSkillLibrary(): Promise<SkillFile> {
  if (cache) return cache
  const raw = await readJson<Partial<SkillFile>>(path(), {})
  const lib = normalizeLibrary(raw)
  const before = lib.skills.length
  const needsSeed = lib.seedVersion < SKILL_SEED_VERSION
  if (needsSeed) seedMissing(lib)
  cache = lib
  // 首启动（或补种）后立刻落盘，避免下次启动看到的列表和这次不一致
  if (needsSeed || lib.skills.length !== before) {
    await writeJsonAtomic(path(), lib)
  }
  return lib
}

export async function saveSkillLibrary(next: SkillLibrary & { deletedBuiltin?: string[] }): Promise<SkillLibrary> {
  const lib = normalizeLibrary(next)
  const prev = cache
  if (prev) {
    // 内置卡「消失」＝作者删了它，记墓碑，防止补种时又长回来
    const prevBuiltin = new Set(prev.skills.filter((s) => s.builtin).map((s) => s.id))
    const nowIds = new Set(lib.skills.map((s) => s.id))
    const tombstones = new Set(lib.deletedBuiltin ?? [])
    for (const id of prevBuiltin) if (!nowIds.has(id)) tombstones.add(id)
    // 作者把它加回来了，墓碑要撤销
    for (const id of nowIds) tombstones.delete(id)
    lib.deletedBuiltin = [...tombstones]
  }
  await writeJsonAtomic(path(), lib)
  cache = lib
  return lib
}

/** 备份还原后强制重新读盘 */
export function invalidateSkillLibrary(): void {
  cache = null
}

/**
 * 恢复内置技法卡：
 * - 作者自建的卡（builtin=false）保留；
 * - 内置卡全部恢复出厂内容（作者的修改被丢弃）；
 * - 墓碑清空，删掉的内置卡会回来。
 * 破坏性操作，UI 必须二次确认。
 */
export async function resetBuiltinSkills(): Promise<SkillLibrary> {
  const prev = await loadSkillLibrary()
  const custom = prev.skills.filter((s) => !s.builtin)
  const lib: SkillFile = {
    version: 1,
    seedVersion: SKILL_SEED_VERSION,
    skills: [...SEED_SKILLS.map(cloneSeed), ...custom],
    deletedBuiltin: []
  }
  await writeJsonAtomic(path(), lib)
  cache = lib
  return lib
}

/**
 * 一张卡占了多少字——设置页需要它来显示「这几张加起来会不会超限」。
 *
 * 用和 resolveSkills 同一套口径（rules + 反例 + 标题标签），
 * 否则作者在设置页看到「还有余量」，写作台上却提示「已截断」。
 */
export function estimateSkillChars(skill: CraftSkill): number {
  const anti = (skill.antiPatterns ?? []).filter((x) => x && x.trim())
  const antiLen = anti.length ? `不要写成这样：\n${anti.map((a) => `- ${a.trim()}`).join('\n')}`.length : 0
  return `〔${skill.name}〕${skill.tagline}`.length + 1 + skill.rules.trim().length + (antiLen ? 1 + antiLen : 0)
}

/** 单卡上限（给设置页的输入校验用）：一张卡不该比整个技法块上限还大 */
export const SKILL_SINGLE_CHAR_LIMIT = SKILL_TOTAL_CHAR_LIMIT