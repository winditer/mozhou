/**
 * 书稿导入 · 装配成 Project（纯函数，可测）
 *
 * 这里做的不是「把数据抄一遍」：导入的书稿**已经写完**，所以它和「AI 一键开书」
 * 的装配规则有三处关键差别，任何一处搞错都会让书架里的书看起来像另一本：
 *
 * 1) 章节 status 必须是 done（有正文就是完稿），不能沿用开书的 planning；
 * 2) 每个章节都要有 outlineNodeId 指回自己那个大纲节点 —— 靠标题兜底匹配
 *    在「同卷两个同名章」时会把两章指到同一个节点上；
 * 3) 大纲是「卷 → 章」两级，章节点带摘要，因为导入后作者多半直接在大纲页看全书。
 */
import type { Chapter, Character, OutlineNode, Project } from '@shared/types'
import { COVER_COLORS, createBlankProject } from '@shared/factory'
import { getScene } from '@shared/scenes'
import { countWords, plainToHtml, uid } from '@shared/utils'
import type { ImportMetaCharacter } from './aiParse'

/** 导入成稿默认落在「长篇小说」场景：有卷/章两级结构，篇幅档位也对得上 */
export const IMPORT_SCENE_ID = 'long-novel'

export interface ImportDraftChapter {
  title: string
  /** 正文纯文本（空行分段），装配时转 HTML */
  body: string
  summary?: string
}

export interface ImportDraftVolume {
  title: string
  chapters: ImportDraftChapter[]
}

export interface ImportProduct {
  title: string
  author?: string
  genreId?: string
  logline?: string
  premise?: string
  keywords?: string[]
  sceneId?: string
  volumes: ImportDraftVolume[]
  /** AI 识别出的人物，进人物档案 */
  characters?: ImportMetaCharacter[]
  /** 预览里取消勾选「生成大纲」时为 false，只落章节 */
  buildOutline?: boolean
}

/** 按书名散列挑封面色，避免每本导入的书都是同一个蓝 */
function pickCoverColor(seed: string): string {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) % 9973
  return COVER_COLORS[hash % COVER_COLORS.length] ?? COVER_COLORS[0]!
}

function toCharacter(item: ImportMetaCharacter): Character {
  const name = item.name.trim() || '未命名角色'
  const role = item.role.trim()
  return {
    id: uid('ch'),
    name,
    role,
    age: '',
    identity: '',
    appearance: '',
    personality: '',
    motivation: '',
    flaw: '',
    arc: '',
    speechStyle: '',
    relations: [],
    hidden: false,
    notes: item.desc.trim()
  }
}

/**
 * 同卷内章节改名去重。
 * 作者手打的稿子里「第1章」「第一章」并存很常见，两个同名大纲节点会让人
 * 在大纲页分不清哪个是哪章，所以重名的追加序号（第 2 个起）。
 */
function dedupeTitle(title: string, used: Set<string>): string {
  const base = title.trim()
  if (!base) return ''
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  while (used.has(`${base}（${n}）`)) n++
  const next = `${base}（${n}）`
  used.add(next)
  return next
}

/**
 * 装配成完整的 Project：书名/作者/题材/简介进作品档案，卷章进章节与大纲。
 *
 * 空章（正文为空白）不导入 —— 目录行、卷首语这类没有正文的标题留着只会在
 * 章节列表里变成一串空壳。
 */
export function assembleImportedProject(product: ImportProduct, defaultSkillIds?: string[]): Project {
  const scene = getScene(product.sceneId || IMPORT_SCENE_ID)
  const perChapter = scene.defaultChapterWords
  const title = product.title.trim() || '未命名作品'
  const author = (product.author ?? '').trim()

  const project = createBlankProject({
    title,
    author,
    sceneId: scene.id,
    genreId: product.genreId || undefined,
    logline: (product.logline ?? '').trim(),
    premise: (product.premise ?? '').trim(),
    keywords: product.keywords ?? [],
    coverColor: pickCoverColor(title),
    // 导入的书之后还要接着写（改稿、续写），技法卡得跟新建的书一致，
    // 否则同一本书里前 30 章没有技法卡、第 31 章突然有，手感直接断层
    defaultSkillIds
  })

  // 人物档案：AI 认出来的角色直接可查，作者不必再手抄一遍
  const characters = (product.characters ?? []).filter((c) => c.name.trim() || c.desc.trim())
  project.bible = { ...project.bible, characters: characters.map(toCharacter) }

  const buildOutline = product.buildOutline !== false
  const now = Date.now()
  const chapters: Chapter[] = []
  const outline: OutlineNode[] = []

  product.volumes.forEach((volume, volumeIndex) => {
    const volumeTitle = volume.title.trim() || `第 ${volumeIndex + 1} 卷`
    const chapterNodes: OutlineNode[] = []
    const usedTitles = new Set<string>()

    for (const draft of volume.chapters) {
      const body = (draft.body ?? '').trim()
      // 空章不导入
      if (!body) continue

      const desired = dedupeTitle(draft.title, usedTitles)
      const chapterTitle = desired || `第 ${chapters.length + 1} 章`
      const nodeId = uid('o')
      const node: OutlineNode = {
        id: nodeId,
        title: chapterTitle,
        summary: (draft.summary ?? '').trim(),
        type: 'chapter',
        // 导入的是成稿：大纲节点和章节都已经是「完成」
        status: 'done',
        children: []
      }
      chapterNodes.push(node)
      chapters.push({
        id: uid('c'),
        title: chapterTitle,
        content: plainToHtml(body),
        summary: (draft.summary ?? '').trim(),
        status: 'done',
        targetWords: perChapter,
        words: countWords(body),
        // 显式指向本节点：不许靠标题兜底，同卷重名时兜底会指错
        ...(buildOutline ? { outlineNodeId: nodeId } : {}),
        createdAt: now,
        updatedAt: now,
        versions: []
      })
    }

    if (chapterNodes.length > 0) {
      outline.push({
        id: uid('o'),
        title: volumeTitle,
        summary: '',
        type: 'volume',
        // 卷下全是已成稿的章，卷还挂着「待写」会自相矛盾
        status: 'done',
        children: chapterNodes
      })
    }
  })

  if (chapters.length > 0) project.chapters = chapters
  project.outline = buildOutline ? outline : []
  project.updatedAt = Date.now()
  return project
}