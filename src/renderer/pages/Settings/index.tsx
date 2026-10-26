import { useEffect, useState, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { BookMarked, Database, Fingerprint, Gauge, Info, ListChecks, Palette, PenLine, Plug, Sparkles } from 'lucide-react'
import { AboutSection } from './AboutSection'
import { BudgetsSection } from './BudgetsSection'
import { AppearanceSection } from './AppearanceSection'
import { ChannelsSection } from './ChannelsSection'
import { DataSection } from './DataSection'
import { GenresSection } from './GenresSection'
import { SkillsSection } from './SkillsSection'
import { PreferencesSection } from './PreferencesSection'
import { StyleLibrarySection } from './StyleLibrary'
import { TasksSection } from './TasksSection'

type SectionId =
  | 'channels'
  | 'tasks'
  | 'style'
  | 'genres'
  | 'skills'
  | 'budgets'
  | 'appearance'
  | 'prefs'
  | 'data'
  | 'about'

const NAV: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: 'channels', label: '渠道与模型', icon: Plug },
  { id: 'tasks', label: '任务分配', icon: ListChecks },
  { id: 'style', label: '文风分身库', icon: Fingerprint },
  { id: 'genres', label: '题材公约', icon: BookMarked },
  { id: 'skills', label: '技法卡库', icon: Sparkles },
  { id: 'budgets', label: '输出预算', icon: Gauge },
  { id: 'appearance', label: '外观与排版', icon: Palette },
  { id: 'prefs', label: '写作偏好', icon: PenLine },
  { id: 'data', label: '数据与备份', icon: Database },
  { id: 'about', label: '关于', icon: Info }
]

export function Settings(): ReactNode {
  const [active, setActive] = useState<SectionId>('channels')

  // 二级导航是页面内 state，截图 / E2E 脚本无法点进「题材公约」这类子页。
  // 挂一个只读的跳转钩子，功能和用户点导航完全一致，只是给自动化用的。
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__MZ_SETTINGS = { go: (id: string) => setActive(id as SectionId) }
  }, [])

  return (
    <div className="h-full flex" style={{ background: 'var(--bg)' }}>
      {/* 左侧二级导航 */}
      <nav
        className="shrink-0 overflow-y-auto scroll-thin"
        style={{ width: 190, background: 'var(--sidebar)', borderRight: '1px solid var(--border)', padding: '14px 8px' }}
      >
        <div className="px-2 pb-2 text-[11px] font-medium" style={{ color: 'var(--text-faint)', letterSpacing: '0.06em' }}>
          设置
        </div>
        {NAV.map((item) => {
          const Icon = item.icon
          const on = active === item.id
          return (
            <button
              key={item.id}
              onClick={() => setActive(item.id)}
              className={`w-full flex items-center gap-2 h-9 px-2.5 rounded-lg text-[12.5px] mb-0.5 ${
                on ? '' : 'surface-hover'
              }`}
              style={{
                background: on ? 'var(--accent-soft)' : 'transparent',
                color: on ? 'var(--accent)' : 'var(--text-dim)',
                fontWeight: on ? 600 : 400,
                cursor: 'default'
              }}
            >
              <Icon size={15} />
              <span className="truncate">{item.label}</span>
            </button>
          )
        })}

        <div className="mt-4 px-2 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-faint)', opacity: 0.85 }}>
          所有改动即时保存
          <br />
          无需手动点确认
        </div>
      </nav>

      {/* 右侧内容 */}
      <div className="flex-1 min-w-0 overflow-y-auto scroll-thin">
        <div className="mx-auto w-full" style={{ maxWidth: 860, padding: '22px 26px 72px' }}>
          {active === 'channels' && <ChannelsSection />}
          {active === 'tasks' && <TasksSection />}
          {active === 'style' && <StyleLibrarySection />}
          {active === 'genres' && <GenresSection />}
          {active === 'skills' && <SkillsSection />}
          {active === 'budgets' && <BudgetsSection />}
          {active === 'appearance' && <AppearanceSection />}
          {active === 'prefs' && <PreferencesSection />}
          {active === 'data' && <DataSection />}
          {active === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  )
}