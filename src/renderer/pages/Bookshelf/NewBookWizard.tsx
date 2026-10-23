import { useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Project } from '@shared/types'
import { getScene } from '@shared/scenes'
import { createBlankProject, scaffoldChapters } from '@shared/factory'
import { clamp } from '@shared/utils'
import { useApp } from '../../store/app'
import { Button, Modal, Spinner } from '../../components/ui'
import {
  buildOutline,
  DEFAULT_COLOR,
  DEFAULT_SCENE,
  GenreStep,
  InfoStep,
  PlanStep,
  SceneStep,
  STEPS,
  StepBar,
  type WizardDraft
} from './WizardSteps'

const EMPTY_DRAFT: WizardDraft = {
  sceneId: DEFAULT_SCENE,
  genreId: '',
  coverColor: DEFAULT_COLOR,
  perChapter: getScene(DEFAULT_SCENE).defaultChapterWords,
  totalWords: 0,
  chapterCount: '3',
  title: '',
  author: '',
  logline: '',
  premise: ''
}

export function NewBookWizard({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const newProject = useApp((s) => s.newProject)
  const toast = useApp((s) => s.toast)

  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<WizardDraft>(EMPTY_DRAFT)
  const [creating, setCreating] = useState(false)

  /* 每次打开都回到第一步，草稿清空（章节数保留上次习惯由默认值决定） */
  useEffect(() => {
    if (!open) return
    setStep(0)
    setDraft({ ...EMPTY_DRAFT })
    setCreating(false)
  }, [open])

  const patch = (next: Partial<WizardDraft>): void => setDraft((d) => ({ ...d, ...next }))

  const pickScene = (id: string): void => {
    patch({ sceneId: id, perChapter: getScene(id).defaultChapterWords })
  }

  const scene = getScene(draft.sceneId)

  const next = (): void => setStep((s) => Math.min(STEPS.length - 1, s + 1))
  const back = (): void => setStep((s) => Math.max(0, s - 1))

  const create = async (): Promise<void> => {
    const name = draft.title.trim()
    if (!name) {
      toast('请先填写书名', 'error')
      return
    }
    const perChapter = clamp(draft.perChapter, scene.minChapterWords, scene.maxChapterWords)
    setCreating(true)
    try {
      const project: Project = createBlankProject({
        title: name,
        author: draft.author.trim(),
        sceneId: draft.sceneId,
        genreId: draft.genreId || undefined,
        logline: draft.logline.trim(),
        premise: draft.premise.trim(),
        targetWordsPerChapter: perChapter,
        targetTotalWords: draft.totalWords,
        coverColor: draft.coverColor
      })

      const count = Number(draft.chapterCount)
      if (count > 1) project.chapters = scaffoldChapters(count, perChapter)

      /* 大纲骨架：每个模板条目一个卷，第一卷挂上这批章节节点 */
      project.outline = buildOutline(project.chapters, scene.outlineTemplate)

      await newProject(project)
      toast(`《${name}》已创建`, 'ok')
      onClose()
    } catch (e) {
      toast(`创建失败：${(e as Error).message}`, 'error')
    } finally {
      setCreating(false)
    }
  }

  const requestClose = (): void => {
    if (!creating) onClose()
  }

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title="新建作品"
      width={760}
      footer={
        <div className="flex w-full items-center justify-between">
          <div className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            第 {step + 1} / {STEPS.length} 步
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={requestClose} disabled={creating} type="button">
              取消
            </Button>
            <Button onClick={back} disabled={step === 0 || creating} type="button">
              <ChevronLeft size={14} />
              上一步
            </Button>
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={next} type="button">
                下一步
                <ChevronRight size={14} />
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void create()} disabled={creating} type="button">
                {creating && <Spinner size={12} />}
                创建作品
              </Button>
            )}
          </div>
        </div>
      }
    >
      <StepBar step={step} />
      <div style={{ minHeight: 384 }}>
        {step === 0 && <SceneStep sceneId={draft.sceneId} onPick={pickScene} />}
        {step === 1 && <GenreStep draft={draft} patch={patch} />}
        {step === 2 && <PlanStep draft={draft} patch={patch} />}
        {step === 3 && <InfoStep draft={draft} patch={patch} />}
      </div>
    </Modal>
  )
}