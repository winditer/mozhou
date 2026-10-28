/**
 * 对话里的「建章并写稿」：应用完之后真正去写那一章。
 *
 * 为什么单独一个模块、而不是塞进 applyResolved：
 * 这里要调一次模型、跑几分钟、会失败、要能取消。纯函数层有副作用就没法在 node 里测，
 * 而改稿这条链最需要测的恰恰是「出错时稿子还在不在」。
 *
 * 生成器从 deps 注入（真实实现是 generateDraft），任务本身不 import 模型层。
 */
import type { Chapter, Project } from '@shared/types'
import { textToParagraph } from './paragraphs'

export interface DraftJob {
  chapterId: string
  title: string
  targetWords: number
  /** 已有正文的章：接着写而不是从头写 */
  continueOnly: boolean
}

export interface DraftProgress {
  chapterId: string
  title: string
  written: number
  target: number
  index: number
  total: number
}

export interface DraftGenArgs {
  project: Project
  chapter: Chapter
  targetWords: number
  existingWords: number
  instruction: string
  onDelta: (d: string) => void
  onStage?: (stage: string) => void
  onThought?: (t: string) => void
}

export interface DraftDeps {
  generate: (a: DraftGenArgs) => Promise<string>
  /** 每次都现取：写稿期间正文一直在变，闭包捕获的那份早就过期了 */
  getProject: () => Project | null
  patch: (chapterId: string, patch: Partial<Chapter>) => void
  /** 把界面切到这一章，让作者看着它长 */
  focus?: (chapterId: string) => void
  onProgress?: (p: DraftProgress) => void
  onStage?: (stage: string) => void
  /** 作者点了停止 */
  shouldStop?: () => boolean
  /** 落盘节流，默认 500ms；测试里传 0 表示每段都落 */
  flushMs?: number
}

export interface DraftResult {
  ok: number
  failed: number
  stopped: boolean
}

const plain = (html: string): string => html.replace(/<[^>]+>/g, '')
/** 正文字数口径与全书一致：去掉空白再数，避免把换行算成字 */
const chars = (html: string): number => plain(html).replace(/\s/g, '').length

/**
 * 串行写稿。
 *
 * 串行是刻意的：并发写几章会把渠道的并发打满、失败重试彼此干扰，
 * 而作者看的是「一章一章写出来」，慢一点但可预期。
 */
export async function runDraftJobs(jobs: DraftJob[], deps: DraftDeps): Promise<DraftResult> {
  const flushMs = deps.flushMs ?? 500
  let ok = 0
  let failed = 0
  let stopped = false

  for (const [index, job] of jobs.entries()) {
    if (deps.shouldStop?.()) {
      stopped = true
      break
    }
    const project = deps.getProject()
    const chapter = project?.chapters.find((c) => c.id === job.chapterId)
    if (!project || !chapter) {
      failed++
      continue
    }

    const baseHtml = job.continueOnly ? chapter.content : ''
    // 「上次我们写进去的值」：落盘前比对这个，能立刻发现作者自己动了笔
    let lastWritten = chapter.content
    let buffer = ''
    let lastFlush = 0
    let conflict = false
    // 作者点了停止：后续 delta 一律不收，已写的部分留着（真要中止流，调用方另有 abortChat）
    let stopRequested = false

    const write = (final: boolean): void => {
      const live = deps.getProject()?.chapters.find((c) => c.id === job.chapterId)
      if (!live) return
      if (live.content !== lastWritten) {
        // 作者在这一章动手了：停下来，别把他的字冲掉
        conflict = true
        return
      }
      const html = baseHtml + textToParagraph(buffer)
      if (html === lastWritten && !final) return
      lastWritten = html
      deps.patch(job.chapterId, { content: html, words: chars(html) })
      deps.onProgress?.({
        chapterId: job.chapterId,
        title: job.title,
        written: chars(html),
        target: job.targetWords,
        index,
        total: jobs.length
      })
    }

    deps.focus?.(job.chapterId)
    deps.onStage?.(`正在写「${job.title}」…`)

    try {
      await deps.generate({
        project,
        chapter: { ...chapter, content: baseHtml },
        targetWords: job.targetWords,
        existingWords: chars(baseHtml),
        instruction: job.continueOnly
          ? '接着这一章往下写，接上已有结尾，不要重写前面写过的内容。'
          : '写出这一章的初稿。',
        onDelta: (d) => {
          if (stopRequested) return
          if (deps.shouldStop?.()) {
            stopRequested = true
            return
          }
          buffer += d
          const now = Date.now()
          if (flushMs === 0 || now - lastFlush >= flushMs) {
            lastFlush = now
            write(false)
          }
        },
        onStage: deps.onStage
      })
      write(true)
      if (conflict || stopRequested) {
        stopped = true
        break
      }
      ok++
    } catch {
      // 失败也把已写部分落盘：半章比空章有用，作者可以接着说「继续写」
      write(true)
      if (conflict || stopRequested) {
        stopped = true
        break
      }
      failed++
    }
    if (deps.shouldStop?.()) {
      stopped = true
      break
    }
  }

  return { ok, failed, stopped }
}