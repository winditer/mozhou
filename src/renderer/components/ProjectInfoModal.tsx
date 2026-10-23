import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Project } from '@shared/types'
import { GENRES, getGenre } from '@shared/genres'
import { Button, Field, Input, Modal, Select, Textarea } from './ui'

/** 封面配色：都是中低明度、白字可读的底色，和书架默认色系一致 */
const COVER_COLORS = [
  '#2F6F5E',
  '#8C4A3C',
  '#2B4C7E',
  '#6D28D9',
  '#0F766E',
  '#B45309',
  '#9D174D',
  '#1E3A8A',
  '#4D7C0F',
  '#7C2D12',
  '#334155',
  '#0F172A'
]

const GENRE_GROUPS = Array.from(new Set(GENRES.map((g) => g.group)))

/**
 * 作品信息编辑：书名 / 作者 / 题材 / 简介 / 梗概 / 封面色。
 * 书架和写作页共用；保存动作由调用方决定（写作页走 store 的 patchProject，
 * 书架走 project.save，避免把当前打开的另一本书写坏）。
 */
export function ProjectInfoModal({
  open,
  project,
  onSave,
  onClose
}: {
  open: boolean
  project: Project | null
  onSave: (next: Project) => Promise<void> | void
  onClose: () => void
}): ReactNode {
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [genreId, setGenreId] = useState('')
  const [logline, setLogline] = useState('')
  const [premise, setPremise] = useState('')
  const [cover, setCover] = useState(COVER_COLORS[0]!)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const projectId = project?.id ?? ''

  useEffect(() => {
    if (!open || !project) return
    setTitle(project.title)
    setAuthor(project.author)
    setGenreId(project.genreId)
    setLogline(project.brief.logline)
    setPremise(project.brief.premise)
    setCover(project.coverColor)
    setError(null)
    setSaving(false)
    // 只在「打开」或「换了一本书」时重置，避免输入过程中被 project 更新打断
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId])

  const genre = useMemo(() => getGenre(genreId), [genreId])

  const save = async (): Promise<void> => {
    if (!project) return
    const name = title.trim()
    if (!name) {
      setError('书名不能为空')
      return
    }
    setSaving(true)
    try {
      await onSave({
        ...project,
        title: name,
        author: author.trim(),
        genreId,
        coverColor: cover,
        brief: { ...project.brief, logline: logline.trim(), premise: premise.trim() }
      })
      onClose()
    } catch (e) {
      setError((e as Error).message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="作品信息"
      width={640}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="flex gap-4">
        {/* 封面预览 */}
        <div className="shrink-0" style={{ width: 108 }}>
          <div
            style={{
              aspectRatio: '3 / 4',
              borderRadius: 8,
              background: `linear-gradient(150deg, ${cover}, color-mix(in srgb, ${cover} 55%, #000))`,
              boxShadow: 'var(--shadow)',
              padding: 8,
              display: 'flex',
              alignItems: 'flex-end',
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              lineHeight: 1.3
            }}
          >
            <span className="line-clamp-3">{title.trim() || '书名'}</span>
          </div>
          <div className="mt-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            封面色
          </div>
          <div className="mt-1.5 grid grid-cols-4 gap-1.5">
            {COVER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => setCover(c)}
                style={{
                  height: 20,
                  borderRadius: 5,
                  background: c,
                  border: cover === c ? '2px solid var(--accent)' : '1px solid var(--border)',
                  outline: 'none',
                  cursor: 'pointer'
                }}
              />
            ))}
          </div>
          <label
            className="mt-1.5 flex items-center gap-1.5 text-[11px] cursor-pointer"
            style={{ color: 'var(--text-faint)' }}
          >
            <input
              type="color"
              value={cover}
              onChange={(e) => setCover(e.target.value)}
              style={{ width: 20, height: 20, padding: 0, border: '1px solid var(--border)', borderRadius: 5, background: 'transparent' }}
            />
            自定义
          </label>
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <Field label="书名">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="这本小说叫什么" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="作者">
              <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="笔名" />
            </Field>
            <Field label="题材">
              <Select value={genreId} onChange={(e) => setGenreId(e.target.value)}>
                {GENRE_GROUPS.map((g) => (
                  <optgroup key={g} label={g}>
                    {GENRES.filter((x) => x.group === g).map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="一句话简介" hint="显示在书架卡片上，也会进提示词">
            <Input value={logline} onChange={(e) => setLogline(e.target.value)} placeholder="用一句话说清这本书写什么" />
          </Field>
          <Field label="故事梗概" hint={genre ? `题材公约：${genre.convention.slice(0, 46)}…` : undefined}>
            <Textarea
              rows={5}
              value={premise}
              onChange={(e) => setPremise(e.target.value)}
              placeholder="起因、主要人物、核心冲突、结局走向…"
              className="text-[12.5px]"
            />
          </Field>
          {error && (
            <div className="text-[11.5px]" style={{ color: 'var(--danger)' }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}