import { useEffect, useState, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ArrowRight, BookMarked, BookOpen, Database, Fingerprint, Gauge, Globe, Info, ListChecks, Palette, PenLine, Plug, Sparkles } from 'lucide-react'
import { AboutSection } from './AboutSection'
import { BudgetsSection } from './BudgetsSection'
import { AppearanceSection } from './AppearanceSection'
import { ChannelsSection } from './ChannelsSection'
import { DataSection } from './DataSection'
import { GenresSection } from './GenresSection'
import { SearchSection } from './SearchSection'
import { SkillsSection } from './SkillsSection'
import { PreferencesSection } from './PreferencesSection'
import { StyleLibrarySection } from './StyleLibrary'
import { TasksSection } from './TasksSection'
import { Button } from '../../components/ui'
import { useApp } from '../../store/app'

type SectionId =
  | 'channels'
  | 'search'
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
  { id: 'search', label: '联网搜索', icon: Globe },
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

/**
 * 首屏引导条：一本书都没有的时候显示。
 *
 * 为什么需要：第一次打开会直接落到设置页（见 store.init），可设置页里没有任何
 * 「去书架」的出口——标题栏那个 logo 谁也不知道能点。用户配完 Key 就停在这里，
 * 以为软件只有设置界面。这条引导把「下一步」写成按钮，配没配好 Key 都给不同的说法。
 */
function FirstRunGuide(): ReactNode {
  const projectCount = useApp((s) => s.projects.length)
  const channelCount = useApp((s) => s.config?.channels.length ?? 0)
  const setView = useApp((s) => s.setView)
  if (projectCount > 0) return null

  const ready = channelCount > 0
  return (
    <div
      className="card mb-4 flex items-center gap-3"
      style={{ padding: '12px 14px', borderColor: 'color-mix(in srgb, var(--accent) 26%, var(--border))' }}
    >
      <span
        className="shrink-0 flex items-center justify-center"
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          background: 'var(--accent-soft)',
          color: 'var(--accent)'
        }}
      >
        <BookOpen size={17} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium">{ready ? '模型已配好，去书架开第一本书' : '先在这里配好模型，再去书架开始写作'}</div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          {ready
            ? '书架是作品列表：新建作品、打开旧稿、导入导出都在那里。'
            : '左侧「渠道与模型」→ 右上「新增渠道」→ 填一个 API Key（推荐 DeepSeek），保存后就能生成正文。'}
        </div>
      </div>
      <Button variant={ready ? 'primary' : 'default'} onClick={() => setView('bookshelf')} type="button">
        去书架 <ArrowRight size={14} />
      </Button>
    </div>
  )
}

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
          <FirstRunGuide />
          {active === 'channels' && <ChannelsSection />}
          {active === 'search' && <SearchSection />}
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