import type { ReactNode } from 'react'

/* ────────────────────────────── 渠道与模型 ────────────────────────────── */

export type Protocol = 'openai' | 'anthropic' | 'gemini'

export interface Channel {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  /** 额外请求头，例如 OpenRouter 的 HTTP-Referer */
  headers?: Record<string, string>
  enabled: boolean
  /** 内置预设 id，用于 UI 显示徽标 */
  presetId?: string
  /** 模型列表获取方式：手填 / 自动拉取 */
  models?: string[]
  note?: string
}

export interface ModelEntry {
  id: string
  channelId: string
  /** 请求体里的 model 字段 */
  model: string
  /** 显示名 */
  label: string
  contextWindow?: number
  /** 单价：元 / 百万 token */
  priceIn?: number
  priceOut?: number
  enabled: boolean
}

export type TaskKind = 'draft' | 'outline' | 'polish' | 'naming' | 'summary' | 'audit' | 'chat'

export const TASK_LABELS: Record<TaskKind, string> = {
  draft: '正文生成',
  outline: '大纲推演',
  polish: '润色改写',
  naming: '取名命名',
  summary: '摘要压缩',
  audit: '一致性审校',
  chat: '自由对话'
}

/* ────────────────────────────── 主题与排版 ────────────────────────────── */

export interface Typography {
  fontFamily: string
  fontSize: number
  lineHeight: number
  pageWidth: number
  indent: boolean
  paragraphSpacing: number
  dimUnfocused: boolean
}

export interface AppSettings {
  themeId: string
  typography: Typography
  typewriter: boolean
  focusMode: boolean
  /** 书架封面档位：s 小 / m 中 / l 大（默认 m = 150px） */
  shelfCoverSize: 's' | 'm' | 'l'
  dailyGoal: number
  taskModels: Record<TaskKind, string | null>
  lastProjectId: string | null
  temperature: number
  firstRunDone: boolean
  showWordCountBar: boolean
}

export interface Config {
  version: number
  channels: Channel[]
  models: ModelEntry[]
  settings: AppSettings
}

/* ────────────────────────────── 场景与题材 ────────────────────────────── */

export interface SceneAction {
  id: string
  label: string
  /** 追加到用户指令后面的提示 */
  instruction: string
  /** 是否需要选中文本 */
  needsSelection?: boolean
}

export interface ScenePreset {
  id: string
  name: string
  group: 'fiction' | 'script' | 'media' | 'business' | 'academic' | 'other'
  icon: string
  tagline: string
  description: string
  /** 结构层级名称，例如 ['卷','章'] */
  structureLabels: [string, string]
  defaultChapterWords: number
  minChapterWords: number
  maxChapterWords: number
  /** 系统提示词：定义 AI 的角色与专业写作规则 */
  systemPrompt: string
  /** 大纲模板的顶层骨架 */
  outlineTemplate: string[]
  /** 设定库分组建议 */
  bibleGroups: string[]
  actions: SceneAction[]
  tonePresets: string[]
  genreIds: string[]
  /** 首次创建时的示例灵感 */
  examples: string[]
}

export interface Genre {
  id: string
  name: string
  group: string
  /** 题材公约：注入到提示词 */
  convention: string
  toneHints: string[]
  color: string
}

/* ────────────────────────────── 项目数据 ────────────────────────────── */

export interface Character {
  id: string
  name: string
  role: string
  age: string
  identity: string
  appearance: string
  personality: string
  motivation: string
  flaw: string
  arc: string
  speechStyle: string
  relations: { name: string; desc: string }[]
  hidden: boolean
  notes: string
}

export type WorldCategory = 'world' | 'power' | 'faction' | 'place' | 'item' | 'rule' | 'other'

export const WORLD_CATEGORY_LABELS: Record<WorldCategory, string> = {
  world: '世界观',
  power: '力量体系',
  faction: '势力组织',
  place: '地点场景',
  item: '关键物品',
  rule: '规则禁忌',
  other: '其它'
}

export interface WorldEntry {
  id: string
  category: WorldCategory
  title: string
  content: string
  /** 是否允许注入给 AI（渐进式披露） */
  visible: boolean
}

export interface Term {
  id: string
  term: string
  definition: string
}

export interface TimelineEvent {
  id: string
  time: string
  title: string
  desc: string
}

export interface Thread {
  id: string
  title: string
  setup: string
  payoff: string
  status: 'open' | 'closed'
  level: 'main' | 'sub'
}

export interface OutlineNode {
  id: string
  title: string
  summary: string
  type: 'volume' | 'chapter'
  status: 'planned' | 'writing' | 'done'
  children: OutlineNode[]
}

export interface Snapshot {
  id: string
  at: number
  content: string
  words: number
}

export interface Chapter {
  id: string
  title: string
  content: string
  summary: string
  status: 'planned' | 'draft' | 'done'
  targetWords: number
  words: number
  outlineNodeId?: string
  createdAt: number
  updatedAt: number
  versions: Snapshot[]
}

export interface StyleProfile {
  id: string
  name: string
  samples: string[]
  traits: string[]
  active: boolean
}

export interface Idea {
  id: string
  text: string
  at: number
  pinned: boolean
}

export interface UsageRecord {
  id: string
  at: number
  model: string
  task: TaskKind
  promptTokens: number
  completionTokens: number
  cost: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  at: number
  model?: string
}

export interface ContextToggles {
  brief: boolean
  bible: boolean
  characters: boolean
  outline: boolean
  previous: boolean
  style: boolean
  genre: boolean
}

export interface ProjectSettings {
  targetWordsPerChapter: number
  targetTotalWords: number
  lengthMode: 'strict' | 'soft'
  pov: string
  tense: string
  tone: string[]
  audience: string
  extraRules: string
  context: ContextToggles
  /** 前文注入章数 */
  previousChapters: number
  modelOverrides: Partial<Record<TaskKind, string>>
}

export interface Project {
  id: string
  title: string
  author: string
  coverColor: string
  sceneId: string
  genreId: string
  createdAt: number
  updatedAt: number
  brief: { logline: string; premise: string; keywords: string[] }
  settings: ProjectSettings
  bible: {
    characters: Character[]
    world: WorldEntry[]
    terms: Term[]
    timeline: TimelineEvent[]
    threads: Thread[]
  }
  outline: OutlineNode[]
  chapters: Chapter[]
  styleProfiles: StyleProfile[]
  ideas: Idea[]
  chat: ChatMessage[]
  usage: UsageRecord[]
  /** 每章滚动摘要缓存：chapterId -> summary */
  summaries: Record<string, string>
}

/* ────────────────────────────── AI 请求 ────────────────────────────── */

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  streamId: string
  channel: Channel
  apiKey: string
  model: string
  messages: PromptMessage[]
  temperature?: number
  maxTokens?: number
  task: TaskKind
}

export interface StreamChunk {
  streamId: string
  delta: string
}

/** 思考类模型的推理增量（不是正文）：只用于界面提示「模型在动」 */
export interface StreamThought {
  streamId: string
  delta: string
}

export interface StreamDone {
  streamId: string
  text: string
  promptTokens: number
  completionTokens: number
  /**
   * 服务端给出的结束原因。'length' 表示输出被 max_tokens 截断，
   * 上层据此判断「文字是断的」，而不是把半截内容当成品。
   */
  finishReason?: string
}

export interface StreamError {
  streamId: string
  message: string
}

export interface TestResult {
  ok: boolean
  latencyMs?: number
  model?: string
  message?: string
}

/* ────────────────────────────── IPC 桥 ────────────────────────────── */

export interface ProjectMeta {
  id: string
  title: string
  author: string
  coverColor: string
  sceneId: string
  genreId: string
  chapters: number
  words: number
  updatedAt: number
}

export interface FilePickResult {
  canceled: boolean
  path?: string
  content?: string
  message?: string
}

export interface MzApi {
  app: {
    info(): Promise<{ version: string; platform: string; userData: string; locale: string }>
    openExternal(url: string): Promise<void>
    isFullScreen(): Promise<boolean>
    setFullScreen(value: boolean): void
    onToggleFocus(cb: () => void): () => void
    minimize(): void
    maximize(): void
    close(): void
  }
  config: {
    get(): Promise<Config>
    save(config: Config): Promise<Config>
    secretSet(ref: string, value: string): Promise<boolean>
    secretHas(ref: string): Promise<boolean>
    secretClear(ref: string): Promise<void>
  }
  project: {
    list(): Promise<ProjectMeta[]>
    create(project: Project): Promise<Project>
    get(id: string): Promise<Project | null>
    save(project: Project): Promise<boolean>
    remove(id: string): Promise<void>
    duplicate(id: string): Promise<ProjectMeta | null>
    backupAll(): Promise<FilePickResult>
    restoreAll(): Promise<{ ok: boolean; count?: number; message?: string }>
  }
  ai: {
    chat(req: ChatRequest): Promise<{ ok: boolean; error?: string }>
    abort(streamId: string): Promise<void>
    test(channel: Channel, apiKey: string, model: string): Promise<TestResult>
    models(channel: Channel, apiKey: string): Promise<{ ok: boolean; models: string[]; message?: string }>
    onChunk(cb: (c: StreamChunk) => void): () => void
    onThought(cb: (t: StreamThought) => void): () => void
    onDone(cb: (d: StreamDone) => void): () => void
    onError(cb: (e: StreamError) => void): () => void
  }
  io: {
    exportFile(payload: { kind: 'md' | 'txt' | 'html' | 'docx' | 'pdf'; title: string; items: { title: string; content: string }[] }): Promise<FilePickResult>
    importFile(): Promise<FilePickResult>
    importChapters(raw: string): Promise<Chapter[]>
  }
}

declare global {
  interface Window {
    mz: MzApi
  }
}

export type { ReactNode }