import { useState, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import {
  BUDGET_KEYS,
  DEFAULT_TOKEN_BUDGETS,
  clampBudget,
  type BudgetKey,
  type PerWordBudget,
  type TokenBudget,
  type TokenBudgets
} from '@shared/budgets'
import { Button, IconButton, Input } from '../../components/ui'
import { useApp } from '../../store/app'
import { LoadingHint, PageHead, Row, patchSettingsSafe } from './common'

/* ───────────────────────── 分组表 ───────────────────────── */

interface RowDef {
  key: BudgetKey
  label: string
  /** 这个预算用在哪儿——写具体入口，不写「生成内容时」这种空话 */
  desc: string
  /** 额外的一句提示，目前只有「设定卡（其他）」用得到 */
  note?: string
}

interface GroupDef {
  title: string
  desc: string
  rows: RowDef[]
}

/** 23 个预算点，按用户意图分组，组内顺序与「先写什么」一致 */
const GROUPS: GroupDef[] = [
  {
    title: '写作',
    desc: '直接影响正文产出的一组，调低会让文章变短甚至被截断。',
    rows: [
      {
        key: BUDGET_KEYS.draftGenerate,
        label: '正文生成',
        desc: '按本章目标字数生成正文。'
      },
      {
        key: BUDGET_KEYS.draftContinue,
        label: '长度守护补写',
        desc: '首轮写不够长时自动补写，按还差多少字计算。'
      },
      {
        key: BUDGET_KEYS.draftSelection,
        label: '选中段落润色',
        desc: '润色、改写选中段落，按选中长度的两倍计算。'
      },
      {
        key: BUDGET_KEYS.chatReply,
        label: '对话助手',
        desc: '右侧写作对话里的一次问答。思考类模型的推理也吃这份额度，给少了回答会半截或直接空白；若允许 AI 附上改动（要抄回原文片段），建议 12000 以上。'
      }
    ]
  },
  {
    title: '大纲与设定',
    desc: '推演结构和写设定卡时用的额度，输出多是结构化的短条目。',
    rows: [
      {
        key: BUDGET_KEYS.outlineGenerate,
        label: '大纲推演',
        desc: '按约 10 章的大纲估算，要求越多章越容易不够。'
      },
      {
        key: BUDGET_KEYS.outlineChapterBrief,
        label: '章节简介',
        desc: '为单个大纲节点生成 150–260 字的情节点简介。'
      },
      {
        key: BUDGET_KEYS.bibleEntry,
        label: '设定卡（人物）',
        desc: '从素材里整理人物设定卡，按约 900 字的量估算。'
      },
      {
        key: BUDGET_KEYS.bibleEntryShort,
        label: '设定卡（其他）',
        desc: '从素材里整理地点、势力、道具等非人物条目，按约 800 字的量估算。',
        note:
          '默认值里它和「设定卡（人物）」是同一套按字数参数，实际都受 2048 的下限兜着。' +
          '改成固定额度后，填小于 2048 的数会真的低于下限，生成一半就被截断。'
      }
    ]
  },
  {
    title: '一键开书',
    desc: '从一句想法开始建书的五个步骤，每一步各有一份额度。',
    rows: [
      {
        key: BUDGET_KEYS.quickstartTitle,
        label: '书名与简介',
        desc: '第 1 步：给出书名与一句话简介。'
      },
      {
        key: BUDGET_KEYS.quickstartSettings,
        label: '核心设定',
        desc: '第 2 步：生成世界观、主角与核心看点。'
      },
      {
        key: BUDGET_KEYS.quickstartVolumes,
        label: '分卷',
        desc: '第 3 步：把故事切成若干卷并写明每卷主线。'
      },
      {
        key: BUDGET_KEYS.quickstartChapters,
        label: '首卷章纲',
        desc: '第 4 步：为首卷排出逐章梗概。'
      },
      {
        key: BUDGET_KEYS.quickstartFirstChapter,
        label: '首章正文',
        desc: '第 5 步：写第一章正文，按开书表单里填的每章字数计算。'
      }
    ]
  },
  {
    title: '摘要与体检',
    desc: '摘要与体检的输出都是结构化 JSON，给不够会解析失败、界面上一片空白。',
    rows: [
      {
        key: BUDGET_KEYS.summaryAuto,
        label: '章节摘要（自动）',
        desc: '写完一章后自动压缩成滚动摘要，供后续生成引用。'
      },
      {
        key: BUDGET_KEYS.summaryAudit,
        label: '章节摘要（体检用）',
        desc: '体检开始前临时补摘要，只在体检流程里使用。'
      },
      {
        key: BUDGET_KEYS.auditBook,
        label: '全书体检',
        desc: '通读全书梗概，找出前后对不上的地方，输出 3–12 条问题。'
      },
      {
        key: BUDGET_KEYS.auditChapter,
        label: '单章体检',
        desc: '评一章的节奏、冲突、悬念与注水程度，并列出问题清单。'
      },
      {
        key: BUDGET_KEYS.auditThread,
        label: '伏笔猎手',
        desc: '扫描正文里埋下却没登记的伏笔，输出至多 8 条。'
      }
    ]
  },
  {
    title: '其它',
    desc: '零散功能各自的额度，改动频率低，一般保持默认即可。',
    rows: [
      {
        key: BUDGET_KEYS.namingIdeas,
        label: '取名灵感',
        desc: '灵感页上「换一批」时一次生成 5 条可直接开写的桥段。'
      },
      {
        key: BUDGET_KEYS.styleTraits,
        label: '文风特征提取',
        desc: '从写作样本里提炼 3–6 条文风特征。'
      },
      {
        key: BUDGET_KEYS.styleTrial,
        label: '文风试写对比',
        desc: '用同一引子写约 150 字的短段，比较开／关文风的差别。'
      },
      {
        key: BUDGET_KEYS.personaGenerate,
        label: '文风分身 AI 生成',
        desc: '在文风分身库里让 AI 起草或改写一份分身（约 6–8 条特征 + 摘要）。'
      },
      {
        key: BUDGET_KEYS.marginNotes,
        label: '段边批注',
        desc: '为整章逐段写侧批，一次覆盖所有段落，至多 6 条批注。'
      },
      {
        key: BUDGET_KEYS.customDefault,
        label: '自定义调用兜底',
        desc: '自定义提示词调用没指定额度时用这一份。'
      }
    ]
  }
]

/** 设置页里各数字框的目标尺寸 */
const NUM_W = 78

/** 按字数预算里四个可调字段 */
type Field = Exclude<keyof PerWordBudget, 'kind'>

/* ───────────────────────── 工具函数 ───────────────────────── */

/**
 * 把输入框里的字符串转成数字。
 *
 * 空字符串必须单独处理：Number('') 是 0，而 0 是有限数，如果只判 Number.isFinite，
 * 用户把「2048」清空的那一瞬间就会被当成 0 写进配置，再被 clampBudget 夹成 1——
 * 于是每敲一个字都得重来。所以空串（含纯空格）一律回退到当前值，什么都不写。
 */
function numOr(value: string, fallback: number): number {
  if (value.trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 算式的一半：round(字数 × 每字倍数) + 思考余量 */
function wantedFor(words: number, b: PerWordBudget): number {
  return Math.round(words * b.perWord) + b.thinkPad
}

/**
 * 写入时的合并基准：从 store 现读，不要用渲染时闭包里的那份。
 * patchSettings 是异步往返，两次快速改动之间 config 还是旧的，
 * 闭包快照会让后一次写入静默冲掉前一次的改动。
 */
function liveBudgets(): TokenBudgets {
  return useApp.getState().config?.settings.tokenBudgets ?? DEFAULT_TOKEN_BUDGETS
}

/**
 * 固定额度行：没有任何 offset，按 2.2 token/字 反推能写多少汉字。
 * 这是上界——真实中文正文按模型不同常是 1.5–2 token/字，所以只配「≈」和「粗估」。
 */
function fixedCharsHint(tokens: number): string {
  return `≈ ${Math.max(1, Math.round(tokens / 2.2))} 汉字（粗估）`
}

/* ───────────────────────── 页面 ───────────────────────── */

export function BudgetsSection(): ReactNode {
  const config = useApp((s) => s.config)
  const budgets: TokenBudgets = config?.settings.tokenBudgets ?? DEFAULT_TOKEN_BUDGETS

  if (!config) return <LoadingHint />

  /**
   * 唯一的写入路径：先过 clampBudget 再落盘。
   * 成功不弹提示——数字框是边打边存的，每敲一下弹一次会很烦；失败由 patchSettingsSafe 报错。
   *
   * 合并基准必须现取，不能用渲染时闭包里的 budgets：patchSettings 是异步往返，
   * config 要等 saveConfig resolve 后才更新。改了 A 行、还没落盘就去改 B 行时，
   * 两次写入会各自基于同一份旧快照合并，后到的那次把 A 的改动整行冲掉——
   * 不报错、不弹提示，纯静默丢失。这里改成从 store 现读，与 AuditTab 的做法一致。
   */
  function write(key: BudgetKey, next: TokenBudget): void {
    const cur = liveBudgets()
    void patchSettingsSafe({ tokenBudgets: { ...cur, [key]: clampBudget(next) } })
  }

  /** 逐字段与默认值比较。不用 JSON.stringify：字段顺序一变（比如存盘归一化过）就会误判 */
  const isDefault = (key: BudgetKey): boolean => {
    const a = clampBudget(budgets[key])
    const b = clampBudget(DEFAULT_TOKEN_BUDGETS[key])
    if (a.kind !== b.kind) return false
    if (a.kind === 'fixed' && b.kind === 'fixed') return a.tokens === b.tokens
    if (a.kind === 'perWord' && b.kind === 'perWord') {
      return a.perWord === b.perWord && a.thinkPad === b.thinkPad && a.min === b.min && a.max === b.max
    }
    return false
  }

  const allDefault = (Object.keys(DEFAULT_TOKEN_BUDGETS) as BudgetKey[]).every(isDefault)

  async function resetOne(key: BudgetKey, label: string): Promise<void> {
    // 同样现取：恢复默认也是对一行的部分更新，不能拿渲染时的快照去覆盖别人的改动
    const cur = liveBudgets()
    const ok = await patchSettingsSafe({ tokenBudgets: { ...cur, [key]: clampBudget(DEFAULT_TOKEN_BUDGETS[key]) } })
    if (ok) useApp.getState().toast(`「${label}」已恢复默认`, 'ok')
  }

  async function resetAll(): Promise<void> {
    const defaults: TokenBudgets = { ...DEFAULT_TOKEN_BUDGETS }
    const ok = await patchSettingsSafe({ tokenBudgets: defaults })
    if (ok) useApp.getState().toast('全部输出预算已恢复默认', 'ok')
  }

  return (
    <div>
      <PageHead
        title="输出预算"
        desc="每一个 AI 环节各自能写多少 token。改了立刻生效，下一次调用就用新数值；一般只在换模型或章节特别长时才需要动。"
      />

      <WarningCallout />

      {GROUPS.map((group) => (
        <div key={group.title} className="mb-3">
          <div className="flex items-baseline gap-2 mb-1.5 mt-4">
            <span className="text-[12.5px] font-medium">{group.title}</span>
            <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              {group.desc}
            </span>
          </div>
          <div className="card px-4 py-1">
            {group.rows.map((row, i) => (
              <BudgetRow
                key={row.key}
                row={row}
                budget={budgets[row.key]}
                first={i === 0}
                isDefault={isDefault(row.key)}
                onWrite={(next) => write(row.key, next)}
                onReset={() => void resetOne(row.key, row.label)}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="card px-4 py-3 flex items-center justify-between gap-4">
        <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          23 项整体恢复出厂数值。改坏了一两项、说不清原来是多少时，用这个最快。
        </div>
        <Button size="sm" onClick={() => void resetAll()} disabled={allDefault}>
          <RotateCcw size={13} /> 全部恢复默认
        </Button>
      </div>
    </div>
  )
}

/* ───────────────────────── 警告卡片 ───────────────────────── */

/** 领域事实：思考 token 也算在 maxTokens 里，并且没有任何参数能把它拆出去 */
function WarningCallout(): ReactNode {
  return (
    <div className="card p-4 flex items-start gap-2.5 text-[12.5px] leading-relaxed mb-1" style={{ color: 'var(--warn)' }}>
      <AlertTriangle size={15} className="shrink-0 mt-0.5" />
      <div className="min-w-0" style={{ wordBreak: 'break-word' }}>
        <div className="font-medium">思考过程也算在预算里，且无法单独排除</div>
        <div className="mt-1" style={{ color: 'var(--text-dim)' }}>
          推理类模型会先想再写，思考用掉的 token 同样计入输出上限，没有任何参数能把它拆出去。
          把「每字倍数」或「思考余量」调小，模型可能把整份额度都花在思考上，正文一个字都没写就结束——
          界面表现就是空返回或半截话。遇到这种情况先换非推理模型，再考虑加预算；固定额度那几项同理。
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────── 单行 ───────────────────────── */

function BudgetRow({
  row,
  budget,
  first,
  isDefault,
  onWrite,
  onReset
}: {
  row: RowDef
  budget: TokenBudget
  first: boolean
  isDefault: boolean
  onWrite: (next: TokenBudget) => void
  onReset: () => void
}): ReactNode {
  // 脏数据或老配置里的坏条目一律按默认值渲染，免得输入框里出现 NaN
  const shown: TokenBudget = budget ?? DEFAULT_TOKEN_BUDGETS[row.key]

  return (
    <div
      className="py-3"
      style={first ? undefined : { borderTop: '1px solid var(--border)' }}
    >
      <Row
        align="start"
        title={row.label}
        tag={
          <span className="chip" style={{ height: 18 }}>
            {shown.kind === 'perWord' ? '按字数' : '固定额度'}
          </span>
        }
        desc={row.desc}
        note={row.note}
        control={
          <>
            {shown.kind === 'perWord' ? (
              <PerWordInputs
                label={row.label}
                value={shown}
                onWrite={(next) => onWrite(clampBudget(next))}
              />
            ) : (
              <FixedInput
                label={row.label}
                value={shown.tokens}
                onWrite={(tokens) => onWrite({ kind: 'fixed', tokens })}
              />
            )}
            <IconButton
              onClick={onReset}
              disabled={isDefault}
              title={isDefault ? '已经是默认值' : '恢复默认'}
              aria-label={`恢复「${row.label}」默认值`}
              style={isDefault ? { opacity: 0.3 } : undefined}
            >
              <RotateCcw size={13} />
            </IconButton>
          </>
        }
        below={shown.kind === 'perWord' ? <PerWordHints value={shown} /> : undefined}
      />
    </div>
  )
}

/* ───────────────────────── 固定额度 ───────────────────────── */

/**
 * 固定额度没有思考余量，按 2.2 token/字 反推的汉字数是上界；
 * 15 行的 aria-label 必须带行名，否则读屏用户分不清是哪一个额度。
 */
function FixedInput({
  label,
  value,
  onWrite
}: {
  label: string
  value: number
  onWrite: (tokens: number) => void
}): ReactNode {
  return (
    <div className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
      <span className="chip" style={{ height: 18 }}>
        {fixedCharsHint(value)}
      </span>
      <Input
        type="number"
        min={1}
        max={32768}
        step={100}
        value={String(value)}
        onChange={(e) => onWrite(numOr(e.target.value, value))}
        style={{ width: NUM_W, textAlign: 'right' }}
        aria-label={`${label} 输出 token 上限`}
      />
      <span>token</span>
    </div>
  )
}

/* ───────────────────────── 按字数 ───────────────────────── */

/**
 * 按字数那四个框：每字倍数 / 思考余量 / 下限 / 上限，边打边存。
 *
 * 下限填得比上限大时，clampBudget 在写盘时会把两者对调（`min: min(a,b), max: max(a,b)`），
 * 这是有意的兜底，不会报错。所以「填反了」这个状态只存在于用户正在输入的原始串里，
 * 落盘后的值永远已经对调过——提示必须挂在原始输入上，挂在 value 上永远不会触发。
 */
function PerWordInputs({
  label,
  value,
  onWrite
}: {
  label: string
  value: PerWordBudget
  onWrite: (next: PerWordBudget) => void
}): ReactNode {
  /**
   * 原始输入串：空串和「填到一半」的值（如刚删掉一个 0）不能直接 round 回写，
   * 否则光标位置和输入过程都会被搅乱。草稿只活在输入框里，落盘仍按 spec 边打边存。
   */
  const [draft, setDraft] = useState<Partial<Record<Field, string>>>({})

  /** 只换一个字段，其余保持当前值；min/max 填反由 clampBudget 换回来 */
  const patch = (field: Field, raw: string): void => {
    setDraft((d) => ({ ...d, [field]: raw }))
    onWrite({ ...value, [field]: numOr(raw, value[field]) })
  }

  /**
   * 填反检测只能看原始输入：clampBudget 在渲染前就把 min/max 换回来了，
   * 等值到了 value 上永远是 min <= max。留空的字段按当前值算（numOr 也这么处理）。
   */
  const rawOf = (field: Field): number => numOr(draft[field] ?? String(value[field]), value[field])
  const inverted = rawOf('min') > rawOf('max')

  const field = (
    text: string,
    key: Field,
    extra: { step: number; min: number; max: number }
  ): ReactNode => (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
        {text}
      </span>
      <Input
        type="number"
        min={extra.min}
        max={extra.max}
        step={extra.step}
        value={draft[key] ?? String(value[key])}
        onChange={(e) => patch(key, e.target.value)}
        style={{ width: NUM_W, textAlign: 'right' }}
        aria-label={`${label} ${text}`}
      />
    </label>
  )

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-end gap-2">
        {field('每字倍数', 'perWord', { step: 0.1, min: 0.5, max: 8 })}
        {field('思考余量', 'thinkPad', { step: 64, min: 0, max: 16384 })}
        {field('下限', 'min', { step: 100, min: 1, max: 32768 })}
        {field('上限', 'max', { step: 500, min: 1, max: 32768 })}
      </div>
      {inverted && (
        <span className="text-[10.5px]" style={{ color: 'var(--warn)' }}>
          下限大于上限，保存时已自动对调。
        </span>
      )}
    </div>
  )
}

/**
 * 按字数那几行底下的小字：公式 + 两个字数档的实际结果。
 *
 * 这里只做正向计算（字数 → token），不再反推「≈ N 汉字」：
 * 预算里那 1024 的思考余量不属于正文，拿 token 除以每字倍数会把它算进字数，
 * 1000 字档会虚报 +46.5%。要反推就得先减掉 thinkPad，而正向这几档已经是答案。
 */
function PerWordHints({ value }: { value: PerWordBudget }): ReactNode {
  // 带上两个具体档位，让公式不只是文字：写起来才知道「每字倍数」到底改变什么
  const samples = [1000, 4000]

  return (
    <div className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
      目标字数 × 每字倍数 + 思考余量，再夹到下限与上限之间。按当前参数：
      {samples.map((words) => (
        <span key={words}>
          {' '}
          {words} 字 →
          <span style={{ color: 'var(--text-dim)' }}>
            {' '}
            {Math.min(value.max, Math.max(value.min, wantedFor(words, value)))}
          </span>
        </span>
      ))}
      {' '}token。
    </div>
  )
}