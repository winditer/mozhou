import { contextBridge, ipcRenderer } from 'electron'
import type { StreamDone } from '@shared/types'

const invoke = ipcRenderer.invoke.bind(ipcRenderer)
const send = ipcRenderer.send.bind(ipcRenderer)

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api = {
  app: {
    info: () => invoke('app:info'),
    openExternal: (url: string) => invoke('app:open-external', url),
    isFullScreen: () => invoke('win:is-fullscreen'),
    setFullScreen: (value: boolean) => send('win:set-fullscreen', value),
    onToggleFocus: (cb: () => void) => on('ui:toggle-focus', cb),
    minimize: () => send('win:minimize'),
    maximize: () => send('win:maximize'),
    close: () => send('win:close')
  },
  config: {
    get: () => invoke('config:get'),
    save: (config: unknown) => invoke('config:save', config),
    secretSet: (ref: string, value: string) => invoke('secret:set', ref, value),
    secretHas: (ref: string) => invoke('secret:has', ref),
    secretClear: (ref: string) => invoke('secret:clear', ref)
  },
  skill: {
    get: () => invoke('skill:get'),
    save: (lib: unknown) => invoke('skill:save', lib),
    resetBuiltin: () => invoke('skill:reset-builtin')
  },
  library: {
    get: () => invoke('library:get'),
    save: (lib: unknown) => invoke('library:save', lib),
    resetBuiltin: () => invoke('library:reset-builtin')
  },
  project: {
    list: () => invoke('project:list'),
    create: (project: unknown) => invoke('project:create', project),
    get: (id: string) => invoke('project:get', id),
    save: (project: unknown) => invoke('project:save', project),
    remove: (id: string) => invoke('project:remove', id),
    duplicate: (id: string) => invoke('project:duplicate', id),
    backupAll: () => invoke('project:backup'),
    restoreAll: () => invoke('project:restore')
  },
  ai: {
    chat: (req: unknown) => invoke('ai:chat', req),
    abort: (streamId: string) => invoke('ai:abort', streamId),
    test: (channel: unknown, apiKey: string, model: string) => invoke('ai:test', channel, apiKey, model),
    models: (channel: unknown, apiKey: string) => invoke('ai:models', channel, apiKey),
    onChunk: (cb: (c: { streamId: string; delta: string }) => void) => on('ai:chunk', cb),
    onThought: (cb: (c: { streamId: string; delta: string }) => void) => on('ai:thought', cb),
    onDone: (cb: (d: StreamDone) => void) => on('ai:done', cb),
    onError: (cb: (e: { streamId: string; message: string }) => void) => on('ai:error', cb)
  },
  search: {
    run: (req: unknown) => invoke('search:run', req)
  },
  io: {
    exportFile: (payload: unknown) => invoke('io:export', payload),
    importFile: () => invoke('io:import'),
    importChapters: (raw: string) => invoke('io:import-chapters', raw)
  }
}

contextBridge.exposeInMainWorld('mz', api)

export type PreloadApi = typeof api