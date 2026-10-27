import type { ReactNode } from 'react'
import { Check, Shuffle } from 'lucide-react'
import type { OutlineNode, ScenePreset } from '@shared/types'
import { GENRES, getGenre } from '@shared/genres'
import { SCENES, getScene } from '@shared/scenes'
import { COVER_COLORS } from '@shared/factory'
import { clamp, formatNumber, lengthTier, uid } from '@shared/utils'
import { Button, Field, Input, Segmented, Slider, Textarea } from '../../components/ui'

/* ───────────────────────── 常量 ───────────────────────── */

export const STEPS = ['选择场景', '题材与主题', '篇幅规划', '作品信息'] as const

export const SCENE_GROUPS: { key: ScenePreset['group']; label: string }[] = [
  { key: 'fiction', label: '虚构文学' },
  { key: 'script', label: '剧本' },
  { key: 'media', label: '新媒体' },
  { key: 'business', label: '商业职场' },
  { key: 'academic', label: '学术' },
  { key: 'other', label: '其它' }
]

const GENRE_GROUPS = ['东方', '现代', '幻想', '现实'] as const

const TOTAL_QUICK = [
  { value: 0, label: '不限' },
  { value: 100_000, label: '10 万' },
  { value: 300_000, label: '30 万' },
  { value: 1_000_000, label: '100 万' }
]

export const DEFAULT_SCENE = 'long-novel'
export const DEFAULT_COLOR = COVER_COLORS[0]!

/* ───────────────────────── 草稿模型 ───────────────────────── */

export interface WizardDraft {
  sceneId: string
  genreId: string
  coverColor: string
  perChapter: number
  totalWords: number
  chapterCount: '1' | '3' | '5'
  title: string
  author: string
  logline: string
  premise: string
}

export type DraftPatch = (patch: Partial<WizardDraft>) => void

/* ───────────────────────── 创建逻辑 ───────────────────────── */

/**
 * 用场景的大纲模板生成卷节点：每个模板条目一个卷，第一卷挂上这批章节对应的 chapter 节点。
 * 抽成纯函数，便于单测与复用。
 */
export function buildOutline(chapters: { title: string }[], template: string[]): OutlineNode[] {
  return template.map<OutlineNode>((label, i) => ({
    id: uid('o'),
    title: label,
    summary: '',
    type: 'volume',
    status: 'planned',
    children:
      i === 0
        ? chapters.map<OutlineNode>((c) => ({
            id: uid('o'),
            title: c.title,
            summary: '',
            type: 'chapter',
            status: 'planned',
            children: []
          }))
        : []
  }))
}

/* ───────────────────────── 小组件 ───────────────────────── */

export function StepBar({ step }: { step: number }): ReactNode {
  return (
    <div className="flex items-center gap-1.5 mb-4">
      {STEPS.map((label, i) => {
        const done = i < step
        const active = i === step
        return (
          <div key={label} className="flex items-center gap-1.5">
            <div className="flex items-center gap-1.5">
              <span
                className="flex items-center justify-center rounded-full text-[11px]"
                style={{
                  width: 20,
                  height: 20,
                  fontWeight: 600,
                  background: active ? 'var(--accent)' : done ? 'var(--accent-soft)' : 'var(--panel-2)',
                  color: active ? 'var(--accent-text)' : done ? 'var(--accent)' : 'var(--text-faint)',
                  border: `1px solid ${active ? 'var(--accent)' : done ? 'transparent' : 'var(--border)'}`
                }}
              >
                {done ? <Check size={11} strokeWidth={3} /> : i + 1}
              </span>
              <span
                className="text-[12px]"
                style={{
                  color: active ? 'var(--text)' : done ? 'var(--text-dim)' : 'var(--text-faint)',
                  fontWeight: active ? 600 : 400
                }}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && <div style={{ width: 24, height: 1, background: 'var(--border)' }} />}
          </div>
        )
      })}
    </div>
  )
}

function GroupLabel({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return (
    <div
      className={`text-[11.5px] mb-1.5 ${className ?? ''}`}
      style={{ color: 'var(--text-dim)', fontWeight: 500 }}
    >
      {children}
    </div>
  )
}

function Chip({
  active,
  children,
  onClick,
  dot,
  recommended
}: {
  active: boolean
  children: ReactNode
  onClick: () => void
  dot?: string
  recommended?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="chip"
      style={{
        height: 25,
        background: active ? 'var(--accent-soft)' : 'var(--panel)',
        color: active ? 'var(--accent)' : 'var(--text-dim)',
        borderColor: active ? 'color-mix(in srgb, var(--accent) 45%, transparent)' : 'var(--border)',
        fontWeight: active ? 500 : 400
      }}
    >
      {dot && <span style={{ width: 7, height: 7, borderRadius: 999, background: dot, flex: '0 0 auto' }} />}
      {children}
      {recommended && (
        <span
          style={{
            fontSize: 9.5,
            color: active ? 'var(--accent)' : 'var(--warn)',
            background: active ? 'transparent' : 'color-mix(in srgb, var(--warn) 14%, transparent)',
            padding: '0 4px',
            borderRadius: 4,
            lineHeight: '14px',
            height: 14
          }}
        >
          推荐
        </span>
      )}
    </button>
  )
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span style={{ color: 'var(--text-faint)', flex: '0 0 auto' }}>{label}</span>
      <span className="truncate" style={{ color: 'var(--text)' }}>
        {children}
      </span>
    </div>
  )
}

export function CoverPreview({
  color,
  icon,
  genreName,
  title,
  author
}: {
  color: string
  icon: string
  genreName: string
  title: string
  author?: string
}): ReactNode {
  return (
    <div>
      <div
        style={{
          aspectRatio: '3 / 4',
          borderRadius: 10,
          overflow: 'hidden',
          position: 'relative',
          background: `linear-gradient(150deg, ${color}, color-mix(in srgb, ${color} 55%, #000))`
        }}
      >
        <div style={{ position: 'absolute', left: 12, top: 10, fontSize: 24, lineHeight: 1, opacity: 0.95 }}>
          {icon}
        </div>
        {/* 与书架封面同一套：题材是右上角徽标，书名下方一行作者 */}
        {genreName && (
          <div
            className="truncate"
            style={{
              position: 'absolute',
              right: 8,
              top: 8,
              maxWidth: 84,
              height: 19,
              padding: '0 7px',
              borderRadius: 999,
              display: 'flex',
              alignItems: 'center',
              fontSize: 10.5,
              color: '#fff',
              background: 'rgba(255,255,255,.22)',
              border: '1px solid rgba(255,255,255,.3)'
            }}
          >
            {genreName}
          </div>
        )}
        <div style={{ position: 'absolute', left: 13, right: 13, bottom: 12, color: '#fff' }}>
          <div
            className="line-clamp-3"
            style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4, textShadow: '0 1px 8px rgba(0,0,0,.22)' }}
          >
            {title || '未命名作品'}
          </div>
          <div className="truncate" style={{ marginTop: 4, fontSize: 11, lineHeight: 1.2, opacity: 0.82 }}>
            {author?.trim() || '未署名'}
          </div>
        </div>
      </div>
      <div className="mt-2 text-[11px] flex items-center gap-1.5" style={{ color: 'var(--text-faint)' }}>
        <span style={{ width: 9, height: 9, borderRadius: 2, background: color, flex: '0 0 auto' }} />
        封面预览
      </div>
    </div>
  )
}

/* ───────────────────────── 步 1：选择场景 ───────────────────────── */

export function SceneStep({
  sceneId,
  onPick
}: {
  sceneId: string
  onPick: (id: string) => void
}): ReactNode {
  return (
    <div>
      {SCENE_GROUPS.map((g) => {
        const list = SCENES.filter((s) => s.group === g.key)
        if (list.length === 0) return null
        return (
          <div key={g.key} className="mt-3.5 first:mt-0">
            <GroupLabel>{g.label}</GroupLabel>
            <div className="grid grid-cols-2 gap-2">
              {list.map((s) => {
                const active = s.id === sceneId
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onPick(s.id)}
                    className="text-left rounded-lg px-3 py-2.5 transition-colors"
                    style={{
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      background: active ? 'var(--accent-soft)' : 'var(--panel)'
                    }}
                  >
                    <div className="flex items-start gap-2">
                      <span style={{ fontSize: 16, lineHeight: '18px', flex: '0 0 auto' }}>{s.icon}</span>
                      <div className="min-w-0">
                        <div
                          className="truncate text-[12.5px]"
                          style={{ fontWeight: 500, color: active ? 'var(--accent)' : 'var(--text)' }}
                        >
                          {s.name}
                        </div>
                        <div className="mt-0.5 text-[11.5px] truncate" style={{ color: 'var(--text-faint)' }}>
                          {s.tagline}
                        </div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ───────────────────────── 步 2：题材与主题 ───────────────────────── */

export function GenreStep({ draft, patch }: { draft: WizardDraft; patch: DraftPatch }): ReactNode {
  const scene = getScene(draft.sceneId)
  const genre = getGenre(draft.genreId)

  return (
    <div className="grid gap-5" style={{ gridTemplateColumns: '1fr 156px' }}>
      <div>
        {GENRE_GROUPS.map((grp) => {
          const list = GENRES.filter((g) => g.group === grp)
          if (list.length === 0) return null
          /* 本场景推荐的题材排到前面 */
          const sorted = [...list].sort(
            (a, b) => Number(scene.genreIds.includes(b.id)) - Number(scene.genreIds.includes(a.id))
          )
          return (
            <div key={grp} className="mt-3.5 first:mt-0">
              <GroupLabel>{grp}</GroupLabel>
              <div className="flex flex-wrap gap-1.5">
                {sorted.map((g) => (
                  <Chip
                    key={g.id}
                    active={g.id === draft.genreId}
                    dot={g.color}
                    recommended={scene.genreIds.includes(g.id)}
                    onClick={() => patch({ genreId: draft.genreId === g.id ? '' : g.id })}
                  >
                    {g.name}
                  </Chip>
                ))}
              </div>
            </div>
          )
        })}

        <GroupLabel className="mt-4">封面色</GroupLabel>
        <div className="flex flex-wrap gap-2">
          {COVER_COLORS.map((c) => {
            const active = c === draft.coverColor
            return (
              <button
                key={c}
                type="button"
                aria-label={`配色 ${c}`}
                onClick={() => patch({ coverColor: c })}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 9,
                  background: `linear-gradient(150deg, ${c}, color-mix(in srgb, ${c} 55%, #000))`,
                  border: active ? '2px solid var(--panel)' : '1px solid var(--border)',
                  boxShadow: active ? `0 0 0 2px ${c}` : 'none'
                }}
              />
            )
          })}
        </div>
      </div>

      <div className="pt-1">
        <CoverPreview
          color={draft.coverColor}
          icon={scene.icon}
          genreName={genre?.name ?? ''}
          title={draft.title.trim()}
          author={draft.author}
        />
      </div>
    </div>
  )
}

/* ───────────────────────── 步 3：篇幅规划 ───────────────────────── */

export function PlanStep({ draft, patch }: { draft: WizardDraft; patch: DraftPatch }): ReactNode {
  const scene = getScene(draft.sceneId)
  const safePer = Math.max(1, draft.perChapter)
  const plannedTotal = draft.totalWords > 0 ? draft.totalWords : safePer * Number(draft.chapterCount)
  const estimatedChapters = draft.totalWords > 0 ? Math.ceil(draft.totalWords / safePer) : 0
  const tier = lengthTier(plannedTotal)

  return (
    <div className="space-y-4">
      <Field
        label="每章目标字数"
        hint={`${scene.name}建议 ${scene.minChapterWords}–${scene.maxChapterWords} 字，默认 ${scene.defaultChapterWords} 字`}
      >
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <Slider
              value={clamp(draft.perChapter, scene.minChapterWords, scene.maxChapterWords)}
              min={scene.minChapterWords}
              max={scene.maxChapterWords}
              step={100}
              onChange={(v) => patch({ perChapter: v })}
            />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Input
              type="number"
              value={draft.perChapter}
              onChange={(e) => patch({ perChapter: Math.max(0, Number(e.target.value) || 0) })}
              onBlur={() =>
                patch({ perChapter: clamp(draft.perChapter, scene.minChapterWords, scene.maxChapterWords) })
              }
              style={{ width: 84, textAlign: 'right' }}
            />
            <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              字
            </span>
          </div>
        </div>
      </Field>

      <Field label="全书目标字数" hint="留 0 表示不限，之后可在作品设置里调整">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <Input
              type="number"
              value={draft.totalWords}
              onChange={(e) => patch({ totalWords: Math.max(0, Number(e.target.value) || 0) })}
              placeholder="0"
              style={{ width: 110, textAlign: 'right' }}
            />
            <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              字
            </span>
          </div>
          <div className="flex items-center gap-1.5 ml-1">
            {TOTAL_QUICK.map((q) => (
              <Chip
                key={q.value}
                active={draft.totalWords === q.value}
                onClick={() => patch({ totalWords: q.value })}
              >
                {q.label}
              </Chip>
            ))}
          </div>
        </div>
      </Field>

      <Field label="初始章节数" hint="先铺好开头几章的骨架，之后可在大纲里随时增删">
        <Segmented<'1' | '3' | '5'>
          value={draft.chapterCount}
          options={[
            { value: '1', label: '1 章' },
            { value: '3', label: '3 章' },
            { value: '5', label: '5 章' }
          ]}
          onChange={(v) => patch({ chapterCount: v })}
        />
      </Field>

      <div
        className="rounded-lg px-3 py-2.5 flex items-center justify-between gap-3"
        style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}
      >
        <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
          {estimatedChapters > 0 ? (
            <>
              按此规划全书约{' '}
              <span style={{ color: 'var(--text)', fontWeight: 600 }}>{formatNumber(estimatedChapters)}</span> 章 · 每章{' '}
              {formatNumber(safePer)} 字
            </>
          ) : (
            <>
              不设全书上限 · 每章 {formatNumber(safePer)} 字 · 先建 {draft.chapterCount} 章
            </>
          )}
        </div>
        <span className="chip chip-accent shrink-0">{tier.label}</span>
      </div>
    </div>
  )
}

/* ───────────────────────── 步 4：作品信息 ───────────────────────── */

export function InfoStep({ draft, patch }: { draft: WizardDraft; patch: DraftPatch }): ReactNode {
  const scene = getScene(draft.sceneId)
  const genre = getGenre(draft.genreId)
  const safePer = Math.max(1, draft.perChapter)
  const estimatedChapters = draft.totalWords > 0 ? Math.ceil(draft.totalWords / safePer) : 0

  const shuffleLogline = (): void => {
    const next = scene.examples
      .filter((x) => x !== draft.logline)
      .sort(() => Math.random() - 0.5)
      .find((x) => x.length > 0)
    if (next) patch({ logline: next })
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3" style={{ gridTemplateColumns: '1.7fr 1fr' }}>
        <Field label="书名">
          <Input
            autoFocus
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder={scene.examples[0]}
            maxLength={60}
          />
        </Field>
        <Field label="作者">
          <Input
            value={draft.author}
            onChange={(e) => patch({ author: e.target.value })}
            placeholder="署名，可留空"
            maxLength={40}
          />
        </Field>
      </div>

      <div>
        <div className="flex items-end justify-between">
          <span className="label" style={{ marginBottom: 5 }}>
            一句话灵感
          </span>
          <Button size="sm" variant="ghost" className="h-[22px] mb-1" onClick={shuffleLogline} type="button">
            <Shuffle size={11} />
            换一个
          </Button>
        </div>
        <Textarea
          rows={3}
          value={draft.logline}
          onChange={(e) => patch({ logline: e.target.value })}
          placeholder={`例如：${scene.examples[0]}`}
        />
      </div>

      <Field label="故事梗概" hint="写下主线与结局方向，AI 生成时会以它为锚点">
        <Textarea
          rows={4}
          value={draft.premise}
          onChange={(e) => patch({ premise: e.target.value })}
          placeholder="主角是谁、想要什么、被什么阻挡、最终会付出什么代价。"
        />
      </Field>

      <div className="card p-3">
        <div className="text-[11.5px] mb-2" style={{ color: 'var(--text-dim)', fontWeight: 500 }}>
          即将创建
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
          <SummaryRow label="场景">
            {scene.icon} {scene.name}
          </SummaryRow>
          <SummaryRow label="题材">{genre ? genre.name : '未选择'}</SummaryRow>
          <SummaryRow label="每章">{formatNumber(safePer)} 字</SummaryRow>
          <SummaryRow label="全书">
            {draft.totalWords > 0 ? `${formatNumber(draft.totalWords)} 字 · 约 ${estimatedChapters} 章` : '不限'}
          </SummaryRow>
          <SummaryRow label="结构">{scene.structureLabels.join(' / ')}</SummaryRow>
          <div className="flex items-center gap-2 min-w-0">
            <span style={{ color: 'var(--text-faint)' }}>配色</span>
            <span style={{ width: 11, height: 11, borderRadius: 3, background: draft.coverColor, flex: '0 0 auto' }} />
            <span style={{ color: 'var(--text)' }}>{draft.coverColor.toUpperCase()}</span>
          </div>
        </div>
      </div>
    </div>
  )
}