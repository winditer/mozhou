import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import type {
  Channel,
  ChatRequest,
  Config,
  FilePickResult,
  Project,
  ProjectMeta,
  SearchChannel,
  SearchRunRequest,
  SearchRunResult
} from '@shared/types'
import type { StyleLibrary } from '@shared/styleLibrary'
import type { SkillLibrary } from '@shared/skills'
import { splitChapters, plainToHtml, countWords, uid } from '@shared/utils'
import {
  clearSecret,
  getSecret,
  hasSecret,
  loadConfig,
  saveConfig,
  setSecret
} from '../storage/config'
import {
  loadStyleLibrary,
  mergeLibraryFromBackup,
  readLibraryForBackup,
  resetBuiltinPersonas,
  saveStyleLibrary
} from '../storage/styleLibrary'
import {
  loadSkillLibrary,
  resetBuiltinSkills,
  saveSkillLibrary
} from '../storage/skills'
import {
  collectAllProjects,
  createProject,
  duplicateProject,
  getProject,
  listProjects,
  removeProject,
  restoreProjects,
  saveProject,
  type BackupPayload
} from '../storage/projects'
import { abortStream, listModels, streamChat, testChannel } from '../ai/registry'
import { buildDocx, buildHtml, buildMarkdown, buildPdf, buildText } from '../export/index'
import { searchCacheFile } from '../paths'
import { runSearch } from '../search/index'
import { deepSeekDonor } from '../search/keySource'
import { canReuseModelKey } from '@shared/webSearch'

type Win = BrowserWindow | null

function senderWin(e: Electron.IpcMainInvokeEvent): Win {
  return BrowserWindow.fromWebContents(e.sender)
}

export function registerIpc(): void {
  /* ───── app ───── */
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
    locale: app.getLocale()
  }))

  ipcMain.handle('app:open-external', async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  /*
   * 复制走主进程：渲染进程的 navigator.clipboard 要求窗口有焦点，
   * 无焦点时直接 NotAllowedError，execCommand 也会静默失败。
   * Electron 的 clipboard 没有这个限制。
   */
  ipcMain.handle('app:copy-text', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })

  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle('win:is-fullscreen', (e) => BrowserWindow.fromWebContents(e.sender)?.isFullScreen() ?? false)
  ipcMain.on('win:set-fullscreen', (e, value: boolean) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w && w.isFullScreen() !== Boolean(value)) w.setFullScreen(Boolean(value))
  })

  /* ───── config ───── */
  ipcMain.handle('config:get', async () => loadConfig())
  ipcMain.handle('config:save', async (_e, config: Config) => saveConfig(config))

  ipcMain.handle('secret:set', async (_e, ref: string, value: string) => setSecret(ref, value))
  ipcMain.handle('secret:has', async (_e, ref: string) => hasSecret(ref))
  ipcMain.handle('secret:clear', async (_e, ref: string) => clearSecret(ref))

  /* ───── 系统文风分身库 ───── */
  ipcMain.handle('library:get', async () => loadStyleLibrary())
  ipcMain.handle('library:save', async (_e, lib: StyleLibrary) => saveStyleLibrary(lib))
  ipcMain.handle('library:reset-builtin', async () => resetBuiltinPersonas())

  /* ───── 写作技法卡库 ───── */
  ipcMain.handle('skill:get', async () => loadSkillLibrary())
  ipcMain.handle('skill:save', async (_e, lib: SkillLibrary) => saveSkillLibrary(lib))
  ipcMain.handle('skill:reset-builtin', async () => resetBuiltinSkills())

  /* ───── project ───── */
  ipcMain.handle('project:list', async (): Promise<ProjectMeta[]> => listProjects())
  ipcMain.handle('project:create', async (_e, project: Project) => createProject(project))
  ipcMain.handle('project:get', async (_e, id: string) => getProject(id))
  ipcMain.handle('project:save', async (_e, project: Project) => saveProject(project))
  ipcMain.handle('project:remove', async (_e, id: string) => removeProject(id))
  ipcMain.handle('project:duplicate', async (_e, id: string) => duplicateProject(id))

  ipcMain.handle('project:backup', async (e): Promise<FilePickResult> => {
    const win = senderWin(e)
    const all = await collectAllProjects()
    const payload: BackupPayload = { app: 'mozhou', version: 1, exportedAt: Date.now(), projects: all }
    const stamp = new Date().toISOString().slice(0, 10)
    const res = await dialog.showSaveDialog(win!, {
      title: '导出完整备份',
      defaultPath: `墨舟备份-${stamp}.mzbak`,
      filters: [{ name: '墨舟备份', extensions: ['mzbak', 'json'] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true }
    await fs.writeFile(res.filePath, JSON.stringify(payload, null, 2), 'utf8')
    return { canceled: false, path: res.filePath }
  })

  ipcMain.handle('project:restore', async (e) => {
    const win = senderWin(e)
    const res = await dialog.showOpenDialog(win!, {
      title: '从备份还原（会新增作品，不覆盖已有）',
      properties: ['openFile'],
      filters: [{ name: '墨舟备份', extensions: ['mzbak', 'json'] }]
    })
    if (res.canceled || !res.filePaths[0]) return { ok: false, message: '已取消' }
    try {
      const text = await fs.readFile(res.filePaths[0], 'utf8')
      const payload = JSON.parse(text) as BackupPayload
      const n = await restoreProjects(payload)
      return { ok: true, count: n }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  /* ───── ai ───── */
  ipcMain.handle('ai:chat', async (e, req: ChatRequest) => {
    const wc = e.sender
    const channel = req.channel
    const apiKey = await getSecret(`channel:${channel.id}`)
    if (!apiKey && !isKeylessChannel(channel)) {
      wc.send('ai:error', { streamId: req.streamId, message: '该渠道还没有填写 API Key，请到「设置 → 模型与渠道」里补上' })
      return { ok: false, error: 'missing-key' }
    }
    const full: ChatRequest = { ...req, apiKey }
    try {
      const usage = await streamChat(
        full,
        (delta) => {
          if (!wc.isDestroyed()) wc.send('ai:chunk', { streamId: req.streamId, delta })
        },
        // 思考类模型的推理增量：只用于界面反馈「模型在动」，不并入正文
        (delta) => {
          if (!wc.isDestroyed()) wc.send('ai:thought', { streamId: req.streamId, delta })
        }
      )
      if (!wc.isDestroyed()) {
        wc.send('ai:done', {
          streamId: req.streamId,
          text: '',
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          finishReason: usage.finishReason,
          // 空正文不在这里报错，交给上层判断重试：只有渲染层知道目标字数和这次是不是首轮
          empty: usage.empty,
          finishedAbnormally: usage.finishedAbnormally
        })
      }
      return { ok: true }
    } catch (err) {
      const msg = (err as Error).message || '未知错误'
      if (!wc.isDestroyed()) wc.send('ai:error', { streamId: req.streamId, message: msg })
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle('ai:abort', async (_e, streamId: string) => {
    abortStream(streamId)
  })

  ipcMain.handle('ai:test', async (_e, channel: Channel, apiKey: string, model: string) => {
    const key = apiKey || (await getSecret(`channel:${channel.id}`))
    return testChannel(channel, key, model)
  })

  ipcMain.handle('ai:models', async (_e, channel: Channel, apiKey: string) => {
    const key = apiKey || (await getSecret(`channel:${channel.id}`))
    return listModels(channel, key)
  })

  /* ───── 联网检索 ───── */
  /**
   * 搜索源与 key 都在主进程解析：渲染进程只报 channelId，
   * 拿不到明文 key，也就不会把它写进任何前端状态或日志里。
   */
  ipcMain.handle('search:run', async (_e, req: SearchRunRequest): Promise<SearchRunResult> => {
    const cfg = await loadConfig()
    const ws = cfg.settings.webSearch
    const channel = (cfg.searchChannels ?? []).find((c) => c.id === req.channelId && c.enabled !== false) ?? null
    const apiKey = channel ? await searchKeyFor(channel, cfg) : null
    return runSearch({
      channel,
      apiKey,
      queries: (req.queries ?? []).slice(0, 3),
      maxResults: Math.min(8, Math.max(3, req.maxResults || ws.maxResults)),
      ttlHours: ws.cacheTtlHours,
      cacheFile: searchCacheFile()
    })
  })

  /* ───── 导入导出 ───── */
  ipcMain.handle(
    'io:export',
    async (e, payload: { kind: 'md' | 'txt' | 'html' | 'docx' | 'pdf'; title: string; items: { title: string; content: string }[] }): Promise<FilePickResult> => {
      const win = senderWin(e)
      const extMap = { md: 'md', txt: 'txt', html: 'html', docx: 'docx', pdf: 'pdf' } as const
      const res = await dialog.showSaveDialog(win!, {
        title: '导出文稿',
        defaultPath: `${payload.title || '未命名'}.${extMap[payload.kind]}`,
        filters: [{ name: payload.kind.toUpperCase(), extensions: [extMap[payload.kind]] }]
      })
      if (res.canceled || !res.filePath) return { canceled: true }
      const items = payload.items
      try {
        if (payload.kind === 'md') {
          await fs.writeFile(res.filePath, buildMarkdown(payload.title, items), 'utf8')
        } else if (payload.kind === 'txt') {
          await fs.writeFile(res.filePath, buildText(payload.title, items), 'utf8')
        } else if (payload.kind === 'html') {
          await fs.writeFile(res.filePath, buildHtml(payload.title, items), 'utf8')
        } else if (payload.kind === 'docx') {
          const buf = await buildDocx(payload.title, items)
          await fs.writeFile(res.filePath, buf)
        } else {
          const html = buildHtml(payload.title, items, { fontSize: 15 })
          const buf = await buildPdf(html)
          await fs.writeFile(res.filePath, buf)
        }
        return { canceled: false, path: res.filePath }
      } catch (err) {
        return { canceled: false, message: (err as Error).message }
      }
    }
  )

  ipcMain.handle('io:import', async (e): Promise<FilePickResult> => {
    const win = senderWin(e)
    const res = await dialog.showOpenDialog(win!, {
      title: '导入文稿',
      properties: ['openFile'],
      filters: [{ name: '文稿', extensions: ['txt', 'md', 'markdown'] }]
    })
    if (res.canceled || !res.filePaths[0]) return { canceled: true }
    const path = res.filePaths[0]
    const text = await fs.readFile(path, 'utf8')
    return { canceled: false, path, content: text }
  })

  ipcMain.handle('io:import-chapters', async (_e, raw: string) => {
    const parts = splitChapters(raw)
    return parts.map((p) => ({
      id: uid('c'),
      title: p.title || '无标题',
      content: plainToHtml(p.body),
      summary: '',
      status: 'draft' as const,
      targetWords: 0,
      words: countWords(p.body),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      versions: []
    }))
  })
}

function isKeylessChannel(channel: Channel): boolean {
  return /127\.0\.0\.1|localhost/i.test(channel.baseUrl)
}

/**
 * 搜索接口的 Key：先看自己有没有单独存。
 *
 * 没存时对 DeepSeek 预设做一次复用：作者已经在用 DeepSeek 写稿的话，
 * 让他为「查资料」再贴一遍同一个 Key 是没有道理的——而绝大多数人做到这一步
 * 会因为「不想再申请一个」直接放弃这个功能。
 *
 * 判定规则在 search/keySource.ts，那里有单独的测试（猜错等于发错 token）。
 */
async function searchKeyFor(channel: SearchChannel, cfg: Config): Promise<string | null> {
  const own = await getSecret(`search:${channel.id}`)
  if (own) return own
  if (!canReuseModelKey(channel)) return null
  const donor = deepSeekDonor(cfg.channels ?? [])
  return donor ? await getSecret(`channel:${donor.id}`) : null
}

export function fileNameOf(p: string): string {
  return basename(p)
}