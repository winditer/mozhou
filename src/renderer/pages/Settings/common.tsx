import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { AppSettings, Config } from '@shared/types'
import { Button, Modal } from '../../components/ui'
import { useApp } from '../../store/app'

/* ───────────────────────── 基础工具 ───────────────────────── */

/** 等宽字体栈：BaseURL / 模型 ID / 路径都用它 */
export const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace'

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return '未知错误'
}

/**
 * 统一的配置写入口：读当前 config → 交给 fn 产出新 config → 落盘
 * 任何 IPC 异常都会 toast，返回值表示是否写成功
 */
export async function commitConfig(fn: (c: Config) => Config): Promise<boolean> {
  const { config, saveConfig, toast } = useApp.getState()
  if (!config) {
    toast('配置尚未载入，请稍候重试', 'error')
    return false
  }
  try {
    await saveConfig(fn(config))
    return true
  } catch (e) {
    toast(`保存失败：${errMsg(e)}`, 'error')
    return false
  }
}

/** 只改 settings 的写入口 */
export async function patchSettingsSafe(patch: Partial<AppSettings>): Promise<boolean> {
  const { config, patchSettings, toast } = useApp.getState()
  if (!config) {
    toast('配置尚未载入，请稍候重试', 'error')
    return false
  }
  try {
    await patchSettings(patch)
    return true
  } catch (e) {
    toast(`保存失败：${errMsg(e)}`, 'error')
    return false
  }
}

/**
 * 拖滑块时不要每个像素都写一次磁盘：本地立即生效，停顿 delay 毫秒后再落盘，
 * 卸载时若还有未落盘的改动会补一次提交。
 */
export function useDebounced<T>(
  initial: T | undefined,
  commit: (value: T) => void,
  delay = 220
): [T | undefined, (value: T) => void] {
  const [value, setValue] = useState<T | undefined>(initial)
  const valueRef = useRef<T | undefined>(initial)
  const commitRef = useRef(commit)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  commitRef.current = commit

  useEffect(() => {
    valueRef.current = initial
    setValue(initial)
  }, [initial])

  const update = useCallback(
    (next: T): void => {
      valueRef.current = next
      setValue(next)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        commitRef.current(next)
      }, delay)
    },
    [delay]
  )

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        if (valueRef.current !== undefined) commitRef.current(valueRef.current)
      }
    },
    []
  )

  return [value, update]
}

/** 渠道 / 模型都在别的 section 里被引用，统一取「可用模型」判定 */
export function isChannelUsable(config: Config, channelId: string): boolean {
  return config.channels.some((c) => c.id === channelId && c.enabled && c.baseUrl.trim().length > 0)
}

/* ───────────────────────── 布局零件 ───────────────────────── */

export function PageHead({ title, desc, right }: { title: string; desc?: string; right?: ReactNode }): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 mb-4">
      <div className="min-w-0">
        <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
        {desc && (
          <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            {desc}
          </p>
        )}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  )
}

/** 一行「标题 + 说明 + 右侧控件」 */
export function Row({
  title,
  desc,
  control,
  htmlForId,
  tag,
  note,
  below,
  align = 'center',
  className
}: {
  title: string
  desc?: string
  control: ReactNode
  htmlForId?: string
  /** 标题后的短标签（如「按字数」「固定额度」） */
  tag?: ReactNode
  /** 说明下方的补充提示，用于需要注意的例外情况 */
  note?: ReactNode
  /** 行内控件区下方的整行内容，用于随控件变化的小字说明 */
  below?: ReactNode
  /** 控件较高时用 start，让标题与控件顶部对齐 */
  align?: 'center' | 'start'
  /** 需要自定义行外框（如加分隔线、改内边距）时传入；此时不再套默认 py-2.5 */
  className?: string
}): ReactNode {
  const inner = (
    <div
      className={`flex ${align === 'start' ? 'items-start' : 'items-center'} justify-between gap-6${className ? '' : ' py-2.5'}`}
    >
      <div className="min-w-0">
        {tag ? (
          <div className="flex items-center gap-2 text-[13px]">
            <span>{title}</span>
            {tag}
          </div>
        ) : (
          <label htmlFor={htmlForId} className="text-[13px]">
            {title}
          </label>
        )}
        {desc && (
          <div className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            {desc}
          </div>
        )}
        {note && (
          <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--warn)' }}>
            {note}
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-2">{control}</div>
    </div>
  )

  if (!className && !below) return inner
  return (
    <div className={className}>
      {inner}
      {below}
    </div>
  )
}

/** 配置还没载入时的占位 */
export function LoadingHint(): ReactNode {
  return (
    <div className="py-16 text-center text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
      配置载入中…
    </div>
  )
}

/** 危险操作确认弹窗 */
export function ConfirmModal({
  open,
  title,
  message,
  confirmText = '确认',
  danger = false,
  onConfirm,
  onClose
}: {
  open: boolean
  title: string
  message: ReactNode
  confirmText?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={440}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmText}
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        {danger && (
          <span className="shrink-0 mt-0.5" style={{ color: 'var(--danger)' }}>
            <AlertTriangle size={17} />
          </span>
        )}
        <div className="text-[13px] leading-relaxed selectable" style={{ color: 'var(--text-dim)' }}>
          {message}
        </div>
      </div>
    </Modal>
  )
}