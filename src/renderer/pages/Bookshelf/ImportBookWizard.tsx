/**
 * 导入书稿向导
 *
 * 四步：本地解析 → AI 识别（可跳过）→ 预览修正 → 导入。
 *
 * 设计取舍：
 * - 第 1 步不花一分钱就要给出「这本书大概长什么样」，解析不出章节也要能导；
 * - 第 2 步默认勾选，但模型没配 / 用户不想花钱时整步可跳过，导入始终能完成；
 * - 第 3 步的一切都能改 —— AI 识别只是初稿，作者才是终审；
 * - 第 4 步才落盘，失败不会在书架里留下半成品。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CircleStop, FileUp, RotateCcw, Settings2, Sparkles, Wand2 } from 'lucide-react'
import { GENRES } from '@shared/genres'
import { BUDGET_KEYS, DEFAULT_TOKEN_BUDGETS, resolveBudget } from '@shared/budgets'
import { formatNumber } from '@shared/utils'
import { abortChat, sendChat } from '../../lib/ai'
import { isAbortMessage } from '../../lib/stream'
import { resolveTaskModel, useApp } from '../../store/app'
import { Button, Checkbox, Field, Input, Modal, Progress, Select, Spinner, Textarea } from '../../components/ui'
import { parseImportText } from './import/parse'
import {
  batchChapters,
  chapterSummaryMessages,
  metaMessages,
  parseChapterSummaries,
  parseMetaOutput,
  parseVolumePlanOutput,
  planVolumeAssignments,
  sampleForMeta,
  volumePlanMessages,
  type ChapterSummary,
  type ImportMetaCharacter
} from './import/aiParse'
import { assembleImportedProject, IMPORT_SCENE_ID, type ImportDraftVolume } from './import/assemble'

export interface ImportFilePayload {
  name: string
  content: string
}

/** 预览里的章节行（可编辑态）。body 不变，标题/摘要/勾选可变 */
interface DraftChapterRow {
  key: number
  index: number
  title: string
  body: string
  words: number
  summary: string
  include: boolean
  volumeIndex: number
}

/** 章节列表一次最多渲染这么多行：几百章的输入框会把窗口拖卡 */
const PREVIEW_LIMIT = 80
/** 超过这个体积只提示、不阻止（作者可能就是要导短篇合集） */
const BIG_FILE_BYTES = 2 * 1024 * 1024

const STEP_LABELS = ['本地解析', 'AI 识别', '预览修正', '导入']

export function ImportBookWizard({
  open,
  onClose,
  file
}: {
  open: boolean
  onClose: () => void
  file: ImportFilePayload | null
}): ReactNode {
  const config = useApp((s) => s.config)
  const toast = useApp((s) => s.toast)
  const setView = useApp((s) => s.setView)

  const [step, setStep] = useState(1)

  /* ── 元信息（第 3 步可改） ── */
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [genreId, setGenreId] = useState('')
  const [logline, setLogline] = useState('')
  const [premise, setPremise] = useState('')
  /** AI 顺手给出的关键词：没有编辑入口，但保存下来，后续生成会用到 */
  const [keywords, setKeywords] = useState<string[]>([])
  const [metaCharacters, setMetaCharacters] = useState<ImportMetaCharacter[]>([])
  const [drafts, setDrafts] = useState<DraftChapterRow[]>([])
  const [volumeTitles, setVolumeTitles] = useState<string[]>([])
  const [buildOutline, setBuildOutline] = useState(true)

  /* ── AI 状态 ── */
  const [aiEnabled, setAiEnabled] = useState(true)
  const [wantVolumePlan, setWantVolumePlan] = useState(false)
  const [aiRunning, setAiRunning] = useState(false)
  const [aiStage, setAiStage] = useState('')
  const [aiDone, setAiDone] = useState(0)
  const [aiTotal, setAiTotal] = useState(0)
  const [aiReceived, setAiReceived] = useState(0)
  const [aiSummaryCount, setAiSummaryCount] = useState(0)
  const [missing, setMissing] = useState<number[]>([])
  const [aiError, setAiError] = useState('')
  const [aiTouched, setAiTouched] = useState(false)

  const [importing, setImporting] = useState(false)
  /** 展开编辑摘要的章节 key 集合：摘要默认折叠，避免 80 个输入框同时铺开 */
  const [openSummaries, setOpenSummaries] = useState<Set<number>>(new Set())

  const abortRef = useRef(false)
  const runningRef = useRef(false)
  const recvRef = useRef(0)
  /** 已拿到的摘要：分卷调用要按章列出摘要，不能读 state（异步里是旧值） */
  const summaryRef = useRef(new Map<number, string>())

  const parsed = useMemo(
    () => (open && file ? parseImportText(file.content, { fileName: file.name }) : null),
    [open, file]
  )

  const bytes = useMemo(
    () => (file ? new TextEncoder().encode(file.content).length : 0),
    [file]
  )

  /** AI 用的章节输入：正文本身不会变，单独抽出来避免编辑标题时重算分批 */
  const aiChapters = useMemo(
    () => (parsed?.chapters ?? []).map((c) => ({ index: c.index, title: c.title, body: c.body })),
    [parsed]
  )
  const batches = useMemo(() => batchChapters(aiChapters), [aiChapters])
  const canPlanVolumes = Boolean(parsed && parsed.splitMode !== 'volume' && aiChapters.length >= 6)
  const planCalls = (aiEnabled ? 1 + batches.length : 0) + (aiEnabled && wantVolumePlan && canPlanVolumes ? 1 : 0)
  const planChars = useMemo(() => {
    if (!aiEnabled) return 0
    const sample = sampleForMeta(aiChapters).length
    return sample + batches.reduce((s, b) => s + b.chars, 0)
  }, [aiEnabled, aiChapters, batches])

  const model = resolveTaskModel(config, null, 'outline')

  /* 每次打开（换文件也算）都回到干净状态 */
  useEffect(() => {
    if (!open) return
    setStep(1)
    setTitle(parsed?.title ?? '')
    setAuthor(parsed?.author ?? '')
    setGenreId('')
    setLogline('')
    setPremise('')
    setKeywords([])
    setMetaCharacters([])
    setDrafts(
      (parsed?.chapters ?? []).map((c) => ({
        key: c.index,
        index: c.index,
        title: c.title,
        body: c.body,
        words: c.words,
        summary: '',
        include: true,
        volumeIndex: c.volumeIndex
      }))
    )
    setVolumeTitles((parsed?.volumes ?? []).map((v) => v.title))
    setBuildOutline(true)
    setAiEnabled(true)
    setWantVolumePlan(Boolean(parsed && parsed.splitMode !== 'volume' && parsed.chapters.length >= 6))
    setAiRunning(false)
    setAiStage('')
    setAiDone(0)
    setAiTotal(0)
    setAiReceived(0)
    setAiSummaryCount(0)
    setMissing([])
    setAiError('')
    setAiTouched(false)
    setImporting(false)
    setOpenSummaries(new Set())
    abortRef.current = false
    runningRef.current = false
    recvRef.current = 0
    summaryRef.current = new Map()
  }, [open, parsed])

  /* 组件卸载/关闭时中断未完成的请求，别在后台空烧 token */
  useEffect(
    () => () => {
      if (runningRef.current) {
        abortRef.current = true
        abortChat()
      }
    },
    []
  )

  /* ───────────────────── AI 调用 ───────────────────── */

  const callAi = async (messages: Parameters<typeof sendChat>[0]['messages'], maxTokens: number): Promise<string> => {
    const picked = resolveTaskModel(useApp.getState().config, null, 'outline')
    if (!picked) throw new Error('未配置可用模型')
    recvRef.current = 0
    setAiReceived(0)
    const res = await sendChat({
      channel: picked.channel,
      model: picked.model,
      messages,
      // 结构化任务走 outline 档：温度低，模型更愿意老老实实回 JSON
      task: 'outline',
      temperature: 0.2,
      maxTokens,
      // 识别/摘要都是 JSON：关掉思考，避免 reasoning 把额度吃完、正文空着回来
      thinking: 'off',
      onDelta: (delta) => {
        if (abortRef.current) return
        recvRef.current += delta.length
        // 流式内容不展示正文（JSON 对作者没意义），只报「已收到 N 字」证明模型在动
        setAiReceived(recvRef.current)
      }
    })
    return res.text || ''
  }

  const applySummaries = (list: ChapterSummary[]): void => {
    for (const item of list) summaryRef.current.set(item.index, item.summary)
    setDrafts((rows) =>
      rows.map((row) => {
        const hit = list.find((x) => x.index === row.index)
        return hit ? { ...row, summary: hit.summary } : row
      })
    )
  }

  const runAi = async (): Promise<void> => {
    const picked = resolveTaskModel(useApp.getState().config, null, 'outline')
    if (!picked) {
      toast('请先到「设置 → 渠道与模型」配置一个可用模型', 'error')
      return
    }
    const budgets = useApp.getState().config?.settings.tokenBudgets ?? DEFAULT_TOKEN_BUDGETS
    const metaBudget = resolveBudget(budgets, BUDGET_KEYS.importMeta)
    const chapterBudget = resolveBudget(budgets, BUDGET_KEYS.importChapters)
    const total = 1 + batches.length + (wantVolumePlan && canPlanVolumes ? 1 : 0)

    abortRef.current = false
    runningRef.current = true
    summaryRef.current = new Map()
    setAiRunning(true)
    setAiError('')
    setAiDone(0)
    setAiTotal(total)
    setAiSummaryCount(0)
    setMissing([])
    setAiTouched(true)

    let summarised = 0
    let aborted = false

    try {
      /* 1) 元信息：1 次 */
      setAiStage('识别书名 / 作者 / 题材 / 梗概…')
      const metaText = await callAi(
        metaMessages({
          fileName: file?.name,
          titleGuess: title,
          authorGuess: author,
          sample: sampleForMeta(aiChapters)
        }),
        metaBudget
      )
      if (abortRef.current) {
        aborted = true
      } else {
        const meta = parseMetaOutput(metaText)
        // 只填 AI 真给了的字段，且不覆盖「正文首行」这种强证据：
        // 文件名常常是下载来的乱名（「新建文本文档(3).txt」），AI 从内容起的书名更可信
        if (meta.title && (!title.trim() || parsed?.titleFrom === 'filename')) setTitle(meta.title)
        if (meta.author && (!author.trim() || parsed?.authorFrom === 'filename')) setAuthor(meta.author)
        if (meta.genreId) setGenreId(meta.genreId)
        if (meta.logline) setLogline(meta.logline)
        if (meta.premise) setPremise(meta.premise)
        if (meta.keywords.length > 0) setKeywords(meta.keywords)
        if (meta.characters.length > 0) setMetaCharacters(meta.characters)
      }
      setAiDone(1)

      /* 2) 章节摘要：逐批，每批失败重试 1 次 */
      for (let i = 0; i < batches.length && !aborted; i++) {
        if (abortRef.current) {
          aborted = true
          break
        }
        const batch = batches[i]!
        const from = batch.indexes[0]
        const to = batch.indexes[batch.indexes.length - 1]
        setAiStage(`章节摘要 ${i + 1}/${batches.length}（第 ${from}–${to} 章）`)

        let ok = false
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try {
            const text = await callAi(
              chapterSummaryMessages({ bookTitle: title, batch }),
              chapterBudget
            )
            if (abortRef.current) {
              aborted = true
              break
            }
            const list = parseChapterSummaries(text, { batch: batch.indexes })
            if (list.length > 0) {
              applySummaries(list)
              summarised += list.length
              ok = true
            }
            // 解析不出内容也算失败：重试一次再放弃
          } catch (e) {
            const message = (e as Error).message || '调用失败'
            if (abortRef.current || isAbortMessage(message)) {
              aborted = true
              break
            }
            if (attempt === 1) setAiError(`第 ${from}–${to} 章摘要失败：${message}`)
          }
        }
        if (!ok && !aborted) setAiError(`第 ${from}–${to} 章摘要没有解析出来`)
        setAiDone((n) => n + 1)
      }

      /* 3) 按情节分卷：1 次，失败就退回「第一卷」 */
      if (!aborted && wantVolumePlan && canPlanVolumes) {
        setAiStage('按情节分卷…')
        try {
          const text = await callAi(
            volumePlanMessages({
              bookTitle: title,
              chapters: aiChapters.map((c) => ({
                index: c.index,
                title: c.title,
                summary: summaryRef.current.get(c.index) ?? ''
              }))
            }),
            chapterBudget
          )
          if (abortRef.current) {
            aborted = true
          } else {
            const plan = parseVolumePlanOutput(text, aiChapters.length)
            if (plan.length > 0) {
              const assigned = planVolumeAssignments(plan, aiChapters.length)
              setVolumeTitles(assigned.titles)
              setDrafts((rows) =>
                rows.map((row) => ({ ...row, volumeIndex: assigned.volumeOf.get(row.index) ?? 0 }))
              )
            }
          }
        } catch (e) {
          // 分卷失败不影响导入：本地没有卷标记时归入「第一卷」
          if (!abortRef.current && !isAbortMessage((e as Error).message)) {
            setAiError(`分卷失败，已按第一卷处理：${(e as Error).message}`)
          }
        }
        setAiDone((n) => n + 1)
      }
    } catch (e) {
      const message = (e as Error).message || '调用失败'
      if (abortRef.current || isAbortMessage(message)) {
        aborted = true
      } else {
        setAiError(message)
        toast(`识别失败：${message}`, 'error')
      }
    } finally {
      runningRef.current = false
      setAiRunning(false)
      setAiStage('')
      setAiSummaryCount(summarised)
      // 统一算「哪些章还没有摘要」：中途停止时未处理的那几批也要列出来，
      // 作者得知道哪些章打开是空的，而不是以为全都识别过了
      setMissing(aiChapters.filter((c) => !summaryRef.current.has(c.index)).map((c) => c.index))
      if (aborted) {
        toast('已停止识别，可先用本地解析结果导入', 'info')
      } else if (summarised > 0) {
        toast(`AI 识别完成：${summarised} 章已有摘要`, 'ok')
      }
    }
  }

  const stopAi = (): void => {
    abortRef.current = true
    abortChat()
  }

  /* ───────────────────── 统计与装配 ───────────────────── */

  const included = useMemo(() => drafts.filter((d) => d.include && d.body.trim().length > 0), [drafts])
  const includedWords = useMemo(() => included.reduce((s, d) => s + d.words, 0), [included])

  /** 勾选的章按卷分组，顺序与本地解析一致 */
  const groupedVolumes = useMemo(() => {
    const groups = new Map<number, DraftChapterRow[]>()
    for (const row of included) {
      const list = groups.get(row.volumeIndex) ?? []
      list.push(row)
      groups.set(row.volumeIndex, list)
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0])
  }, [included])

  const outlineCounts = useMemo(() => {
    const volumes = groupedVolumes.length
    const chapters = groupedVolumes.reduce((s, [, rows]) => s + rows.length, 0)
    return { volumes, chapters }
  }, [groupedVolumes])

  const buildDraftVolumes = (): ImportDraftVolume[] =>
    groupedVolumes.map(([volumeIndex, rows]) => ({
      title: volumeTitles[volumeIndex] ?? `第 ${volumeIndex + 1} 卷`,
      chapters: rows.map((r) => ({ title: r.title, body: r.body, summary: r.summary }))
    }))

  const doImport = async (): Promise<void> => {
    if (included.length === 0) return
    setImporting(true)
    try {
      const project = assembleImportedProject({
        title,
        author,
        genreId,
        logline,
        premise,
        keywords,
        sceneId: IMPORT_SCENE_ID,
        volumes: buildDraftVolumes(),
        characters: metaCharacters,
        buildOutline
      }, useApp.getState().config?.settings.defaultSkillIds)
      // newProject 会落盘并直接进入写作台第一章，这正是导入完想做的事
      await useApp.getState().newProject(project)
      useApp.getState().toast(`已导入《${project.title}》· ${included.length} 章 · ${formatNumber(includedWords)} 字`, 'ok')
      onClose()
    } catch (e) {
      toast(`导入失败：${(e as Error).message}`, 'error')
    } finally {
      setImporting(false)
    }
  }

  const close = (): void => {
    if (runningRef.current) stopAi()
    onClose()
  }

  const goSettings = (): void => {
    onClose()
    setView('settings')
  }

  /* ───────────────────── 渲染小件 ───────────────────── */

  const stepDots = (): ReactNode => (
    <div className="flex items-center gap-1.5 mb-3">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1
        const active = n === step
        const done = n < step
        return (
          <div key={label} className="flex items-center gap-1.5">
            <div
              className="flex items-center gap-1.5 rounded-full px-2.5"
              style={{
                height: 24,
                background: active ? 'var(--accent-soft)' : 'var(--panel-2)',
                border: '1px solid var(--border)',
                color: active ? 'var(--accent)' : done ? 'var(--text-dim)' : 'var(--text-faint)',
                fontSize: 11.5
              }}
            >
              <span
                className="inline-flex items-center justify-center rounded-full"
                style={{
                  width: 15,
                  height: 15,
                  fontSize: 10,
                  background: active || done ? 'var(--accent)' : 'transparent',
                  color: active || done ? '#fff' : 'var(--text-faint)'
                }}
              >
                {n}
              </span>
              {label}
            </div>
            {n < STEP_LABELS.length && <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>›</span>}
          </div>
        )
      })}
    </div>
  )

  const notice = (text: string, kind: 'info' | 'warn' = 'info'): ReactNode => (
    <div
      className="rounded-md px-2.5 py-2 text-[12px] leading-relaxed"
      style={{
        background: 'var(--panel-2)',
        border: '1px solid var(--border)',
        color: kind === 'warn' ? 'var(--warn)' : 'var(--text-dim)'
      }}
    >
      {text}
    </div>
  )

  const previewRows = drafts.slice(0, PREVIEW_LIMIT)

  /* ───────────────────── 各步内容 ───────────────────── */

  const stepParse = (): ReactNode => {
    if (!parsed) return null
    return (
      <div className="grid gap-3">
        <div className="card p-3">
          <div className="flex items-center gap-2 text-[13px]">
            <FileUp size={14} style={{ color: 'var(--accent)' }} />
            <span className="font-medium truncate">{file?.name ?? '未选择文件'}</span>
            <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              {(bytes / 1024).toFixed(0)} KB
            </span>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
            <div style={{ color: 'var(--text-dim)' }}>
              识别到 <b>{parsed.chapters.length}</b> 章
            </div>
            <div style={{ color: 'var(--text-dim)' }}>
              <b>{parsed.volumes.length}</b> 卷
            </div>
            <div style={{ color: 'var(--text-dim)' }}>
              共 <b>{formatNumber(parsed.totalWords)}</b> 字
            </div>
          </div>
          <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <Field label="书名（本地候选）">
              <div className="text-[13px] truncate" style={{ color: 'var(--text-dim)' }}>
                {parsed.title || '—'}
              </div>
            </Field>
            <Field label="作者（本地候选）">
              <div className="text-[13px] truncate" style={{ color: 'var(--text-dim)' }}>
                {parsed.author || '—'}
              </div>
            </Field>
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            这两项和第 3 步的所有信息都能改。
          </div>
        </div>

        {bytes > BIG_FILE_BYTES && (
          <div style={{ color: 'var(--warn)' }}>
            {notice(
              `文件约 ${(bytes / 1024 / 1024).toFixed(1)} MB，属于大稿：解析与 AI 识别会慢一些，期间界面可能短暂无响应，但仍可继续导入。`,
              'warn'
            )}
          </div>
        )}

        {parsed.notices.map((n) => (
          <div key={n}>{notice(n)}</div>
        ))}

        {parsed.chapters.length > 0 ? (
          <div className="card p-3">
            <div className="text-[12.5px] font-medium mb-1.5">章节预览</div>
            <div className="grid gap-1">
              {parsed.chapters.slice(0, 8).map((c) => (
                <div key={c.index} className="flex items-center gap-2 text-[12px]">
                  <span className="tabular-nums shrink-0" style={{ color: 'var(--text-faint)', width: 28 }}>
                    {c.index}
                  </span>
                  <span className="truncate flex-1" style={{ color: 'var(--text-dim)' }}>
                    {c.title}
                  </span>
                  <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                    {formatNumber(c.words)} 字
                  </span>
                </div>
              ))}
            </div>
            {parsed.chapters.length > 8 && (
              <div className="mt-1.5 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                还有 {parsed.chapters.length - 8} 章，完整清单在第 3 步。
              </div>
            )}
          </div>
        ) : (
          <div>{notice('这份文件里没有解析出章节正文，换个文件或用「写作台 → 导入」粘贴试试。', 'warn')}</div>
        )}
      </div>
    )
  }

  const stepAi = (): ReactNode => (
    <div className="grid gap-3">
      <div className="card p-3 grid gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <Checkbox
            checked={aiEnabled}
            onChange={(v) => setAiEnabled(v)}
            disabled={aiRunning}
            label="用 AI 识别书名 / 题材 / 梗概 / 章节摘要"
          />
          <span className="text-[11.5px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
            将调用 {planCalls} 次 · 输入约 {formatNumber(planChars)} 字
          </span>
        </div>

        {canPlanVolumes && (
          <Checkbox
            checked={wantVolumePlan}
            onChange={(v) => setWantVolumePlan(v)}
            disabled={aiRunning || !aiEnabled}
            label="按情节自动分卷（本地没有卷标记，多 1 次调用）"
          />
        )}

        <div className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          {model ? `模型：${model.label}（outline 任务）` : '未配置可用模型'}
        </div>

        {!model && (
          <div className="grid gap-2">
            {notice('未配置模型，已用本地解析结果；配置后可重新识别。', 'warn')}
            <div className="flex justify-end">
              <Button size="sm" onClick={goSettings} type="button">
                <Settings2 size={12} />
                去设置
              </Button>
            </div>
          </div>
        )}

        {model && !aiEnabled && (
          <div>{notice('已选择不用 AI：书名、作者和卷章结构只来自本地解析，章节摘要为空。')}</div>
        )}

        {aiRunning && (
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between text-[12px]">
              <span style={{ color: 'var(--text-dim)' }}>{aiStage}</span>
              <span className="tabular-nums" style={{ color: 'var(--text-faint)' }}>
                {aiDone}/{aiTotal} 次 · 已收到 {aiReceived} 字
              </span>
            </div>
            <Progress value={aiDone} max={Math.max(1, aiTotal)} />
          </div>
        )}

        {!aiRunning && aiTouched && (
          <div className="grid gap-1">
            <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              {aiSummaryCount > 0
                ? `已完成 ${aiSummaryCount} 章摘要${aiDone > 0 ? ` · 共 ${aiDone} 次调用` : ''}`
                : '本次没有拿到摘要，章节会用标题占位'}
            </div>
            {missing.length > 0 && (
              <div className="text-[11.5px]" style={{ color: 'var(--warn)' }}>
                以下章节没有摘要：第 {missing.slice(0, 20).join('、')}
                {missing.length > 20 ? ` 等 ${missing.length} 章` : ''}。可以重试，或直接导入。
              </div>
            )}
            {aiError && (
              <div className="text-[11.5px]" style={{ color: 'var(--warn)' }}>
                {aiError}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {aiRunning ? (
            <Button variant="danger" onClick={stopAi} type="button">
              <CircleStop size={13} />
              停止识别
            </Button>
          ) : (
            <Button onClick={() => void runAi()} disabled={!model || !aiEnabled || drafts.length === 0} type="button">
              {aiTouched ? <RotateCcw size={13} /> : <Wand2 size={13} />}
              {aiTouched ? '重新识别' : '开始识别'}
            </Button>
          )}
        </div>
      </div>

      <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        识别只是给初稿：书名、作者、题材、梗概和每章摘要都会写进第 3 步的表单，随时可改。
        跳过这一步也能完整导入，正文与卷章结构全部来自本地解析。
      </div>
    </div>
  )

  const stepPreview = (): ReactNode => (
    <div className="grid gap-3">
      <div className="card p-3 grid gap-2.5">
        <div className="grid gap-2.5" style={{ gridTemplateColumns: '1.4fr 1fr 1fr' }}>
          <Field label="书名">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="作者">
            <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="留空即未署名" />
          </Field>
          <Field label="题材">
            <Select value={genreId} onChange={(e) => setGenreId(e.target.value)}>
              <option value="">不指定</option>
              {GENRES.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="一句话简介">
          <Input value={logline} onChange={(e) => setLogline(e.target.value)} placeholder="主角 + 困境 + 钩子" />
        </Field>
        <Field label="故事梗概">
          <Textarea rows={4} value={premise} onChange={(e) => setPremise(e.target.value)} />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
        <span className="truncate">
          将创建《{title.trim() || '未命名作品'}》：<b>{included.length}</b> 章 · {formatNumber(includedWords)} 字
          {buildOutline ? ` · 大纲 ${outlineCounts.volumes} 卷 ${outlineCounts.chapters} 章` : ' · 不生成大纲'}
        </span>
        <div className="flex items-center gap-3">
          <Checkbox checked={buildOutline} onChange={setBuildOutline} label="生成大纲（卷 → 章）" />
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => {
              const all = drafts.every((d) => d.include)
              setDrafts((rows) => rows.map((r) => ({ ...r, include: !all })))
            }}
          >
            {drafts.every((d) => d.include) ? '全部不导入' : '全部导入'}
          </Button>
        </div>
      </div>

      {buildOutline && groupedVolumes.length > 0 && (
        <div className="card p-3">
          <div className="text-[12.5px] font-medium mb-1.5">大纲预览</div>
          <div className="grid gap-1">
            {groupedVolumes.map(([volumeIndex, rows]) => (
              <div key={volumeIndex} className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                <b>{volumeTitles[volumeIndex] ?? `第 ${volumeIndex + 1} 卷`}</b>
                <span style={{ color: 'var(--text-faint)' }}>
                  {' '}
                  · {rows.length} 章（{rows[0]?.title.slice(0, 16)}… → {rows[rows.length - 1]?.title.slice(0, 16)}…）
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card p-3">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[12.5px] font-medium">章节清单</div>
          <div className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            取消勾选即不导入
          </div>
        </div>
        <div className="grid gap-1.5" style={{ maxHeight: 280, overflow: 'auto' }}>
          {previewRows.map((row) => {
            const expanded = openSummaries.has(row.key)
            return (
              <div key={row.key} className="grid gap-1" style={{ gridTemplateColumns: '22px 28px 1fr 64px 56px' }}>
                <input
                  type="checkbox"
                  checked={row.include}
                  onChange={(e) => {
                    const next = e.target.checked
                    setDrafts((rows) => rows.map((r) => (r.key === row.key ? { ...r, include: next } : r)))
                  }}
                  title={row.include ? '不导入这一章' : '导入这一章'}
                  style={{ marginTop: 7 }}
                />
                <div className="text-[11.5px] tabular-nums" style={{ color: 'var(--text-faint)', marginTop: 7 }}>
                  {row.index}
                </div>
                <Input
                  value={row.title}
                  onChange={(e) => {
                    const next = e.target.value
                    setDrafts((rows) => rows.map((r) => (r.key === row.key ? { ...r, title: next } : r)))
                  }}
                  style={{ height: 28, fontSize: 12.5 }}
                />
                <div className="text-[11.5px] tabular-nums flex items-center justify-end" style={{ color: 'var(--text-faint)' }}>
                  {formatNumber(row.words)} 字
                </div>
                <button
                  type="button"
                  className="rounded text-[11px]"
                  style={{ color: row.summary ? 'var(--text-dim)' : 'var(--text-faint)' }}
                  onClick={() =>
                    setOpenSummaries((prev) => {
                      const next = new Set(prev)
                      if (next.has(row.key)) next.delete(row.key)
                      else next.add(row.key)
                      return next
                    })
                  }
                >
                  {expanded ? '收起' : row.summary ? '改摘要' : '加摘要'}
                </button>

                {!expanded && row.summary ? (
                  <div
                    className="text-[11.5px] leading-relaxed"
                    style={{ gridColumn: '3 / 6', color: 'var(--text-faint)' }}
                    title={row.summary}
                  >
                    {row.summary.length > 90 ? `${row.summary.slice(0, 90)}…` : row.summary}
                  </div>
                ) : null}

                {expanded ? (
                  <div style={{ gridColumn: '3 / 6' }}>
                    <Textarea
                      rows={2}
                      value={row.summary}
                      placeholder="这一章讲了什么，导入后会作为章节摘要与大纲节点摘要"
                      onChange={(e) => {
                        const next = e.target.value
                        setDrafts((rows) => rows.map((r) => (r.key === row.key ? { ...r, summary: next } : r)))
                      }}
                      style={{ fontSize: 12 }}
                    />
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
        {drafts.length > PREVIEW_LIMIT && (
          <div className="mt-1.5 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            只显示前 {PREVIEW_LIMIT} 章（其余 {drafts.length - PREVIEW_LIMIT} 章照常导入，标题保持原样）。
          </div>
        )}
      </div>
    </div>
  )

  const stepImport = (): ReactNode => (
    <div className="grid gap-3">
      <div className="card p-3 grid gap-2 text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
        <div>
          将创建作品《<b>{title.trim() || '未命名作品'}</b>》{author.trim() ? ` · 作者 ${author.trim()}` : ''}
        </div>
        <div>
          {included.length} 章 · {formatNumber(includedWords)} 字
          {buildOutline ? ` · 大纲 ${outlineCounts.volumes} 卷 ${outlineCounts.chapters} 章` : ' · 不生成大纲'}
        </div>
        <div>章节状态一律标记为「已完成」（导入的就是成稿），导入后直接进入写作台第一章。</div>
        {!buildOutline && <div style={{ color: 'var(--warn)' }}>你选择了不生成大纲：章节列表可用，大纲页会是空的。</div>}
      </div>
      <div className="grid gap-1 text-[12px]" style={{ color: 'var(--text-faint)' }}>
        {groupedVolumes.slice(0, 12).map(([volumeIndex, rows]) => (
          <div key={volumeIndex} className="truncate">
            {volumeTitles[volumeIndex] ?? `第 ${volumeIndex + 1} 卷`} · {rows.length} 章
          </div>
        ))}
        {groupedVolumes.length > 12 && <div>…还有 {groupedVolumes.length - 12} 卷</div>}
      </div>
    </div>
  )

  const body = (): ReactNode => {
    switch (step) {
      case 1:
        return stepParse()
      case 2:
        return stepAi()
      case 3:
        return stepPreview()
      default:
        return stepImport()
    }
  }

  const footer = (): ReactNode => {
    const noChapters = drafts.length === 0
    if (step === 1) {
      return (
        <>
          <Button onClick={close} type="button">
            取消
          </Button>
          <Button variant="primary" onClick={() => setStep(2)} disabled={noChapters} type="button">
            下一步：AI 识别
          </Button>
        </>
      )
    }
    if (step === 2) {
      return (
        <>
          <Button onClick={() => setStep(1)} disabled={aiRunning} type="button">
            上一步
          </Button>
          <Button
            variant="primary"
            onClick={() => setStep(3)}
            disabled={aiRunning}
            type="button"
          >
            {aiTouched ? '下一步：预览' : '跳过，直接预览'}
          </Button>
        </>
      )
    }
    if (step === 3) {
      return (
        <>
          <Button onClick={() => setStep(2)} type="button">
            上一步
          </Button>
          <Button variant="primary" onClick={() => setStep(4)} disabled={included.length === 0} type="button">
            下一步：确认导入
          </Button>
        </>
      )
    }
    return (
      <>
        <Button onClick={() => setStep(3)} disabled={importing} type="button">
          上一步
        </Button>
        <Button
          variant="primary"
          onClick={() => void doImport()}
          disabled={importing || included.length === 0}
          type="button"
        >
          {importing ? <Spinner size={12} /> : <Sparkles size={13} />}
          导入到书架
        </Button>
      </>
    )
  }

  return (
    <Modal open={open} onClose={close} title="导入书稿" width={820} footer={footer()}>
      {stepDots()}
      {body()}
    </Modal>
  )
}