import { create } from 'zustand'
import type {
  AppSettings,
  Chapter,
  Config,
  Project,
  ProjectMeta,
  TaskKind
} from '@shared/types'
import { TASK_LABELS } from '@shared/types'
import type { StyleLibrary } from '@shared/styleLibrary'
import { countWords, uid } from '@shared/utils'
import { mz } from '../lib/bridge'

/** 库载入失败时的兜底：空库仍然能工作（书里自建的分身照常生效），只是没有系统分身可选 */
function emptyLibrary(): StyleLibrary {
  return { version: 1, seedVersion: 0, personas: [] }
}

export type ViewName = 'bookshelf' | 'workspace' | 'settings'
export type WorkspaceTab = 'write' | 'outline' | 'bible' | 'ideas' | 'style' | 'audit' | 'stats'

export interface Toast {
  id: string
  kind: 'info' | 'ok' | 'error'
  text: string
}

export interface AppInfo {
  version: string
  platform: string
  userData: string
  locale: string
}

interface AppState {
  ready: boolean
  appInfo: AppInfo | null
  config: Config | null
  projects: ProjectMeta[]
  project: Project | null
  view: ViewName
  tab: WorkspaceTab
  activeChapterId: string | null
  saving: boolean
  savedAt: number
  aiPanelOpen: boolean
  aiPanel: 'chat' | 'context'
  toasts: Toast[]
  loadingProject: boolean
  /** 系统文风分身库（全局共享）。null = 还没载入完；载入失败时是空库，不是 null */
  styleLibrary: StyleLibrary | null

  init: () => Promise<void>
  loadStyleLibrary: () => Promise<void>
  saveStyleLibrary: (fn: (lib: StyleLibrary) => StyleLibrary) => Promise<boolean>
  refreshProjects: () => Promise<void>
  setView: (v: ViewName) => void
  setTab: (t: WorkspaceTab) => void
  setAiPanel: (p: 'chat' | 'context') => void
  toggleAiPanel: () => void

  openProject: (id: string) => Promise<void>
  closeProject: () => void
  newProject: (p: Project) => Promise<void>
  patchProject: (fn: (p: Project) => Project) => void
  flush: () => Promise<void>
  deleteProject: (id: string) => Promise<void>
  duplicateProject: (id: string) => Promise<void>

  setActiveChapter: (id: string | null) => void
  addChapter: (title?: string, atIndex?: number) => Chapter | null
  patchChapter: (id: string, patch: Partial<Chapter>) => void
  removeChapter: (id: string) => void
  moveChapter: (from: number, to: number) => void

  saveConfig: (next: Config) => Promise<void>
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>

  toast: (text: string, kind?: Toast['kind']) => void
  dismissToast: (id: string) => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  appInfo: null,
  config: null,
  projects: [],
  project: null,
  view: 'bookshelf',
  tab: 'write',
  activeChapterId: null,
  saving: false,
  savedAt: 0,
  aiPanelOpen: true,
  aiPanel: 'chat',
  toasts: [],
  loadingProject: false,
  styleLibrary: null,

  async init() {
    const [info, config, projects] = await Promise.all([mz.app.info(), mz.config.get(), mz.project.list()])
    set({ appInfo: info, config, projects, ready: true })
    // 库单独载入：老版本 preload 没有 window.mz.library、或 library.json 损坏时，
    // 不能让整个应用起不来——那会把「文风分身不可用」升级成「软件打不开」。
    await get().loadStyleLibrary()
    if (!config.settings.firstRunDone) {
      // 只有「真正第一次打开」（一本书都没有）才把首屏留在设置页引导配置模型；
      // 已经有作品的老用户直接进书架，否则每次启动都被丢回设置页。
      const firstLaunch = projects.length === 0
      set({ view: firstLaunch ? 'settings' : 'bookshelf' })
      const next = { ...config, settings: { ...config.settings, firstRunDone: true } }
      set({ config: next })
      void mz.config.save(next)
    }
  },

  async refreshProjects() {
    const projects = await mz.project.list()
    set({ projects })
  },

  async loadStyleLibrary() {
    try {
      // 老版本 preload 上 mz.library 是 undefined，在这里就会抛 TypeError，正好被兜住
      const lib = await mz.library.get()
      set({ styleLibrary: lib ?? emptyLibrary() })
    } catch {
      set({ styleLibrary: emptyLibrary() })
      get().toast('文风分身库载入失败', 'error')
    }
  },

  async saveStyleLibrary(fn) {
    const cur = get().styleLibrary
    try {
      const next = fn(cur ?? emptyLibrary())
      const saved = await mz.library.save(next)
      set({ styleLibrary: saved ?? next })
      return true
    } catch (e) {
      get().toast(`文风分身库保存失败：${(e as Error).message}`, 'error')
      return false
    }
  },

  setView(v) {
    void get().flush()
    set({ view: v })
  },

  setTab(t) {
    set({ tab: t })
  },

  setAiPanel(p) {
    set({ aiPanel: p, aiPanelOpen: true })
  },

  toggleAiPanel() {
    set((s) => ({ aiPanelOpen: !s.aiPanelOpen }))
  },

  async openProject(id) {
    set({ loadingProject: true })
    const p = await mz.project.get(id)
    if (!p) {
      set({ loadingProject: false })
      get().toast('作品不存在或已被删除', 'error')
      return
    }
    const firstChapter = p.chapters[0]?.id ?? null
    set({
      project: p,
      view: 'workspace',
      tab: 'write',
      activeChapterId: firstChapter,
      loadingProject: false,
      savedAt: p.updatedAt
    })
    const cfg = get().config
    if (cfg) {
      const next = { ...cfg, settings: { ...cfg.settings, lastProjectId: id } }
      set({ config: next })
      void mz.config.save(next)
    }
  },

  closeProject() {
    void get().flush()
    set({ project: null, view: 'bookshelf', activeChapterId: null })
  },

  async newProject(p) {
    const created = await mz.project.create(p)
    await get().refreshProjects()
    await get().openProject(created.id)
  },

  patchProject(fn) {
    const cur = get().project
    if (!cur) return
    const next = fn(cur)
    next.updatedAt = Date.now()
    set({ project: next })
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      void get().flush()
    }, 700)
  },

  async flush() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const project = get().project
    if (!project) return
    set({ saving: true })
    try {
      await mz.project.save(project)
      set({ saving: false, savedAt: Date.now() })
      void get().refreshProjects()
    } catch (e) {
      set({ saving: false })
      get().toast(`保存失败：${(e as Error).message}`, 'error')
    }
  },

  async deleteProject(id) {
    await mz.project.remove(id)
    await get().refreshProjects()
    if (get().project?.id === id) set({ project: null, view: 'bookshelf' })
  },

  async duplicateProject(id) {
    await mz.project.duplicate(id)
    await get().refreshProjects()
    get().toast('已复制为新作品', 'ok')
  },

  setActiveChapter(id) {
    set({ activeChapterId: id, tab: 'write' })
  },

  addChapter(title, atIndex) {
    const cur = get().project
    if (!cur) return null
    const sceneDefault = cur.settings.targetWordsPerChapter || 2500
    const chapter: Chapter = {
      id: uid('c'),
      title: title || `第 ${cur.chapters.length + 1} 章`,
      content: '',
      summary: '',
      status: 'draft',
      targetWords: sceneDefault,
      words: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      versions: []
    }
    const chapters = [...cur.chapters]
    if (typeof atIndex === 'number' && atIndex >= 0 && atIndex <= chapters.length) {
      chapters.splice(atIndex, 0, chapter)
    } else {
      chapters.push(chapter)
    }
    get().patchProject((p) => ({ ...p, chapters }))
    set({ activeChapterId: chapter.id, tab: 'write' })
    return chapter
  },

  patchChapter(id, patch) {
    get().patchProject((p) => {
      const chapters = p.chapters.map((c) => {
        if (c.id !== id) return c
        const prev = c.content
        const merged = { ...c, ...patch, updatedAt: Date.now() }
        if (patch.content !== undefined) {
          merged.words = countWords(patch.content)
          merged.versions = pushSnapshot(c.versions, prev, patch.content)
        }
        return merged
      })
      return { ...p, chapters }
    })
  },

  removeChapter(id) {
    const cur = get().project
    if (!cur) return
    const chapters = cur.chapters.filter((c) => c.id !== id)
    // 章节没了，它的梗概缓存也不该留着，否则体检/上下文会读到孤儿条目
    const summaries = { ...cur.summaries }
    delete summaries[id]
    set({
      project: { ...cur, chapters, summaries, updatedAt: Date.now() },
      activeChapterId: chapters[0]?.id ?? null
    })
    void get().flush()
  },

  moveChapter(from, to) {
    const cur = get().project
    if (!cur) return
    if (from === to || from < 0 || to < 0 || from >= cur.chapters.length || to >= cur.chapters.length) return
    const chapters = [...cur.chapters]
    const [item] = chapters.splice(from, 1)
    chapters.splice(to, 0, item)
    get().patchProject((p) => ({ ...p, chapters }))
  },

  async saveConfig(next) {
    const saved = await mz.config.save(next)
    set({ config: saved })
  },

  async patchSettings(patch) {
    const cfg = get().config
    if (!cfg) return
    const next: Config = { ...cfg, settings: { ...cfg.settings, ...patch } }
    await get().saveConfig(next)
  },

  toast(text, kind = 'info') {
    const id = uid('t')
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3200)
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))

/* ───────────────── 派生选择器 ───────────────── */

export function activeChapter(state: AppState): Chapter | null {
  const p = state.project
  if (!p) return null
  return p.chapters.find((c) => c.id === state.activeChapterId) ?? null
}

export function totalWords(p: Project | null): number {
  if (!p) return 0
  return p.chapters.reduce((s, c) => s + (c.words || 0), 0)
}

/** 系统文风分身库。单独导出选择器，方便组件只订阅这一块而不被 project 的每次 patch 唤醒 */
export function styleLibraryOf(state: AppState): StyleLibrary | null {
  return state.styleLibrary
}

export function resolveTaskModel(config: Config | null, project: Project | null, task: TaskKind): { channel: any; model: string; label: string } | null {
  if (!config) return null
  const override = project?.settings.modelOverrides?.[task]
  const preferred = override || config.settings.taskModels[task] || null
  const list = config.models.filter((m) => m.enabled)
  let entry = preferred ? list.find((m) => m.id === preferred) : undefined
  if (!entry) entry = list.find((m) => m.id === config.settings.taskModels.draft) ?? list[0]
  if (!entry) return null
  const channel = config.channels.find((c) => c.id === entry!.channelId && c.enabled)
  if (!channel) return null
  return { channel, model: entry.model, label: entry.label }
}

export function taskModelLabel(config: Config | null, project: Project | null, task: TaskKind): string {
  const r = resolveTaskModel(config, project, task)
  return r ? r.label : `${TASK_LABELS[task]} · 未配置`
}

/* ───────────────────── 章节快照 ─────────────────────
   每章保留最近 N 个历史版本。以前 types 里定义了 versions 字段却从没写过，
   等于"关于数据安全的承诺只写在 README 里"。这里把它落实：
   - 只在内容真的变了才存，避免每次刷新都占一份；
   - 同一分钟的连续编辑合并，长会话里不会把 20 个位置吃满；
   - 超过上限丢掉最旧的，保证磁盘不会无声膨胀。 */

const MAX_SNAPSHOTS = 20
/** 两次快照之间的最小间隔（毫秒）：一分钟内的连续编辑只留一份 */
const SNAPSHOT_GAP_MS = 60_000

function pushSnapshot(prevVersions: Chapter['versions'], beforeHtml: string, afterHtml: string): Chapter['versions'] {
  const before = (beforeHtml ?? '').trim()
  const after = (afterHtml ?? '').trim()
  const list = prevVersions ?? []
  if (!before || before === after) return list
  const now = Date.now()
  const last = list[list.length - 1]
  // 距上一次快照不到一分钟：用新内容顶掉它，避免一分钟存二十份
  if (last && now - last.at < SNAPSHOT_GAP_MS) {
    return [...list.slice(0, -1), { id: last.id, at: now, content: before, words: countWords(before) }]
  }
  const next = [...list, { id: uid('v'), at: now, content: before, words: countWords(before) }]
  return next.length > MAX_SNAPSHOTS ? next.slice(next.length - MAX_SNAPSHOTS) : next
}
