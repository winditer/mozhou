/**
 * PDF 导出
 *
 * 借 Chromium：在隐藏窗口里加载 HTML，再用 printToPDF 打印成 A4 版式。
 * 窗口销毁放在 finally，任何一步抛错都不会残留 BrowserWindow。
 */
import { BrowserWindow } from 'electron'

/** 等字体与布局稳定的时间（毫秒） */
const SETTLE_MS = 300

/** 把完整 HTML 文档打印成 PDF */
export async function renderPdf(html: string): Promise<Buffer> {
  let win: BrowserWindow | null = null

  try {
    win = new BrowserWindow({
      show: false,
      width: 794,
      height: 1123,
      webPreferences: {
        offscreen: true,
        // 隐藏窗口默认会被降频，关掉后计时器与排版更稳定
        backgroundThrottling: false
      }
    })

    const target = win
    const loaded = new Promise<void>((resolve) => {
      target.webContents.once('did-finish-load', () => resolve())
    })

    await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await loaded
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

    return await target.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.8, bottom: 0.8, left: 0.9, right: 0.9 }
    })
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}