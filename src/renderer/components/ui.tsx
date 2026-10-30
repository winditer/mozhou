import React, { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { X } from 'lucide-react'

/* ───────────────────────── Button ───────────────────────── */

type BtnVariant = 'default' | 'primary' | 'ghost' | 'danger'
type BtnSize = 'sm' | 'md' | 'lg'

export function Button({
  children,
  variant = 'default',
  size = 'md',
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize }): ReactNode {
  return (
    <button
      className={clsx(
        'btn',
        variant === 'primary' && 'btn-primary',
        variant === 'ghost' && 'btn-ghost',
        variant === 'danger' && 'btn-danger',
        size === 'sm' && 'btn-sm',
        size === 'lg' && 'btn-lg',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function IconButton({
  children,
  active,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }): ReactNode {
  return (
    <button className={clsx('icon-btn', active && 'active', className)} {...rest}>
      {children}
    </button>
  )
}

/* ───────────────────────── 表单 ───────────────────────── */

export function Field({
  label,
  hint,
  children,
  className
}: {
  label?: string
  hint?: string
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <div className={clsx('min-w-0', className)}>
      {label && <label className="label">{label}</label>}
      {children}
      {hint && <div className="mt-1 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>{hint}</div>}
    </div>
  )
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input {...props} className={clsx('input', props.className)} />
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return <textarea {...props} className={clsx('textarea', props.className)} />
}

export function Select({
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select {...props} className={clsx('select', props.className)}>
      {children}
    </select>
  )
}

export function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}): ReactNode {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2"
      style={{ cursor: 'default' }}
    >
      <span
        className="relative inline-flex items-center rounded-full transition-colors"
        style={{
          width: 36,
          height: 21,
          background: checked ? 'var(--accent)' : 'var(--border-strong)'
        }}
      >
        <span
          className="absolute rounded-full bg-white transition-transform"
          style={{
            width: 17,
            height: 17,
            left: 2,
            transform: checked ? 'translateX(15px)' : 'none',
            boxShadow: '0 1px 3px rgba(0,0,0,.25)'
          }}
        />
      </span>
      {label && <span style={{ color: 'var(--text-dim)' }}>{label}</span>}
    </button>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
}): ReactNode {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full"
      style={{ accentColor: 'var(--accent)' }}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}): ReactNode {
  return (
    <div className="inline-flex p-0.5 rounded-lg" style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className="px-2.5 h-[26px] rounded-md text-[12px] transition-colors whitespace-nowrap"
          style={{
            background: value === o.value ? 'var(--panel)' : 'transparent',
            color: value === o.value ? 'var(--text)' : 'var(--text-dim)',
            boxShadow: value === o.value ? '0 1px 2px rgba(0,0,0,.08)' : 'none',
            fontWeight: value === o.value ? 600 : 400
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ───────────────────────── Modal ───────────────────────── */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 620
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div
      data-mz-modal="1"
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(8,12,18,.42)', backdropFilter: 'blur(2px)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        className="fade-in card flex flex-col overflow-hidden"
        style={{ width, maxWidth: '92vw', maxHeight: '86vh', background: 'var(--panel)', boxShadow: 'var(--shadow)' }}
      >
        {title && (
          <div className="flex items-center justify-between px-5 h-12 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="font-semibold text-[14px]">{title}</div>
            <IconButton onClick={onClose} aria-label="关闭">
              <X size={16} />
            </IconButton>
          </div>
        )}
        <div className="flex-1 overflow-auto scroll-thin px-5 py-4 selectable">{children}</div>
        {footer && (
          <div className="px-5 py-3 flex justify-end gap-2 shrink-0" style={{ borderTop: '1px solid var(--border)', background: 'var(--panel-2)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

/* ───────────────────────── 其它 ───────────────────────── */

export function Spinner({ size = 14 }: { size?: number }): ReactNode {
  return (
    <span
      className="spin inline-block rounded-full"
      style={{ width: size, height: size, border: '2px solid currentColor', borderTopColor: 'transparent', opacity: 0.8 }}
    />
  )
}

export function EmptyState({
  icon,
  title,
  desc,
  action
}: {
  icon?: ReactNode
  title: string
  desc?: string
  action?: ReactNode
}): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      {icon && <div style={{ color: 'var(--text-faint)' }}>{icon}</div>}
      <div className="mt-3 font-medium text-[14px]">{title}</div>
      {desc && (
        <div className="mt-1.5 text-[12.5px] max-w-sm leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          {desc}
        </div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Section({
  title,
  desc,
  children,
  right
}: {
  title: string
  desc?: string
  children: ReactNode
  right?: ReactNode
}): ReactNode {
  return (
    <div className="card p-5 mb-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="font-semibold text-[14px]">{title}</div>
          {desc && (
            <div className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
              {desc}
            </div>
          )}
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

export function Progress({ value, max = 100, height = 5 }: { value: number; max?: number; height?: number }): ReactNode {
  const pct = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100))
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height, background: 'var(--panel-2)' }}>
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--ok)' : 'var(--accent)' }}
      />
    </div>
  )
}

export function Tooltip({ text, children }: { text: string; children: ReactNode }): ReactNode {
  return (
    <span title={text} className="inline-flex">
      {children}
    </span>
  )
}

/**
 * 原生 checkbox 太丑、第三方组件又没必要，这里包一层。
 * 保留原生 input 是为了键盘与无障碍：label 包住它，点文字也能勾。
 */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  title
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: ReactNode
  disabled?: boolean
  title?: string
}): ReactNode {
  return (
    <label
      className="inline-flex items-center gap-1.5 text-[12px] select-none"
      style={{ color: disabled ? 'var(--text-faint)' : 'var(--text-dim)', cursor: disabled ? 'default' : 'pointer' }}
      title={title}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 13, height: 13, accentColor: 'var(--accent)', margin: 0 }}
      />
      {label}
    </label>
  )
}