import { useMemo, useState, type ReactNode } from 'react'
import { Plus, RotateCcw, Trash2, Sparkles } from 'lucide-react'
import {
  CRAFT_SKILL_GROUPS,
  SKILL_TOTAL_CHAR_LIMIT,
  groupColor,
  groupLabel,
  listCandidates,
  resolveSkills,
  type CraftSkill,
  type CraftSkillGroup
} from '@shared/skills'
import { uid } from '@shared/utils'
import { Button, IconButton, Input, Switch, Textarea } from '../../components/ui'
import { useApp } from '../../store/app'
import { LoadingHint, MONO, PageHead } from './common'

/**
 * 技法卡库：全局管理、跨书复用的写作方法论。
 *
 * 三个设计取向（与文风分身库同一套纪律）：
 *
 * 1. **不改 id**。书内只存 id，改 id 等于把所有书的勾选静默清空。
 * 2. **删内置卡记墓碑**。主进程按 deletedBuiltin 跳过补种，否则作者删完下次启动又长回来。
 * 3. **字数余量要看得见**。技法块在提示词里共用一个 1200 字上限，
 *    作者在这里加卡时得知道「再加一张会不会把别的挤掉」，而不是等写作台上被截断。
 *
 * 这里同时管理「设置里的默认勾选」（defaultSkillIds，只影响新书）。
 * 单本书的勾选在写作台右侧做——两处职责不重叠，免得作者以为改这里会动到已经建好的书。
 */
export function SkillsSection(): ReactNode {
  const skillLibrary = useApp((s) => s.skillLibrary)
  const saveSkillLibrary = useApp((s) => s.saveSkillLibrary)
  const config = useApp((s) => s.config)
  const toast = useApp((s) => s.toast)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState<CraftSkill | null>(null)

  const skills = skillLibrary?.skills ?? []
  const defaults = config?.settings.defaultSkillIds ?? []
  const active = useMemo(() => skills.find((s) => s.id === activeId) ?? skills[0] ?? null, [skills, activeId])

  // 默认勾选的卡加起来的占用：用与分析注入时同一个 resolveSkills，
  // 否则这里显示「还有余量」、写作台上却提示「已截断」，作者会以为哪里出错了
  const usage = useMemo(() => {
    if (!skillLibrary) return { chars: 0, trimmed: [] as CraftSkill[] }
    const r = resolveSkills(defaults, skillLibrary, { sceneId: 'long-novel', genreId: 'xuanhuan', targetWords: 2500 })
    return { chars: r.chars, trimmed: r.trimmed }
  }, [skillLibrary, defaults])

  if (!skillLibrary) return <LoadingHint />

  const editing = draft ?? active
  const dirty = Boolean(draft && active && (draft.rules !== active.rules || draft.name !== active.name || draft.tagline !== active.tagline || draft.whenToUse !== active.whenToUse))

  function pick(skill: CraftSkill): void {
    setActiveId(skill.id)
    setDraft(null)
  }

  function startEdit(): void {
    if (!active) return
    setDraft({ ...active, antiPatterns: [...(active.antiPatterns ?? [])] })
  }

  async function commitDraft(): Promise<void> {
    if (!draft) return
    const vi = (draft.version ?? 1) + 1
    const next: CraftSkill = {
      ...draft,
      name: draft.name.trim() || '未命名技法卡',
      // 改过规则就升版：作者在这里改的是自己的方法论，书里记着上次用的版本，
      // 界面据此提示「已更新到 vN」，而不是让改动静默生效
      version: draft.rules !== active?.rules ? vi : draft.version,
      changelog:
        draft.rules !== active?.rules
          ? [...(draft.changelog ?? []), { version: vi, note: '在设置页修改了规则', at: Date.now() }]
          : draft.changelog,
      updatedAt: Date.now()
    }
    const ok = await saveSkillLibrary((lib) => ({
      ...lib,
      skills: lib.skills.map((s) => (s.id === next.id ? next : s))
    }))
    if (ok) {
      setDraft(null)
      toast('技法卡已保存', 'info')
    }
  }

  async function toggleBuiltin(skill: CraftSkill): Promise<void> {
    // 改内置卡内容时保留 builtin=true：它仍然是「有出厂版本可对照」的卡，
    // 只是被作者改过。恢复出厂时会覆盖掉这里的改动。
    const ok = await saveSkillLibrary((lib) => ({
      ...lib,
      skills: lib.skills.map((s) => (s.id === skill.id ? { ...s, updatedAt: Date.now() } : s))
    }))
    if (ok) toast('已更新', 'info')
  }

  async function createSkill(): Promise<void> {
    const now = Date.now()
    const skill: CraftSkill = {
      id: uid('sk'),
      name: '新建技法卡',
      group: 'structure',
      tagline: '一句话说明这张卡管什么',
      whenToUse: '什么时候该勾它',
      rules: '一、写第一条可执行的规则：用祈使句，能被人照着做、被编辑逐条核对。\n二、写第二条。',
      antiPatterns: [],
      version: 1,
      changelog: [{ version: 1, note: '新建', at: now }],
      builtin: false,
      createdAt: now,
      updatedAt: now
    }
    const ok = await saveSkillLibrary((lib) => ({ ...lib, skills: [...lib.skills, skill] }))
    if (ok) {
      setActiveId(skill.id)
      setDraft(skill)
    }
  }

  async function removeSkill(skill: CraftSkill): Promise<void> {
    if (!window.confirm(`确定删除技法卡「${skill.name}」？已勾选它的书会失去这张卡。`)) return
    const ok = await saveSkillLibrary((lib) => ({ ...lib, skills: lib.skills.filter((s) => s.id !== skill.id) }))
    if (ok) {
      setDraft(null)
      setActiveId(null)
      toast('已删除', 'info')
    }
  }

  async function resetBuiltin(): Promise<void> {
    if (!window.confirm('恢复内置技法卡？你自己新建的卡会保留，内置卡会恢复出厂内容，你的修改会丢失。')) return
    try {
      const saved = await window.mz.skill.resetBuiltin()
      useApp.setState({ skillLibrary: saved })
      setDraft(null)
      toast('内置技法卡已恢复', 'info')
    } catch (e) {
      toast(`恢复失败：${(e as Error).message}`, 'error')
    }
  }

  async function toggleDefault(id: string): Promise<void> {
    const next = defaults.includes(id) ? defaults.filter((x) => x !== id) : [...defaults, id]
    const { patchSettings } = useApp.getState()
    try {
      await patchSettings({ defaultSkillIds: next })
    } catch (e) {
      toast(`保存失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div className="space-y-6">
      <PageHead
        title="技法卡库"
        desc="跨书复用的写作方法论。这里管理卡本身和「新建书默认勾选哪几张」；某本书具体用哪几张，在写作台右侧勾选。"
        right={
          <>
            <Button variant="ghost" onClick={resetBuiltin}>
              <RotateCcw size={14} /> 恢复内置
            </Button>
            <Button onClick={createSkill}>
              <Plus size={14} /> 新建技法卡
            </Button>
          </>
        }
      />

      {/* 字数预算条：技法块在提示词里共用上限，作者加卡时得看得见还剩多少 */}
      <div className="card p-4">
        <div className="flex items-center justify-between text-sm">
          <span style={{ color: 'var(--text-dim)' }}>
            新建书默认勾选 <b style={{ color: 'var(--text)' }}>{defaults.length}</b> 张 · 占用{' '}
            <b style={{ color: usage.chars > SKILL_TOTAL_CHAR_LIMIT ? 'var(--danger)' : 'var(--text)' }}>{usage.chars}</b> /{' '}
            {SKILL_TOTAL_CHAR_LIMIT} 字
          </span>
          {usage.trimmed.length > 0 && (
            <span style={{ color: 'var(--danger)', fontSize: 12 }}>
              ⚠ 超出上限，实际不会注入：{usage.trimmed.map((s) => s.name).join('、')}
            </span>
          )}
        </div>
        <div className="mt-2 h-1.5 rounded-full" style={{ background: 'var(--border)' }}>
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${Math.min(100, (usage.chars / SKILL_TOTAL_CHAR_LIMIT) * 100)}%`,
              background: usage.chars > SKILL_TOTAL_CHAR_LIMIT ? 'var(--danger)' : 'var(--accent)'
            }}
          />
        </div>
        <div className="mt-2 text-xs" style={{ color: 'var(--text-faint)' }}>
          技法块和场景提示词、文风分身共用同一个上下文。上限存在的意义是防止技法压过文体本身。
        </div>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: '260px 1fr' }}>
        {/* 左：卡片列表 */}
        <div className="card overflow-hidden">
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            {CRAFT_SKILL_GROUPS.map((g) => {
              const list = skills.filter((s) => s.group === g.id)
              if (!list.length) return null
              return (
                <div key={g.id}>
                  <div
                    className="px-3 py-1.5 text-xs font-medium"
                    style={{ color: 'var(--text-faint)', background: 'var(--bg-subtle)' }}
                  >
                    {g.label}
                  </div>
                  {list.map((s) => {
                    const on = s.id === active?.id
                    return (
                      <button
                        key={s.id}
                        onClick={() => pick(s)}
                        className="w-full px-3 py-2 text-left text-sm transition-colors"
                        style={{
                          background: on ? 'var(--bg-subtle)' : 'transparent',
                          borderLeft: `3px solid ${on ? groupColor(s.group) : 'transparent'}`,
                          color: 'var(--text)'
                        }}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="truncate">{s.name}</span>
                          {s.deprecated && <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>退役</span>}
                        </div>
                        <div className="truncate text-xs" style={{ color: 'var(--text-faint)' }}>
                          {s.tagline || '无说明'}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )
            })}
            {!skills.length && (
              <div className="p-4 text-sm" style={{ color: 'var(--text-faint)' }}>
                还没有技法卡。点右上角「新建技法卡」开始，或「恢复内置」拿回出厂的两张。
              </div>
            )}
          </div>
        </div>

        {/* 右：编辑 */}
        <div className="card p-4">
          {!editing ? (
            <div className="text-sm" style={{ color: 'var(--text-faint)' }}>
              左侧选择一张技法卡来查看或编辑。
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 space-y-2">
                  <Input
                    value={editing.name}
                    onChange={(e) =>
                      draft ? setDraft({ ...draft, name: e.target.value }) : startEdit()
                    }
                    onFocus={startEdit}
                    placeholder="技法卡名称"
                  />
                  <Input
                    value={editing.tagline}
                    onChange={(e) => setDraft({ ...(draft ?? editing), tagline: e.target.value })}
                    placeholder="一句话说明这张卡管什么"
                  />
                </div>
                <div className="flex items-center gap-1">
                  <IconButton title="删除" onClick={() => removeSkill(editing)}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>

              <div>
                <div className="mb-1 text-xs font-medium" style={{ color: 'var(--text-dim)' }}>
                  何时该用（给作者看的判断依据）
                </div>
                <Textarea
                  rows={2}
                  value={editing.whenToUse}
                  onChange={(e) => setDraft({ ...(draft ?? editing), whenToUse: e.target.value })}
                  placeholder="什么情况下该勾这张卡"
                />
              </div>

              <div>
                <div className="mb-1 text-xs font-medium" style={{ color: 'var(--text-dim)' }}>
                  规则（会原样注入提示词，必须是可执行的祈使句）
                </div>
                <Textarea
                  rows={8}
                  style={{ fontFamily: MONO }}
                  value={editing.rules}
                  onChange={(e) => setDraft({ ...(draft ?? editing), rules: e.target.value })}
                  placeholder="一、……&#10;二、……"
                />
                <div className="mt-1 text-xs" style={{ color: 'var(--text-faint)' }}>
                  {editing.rules.length} 字 · 写成「请写得更自然些」这类空话会原样进提示词，只会让模型更散
                </div>
              </div>

              <div>
                <div className="mb-1 text-xs font-medium" style={{ color: 'var(--text-dim)' }}>
                  反例（每行一条，负向约束比正向描述更有效）
                </div>
                <Textarea
                  rows={3}
                  style={{ fontFamily: MONO }}
                  value={(editing.antiPatterns ?? []).join('\n')}
                  onChange={(e) =>
                    setDraft({
                      ...(draft ?? editing),
                      antiPatterns: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)
                    })
                  }
                  placeholder="而这一切，才刚刚开始。"
                />
              </div>

              <div className="flex items-center justify-between border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={defaults.includes(editing.id)} onChange={() => toggleDefault(editing.id)} />
                  <span>新建书默认勾选</span>
                </label>
                <span className="text-xs" style={{ color: 'var(--text-faint)', fontFamily: MONO }}>
                  v{editing.version} · {groupLabel(editing.group)}
                </span>
              </div>

              {dirty && (
                <div className="flex items-center justify-end gap-2">
                  <Button variant="ghost" onClick={() => setDraft(null)}>
                    放弃
                  </Button>
                  <Button onClick={commitDraft}>
                    <Sparkles size={14} /> 保存
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}