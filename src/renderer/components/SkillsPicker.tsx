import { useMemo, type ReactNode } from 'react'
import { Link2 } from 'lucide-react'
import { SKILL_TOTAL_CHAR_LIMIT, groupColor, listCandidates, resolveSkills, skillApplicable } from '@shared/skills'
import type { Project } from '@shared/types'
import { useApp } from '../store/app'
import { skillContext } from '../lib/prompt'
import { Switch } from './ui'

/**
 * 写作台的技法卡勾选面板。
 *
 * 和设置页「技法卡库」的分工：
 *   设置页 → 管卡本身的内容，以及「新书默认勾哪几张」
 *   这里   → 管**这本书**这次用哪几张
 *
 * 四条界面纪律，每条都对应一个会让作者困惑的失败：
 *
 * 1. **顺序即勾选顺序**，所以显示顺序也用 book.settings.activeSkillIds 的顺序，
 *    而不是按分组排——作者勾的先后决定注入先后，视觉上必须一致。
 * 2. **不适配的卡不隐藏，而是灰显并说明原因**。直接隐藏的话，作者会以为卡被删了，
 *    或者以为「我明明新建过这张卡怎么找不着」。
 * 3. **超限要当场说出来**。resolveSkills 已算好被截断的是哪几张，这里如实列出，
 *    绝不能让面板显示"已启用 5 张"而提示词里只有 2 张。
 * 4. **旧版提示**。技法卡升版后，已经勾着它的书会在这里看到一句提醒。
 */
export function SkillsPicker({ project }: { project: Project }): ReactNode {
  const skillLibrary = useApp((s) => s.skillLibrary)
  const patchProject = useApp((s) => s.patchProject)

  const ctx = useMemo(() => skillContext(project), [project])
  const activeIds = project.settings.activeSkillIds ?? []

  const resolved = useMemo(
    () => resolveSkills(activeIds, skillLibrary, ctx, SKILL_TOTAL_CHAR_LIMIT),
    [activeIds, skillLibrary, ctx]
  )

  const candidates = useMemo(() => listCandidates(skillLibrary, ctx), [skillLibrary, ctx])

  // 显示顺序：先按勾选顺序（作者看到的就是注入顺序），再补上未勾选的卡
  const ordered = useMemo(() => {
    const byId = new Map(candidates.map((c) => [c.skill.id, c]))
    const picked = activeIds.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => Boolean(c))
    const rest = candidates.filter((c) => !activeIds.includes(c.skill.id))
    return [...picked, ...rest]
  }, [candidates, activeIds])

  function toggle(id: string, on: boolean): void {
    patchProject((p) => {
      const cur = p.settings.activeSkillIds ?? []
      const next = on ? [...cur, id] : cur.filter((x) => x !== id)
      return {
        ...p,
        settings: {
          ...p.settings,
          activeSkillIds: next,
          // 顺手记下当前版本：之后库里升版，就靠这个数字判断「这张卡变过」
          skillVersions: Object.fromEntries(
            next.map((sid) => {
              const s = skillLibrary?.skills.find((x) => x.id === sid)
              return [sid, s?.version ?? 0]
            })
          )
        }
      }
    })
  }

  if (!skillLibrary) {
    return (
      <div className="text-[12px] px-1 py-2" style={{ color: 'var(--text-faint)' }}>
        技法卡库还没载入。
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          已启用 <b style={{ color: 'var(--text)' }}>{resolved.applied.length}</b> 张 · {resolved.chars}/{SKILL_TOTAL_CHAR_LIMIT} 字
        </span>
        {resolved.trimmed.length > 0 && (
          <span className="text-[10.5px]" style={{ color: 'var(--warn)' }}>
            ⚠ 超限未注入 {resolved.trimmed.length} 张
          </span>
        )}
      </div>

      {resolved.trimmed.length > 0 && (
        <div
          className="rounded-lg px-2.5 py-2 text-[11px] leading-relaxed"
          style={{ background: 'var(--panel)', border: '1px solid var(--warn)', color: 'var(--text-dim)' }}
        >
          已超出 {SKILL_TOTAL_CHAR_LIMIT} 字上限，本次不会注入：
          {resolved.trimmed.map((s) => s.name).join('、')}。
          <br />
          技法块和场景提示词共用上下文，塞太多会让模型顾此失彼。请取消几张，或到设置里精简规则。
        </div>
      )}

      {resolved.missing.length > 0 && (
        <div
          className="rounded-lg px-2.5 py-2 text-[11px] leading-relaxed"
          style={{ background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text-faint)' }}
        >
          以下勾选已失效或不适配本书，本次未注入：{resolved.missing.join('、')}。
          取消勾选即可清理。
        </div>
      )}

      <div className="card p-2">
        {ordered.map(({ skill, applicable, reason }) => {
          const on = activeIds.includes(skill.id)
          // 不适配的卡即使勾着也不生效，所以开关显示的是「实际生效」而非「字段里有没有」
          const effective = on && applicable
          return (
            <div
              key={skill.id}
              className="flex items-start justify-between gap-2 px-1 py-1.5"
              style={{ opacity: applicable ? 1 : 0.55 }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: groupColor(skill.group) }}
                  />
                  <span className="text-[12px] truncate">{skill.name}</span>
                  {skill.version > 1 && (
                    <span className="text-[9.5px]" style={{ color: 'var(--text-faint)' }}>
                      v{skill.version}
                    </span>
                  )}
                  {on && applicable && (
                    <Link2 size={9} style={{ color: 'var(--ok)', flexShrink: 0 }} />
                  )}
                </div>
                <div className="text-[10.5px] leading-snug mt-0.5" style={{ color: 'var(--text-faint)' }}>
                  {applicable ? skill.tagline : reason}
                </div>
              </div>
              <Switch checked={effective} onChange={(v) => toggle(skill.id, v)} />
            </div>
          )
        })}
        {!ordered.length && (
          <div className="px-1 py-2 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            技法卡库是空的。到「设置 → 技法卡库」新建一张，或恢复内置卡。
          </div>
        )}
      </div>

      <div className="px-1 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        勾选顺序就是注入顺序（上面的排列即此顺序）。技法卡只在生成整章正文时生效，
        不改写选区、不影响大纲生成。
      </div>
    </div>
  )
}