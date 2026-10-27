import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BookOpen, Copy, Ellipsis, Feather, Pencil, Plus, Search, Trash } from 'lucide-react'
import type { Project, ProjectMeta } from '@shared/types'
import { getGenre } from '@shared/genres'
import { getScene } from '@shared/scenes'
import { formatNumber, relativeTime } from '@shared/utils'
import { useApp } from '../../store/app'
import { Button, EmptyState, Input, Modal, Select, Spinner } from '../../components/ui'
import { ProjectInfoModal } from '../../components/ProjectInfoModal'
import { mz } from '../../lib/bridge'
import { NewBookWizard } from './NewBookWizard'
import { QuickStart } from './QuickStart'

type SortKey = 'updated' | 'words' | 'created'

/** 书架封面三档：小 / 中 / 大（默认中）。"
 *  "微"档在 50px 下书名已无法辨认，留着只会让书架看起来像故障，故移除。 */
const COVER_SIZES = [
  { key: 's', label: '小', min: 100 },
  { key: 'm', label: '中', min: 150 },
  { key: 'l', label: '大', min: 196 }
] as const
type CoverSize = (typeof COVER_SIZES)[number]['key']
const COVER_MIN: Record<CoverSize, number> = { s: 100, m: 150, l: 196 }

function coverSizeOf(v: unknown): CoverSize {
  if (v === 's' || v === 'm' || v === 'l') return v
  // 老配置里的 'sl'（已下线）落到新的最小档
  return v === 'sl' ? 's' : 'm'
}

/**
 * ProjectMeta 目前只带 updatedAt；若主进程后续补上 createdAt，这里自动按真实创建时间排序，
 * 否则退回 updatedAt，保证「创建时间」这一项不会因字段缺失而报错。
 */
function createdStamp(m: ProjectMeta): number {
  const maybe = (m as ProjectMeta & { createdAt?: number }).createdAt
  return typeof maybe === 'number' ? maybe : m.updatedAt
}

/* ───────────────────────── 书卡 ───────────────────────── */

function BookCard({
  meta,
  size,
  onOpen,
  onDuplicate,
  onDelete,
  onEditInfo
}: {
  meta: ProjectMeta
  size: CoverSize
  onOpen: (id: string) => void
  onDuplicate: (meta: ProjectMeta) => void
  onDelete: (meta: ProjectMeta) => Promise<void>
  onEditInfo: (id: string) => void
}): ReactNode {
  // 最小档（小）封面信息密度高，字号与留白相应收紧
  const dense = size === 's'
  const scene = getScene(meta.sceneId)
  const genre = getGenre(meta.genreId)

  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      const el = menuRef.current
      if (el && !el.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const showMenu = hover || menuOpen

  return (
    <div
      className="relative"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(meta.id)}
      onKeyDown={(e) => {
        /* 键盘事件来自卡片内的 ⋯ 按钮时，交给按钮自己处理 */
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(meta.id)
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* 封面 */}
      <div
        style={{
          aspectRatio: '3 / 4',
          borderRadius: 10,
          overflow: 'hidden',
          position: 'relative',
          background: `linear-gradient(150deg, ${meta.coverColor}, color-mix(in srgb, ${meta.coverColor} 55%, #000))`,
          transform: hover ? 'translateY(-2px)' : 'none',
          boxShadow: hover ? 'var(--shadow)' : 'none',
          transition: 'transform .16s ease, box-shadow .16s ease'
        }}
      >
        <div style={{ position: 'absolute', left: 10, top: 8, fontSize: dense ? 17 : 24, lineHeight: 1, opacity: 0.95 }}>
          {scene.icon}
        </div>

        {genre && (
          <div
            className="truncate"
            style={{
              position: 'absolute',
              right: dense ? 6 : 8,
              top: dense ? 6 : 8,
              maxWidth: dense ? 62 : 84,
              height: dense ? 16 : 19,
              padding: dense ? '0 5px' : '0 7px',
              borderRadius: 999,
              display: 'flex',
              alignItems: 'center',
              fontSize: dense ? 9 : 10.5,
              color: '#fff',
              background: 'rgba(255,255,255,.22)',
              border: '1px solid rgba(255,255,255,.3)',
              backdropFilter: 'blur(3px)',
              transform: showMenu ? 'translateX(-26px)' : 'none',
              transition: 'transform .16s ease'
            }}
          >
            {genre.name}
          </div>
        )}

        <div
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: 12,
            color: '#fff'
          }}
        >
          <div
            className="line-clamp-3"
            style={{
              fontSize: dense ? 12 : 17,
              fontWeight: 600,
              lineHeight: 1.35,
              textShadow: '0 1px 8px rgba(0,0,0,.28)'
            }}
          >
            {meta.title}
          </div>
          <div
            className="truncate"
            style={{
              marginTop: dense ? 3 : 5,
              fontSize: dense ? 9.5 : 11.5,
              lineHeight: 1.2,
              opacity: 0.82,
              textShadow: '0 1px 6px rgba(0,0,0,.25)'
            }}
          >
            {meta.author || '未署名'}
          </div>
        </div>
      </div>

      {/* 卡片信息 */}
      <div className={dense ? 'mt-1.5' : 'mt-2'}>
          <div className="text-[13px] line-clamp-1" style={{ fontWeight: 500 }}>
            {meta.title}
          </div>
          {!dense && (
            <div
              className="text-[11.5px] mt-0.5 flex items-center gap-1 min-w-0"
              style={{ color: 'var(--text-faint)' }}
            >
              <span className="truncate">{meta.author || '未署名'}</span>
              <span style={{ flex: '0 0 auto' }}>
                · {meta.chapters} 章 · {formatNumber(meta.words)} 字
              </span>
            </div>
          )}
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
            {dense ? `${formatNumber(meta.words)} 字` : relativeTime(meta.updatedAt)}
          </div>
      </div>

      {/* ⋯ 菜单按钮 */}
      <button
        type="button"
        aria-label="更多操作"
        onClick={(e) => {
          e.stopPropagation()
          setMenuOpen((v) => !v)
        }}
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          width: 24,
          height: 24,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(10,14,20,.34)',
          color: '#fff',
          border: 'none',
          opacity: showMenu ? 1 : 0,
          transition: 'opacity .14s ease',
          zIndex: 3,
          cursor: 'default'
        }}
      >
        <Ellipsis size={14} />
      </button>

      {/* 下拉菜单 */}
      {menuOpen && (
        <div
          ref={menuRef}
          className="fade-in card"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 34,
            right: 6,
            width: 128,
            padding: 4,
            zIndex: 20,
            boxShadow: 'var(--shadow)',
            background: 'var(--panel)'
          }}
        >
          <button
            type="button"
            className="w-full flex items-center gap-2 px-2 h-8 rounded-md text-[12.5px] surface-hover"
            onClick={() => {
              setMenuOpen(false)
              onOpen(meta.id)
            }}
          >
            <BookOpen size={13} style={{ color: 'var(--text-faint)' }} />
            打开
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-2 px-2 h-8 rounded-md text-[12.5px] surface-hover"
            onClick={() => {
              setMenuOpen(false)
              onEditInfo(meta.id)
            }}
          >
            <Pencil size={13} style={{ color: 'var(--text-faint)' }} />
            编辑信息
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-2 px-2 h-8 rounded-md text-[12.5px] surface-hover"
            onClick={() => {
              setMenuOpen(false)
              onDuplicate(meta)
            }}
          >
            <Copy size={13} style={{ color: 'var(--text-faint)' }} />
            复制作品
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-2 px-2 h-8 rounded-md text-[12.5px] surface-hover"
            style={{ color: 'var(--danger)' }}
            onClick={() => {
              setMenuOpen(false)
              setConfirm(true)
            }}
          >
            <Trash size={13} />
            删除
          </button>
        </div>
      )}

      {/* 删除确认 */}
      <Modal
        open={confirm}
        onClose={() => {
          if (!busy) setConfirm(false)
        }}
        title="删除作品"
        width={420}
        footer={
          <>
            <Button onClick={() => setConfirm(false)} disabled={busy} type="button">
              取消
            </Button>
            <Button
              variant="danger"
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void onDelete(meta).finally(() => {
                  setBusy(false)
                  setConfirm(false)
                })
              }}
            >
              {busy && <Spinner size={12} />}
              删除
            </Button>
          </>
        }
      >
        <div className="text-[13px] leading-relaxed" onClick={(e) => e.stopPropagation()}>
          确定要删除《{meta.title}》吗？
          <div className="mt-2 text-[12px]" style={{ color: 'var(--text-faint)' }}>
            该作品的章节、设定与灵感会一并移除，此操作不可恢复。
          </div>
        </div>
      </Modal>
    </div>
  )
}

/* ───────────────────────── 书架页 ───────────────────────── */

export function Bookshelf(): ReactNode {
  const projects = useApp((s) => s.projects)
  const refreshProjects = useApp((s) => s.refreshProjects)
  const openProject = useApp((s) => s.openProject)
  const deleteProject = useApp((s) => s.deleteProject)
  const duplicateProject = useApp((s) => s.duplicateProject)
  const toast = useApp((s) => s.toast)

  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('updated')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [qsOpen, setQsOpen] = useState(false)
  const patchSettings = useApp((s) => s.patchSettings)
  const coverSize = coverSizeOf(useApp((s) => s.config?.settings.shelfCoverSize))
  const [infoProject, setInfoProject] = useState<Project | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        await refreshProjects()
      } catch (e) {
        toast(`读取作品列表失败：${(e as Error).message}`, 'error')
      }
    })()
  }, [refreshProjects, toast])

  const totalWordsAll = useMemo(() => projects.reduce((s, p) => s + (p.words || 0), 0), [projects])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? projects.filter(
          (p) => p.title.toLowerCase().includes(q) || (p.author || '').toLowerCase().includes(q)
        )
      : [...projects]
    if (sort === 'words') filtered.sort((a, b) => b.words - a.words)
    else if (sort === 'created') filtered.sort((a, b) => createdStamp(b) - createdStamp(a))
    else filtered.sort((a, b) => b.updatedAt - a.updatedAt)
    return filtered
  }, [projects, query, sort])

  const handleOpen = (id: string): void => {
    void (async () => {
      try {
        await openProject(id)
      } catch (e) {
        toast(`打开作品失败：${(e as Error).message}`, 'error')
      }
    })()
  }

  const handleDuplicate = (meta: ProjectMeta): void => {
    void (async () => {
      try {
        await duplicateProject(meta.id)
      } catch (e) {
        toast(`复制失败：${(e as Error).message}`, 'error')
      }
    })()
  }

  const handleEditInfo = (id: string): void => {
    void (async () => {
      try {
        const full = await mz.project.get(id)
        if (!full) {
          toast('作品不存在或已被删除', 'error')
          return
        }
        setInfoProject(full)
      } catch (e) {
        toast(`读取作品信息失败：${(e as Error).message}`, 'error')
      }
    })()
  }

  const saveInfo = async (next: Project): Promise<void> => {
    await mz.project.save(next)
    await refreshProjects()
    toast('作品信息已更新', 'ok')
  }

  const handleDelete = async (meta: ProjectMeta): Promise<void> => {
    try {
      await deleteProject(meta.id)
      toast(`已删除《${meta.title}》`, 'ok')
    } catch (e) {
      toast(`删除失败：${(e as Error).message}`, 'error')
    }
  }

  const isEmpty = projects.length === 0

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* 工具条 */}
      <div
        className="flex items-center justify-between shrink-0 gap-4"
        style={{ height: 56, padding: '0 24px', borderBottom: '1px solid var(--border)' }}
      >
        <div className="flex items-baseline gap-2.5 min-w-0">
          <div className="text-[17px] font-semibold shrink-0">书架</div>
          <div className="text-[11.5px] truncate" style={{ color: 'var(--text-faint)' }}>
            共 {projects.length} 部作品 · 合计 {formatNumber(totalWordsAll)} 字
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="relative" style={{ width: 220 }}>
            <Search
              size={13}
              style={{ position: 'absolute', left: 9, top: 10, color: 'var(--text-faint)', pointerEvents: 'none' }}
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索书名或作者"
              style={{ paddingLeft: 26 }}
            />
          </div>

          <div
            className="flex items-center gap-0.5 p-0.5 rounded-md shrink-0"
            style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}
            title="封面大小"
          >
            {COVER_SIZES.map((c) => (
              <button
                key={c.key}
                type="button"
                title={`${c.label}（${c.min}px）`}
                onClick={() => void patchSettings({ shelfCoverSize: c.key })}
                className="rounded transition-colors"
                style={{
                  width: 26,
                  height: 24,
                  fontSize: 11.5,
                  background: coverSize === c.key ? 'var(--accent-soft)' : 'transparent',
                  color: coverSize === c.key ? 'var(--accent)' : 'var(--text-faint)'
                }}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div style={{ width: 124 }}>
            <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="updated">最近编辑</option>
              <option value="words">字数最多</option>
              <option value="created">创建时间</option>
            </Select>
          </div>

          <Button onClick={() => setQsOpen(true)} type="button">
            ✨ AI 一键开书
          </Button>

          <Button variant="primary" onClick={() => setWizardOpen(true)} type="button">
            <Plus size={14} />
            新建作品
          </Button>
        </div>
      </div>

      {/* 作品网格 */}
      <div className="flex-1 min-h-0 overflow-auto scroll-thin">
        {isEmpty ? (
          <div className="h-full flex items-center justify-center">
            <EmptyState
              icon={<Feather size={34} />}
              title="还没有作品"
              desc="从一个场景开始，让墨舟陪你写完第一本。"
              action={
                <Button variant="primary" size="lg" onClick={() => setWizardOpen(true)} type="button">
                  <Plus size={15} />
                  创建第一部作品
                </Button>
              }
            />
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Search size={30} />}
            title="没有匹配的作品"
            desc={query ? `没有找到包含「${query}」的书名或作者。` : '换个排序方式试试。'}
            action={
              <Button onClick={() => setQuery('')} type="button">
                清空搜索
              </Button>
            }
          />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(${COVER_MIN[coverSize]}px, 1fr))`,
              gap: coverSize === 's' ? 14 : coverSize === 'm' ? 18 : 20,
              padding: 24
            }}
          >
            {list.map((m) => (
              <BookCard
                key={m.id}
                meta={m}
                onOpen={handleOpen}
                size={coverSize}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                onEditInfo={handleEditInfo}
              />
            ))}
          </div>
        )}
      </div>

      <ProjectInfoModal
        open={Boolean(infoProject)}
        project={infoProject}
        onSave={saveInfo}
        onClose={() => setInfoProject(null)}
      />

      <NewBookWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      <QuickStart open={qsOpen} onClose={() => setQsOpen(false)} />
    </div>
  )
}