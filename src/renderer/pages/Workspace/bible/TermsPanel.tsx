import type { ReactNode } from 'react'
import { Plus, Tags, Trash } from 'lucide-react'
import type { Term } from '@shared/types'
import { uid } from '@shared/utils'
import { Button, EmptyState, Input } from '../../../components/ui'
import { useApp } from '../../../store/app'
import { ConfirmButton } from '../ConfirmButton'

export function TermsPanel(): ReactNode {
  const project = useApp((s) => s.project)
  const patchProject = useApp((s) => s.patchProject)
  if (!project) return null

  const terms = project.bible.terms
  const write = (next: Term[]): void => {
    patchProject((p) => ({ ...p, bible: { ...p.bible, terms: next } }))
  }
  const patchTerm = (id: string, patch: Partial<Term>): void => {
    write(terms.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          专有名词统一口径：同一个东西在不同章节叫法不一致，是最明显的“AI 味”来源之一。
        </div>
        <Button size="sm" onClick={() => write([...terms, { id: uid('t'), term: '', definition: '' }])}>
          <Plus size={13} /> 新增
        </Button>
      </div>

      {terms.length === 0 ? (
        <EmptyState
          icon={<Tags size={26} />}
          title="还没有术语表"
          desc="把境界名、组织名、功法名、地名这些固定叫法记下来，写作时会作为硬约束注入，避免同义词乱飞。"
          action={
            <Button size="sm" onClick={() => write([...terms, { id: uid('t'), term: '', definition: '' }])}>
              <Plus size={13} /> 新增
            </Button>
          }
        />
      ) : (
        <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          <div
            className="grid items-center gap-2 px-3 h-8 text-[11px]"
            style={{ gridTemplateColumns: '220px 1fr 32px', background: 'var(--panel-2)', color: 'var(--text-faint)' }}
          >
            <span>术语</span>
            <span>释义 / 使用约定</span>
            <span />
          </div>
          {terms.map((t) => (
            <div
              key={t.id}
              className="grid items-center gap-2 px-3 py-1.5"
              style={{ gridTemplateColumns: '220px 1fr 32px', borderTop: '1px solid var(--border)', background: 'var(--panel)' }}
            >
              <Input
                value={t.term}
                onChange={(e) => patchTerm(t.id, { term: e.target.value })}
                placeholder="例如：灵台境"
                className="h-[28px] py-0 text-[12.5px]"
              />
              <Input
                value={t.definition}
                onChange={(e) => patchTerm(t.id, { definition: e.target.value })}
                placeholder="一句话说明它是什么、怎么用"
                className="h-[28px] py-0 text-[12.5px]"
              />
              <ConfirmButton
                label={<Trash size={13} />}
                title="删除这条术语"
                onConfirm={() => write(terms.filter((x) => x.id !== t.id))}
                className="!h-6 !w-6 !px-0"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}