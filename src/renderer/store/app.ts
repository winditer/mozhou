import { create } from 'zustand'
import type {
  AppSettings,
  Chapter,
  Config,
  OutlineNode,
  Project,
  ProjectMeta,
  TaskKind
} from '@shared/types'
import { TASK_LABELS } from '@shared/types'
import type { StyleLibrary } from '@shared/styleLibrary'
import type { SkillLibrary } from '@shared/skills'
import { countWords, outlineTitleKey, resolveOutlineNodeId, buildOutlineIndex, uid } from '@shared/utils'
import { mz } from '../lib/bridge'
import { applyResolved, type ResolvedEdit } from '../lib/applyEdits'

/**
 * 上一次对话改稿的现场：只留章节/大纲/设定三样，因为那是 mz-edit 唯一能碰的东西。
 * 只留最近一次、不持久化——这类改动本来就该当场看着不对就撤；
 * 做全量 undo 栈会让 project.json 无声膨胀。
 */
export interface EditUndo {
  at: number
  chapters: Chapter[]
  outline: OutlineNode[]
  bible: Project['bible']
}

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
  /** 写作技法卡库（全局共享）。同上，载入失败时给空库而不是 null */
  skillLibrary: SkillLibrary | null

  init: () => Promise<void>
  loadStyleLibrary: () => Promise<void>
  saveStyleLibrary: (fn: (lib: StyleLibrary) => StyleLibrary) => Promise<boolean>
  loadSkillLibrary: () => Promise<void>
  saveSkillLibrary: (fn: (lib: SkillLibrary) => SkillLibrary) => Promise<boolean>
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
  /**
   * 对话改稿的批量落地：一次 patchProject 改完所有章，每章压一份快照。
   *
   * 不能复用 patchChapter 逐条调——它内部各自 patchProject，改五章就是五次落盘、
   * 五次自动保存，中间任何一次失败都会留下「改了一半」的稿子。
   */
  applyEditBatch: (edits: ResolvedEdit[]) => void
  /** 撤销上一次对话改稿（界面只在 30 秒内给入口） */
  undoLastEditBatch: () => void
  /** 上一次改稿前的现场，供撤销用；重启即失效是有意的 */
  lastEditUndo: EditUndo | null
  /**
   * 外部改动计数：`applyEditBatch` / 撤销时自增。
   *
   * 编辑器（BookEditor）只在章节切换时同步内容，为的是别在作者打字时把光标冲掉；
   * 但对话改稿改的常常是**当前正在编辑的这一章**，不通知它就会「数据改了、屏幕上没变」。
   * 所以给一个显式的信号：只有非打字路径的改动才自增。
   */
  externalEditRev: number
  removeChapter: (id: string) => void
  moveChapter: (from: number, to: number) => void
  /** 手动切换章节状态（章节列表里的徽标，点击循环） */
  cycleChapterStatus: (id: string) => void
  /** 大纲节点的状态是计划；切换它要同时写回已建的那一章，否则两边立刻分叉 */
  patchOutlineStatus: (nodeId: string, status: OutlineNode['status']) => void

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
  skillLibrary: null,
  lastEditUndo: null,
  externalEditRev: 0,

  async init() {
    const [info, config, projects] = await Promise.all([mz.app.info(), mz.config.get(), mz.project.list()])
    set({ appInfo: info, config, projects, ready: true })
    // 库单独载入：老版本 preload 没有 window.mz.library、或 library.json 损坏时，
    // 不能让整个应用起不来——那会把「文风分身不可用」升级成「软件打不开」。
    await get().loadStyleLibrary()
    // 技法卡同一条纪律：库载入失败不能把「技法卡不可用」升级成「软件打不开」
    await get().loadSkillLibrary()
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

  async loadSkillLibrary() {
    try {
      const lib = await mz.skill.get()
      set({ skillLibrary: lib ?? { version: 1, seedVersion: 0, skills: [] } })
    } catch {
      set({ skillLibrary: { version: 1, seedVersion: 0, skills: [] } })
      get().toast('技法卡库载入失败', 'error')
    }
  },

  async saveSkillLibrary(fn) {
    const cur = get().skillLibrary ?? { version: 1, seedVersion: 0, skills: [] }
    try {
      const next = fn(cur)
      const saved = await mz.skill.save(next)
      set({ skillLibrary: saved ?? next })
      return true
    } catch (e) {
      get().toast(`技法卡库保存失败：${(e as Error).message}`, 'error')
      return false
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

  applyEditBatch(edits) {
    const cur = get().project
    if (!cur) return
    // 一条能落地的都没有：不留现场、不落盘，省得「撤销」按钮指向一次没发生的改动
    if (!edits.some((e) => e.status === 'found')) return
    // 先留现场再改：撤销要能回到「应用之前」的样子
    set({ lastEditUndo: { at: Date.now(), chapters: cur.chapters, outline: cur.outline, bible: cur.bible } })
    get().patchProject((p) => {
      const next = applyResolved(p, edits)
      if (next === p) return p
      const chapters = next.chapters.map((c) => {
        const prev = p.chapters.find((x) => x.id === c.id)
        if (!prev) return c
        if (prev.content === c.content) {
          // 正文没变的章：快照与字数沿用原来的，避免无意义的版本堆积
          return { ...c, versions: prev.versions, words: prev.words, updatedAt: prev.updatedAt }
        }
        const words = countWords(c.content)
        const merged: Chapter = {
          ...c,
          words,
          updatedAt: Date.now(),
          versions: pushSnapshot(prev.versions, prev.content, c.content)
        }
        if (words > 0 && merged.status === 'planning') merged.status = 'draft'
        return merged
      })
      return { ...next, chapters }
    })
    set({ externalEditRev: get().externalEditRev + 1 })
    void get().flush()
  },

  undoLastEditBatch() {
    const u = get().lastEditUndo
    if (!u) return
    get().patchProject((p) => ({ ...p, chapters: u.chapters, outline: u.outline, bible: u.bible }))
    set({ lastEditUndo: null, externalEditRev: get().externalEditRev + 1 })
    void get().flush()
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
    // 标题默认「第 N 章」会伤到「按标题匹配大纲」：同一本书里重复的默认标题
    // 会让人分不清哪一章对应大纲哪一节，所以取一个还没被用过的序号
    const title0 = title?.trim() || nextChapterTitle(cur.chapters)
    const sceneDefault = cur.settings.targetWordsPerChapter || 2500
    const chapter: Chapter = {
      id: uid('c'),
      title: title0,
      content: '',
      summary: '',
      status: 'planning',
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
    get().patchProject((p) => linkChapterToOutline({ ...p, chapters }, chapter.id))
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
        // 正文从空变成非空：这一章就真的开写了，「待写」不该再留着。
        // 唯一例外是作者刚从「已完成」倒推回来（改错字不该把完本打回进行中）。
        if (patch.content !== undefined && patch.status === undefined && merged.words > 0 && merged.status === 'planning') {
          merged.status = 'draft'
        }
        return merged
      })
      return { ...p, chapters }
    })
  },

  cycleChapterStatus(id) {
    get().patchProject((p) => {
      const target = p.chapters.find((c) => c.id === id)
      if (!target) return p
      return withChapterStatus(p, id, nextChapterStatus(target.status))
    })
  },

  patchOutlineStatus(nodeId, status) {
    get().patchProject((p) => {
      const outline = updateOutlineStatus(p.outline, nodeId, status)
      // 大纲节点对应的那一章同步改，两处读到的永远是同一个答案
      const linked = chapterForNode(p, nodeId)
      const chapters = linked
        ? p.chapters.map((c) => (c.id === linked.id ? { ...c, status: status as Chapter['status'], updatedAt: Date.now() } : c))
        : p.chapters
      return { ...p, outline, chapters }
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

/* ───────────────── 章节状态：单一事实来源 ─────────────────
   章节和 outline 节点各有一个 status，但它们问的是两件事：

   - OutlineNode.status = 作者在大纲页定的**计划**（planned → writing → done）
   - Chapter.status     = 写作台里正文进度的**事实**

   两边如果各改各的，同一章就会同时显示「待写」和「已完成」（章节列表读 A、
   大纲页读 B）。这里的规矩是：**大纲节点的状态是计划，章节的状态是事实**——
   大纲页改状态时同步写回已建的那一章，章节页改状态时同步写回所属节点，
   只建了大纲没建章的那部分只提示计划，不假装有事实。 */

const CHAPTER_TO_NODE_STATUS: Record<Chapter['status'], OutlineNode['status']> = {
  planning: 'planned',
  draft: 'writing',
  done: 'done'
}

/** 大纲节点状态反推章节状态：进行中一律落到「撰写中」，不再区分有没有正文 */
const NODE_TO_CHAPTER_STATUS: Record<OutlineNode['status'], Chapter['status']> = {
  planned: 'planning',
  writing: 'draft',
  done: 'done'
}

/** 大纲节点的计划 → 章节的事实：建章时用它给新章一个与大纲一致的起点 */
export function statusForNode(status: OutlineNode['status']): Chapter['status'] {
  return NODE_TO_CHAPTER_STATUS[status]
}

/** 徽标点一下循环：待写 → 撰写中 → 已完成 → 待写 */
export function nextChapterStatus(s: Chapter['status']): Chapter['status'] {
  return s === 'planning' ? 'draft' : s === 'draft' ? 'done' : 'planning'
}

function updateOutlineStatus(nodes: OutlineNode[], id: string, status: OutlineNode['status']): OutlineNode[] {
  return nodes.map((n) => {
    if (n.id === id) return { ...n, status }
    if (!n.children.length) return n
    const children = updateOutlineStatus(n.children, id, status)
    return children === n.children ? n : { ...n, children }
  })
}

/** 找出章 → 大纲节点的映射（显式 id 优先，标题兜底），并保证一个节点只归属一章 */
function chapterNodeMap(project: Project): Map<string, string> {
  const index = buildOutlineIndex(project.outline)
  const map = new Map<string, string>()
  for (const c of project.chapters) {
    const nodeId = resolveOutlineNodeId(c, index)
    if (nodeId) map.set(c.id, nodeId)
  }
  return map
}

/** 某章当前挂在哪个大纲节点上 */
export function nodeIdOfChapter(project: Project, chapterId: string): string | null {
  return chapterNodeMap(project).get(chapterId) ?? null
}

/** 某个大纲节点已经建了哪一章 */
export function chapterForNode(project: Project, nodeId: string): Chapter | null {
  const map = chapterNodeMap(project)
  for (const [chapterId, nid] of map) {
    if (nid === nodeId) return project.chapters.find((c) => c.id === chapterId) ?? null
  }
  return null
}

/** 给新章节找它的 outline 节点，并把它写进 outlineNodeId（落盘，不再每次靠标题猜） */
function linkChapterToOutline(project: Project, chapterId: string): Project {
  const chapter = project.chapters.find((c) => c.id === chapterId)
  if (!chapter || !project.outline.length) return project
  const index = buildOutlineIndex(project.outline)
  // 先把已有章节占位，避免新章抢走别人已经匹配上的节点
  for (const c of project.chapters) {
    if (c.id !== chapterId) resolveOutlineNodeId(c, index)
  }
  const nodeId = resolveOutlineNodeId(chapter, index)
  if (!nodeId || nodeId === chapter.outlineNodeId) return project
  return {
    ...project,
    chapters: project.chapters.map((c) => (c.id === chapterId ? { ...c, outlineNodeId: nodeId } : c))
  }
}

/** 改章节状态时，同时把计划（大纲节点）拉齐 */
function withChapterStatus(project: Project, chapterId: string, status: Chapter['status']): Project {
  const chapters = project.chapters.map((c) => (c.id === chapterId ? { ...c, status, updatedAt: Date.now() } : c))
  const nodeId = nodeIdOfChapter(project, chapterId)
  if (!nodeId) return { ...project, chapters }
  return {
    ...project,
    chapters,
    outline: updateOutlineStatus(project.outline, nodeId, CHAPTER_TO_NODE_STATUS[status])
  }
}

/** 「第 N 章」的自增序号：跳过已被占用的标题 */
function nextChapterTitle(chapters: Chapter[]): string {
  const used = new Set(chapters.map((c) => outlineTitleKey(c.title)))
  for (let i = chapters.length + 1; i < chapters.length + 1000; i++) {
    const t = `第 ${i} 章`
    if (!used.has(outlineTitleKey(t))) return t
  }
  return `第 ${chapters.length + 1} 章`
}

/* ───────────────── 章节状态的显示口径 ─────────────────
   章节列表和大纲页必须用同一套词。之前章节列表说「待写/撰写中/已完成」，
   大纲页说「待写/进行中/已完成」，同一个中间态两个名字，作者会以为它们不是一回事。 */

export const CHAPTER_STATUS_LABEL: Record<Chapter['status'], string> = {
  planning: '待写',
  draft: '撰写中',
  done: '已完成'
}

export const CHAPTER_STATUS_COLOR: Record<Chapter['status'], { fg: string; bg: string }> = {
  planning: { fg: 'var(--text-faint)', bg: 'var(--panel-2)' },
  draft: { fg: 'var(--warn)', bg: 'var(--panel-2)' },
  done: { fg: 'var(--ok)', bg: 'var(--panel-2)' }
}

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
