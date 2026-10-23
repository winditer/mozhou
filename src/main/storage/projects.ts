import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Project, ProjectMeta } from '@shared/types'
import { countWords } from '@shared/utils'
import { dataRoot, projectDir, projectFile } from '../paths'
import { ensureDir, listDirs, readJson, removeDir, writeJsonAtomic } from './jsonStore'

const PROJECTS = () => join(dataRoot(), 'projects')

export async function listProjects(): Promise<ProjectMeta[]> {
  await ensureDir(PROJECTS())
  const ids = await listDirs(PROJECTS())
  const metas: ProjectMeta[] = []
  for (const id of ids) {
    const p = await readJson<Project | null>(projectFile(id), null)
    if (!p) continue
    metas.push({
      id: p.id,
      title: p.title,
      author: p.author,
      coverColor: p.coverColor,
      sceneId: p.sceneId,
      genreId: p.genreId,
      chapters: p.chapters?.length ?? 0,
      words: (p.chapters ?? []).reduce((s, c) => s + (c.words || countWords(c.content || '')), 0),
      updatedAt: p.updatedAt
    })
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getProject(id: string): Promise<Project | null> {
  const p = await readJson<Project | null>(projectFile(id), null)
  if (!p) return null
  return normalizeProject(p)
}

export async function createProject(project: Project): Promise<Project> {
  const p = normalizeProject(project)
  await ensureDir(projectDir(p.id))
  await writeJsonAtomic(projectFile(p.id), p)
  return p
}

export async function saveProject(project: Project): Promise<boolean> {
  const p = normalizeProject({ ...project, updatedAt: Date.now() })
  await ensureDir(projectDir(p.id))
  await writeJsonAtomic(projectFile(p.id), p)
  return true
}

export async function removeProject(id: string): Promise<void> {
  await removeDir(projectDir(id))
}

export async function duplicateProject(id: string): Promise<ProjectMeta | null> {
  const src = await getProject(id)
  if (!src) return null
  const copy: Project = {
    ...src,
    id: `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: `${src.title} 副本`,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  await createProject(copy)
  return {
    id: copy.id,
    title: copy.title,
    author: copy.author,
    coverColor: copy.coverColor,
    sceneId: copy.sceneId,
    genreId: copy.genreId,
    chapters: copy.chapters.length,
    words: copy.chapters.reduce((s, c) => s + c.words, 0),
    updatedAt: copy.updatedAt
  }
}

/* ───────────────────────── 整库备份 / 还原 ───────────────────────── */

export interface BackupPayload {
  app: 'mozhou'
  version: number
  exportedAt: number
  projects: Project[]
}

export async function collectAllProjects(): Promise<Project[]> {
  const ids = await listDirs(PROJECTS())
  const out: Project[] = []
  for (const id of ids) {
    const p = await getProject(id)
    if (p) out.push(p)
  }
  return out
}

export async function restoreProjects(payload: BackupPayload): Promise<number> {
  if (!payload || payload.app !== 'mozhou' || !Array.isArray(payload.projects)) {
    throw new Error('备份文件格式不正确，这不是墨舟的备份文件')
  }
  let n = 0
  for (const raw of payload.projects) {
    const p = normalizeProject(raw)
    await createProject(p)
    n++
  }
  return n
}

export async function countProjects(): Promise<number> {
  try {
    const entries = await fs.readdir(PROJECTS(), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).length
  } catch {
    return 0
  }
}

/* ───────────────────────── 兼容与自愈 ───────────────────────── */

function normalizeProject(p: Project): Project {
  const pf: Partial<Project> = p
  return {
    id: pf.id ?? `p_${Date.now().toString(36)}`,
    title: pf.title ?? '未命名作品',
    author: pf.author ?? '',
    coverColor: pf.coverColor ?? '#2b6cb0',
    sceneId: pf.sceneId ?? 'free',
    genreId: pf.genreId ?? '',
    createdAt: pf.createdAt ?? Date.now(),
    updatedAt: pf.updatedAt ?? Date.now(),
    brief: { logline: '', premise: '', keywords: [], ...(pf.brief ?? {}) },
    settings: {
      targetWordsPerChapter: 2500,
      targetTotalWords: 0,
      lengthMode: 'soft',
      pov: '第三人称',
      tense: '过去时',
      tone: [],
      audience: '',
      extraRules: '',
      context: {
        brief: true,
        bible: true,
        characters: true,
        outline: true,
        previous: true,
        style: true,
        genre: true
      },
      previousChapters: 2,
      modelOverrides: {},
      ...(pf.settings ?? {})
    },
    bible: {
      characters: [],
      world: [],
      terms: [],
      timeline: [],
      threads: [],
      ...(pf.bible ?? {})
    },
    outline: pf.outline ?? [],
    chapters: (pf.chapters ?? []).map((c) => ({
      ...c,
      versions: c.versions ?? [],
      summary: c.summary ?? '',
      status: c.status ?? 'draft',
      targetWords: c.targetWords ?? 0,
      words: c.words || countWords(c.content ?? ''),
      createdAt: c.createdAt ?? Date.now(),
      updatedAt: c.updatedAt ?? Date.now()
    })),
    styleProfiles: pf.styleProfiles ?? [],
    ideas: pf.ideas ?? [],
    chat: pf.chat ?? [],
    usage: pf.usage ?? [],
    summaries: pf.summaries ?? {}
  }
}