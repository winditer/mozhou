import type { Chapter, OutlineNode, Project } from './types'
import { getScene } from './scenes'
import { uid } from './utils'

export interface NewProjectInput {
  title: string
  author?: string
  sceneId: string
  genreId?: string
  logline?: string
  premise?: string
  keywords?: string[]
  targetWordsPerChapter?: number
  targetTotalWords?: number
  coverColor?: string
  pov?: string
  tense?: string
  tone?: string[]
  audience?: string
  extraRules?: string
  /** 建书向导里选定的默认模型，作为本书任务覆盖 */
  defaultModelId?: string | null
  /** 设置里配置的默认技法卡，新书继承它们；不传则不带任何技法卡 */
  defaultSkillIds?: string[]
}

export const COVER_COLORS = [
  '#2b6cb0',
  '#8a6a3b',
  '#2f8a5b',
  '#9b4d6b',
  '#4b5b9b',
  '#b7791f',
  '#3a7d7d',
  '#7a4fb5',
  '#a8452f',
  '#3f4a56'
]

export function createBlankProject(input: NewProjectInput): Project {
  const scene = getScene(input.sceneId)
  const now = Date.now()
  const firstChapter: Chapter = {
    id: uid('c'),
    title: scene.structureLabels[1] === '章' ? '第 1 章' : `第 1 ${scene.structureLabels[1]}`,
    content: '',
    summary: '',
    status: 'planning',
    targetWords: input.targetWordsPerChapter ?? scene.defaultChapterWords,
    words: 0,
    createdAt: now,
    updatedAt: now,
    versions: []
  }

  const outline: OutlineNode[] = [
    {
      id: uid('o'),
      title: `第一卷`,
      summary: '',
      type: 'volume',
      status: 'planned',
      children: [
        {
          id: uid('o'),
          title: firstChapter.title,
          summary: '',
          type: 'chapter',
          status: 'planned',
          children: []
        }
      ]
    }
  ]

  const modelOverrides: Project['settings']['modelOverrides'] = {}
  if (input.defaultModelId) {
    for (const t of ['draft', 'outline', 'polish', 'naming', 'summary', 'audit', 'chat'] as const) {
      modelOverrides[t] = input.defaultModelId
    }
  }

  return {
    id: uid('p'),
    title: input.title || '未命名作品',
    author: input.author ?? '',
    coverColor: input.coverColor ?? COVER_COLORS[0],
    sceneId: scene.id,
    genreId: input.genreId ?? '',
    createdAt: now,
    updatedAt: now,
    brief: {
      logline: input.logline ?? '',
      premise: input.premise ?? '',
      keywords: input.keywords ?? []
    },
    settings: {
      targetWordsPerChapter: input.targetWordsPerChapter ?? scene.defaultChapterWords,
      targetTotalWords: input.targetTotalWords ?? 0,
      lengthMode: 'soft',
      pov: input.pov ?? '第三人称',
      tense: input.tense ?? '过去时',
      tone: input.tone ?? [],
      audience: input.audience ?? '',
      extraRules: input.extraRules ?? '',
      context: {
        brief: true,
        bible: true,
        characters: true,
        outline: true,
        previous: true,
        style: true,
        genre: true,
        skills: true
      },
      previousChapters: 2,
      modelOverrides,
      // 新建书继承设置里的默认技法卡；由调用方传入，避免 factory 去读全局设置
      activeSkillIds: input.defaultSkillIds ? [...input.defaultSkillIds] : [],
      skillVersions: {}
    },
    bible: {
      characters: [],
      world: [],
      terms: [],
      timeline: [],
      threads: []
    },
    outline,
    chapters: [firstChapter],
    styleProfiles: [],
    ideas: [],
    chat: [],
    usage: [],
    summaries: {},
    marginNotes: {},
    recitals: {}
  }
}

/** 建书向导的初始章节骨架（可选 N 章） */
export function scaffoldChapters(count: number, words: number): Chapter[] {
  const now = Date.now()
  return Array.from({ length: count }, (_, i) => ({
    id: uid('c'),
    title: `第 ${i + 1} 章`,
    content: '',
    summary: '',
    status: 'planning' as const,
    targetWords: words,
    words: 0,
    createdAt: now,
    updatedAt: now,
    versions: []
  }))
}