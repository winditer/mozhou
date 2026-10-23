import type { ReactNode } from 'react'
import { useApp } from '../store/app'
import { Check, CircleDot, Feather, Loader2, Minus, PanelRight, Settings as SettingsIcon, Square, X } from 'lucide-react'
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
        {!isMac && (
          <>
            <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
            <IconButton onClick={() => window.mz.app.minimize()} title="最小化">
              <Minus size={15} />
            </IconButton>
            <IconButton onClick={() => window.mz.app.maximize()} title="最大化">
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