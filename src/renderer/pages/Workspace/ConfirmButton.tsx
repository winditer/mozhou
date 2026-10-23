import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../components/ui'

/**
 * 二次确认按钮：第一次点击变成「确认删除」，2.6s 内再点才执行。
 * 用于删除角色 / 大纲节点这类不可撤销操作。
 */
export function ConfirmButton({
  onConfirm,
  title,
  label,
  confirmLabel = '确认删除',
  className
}: {
  onConfirm: () => void
  title?: string
  label: ReactNode
  confirmLabel?: string
  className?: string
}): ReactNode {
  const [pending, setPending] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const arm = (): void => {
    setPending(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setPending(false), 2600)
  }

  if (pending) {
    return (
      <Button
        size="sm"
        variant="danger"
        className={className}
        title={title}
        onClick={() => {
          if (timer.current) clearTimeout(timer.current)
          setPending(false)
          onConfirm()
        }}
      >
        {confirmLabel}
      </Button>
    )
  }

  return (
    <Button size="sm" variant="ghost" className={className} title={title} onClick={arm}>
      {label}
    </Button>
  )
}