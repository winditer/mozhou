import { useMemo, useState, type ReactNode } from 'react'
import { ListTree, Plus, Sparkles } from 'lucide-react'
import type { Chapter, OutlineNode } from '@shared/types'
import { getScene } from '@shared/scenes'
import { countWords, formatNumber, uid } from '@shared/utils'
import { Button, EmptyState } from '../../components/ui'
import { useApp } from '../../store/app'
import { ChapterRow, VolumeRow, type RowActions } from './outline/Rows'
import { ChapterBriefModal } from './outline/ChapterBriefModal'
import { GenOutlineModal } from './outline/GenOutlineModal'
import { insertChild, moveNode, outlineStats, removeNode, updateNode } from './outline/parse'

export function OutlineTab(): ReactNode {
  const project = useApp((s) => s.project)
  const patchProject = useApp((s) => s.patchProject)
  const addChapter = useApp((s) => s.addChapter)
  const setActiveChapter = useApp((s) => s.setActiveChapter)
  const setTab = useApp((s) => s.setTab)
  const toast = useApp((s) => s.toast)

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [genOpen, setGenOpen] = useState(false)
  const [briefNode, setBriefNode] = useState<OutlineNode | null>(null)

  const outline = project?.outline ?? []

  const stat = useMemo(() => outlineStats(outline, countWords), [outline])
  const chapterMap = useMemo(() => {
    const map = new Map<string, Chapter>()
    for (const c of project?.chapters ?? []) {
      if (c.outlineNodeId) map.set(c.outlineNodeId, c)
    }
    return map
  }, [project?.chapters])

  if (!project) return null

  const scene = getScene(project.sceneId)
  const volLabel = scene.structureLabels[0]
  const chLabel = scene.structureLabels[1]

  const writeOutline = (next: OutlineNode[]): void => {
    patchProject((p) => ({ ...p, outline: next }))
  }

  const actions: RowActions = {
    onPatch: (id, patch) => writeOutline(updateNode(outline, id, patch)),
    onRemove: (id) => {
      writeOutline(removeNode(outline, id))
      toast('已删除该节点', 'info')
    },
    onMove: (id, dir) => {
      const next = moveNode(outline, id, dir)
      if (next === outline) return
      writeOutline(next)
    },
    onAddChild: (volumeId) => {
      const vol = outline.find((v) => v.id === volumeId)
      const count = (vol?.children.length ?? 0) + 1
      writeOutline(
        insertChild(outline, volumeId, {
          id: uid('ch'),
          title: `${chLabel} ${count}`,
          summary: '',
          type: 'chapter',
          status: 'planned',
          children: []
        })
      )
    },
    onGenerateBrief: (node) => setBriefNode(node),
    onBuildChapter: (node) => {
      const created = addChapter(node.title)
      if (!created) {
        toast('新建章节失败', 'error')
        return
      }
      patchProject((p) => ({
        ...p,
        chapters: p.chapters.map((c) => (c.id === created.id ? { ...c, outlineNodeId: node.id } : c))
      }))
      setTab('outline')
      toast(`已建为章节「${created.title}」`, 'ok')
    },
    onOpenChapter: (chapter) => {
      setActiveChapter(chapter.id)
      setTab('write')
    }
  }

  const addVolume = (): void => {
    writeOutline([
      ...outline,
      {
        id: uid('vol'),
        title: `${volLabel} ${outline.length + 1}`,
        summary: '',
        type: 'volume',
        status: 'planned',
        children: []
      }
    ])
  }

  const progress = stat.chapters ? Math.round((stat.done / stat.chapters) * 100) : 0

  return (
    <div className="h-full flex flex-col min-h-0" style={{ background: 'var(--bg)' }}>
      {/* 工具条 */}
      <div
        className="shrink-0 flex items-center gap-2 px-4 h-12"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--panel)' }}
      >
        <Button variant="primary" onClick={() => setGenOpen(true)}>
          <Sparkles size={14} /> AI 生成大纲
        </Button>
        <Button onClick={addVolume}>
          <Plus size={14} /> 新增{volLabel}
        </Button>
        <div className="flex-1" />
        <div className="flex items-center gap-3 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          <span>
            {stat.volumes} {volLabel} · {stat.chapters} {chLabel}
          </span>
          <span className="tabular-nums">大纲 {formatNumber(stat.words)} 字</span>
          {stat.chapters > 0 && <span className="tabular-nums">{progress}% 已完成</span>}
        </div>
      </div>

      {/* 主体 */}
      <div className="flex-1 min-h-0 overflow-auto scroll-thin">
        <div className="mx-auto px-4 py-4 space-y-1.5" style={{ maxWidth: 980 }}>
          {outline.length === 0 ? (
            <div className="pt-16">
              <EmptyState
                icon={<ListTree size={26} />}
                title="还没有大纲"
                desc={`先生成一份大纲，再开始写。AI 会按「${volLabel} → ${chLabel}」两级结构给出草稿，你可以逐行修改后再导入。`}
                action={
                  <div className="flex items-center gap-2">
                    <Button variant="primary" onClick={() => setGenOpen(true)}>
                      <Sparkles size={14} /> AI 生成大纲
                    </Button>
                    <Button onClick={addVolume}>
                      <Plus size={14} /> 手动新增{volLabel}
                    </Button>
                  </div>
                }
              />
            </div>
          ) : (
            <>
              {outline.map((vol) => {
                const isCollapsed = !!collapsed[vol.id]
                return (
                  <div key={vol.id} className="rounded-md">
                    <VolumeRow
                      node={vol}
                      collapsed={isCollapsed}
                      chapterCount={vol.children.length}
                      childLabel={chLabel}
                      onToggle={() => setCollapsed((m) => ({ ...m, [vol.id]: !m[vol.id] }))}
                      actions={actions}
                    />
                    {!isCollapsed && (
                      <div className="mt-1 space-y-0.5">
                        {vol.children.length === 0 ? (
                          <div className="pl-8 h-8 flex items-center gap-2 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                            这一{volLabel}还没有{chLabel}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="!h-6 !px-1.5 !text-[11px]"
                              onClick={() => actions.onAddChild(vol.id)}
                            >
                              <Plus size={12} /> 加一{chLabel}
                            </Button>
                          </div>
                        ) : (
                          vol.children.map((ch, i) => (
                            <ChapterRow
                              key={ch.id}
                              node={ch}
                              index={i + 1}
                              chapter={chapterMap.get(ch.id)}
                              actions={actions}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )
              })}

              <div className="pt-2 pb-6 pl-1">
                <Button variant="ghost" size="sm" onClick={addVolume} className="text-[12px]">
                  <Plus size={13} /> 新增{volLabel}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      <GenOutlineModal open={genOpen} onClose={() => setGenOpen(false)} project={project} />
      <ChapterBriefModal node={briefNode} project={project} onClose={() => setBriefNode(null)} />
    </div>
  )
}