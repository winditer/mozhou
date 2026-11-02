import type { ReactNode } from 'react'
import { useApp } from '../store/app'
import { BookOpen, Check, CircleDot, Feather, Loader2, Minus, PanelRight, Settings as SettingsIcon, Square, X } from 'lucide-react'
import { IconButton } from './ui'

export function TitleBar(): ReactNode {
  const { view, project, saving, savedAt, setView, toggleAiPanel, aiPanelOpen, appInfo, flush } = useApp()
  const isMac = appInfo?.platform === 'darwin'
  const isWorkspace = view === 'workspace'

  return (
    <div className="titlebar" style={{ paddingLeft: isMac ? 86 : 12 }}>
      <div className="flex items-center gap-2 no-drag" style={{ minWidth: 0 }}>
        <button
          onClick={() => setView('bookshelf')}
          className="flex items-center gap-1.5 font-semibold text-[13px] tracking-wide"
          style={{ color: 'var(--text)' }}
          title="回到书架"
        >
          <Feather size={15} style={{ color: 'var(--accent)' }} />
          墨舟
        </button>
        {/*
          以前只有 logo 能回书架，用户以为那只是个图标；第一次打开又被引导进设置页，
          配完模型就找不到作品列表了。给一个写着「书架」的按钮，回退路径才看得见。
        */}
        {view !== 'bookshelf' && (
          <button
            onClick={() => setView('bookshelf')}
            className="flex items-center gap-1 h-7 px-2 rounded-md text-[12px] surface-hover"
            style={{ color: 'var(--text-dim)' }}
            title="返回书架（作品列表）"
          >
            <BookOpen size={13} />
            书架
          </button>
        )}
        {isWorkspace && project && (
          <>
            <span style={{ color: 'var(--text-faint)' }}>/</span>
            <span className="text-[12.5px] truncate max-w-[280px]" style={{ color: 'var(--text-dim)' }} title={project.title}>
              {project.title}
            </span>
            <span className="flex items-center gap-1 text-[11px] ml-1" style={{ color: 'var(--text-faint)' }}>
              {saving ? (
                <>
                  <Loader2 size={11} className="spin" />
                  保存中
                </>
              ) : savedAt ? (
                <>
                  <Check size={11} />
                  已自动保存
                </>
              ) : (
                <>
                  <CircleDot size={11} />
                  未保存
                </>
              )}
            </span>
          </>
        )}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-0.5 no-drag">
        {isWorkspace && (
          <>
            <IconButton onClick={() => void flush()} title="立即保存（⌘S）">
              <Check size={15} />
            </IconButton>
            <IconButton onClick={toggleAiPanel} active={aiPanelOpen} title="AI 面板">
              <PanelRight size={15} />
            </IconButton>
          </>
        )}
        <IconButton onClick={() => setView('settings')} active={view === 'settings'} title="设置（⌘,）">
          <SettingsIcon size={15} />
        </IconButton>
        {/*
          Windows/Linux 下主窗口是 frame: false（见 src/main/index.ts createWindow），
          系统标题栏和系统菜单栏都不画了，所以这三个按钮是唯一的窗口控制入口，必须留着。
          它们走 preload 的 window.mz.app.* → 主进程 ipcMain 的 win:minimize/maximize/close；
          maximize 那侧是 isMaximized() ? unmaximize() : maximize()，所以同一个按钮点两次
          就是「最大化 ↔ 还原」来回切。
          mac 不渲染它们：红绿灯由系统画，hiddenInset 下位置由 trafficLightPosition 控制。
        */}
        {!isMac && (
          <>
            <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
            <IconButton onClick={() => window.mz.app.minimize()} title="最小化">
              <Minus size={15} />
            </IconButton>
            <IconButton onClick={() => window.mz.app.maximize()} title="最大化 / 还原">
              <Square size={13} />
            </IconButton>
            <IconButton onClick={() => window.mz.app.close()} title="关闭">
              <X size={15} />
            </IconButton>
          </>
        )}
      </div>
    </div>
  )
}