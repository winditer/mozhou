import type { ReactNode } from 'react'
import type { TokenBudgets } from './budgets'
import type { StyleLibrary, StylePersona, StyleRef } from './styleLibrary'
import type { SkillLibrary } from './skills'
/**
 * 改稿指令的类型与校验在 `editProtocol.ts`，这里只做类型引用。
 * 两边互相引用是故意的：`import type` 编译后会被抹掉，不留运行时循环依赖。
 */
import type { EditOp } from './editProtocol'

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
  /**
   * 各调用点的输出预算（maxTokens），键见 shared/budgets.ts 的 BUDGET_KEYS。
   * 老配置里没有这一项，读盘时由 mergeSettings 逐键补齐默认值。
   */
  tokenBudgets: TokenBudgets
  temperature: number
  firstRunDone: boolean
  showWordCountBar: boolean
  /**
   * 题材公约的全局覆盖表：题材 id → 作者自定义的公约正文。
   * 只存被改过的题材，未出现的题材继续沿用 shared/genres.ts 的内置默认值。
   */
  genreConventions: Record<string, string>
  /**
   * 新建书时默认勾选的技法卡 id。
   * 只影响新书：老书的 activeSkillIds 是各自存的，改这里不会动它们。
   */
  defaultSkillIds: string[]
  /**
   * 允许对话直接提改动（mz-edit）。
   *
   * 默认开。关掉之后对话只聊天、不再往提示词里注入改稿协议——
   * 给「模型对 JSON 服从度太差，每次都写坏」或「只想让它当陪聊」的作者留个开关。
   */
  allowChatEdits: boolean
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

/* ───────────────────────── 段落侧批 / 评书 ───────────────────────── */

/** 侧批的六种口吻：删 / 改 / 慢 / 快 / 虚 / 偏。与批注提示词里的枚举一一对应。 */
export type MarginNoteKind = '删' | '改' | '慢' | '快' | '虚' | '偏'

export interface MarginNote {
  /** 段落序号，从 1 开始（按 stripHtml 后按空行切分） */
  paragraph: number
  kind: MarginNoteKind
  note: string
  /** 批注指向的原文片段，模型尽量给；用于跳转与核对 */
  quote?: string
  /** 作者标记：已处理（列表默认仍显示，可筛「只看未处理」） */
  resolved?: boolean
}

/**
 * 某一章的侧批结果。
 *
 * 为什么要持久化而不是留在组件 state 里：批注是花钱跑出来的编辑意见，
 * 作者切去改两段再回来，结果就没了——那这个功能等于一次性的玩具。
 */
export interface MarginNoteSet {
  at: number
  /** 生成这份结果的模型显示名 */
  model?: string
  /** 生成时这一章有多少段（正文改短后序号会错位） */
  paragraphs: number
  /** 生成时正文指纹（词数 + 首尾片段），用于提示「批注基于旧稿」 */
  fingerprint: string
  notes: MarginNote[]
}

/** 一章的 AI 评书稿。同样按章持久化，关掉应用再打开还能接着听。 */
export interface Recital {
  at: number
  /** 风格 id，见评书面板内的 RECITAL_STYLES */
  styleId: string
  /** 回目名（评书稿标题） */
  title: string
  /** 评书稿全文（纯文本，空行分段） */
  script: string
  model?: string
  /** 作者手改过：重新生成前要确认是否覆盖 */
  edited?: boolean
}

export interface Genre {
  id: string
  name: string
  group: string
  /** 题材公约的内置默认值：注入提示词前可被设置里的全局覆盖替换 */
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
  /**
   * 正文进度的事实：planning 待写 / draft 撰写中 / done 已完成。
   * 与 OutlineNode.status（作者定的计划）一一对应，写 store 时互相同步。
   */
  status: 'planning' | 'draft' | 'done'
  targetWords: number
  words: number
  /** 关联的大纲节点。缺失时按标题兜底匹配（兼容老数据） */
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
  /** 风格摘要：引用系统分身时同步过来，也允许用户改 */
  summary?: string
  /**
   * 引用系统文风分身库里的某个分身。
   * 有值时为「引用态」：生成前按 sourceId 回系统库取当前值（实时跟随）；
   * 无值时为「书内自建」：只用本对象的 traits / samples。
   */
  sourceRef?: StyleRef
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
  /**
   * 这条回答被输出上限（max_tokens）截断了，末尾是断的。
   * 只做界面标注，内容照旧参与后续对话——半截回答拿来接着讨论仍然有用。
   */
  truncated?: boolean
  /**
   * 这一轮 AI 提出的改稿指令（已解析校验，但**尚未应用**）。
   * 存下来而不是当场应用：作者刷新页面后还能看到「本轮提出 4 处修改」并继续应用。
   * 定位在点开预览时才做——anchors 的有效性取决于当时的正文。
   */
  edits?: EditOp[]
  /** 这批改动被应用的时间。有值就置灰按钮，避免同一批改两次 */
  editsAppliedAt?: number
  /** 应用后写稿写进去的字数（只有 create_chapter(draft) / write_chapter 才有） */
  draftWords?: number
  /** 解析编辑块失败的原因，气泡下方显示，不许静默 */
  editsError?: string
}

export interface ContextToggles {
  brief: boolean
  bible: boolean
  characters: boolean
  outline: boolean
  previous: boolean
  style: boolean
  genre: boolean
  /** 写作技法卡是否注入（作者勾了卡但想暂时关掉时用，不必清空勾选） */
  skills: boolean
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
  /**
   * 本书启用的技法卡 id，顺序即注入顺序（作者勾选顺序，不自动排序）。
   * 只存 id 不存内容：技法卡是跨书复用的方法论，库里改了所有书立刻跟着变。
   */
  activeSkillIds: string[]
  /**
   * 上次生成时各卡用的版本。
   * 库里某张卡升版后，界面据此提示「已更新到 vN」，但不阻止生成——
   * 作者有权知道自己的方法论在变，也有权继续用新版。
   */
  skillVersions: Record<string, number>
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
  /** 段落侧批：chapterId → 批注集（只存有结果的章） */
  marginNotes: Record<string, MarginNoteSet>
  /** AI 评书稿：chapterId → 评书稿 */
  recitals: Record<string, Recital>
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
  /**
   * 让模型跳过思考（推理）过程。
   *
   * 'off' 只对支持该开关的渠道实际生效（目前是 DeepSeek 官方及其兼容网关），
   * 其他渠道会忽略——把不认识的字段发给 OpenAI / Anthropic 这类网关会直接 400。
   * 用途：体检、抽取这类「结构化 JSON 输出」的任务不需要深推理，思考 token
   * 反而会把 maxTokens 吃光，导致正文空着结束（见 thoughtStarved）。
   */
  thinking?: 'off'
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
  /**
   * 本次流一个正文字符都没产出（思考吃光 max_tokens、网关吞掉 content 等）。
   *
   * 刻意不在这里抛错：空正文往往换个提示词/重试就能出字，抛错会被上层当致命失败
   * 直接终结整个生成流程。上层据 empty + finishReason 自己决定要不要重试。
   */
  empty: boolean
  /** 流收尾异常（没等到 [DONE] 就断）。仅作排查线索，不参与重试判断 */
  finishedAbnormally?: boolean
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
  /** 写作技法卡库：全局共享，书内只存 id 引用 */
  skill: {
    get(): Promise<SkillLibrary>
    save(lib: SkillLibrary): Promise<SkillLibrary>
    /** 恢复内置技法卡：保留作者自建的卡，把内置卡恢复为出厂状态 */
    resetBuiltin(): Promise<SkillLibrary>
  }
  /** 系统文风分身库：全局共享、跨书引用 */
  library: {
    get(): Promise<StyleLibrary>
    save(lib: StyleLibrary): Promise<StyleLibrary>
    /** 恢复内置种子：保留用户自建分身，把内置分身恢复为出厂状态 */
    resetBuiltin(): Promise<StyleLibrary>
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