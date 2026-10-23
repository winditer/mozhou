import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useApp } from '../store/app'

export function Toasts(): ReactNode {
  const { toasts, dismissToast } = useApp()
  if (!toasts.length) return null
  return createPortal(
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] flex flex-col gap-2 items-center">
      {toasts.map((t) => {
        const color = t.kind === 'error' ? 'var(--danger)' : t.kind === 'ok' ? 'var(--ok)' : 'var(--text-dim)'
        const Icon = t.kind === 'error' ? AlertCircle : t.kind === 'ok' ? CheckCircle2 : Info
        return (
          <div
            key={t.id}
            className="fade-in flex items-center gap-2 px-3.5 py-2 rounded-lg text-[12.5px] selectable"
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              boxShadow: 'var(--shadow)',
              color: 'var(--text)',
              maxWidth: 620
            }}
          >
            <Icon size={15} style={{ color, flexShrink: 0 }} />
            <span className="leading-snug">{t.text}</span>
            <button onClick={() => dismissToast(t.id)} className="ml-1" style={{ color: 'var(--text-faint)' }}>
              <X size={13} />
            </button>
          </div>
        )
      })}
    </div>,
    document.body
  )
}