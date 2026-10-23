import type { ReactNode } from 'react'
import { Feather } from 'lucide-react'
import { useApp } from '../../store/app'
import { PageHead, MONO } from './common'

const PLATFORM_LABEL: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux'
}

export function AboutSection(): ReactNode {
  const appInfo = useApp((s) => s.appInfo)
  const platform = appInfo?.platform ?? ''
  const mod = platform === 'darwin' ? '⌘' : 'Ctrl'

  const shortcuts: { keys: string[]; label: string }[] = [
    { keys: [mod, 'S'], label: '保存当前作品' },
    { keys: [mod, ','], label: '打开设置' },
    { keys: [mod, 'K'], label: '命令面板' },
    { keys: [mod, 'B'], label: '收起 / 展开侧栏' }
  ]

  const info: { label: string; value: string }[] = [
    { label: '版本', value: appInfo?.version ? `v${appInfo.version}` : '—' },
    { label: '平台', value: PLATFORM_LABEL[platform] ?? (platform || '—') },
    { label: '技术底座', value: 'Electron · React · TypeScript' },
    { label: '数据存储', value: '本地 JSON 文件，无云端账户' }
  ]

  return (
    <div>
      <PageHead title="关于" desc="一款不催更、不联网存档、不替你决定句子的写作工具。" />

      <div className="card p-5 mb-4">
        <div className="flex items-center gap-3.5">
          <div
            className="flex items-center justify-center rounded-xl shrink-0"
            style={{ width: 52, height: 52, background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            <Feather size={26} />
          </div>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tracking-tight">墨舟 Mozhou</div>
            <div className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
              本地优先的全场景 AI 写作工坊——你的稿子在你的硬盘上，模型用你自己的 Key。
            </div>
          </div>
        </div>

        <div className="grid gap-x-8 gap-y-1.5 mt-4 pt-4" style={{ gridTemplateColumns: '1fr 1fr', borderTop: '1px solid var(--border)' }}>
          {info.map((it) => (
            <div key={it.label} className="flex items-center justify-between gap-3 text-[12px]">
              <span style={{ color: 'var(--text-faint)' }}>{it.label}</span>
              <span className="truncate selectable" style={{ color: 'var(--text-dim)' }}>
                {it.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-4 mb-4">
        <div className="text-[13px] font-medium mb-2.5">快捷键</div>
        <div className="flex flex-col gap-1.5">
          {shortcuts.map((s) => (
            <div key={s.label} className="flex items-center justify-between gap-4 text-[12.5px]">
              <span style={{ color: 'var(--text-dim)' }}>{s.label}</span>
              <span className="flex items-center gap-1">
                {s.keys.map((k, i) => (
                  <span key={`${s.label}-${i}`} className="kbd" style={{ fontFamily: MONO }}>
                    {k}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="text-[11.5px] leading-relaxed px-1" style={{ color: 'var(--text-faint)' }}>
        墨舟不代收模型费用，所有用量按你所用服务商的规则计费。写作数据、设定库与版本快照全部留在本机。
        <br />
        愿你把稿子写完。
      </div>
    </div>
  )
}