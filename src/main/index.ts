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

// 平台开关集中在这里：createWindow 和 buildMenu 都要按平台分叉，各写一份容易走岔。
const isMac = process.platform === 'darwin'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#f7f8fa',
    // 只有两套窗口装饰可选，二选一，不能叠：
    // - macOS：hiddenInset，红绿灯仍由系统画，但要浮在自绘顶栏上（位置见下）；
    // - Windows/Linux：frame: false 走真正无边框。
    //   以前这里给非 mac 留的是 titleBarStyle: 'default'，那是完整原生窗口框 ——
    //   系统标题栏（图标+「墨舟 Mozhou」+最小化/最大化/关闭）、系统菜单栏（编辑/视图/窗口）
    //   会全部画出来，和 TitleBar.tsx 的自绘顶栏叠成上下两条栏、左右两套按钮。
    //   DESIGN.md §6 要的是「无边框标题栏 + 自绘顶栏」，所以非 mac 一律 frame: false：
    //   没有 frame 就没有原生标题栏，Windows/Linux 的菜单栏也属于原生窗口框的一部分，一并消失。
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          // 标题栏高 42px（.titlebar），右侧图标按钮 30px、垂直居中 → 中线在 21px。
          // 系统红绿灯直径 12px，要落在同一条中线上，顶部就得是 21 - 12/2 = 15。
          // 以前写 20，灯心在 26，比右边那排按钮低 5px，看起来像没对齐。
          trafficLightPosition: { x: 16, y: 15 }
        }
      : {
          // 只去掉窗口装饰，不顺手把系统行为也去掉：thickFrame 默认为 true，
          // 所以无边框窗口在 Windows 上仍然保留 WS_THICKFRAME —— 拖边缘可缩放、有阴影和动画；
          // roundedCorners 默认 true，Win11 上依然会被 DWM 加圆角（Win10 没有，这点接受）。
          // 拖动/双击标题栏最大化靠 .titlebar 的 -webkit-app-region: drag，Electron 会把
          // drag 区当非客户区处理（只有 transparent 窗口会丢掉双击最大化，我们不是）。
          frame: false
        }),
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
  // 结论：frame: false 只让菜单栏不再绘制，不会让 accelerator 失效，所以这里必须保持原样。
  // 依据：accelerator 是挂在窗口上的快捷键，frame 管的是「菜单栏那块 UI 画不画」；
  // 反过来的证据在 Electron 文档里 —— before-input-event 的 event.preventDefault 被描述为
  // 「同时拦掉页面的 keydown/keyup 和菜单快捷键」（想只拦菜单得用 setIgnoreMenuShortcuts），
  // 说明菜单快捷键是一条独立于窗口装饰的通道，去掉 frame 不影响它。
  // 于是 Windows/Linux 无边框之后：菜单栏看不见，但下面的 Ctrl+Shift+F（沉浸写作）以及
  // reload / toggleDevTools / zoomIn / zoomOut 这些 role 项的默认快捷键照旧生效，
  // 开发者要的「重新加载 / 开发者工具 / 缩放」也就还留着（只是没了可视入口，找不到就按快捷键）。
  // 不再用 before-input-event 把 Ctrl+Shift+F 补一遍：两条路都挂着会一次按键触发两次
  // （toggle 一开一关等于没反应），而且 preventDefault 还会连带吃掉渲染层的按键
  // （Ctrl+F 在 Workspace 里是自己监听 window keydown 的，不能被主进程抢掉）。
  // 唯一需要在 Windows 实机上确认的：打包后按 Ctrl+Shift+F，左栏应能收起/展开。
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