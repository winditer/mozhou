import { BrowserWindow, Menu, app, shell } from 'electron'
import { join } from 'node:path'
import { applyUserDataOverride } from './paths'
import { registerIpc } from './ipc'

applyUserDataOverride()

const dbg = (m: string, ...a: unknown[]): void => {
  if (process.env['MOZHOU_DEBUG']) console.error('[mz]', m, ...a)
}
process.on('uncaughtException', (e) => console.error('[mz] uncaught', e))
process.on('unhandledRejection', (e) => console.error('[mz] unhandled', e))

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#f7f8fa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 20 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false
    }
  })

  mainWindow.webContents.on('did-finish-load', () => dbg('did-finish-load'))
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => dbg('did-fail-load', code, desc, url))
  mainWindow.webContents.on('render-process-gone', (_e, d) => dbg('render-process-gone', JSON.stringify(d)))
  mainWindow.on('ready-to-show', () => {
    dbg('ready-to-show')
    mainWindow?.show()
  })

  // 外链一律走系统浏览器，窗口内不允许跳转
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('file://')) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 自动化验收用：MOZHOU_SHOT=/path/to.png 时加载完成后截图退出
  const shot = process.env['MOZHOU_SHOT']
  if (shot) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        // 验收用：MOZHOU_SHOT_WIDTH 可在截图前把窗口改到指定宽度，
        // 用来复现窄窗口下的布局问题（默认 1440，最小 1080）
        const forcedW = Number(process.env['MOZHOU_SHOT_WIDTH'] ?? 0)
        if (forcedW > 0 && mainWindow) {
          mainWindow.setSize(forcedW, mainWindow.getSize()[1])
          await new Promise((r) => setTimeout(r, 400))
        }
        const js = process.env['MOZHOU_SHOT_JS']
        if (js) {
          try {
            const out = await mainWindow?.webContents.executeJavaScript(js)
            if (out !== undefined) console.error('[mz] shot-js-result ' + JSON.stringify(out))
          } catch (e) {
            console.error('[mz] shot js failed', e)
          }
          await new Promise((r) => setTimeout(r, Number(process.env['MOZHOU_SHOT_JS_WAIT'] ?? 900)))
        }
        void mainWindow?.webContents
          .capturePage()
          .then(async (img) => {
            const { writeFile } = await import('node:fs/promises')
            await writeFile(shot, img.toPNG())
          })
          .finally(() => app.quit())
      }, Number(process.env['MOZHOU_SHOT_DELAY'] ?? 2200))
    })
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const, label: '关于墨舟' },
              { type: 'separator' as const },
              { role: 'hide' as const, label: '隐藏墨舟' },
              { role: 'hideOthers' as const, label: '隐藏其他' },
              { role: 'unhide' as const, label: '全部显示' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: '退出墨舟' }
            ]
          }
        ]
      : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        {
          label: '沉浸写作',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send('ui:toggle-focus')
        },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const, label: '前置全部窗口' }] : [{ role: 'close' as const, label: '关闭' }])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

void app.whenReady().then(() => {
  dbg('ready')
  app.setName('墨舟')
  registerIpc()
  dbg('ipc registered')
  buildMenu()
  createWindow()
  dbg('window created')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})