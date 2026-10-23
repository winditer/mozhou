import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { StyleLibrary, StylePersona } from '@shared/styleLibrary'
import { SEED_PERSONAS, SEED_VERSION } from '@shared/personas'
import { styleLibraryFile } from '../paths'
import { ensureDir, readJson, writeJsonAtomic } from './jsonStore'

/**
 * 系统文风分身库的持久化。
 *
 * 三条承诺，写在这里是为了以后改代码时别悄悄破坏：
 *
 * 1. **首次启动补种，之后不动用户数据**。用户改过的内置分身不会被升级覆盖——
 *    只有 `seedVersion` 变大时，才会把「库里完全没有的新种子」补进来（按 id 判断），
 *    已存在的 id 一律保留用户版本。
 * 2. **删掉的内置分身不会自己回来**。改内置分身时把 id 记进 `tombstones`
 *    （下面内存里维护，落盘在同一个文件的 hidden 列表），补种时跳过。
 * 3. **原子写 + .bak**。这个文件是几百 KB 的用户资产，写坏一次就是全库丢失。
 */

interface LibraryFile extends StyleLibrary {
  /** 用户主动删除的内置分身 id：补种时跳过，避免「删了又长回来」 */
  deletedBuiltin?: string[]
}

let cache: LibraryFile | null = null

function path(): string {
  return styleLibraryFile()
}

/** 校验/修补一条分身，坏数据宁可补齐也不要整库读不出来 */
function normalizePersona(p: Partial<StylePersona>): StylePersona | null {
  if (!p || typeof p.id !== 'string' || !p.id.trim()) return null
  return {
    id: p.id,
    name: (p.name ?? '').trim() || '未命名分身',
    category: p.category ?? 'custom',
    tags: Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === 'string' && t.trim()) : [],
    summary: p.summary ?? '',
    traits: Array.isArray(p.traits) ? p.traits.filter((t) => typeof t === 'string') : [],
    refs: Array.isArray(p.refs) ? p.refs.filter((t) => typeof t === 'string') : [],
    samples: Array.isArray(p.samples) ? p.samples.filter((t) => typeof t === 'string') : [],
    builtin: p.builtin === true,
    aiAssisted: p.aiAssisted === true,
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0
  }
}

function normalizeLibrary(raw: Partial<LibraryFile>): LibraryFile {
  const personas = (raw.personas ?? []).map(normalizePersona).filter((p): p is StylePersona => Boolean(p))
  const seen = new Set<string>()
  const dedup = personas.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
  return {
    version: raw.version ?? 1,
    seedVersion: typeof raw.seedVersion === 'number' ? raw.seedVersion : 0,
    personas: dedup,
    deletedBuiltin: Array.isArray(raw.deletedBuiltin) ? raw.deletedBuiltin.filter((x) => typeof x === 'string') : []
  }
}

/**
 * 补种：只补「库里没有、也没被用户删过」的内置分身。
 * 返回是否真的加了东西，用于决定要不要落盘。
 */
function seedMissing(lib: LibraryFile): boolean {
  if (lib.seedVersion >= SEED_VERSION) return false
  const had = new Set(lib.personas.map((p) => p.id))
  const deleted = new Set(lib.deletedBuiltin ?? [])
  let added = 0
  for (const seed of SEED_PERSONAS) {
    if (had.has(seed.id) || deleted.has(seed.id)) continue
    lib.personas.push({ ...seed, traits: [...seed.traits], tags: [...seed.tags], refs: [...seed.refs], samples: [...seed.samples] })
    added++
  }
  lib.seedVersion = SEED_VERSION
  // 即使一条没加也要记下版本，否则每次启动都会重扫一遍
  return added > 0 || true
}

export async function loadStyleLibrary(): Promise<LibraryFile> {
  if (cache) return cache
  const raw = await readJson<Partial<LibraryFile>>(path(), {})
  const lib = normalizeLibrary(raw)
  const before = lib.personas.length
  const needsSeed = lib.seedVersion < SEED_VERSION
  if (needsSeed) seedMissing(lib)
  cache = lib
  // 首启动（或补种）后立刻落盘：避免用户下次启动看到的列表和这次不一致
  if (needsSeed || lib.personas.length !== before) {
    await writeJsonAtomic(path(), lib)
  }
  return lib
}

export async function saveStyleLibrary(next: StyleLibrary & { deletedBuiltin?: string[] }): Promise<StyleLibrary> {
  const lib = normalizeLibrary(next)
  const prev = cache
  // 与旧库对比：内置分身「消失」了，说明用户删了它，记进墓碑
  if (prev) {
    const prevBuiltin = new Set(prev.personas.filter((p) => p.builtin).map((p) => p.id))
    const nowIds = new Set(lib.personas.map((p) => p.id))
    const tombstones = new Set(lib.deletedBuiltin ?? [])
    for (const id of prevBuiltin) if (!nowIds.has(id)) tombstones.add(id)
    // 用户如果把内置分身加回来了，墓碑要撤销，否则下次补种又会算它「被删」
    for (const id of nowIds) tombstones.delete(id)
    lib.deletedBuiltin = [...tombstones]
  }
  await writeJsonAtomic(path(), lib)
  cache = lib
  return lib
}

/** 只读地清掉内存缓存（备份还原后强制重新读盘） */
export function invalidateStyleLibrary(): void {
  cache = null
}

/**
 * 恢复内置种子：
 * - 用户自建分身（builtin=false）保留；
 * - 内置分身全部恢复为出厂内容（用户的修改被丢弃）；
 * - 墓碑清空，删掉的内置分身会回来。
 * 这是有破坏性的操作，UI 必须二次确认。
 */
export async function resetBuiltinPersonas(): Promise<StyleLibrary> {
  const prev = await loadStyleLibrary()
  const custom = prev.personas.filter((p) => !p.builtin)
  const lib: LibraryFile = {
    version: 1,
    seedVersion: SEED_VERSION,
    personas: [
      ...SEED_PERSONAS.map((seed) => ({
        ...seed,
        traits: [...seed.traits],
        tags: [...seed.tags],
        refs: [...seed.refs],
        samples: [...seed.samples]
      })),
      ...custom
    ],
    deletedBuiltin: []
  }
  await writeJsonAtomic(path(), lib)
  cache = lib
  return lib
}

/** 备份用：整库内容（导出 .mzbak 时带上，避免换机器丢分身） */
export async function readLibraryForBackup(): Promise<LibraryFile> {
  return loadStyleLibrary()
}

/** 还原用：合并而不是覆盖，避免还原旧备份把新加的分身冲掉 */
export async function mergeLibraryFromBackup(incoming: LibraryFile): Promise<void> {
  const lib = await loadStyleLibrary()
  const byId = new Map(lib.personas.map((p) => [p.id, p]))
  for (const p of normalizeLibrary(incoming).personas) {
    // 只补不覆盖：还原是「找回」，不是「回滚」
    if (!byId.has(p.id)) lib.personas.push(p)
  }
  await writeJsonAtomic(path(), lib)
  cache = lib
}

export async function ensureStyleLibraryDir(): Promise<void> {
  await ensureDir(dirname(path()))
  try {
    await fs.access(path())
  } catch {
    await loadStyleLibrary()
  }
}