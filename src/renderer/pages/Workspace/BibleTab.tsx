import { useState, type ReactNode } from 'react'
import { BookOpen, Sparkles } from 'lucide-react'
import { Button, EmptyState, Segmented } from '../../components/ui'
import { useApp } from '../../store/app'
import { BibleAiModal, type BibleAiKind } from './bible/BibleAiModal'
import { CharactersPanel } from './bible/CharactersPanel'
import { WorldPanel } from './bible/WorldPanel'
import { TermsPanel } from './bible/TermsPanel'
import { TimelinePanel } from './bible/TimelinePanel'
import { ThreadsPanel } from './bible/ThreadsPanel'

type Part = 'characters' | 'world' | 'terms' | 'timeline' | 'threads'

export function BibleTab(): ReactNode {
  const project = useApp((s) => s.project)
  const [part, setPart] = useState<Part>('characters')
  const [aiOpen, setAiOpen] = useState(false)

  if (!project) return null

  const b = project.bible
  const aiSupported = part === 'characters' || part === 'world'
  const kind: BibleAiKind = part === 'world' ? 'world' : 'characters'

  const options: { value: Part; label: string }[] = [
    { value: 'characters', label: `角色 ${b.characters.length}` },
    { value: 'world', label: `世界观 ${b.world.length}` },
    { value: 'terms', label: `术语 ${b.terms.length}` },
    { value: 'timeline', label: `时间线 ${b.timeline.length}` },
    { value: 'threads', label: `伏笔 ${b.threads.length}` }
  ]

  const empty =
    b.characters.length === 0 && b.world.length === 0 && b.terms.length === 0 && b.timeline.length === 0 && b.threads.length === 0

  return (
    <div className="h-full flex flex-col min-h-0" style={{ background: 'var(--bg)' }}>
      <div
        className="shrink-0 flex items-center gap-3 px-4 h-12"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--panel)' }}
      >
        <Segmented value={part} options={options} onChange={(v) => setPart(v)} />
        <div className="flex-1" />
        <span className="text-[11px] hidden lg:inline" style={{ color: 'var(--text-faint)' }}>
          {aiSupported ? '先让 AI 给一版草稿，再逐条改' : '该分区暂为手动编辑'}
        </span>
        <Button
          variant={aiSupported ? 'primary' : 'default'}
          onClick={() => setAiOpen(true)}
          disabled={!aiSupported}
          title={aiSupported ? '读取已有设定后补全一批条目' : '该分区暂只支持手动编辑'}
        >
          <Sparkles size={14} /> AI 帮我补全
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto scroll-thin">
        <div className="mx-auto px-4 py-4" style={{ maxWidth: 1000 }}>
          {empty && part === 'characters' ? (
            <div className="pt-10">
              <EmptyState
                icon={<BookOpen size={26} />}
                title="设定库还没有内容"
                desc="设定库是长篇一致性的地基：角色卡、世界规则、术语口径、时间线、伏笔台账。先补角色，再补世界规则，效果最好。"
                action={
                  <Button variant="primary" onClick={() => setAiOpen(true)}>
                    <Sparkles size={14} /> 让 AI 先给一版
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              {part === 'characters' && <CharactersPanel />}
              {part === 'world' && <WorldPanel />}
              {part === 'terms' && <TermsPanel />}
              {part === 'timeline' && <TimelinePanel />}
              {part === 'threads' && <ThreadsPanel />}
            </>
          )}
        </div>
      </div>

      <BibleAiModal open={aiOpen} kind={kind} project={project} onClose={() => setAiOpen(false)} />
    </div>
  )
}