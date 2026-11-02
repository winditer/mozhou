import { useEffect, type ReactNode } from 'react'
import { useApp } from './store/app'
import { themeVars } from '@shared/themes'
import { TitleBar } from './components/TitleBar'
import { Toasts } from './components/Toasts'
import { Bookshelf } from './pages/Bookshelf'
import { Settings } from './pages/Settings'
import { Workspace } from './pages/Workspace'
import { Loader2 } from 'lucide-react'
import { mz } from './lib/bridge'

function useThemeEffect(): void {
  const config = useApp((s) => s.config)
  useEffect(() => {
    if (!config) return
    const vars = themeVars(config.settings.themeId)
    const root = document.documentElement
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    const t = config.settings.typography
    root.style.setProperty('--editor-font', t.fontFamily)
    root.style.setProperty('--editor-size', `${t.fontSize}px`)
    root.style.setProperty('--editor-line', String(t.lineHeight))
    root.style.setProperty('--editor-width', `${t.pageWidth}px`)
    root.style.setProperty('--editor-indent', t.indent ? '2em' : '0')
    root.style.setProperty('--editor-para-gap', `${t.paragraphSpacing}em`)
    document.body.style.background = vars['--bg'] ?? '#f7f8fa'
  }, [config])
}

export function App(): ReactNode {
  const { ready, view, init, flush } = useApp()
  const focusMode = useApp((s) => s.config?.settings.focusMode ?? false)
  useThemeEffect()

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (view === 'workspace' || !focusMode) return
    void useApp.getState().patchSettings({ focusMode: false })
    mz.app.setFullScreen(false)
  }, [view, focusMode])

  // 自动化验收钩子（同时便于未来做 E2E）
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__MZ = {
      openProject: (id: string) => useApp.getState().openProject(id),
      setView: (v: string) => useApp.getState().setView(v as never),
      setTab: (t: string) => useApp.getState().setTab(t as never),
      state: () => useApp.getState(),
      /** 按文字点按钮：写作页把搜索入口收成快捷键以后，验收脚本不能再靠按钮文字开面板 */
      clickByText: (text: string): boolean => {
        const want = text.replace(/\s+/g, '')
        const hit = [...document.querySelectorAll<HTMLElement>('button, [role="button"], a')].find(
          (el) => (el.textContent ?? '').replace(/\s+/g, '').includes(want)
        )
        if (!hit) return false
        hit.click()
        return true
      },
      /** 给受控 input 赋值：必须走原型上的 value setter，否则 React 收不到这次改动 */
      typeInto: (selector: string, value: string): boolean => {
        const el = document.querySelector(selector) as HTMLInputElement | null
        if (!el) return false
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      },
      /** 派发一次快捷键。meta 与 ctrl 同时给，mac / Windows 的处理分支都能走到 */
      press: (key: string, mods?: { shift?: boolean }): boolean =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            metaKey: true,
            ctrlKey: true,
            shiftKey: mods?.shift ?? false,
            bubbles: true,
            cancelable: true
          })
        )
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key.toLowerCase() === 's') {
        e.preventDefault()
        void flush()
      }
      if (e.key === ',') {
        e.preventDefault()
        useApp.getState().setView('settings')
      }
      if (!e.shiftKey && e.key.toLowerCase() === 'j' && useApp.getState().view === 'workspace') {
        e.preventDefault()
        useApp.getState().toggleAiPanel()
      }
    }
    window.addEventListener('keydown', onKey)
    const onBeforeUnload = (): void => {
      void flush()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [flush])

  if (!ready) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <Loader2 size={22} className="spin" style={{ color: 'var(--accent)' }} />
        <div className="text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
          正在载入墨舟…
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {!(focusMode && view === 'workspace') && <TitleBar />}
      <div className="flex-1 min-h-0">
        {view === 'bookshelf' && <Bookshelf />}
        {view === 'workspace' && <Workspace />}
        {view === 'settings' && <Settings />}
      </div>
      <Toasts />
    </div>
  )
}