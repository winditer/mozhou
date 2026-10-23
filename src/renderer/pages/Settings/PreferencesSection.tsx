import { useEffect, useState, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button, Input, Slider, Switch } from '../../components/ui'
import { useApp } from '../../store/app'
import { LoadingHint, PageHead, patchSettingsSafe, Row, useDebounced } from './common'

const GOAL_PRESETS = [1000, 3000, 6000]

export function PreferencesSection(): ReactNode {
  const config = useApp((s) => s.config)
  const toast = useApp((s) => s.toast)

  const [temperature, updateTemperature] = useDebounced<number>(config?.settings.temperature, (v) => {
    void patchSettingsSafe({ temperature: v })
  })
  const [goalDraft, setGoalDraft] = useState(String(config?.settings.dailyGoal ?? 0))

  useEffect(() => {
    if (config) setGoalDraft(String(config.settings.dailyGoal))
  }, [config?.settings.dailyGoal])

  if (!config || temperature === undefined) return <LoadingHint />

  async function commitGoal(raw: number): Promise<void> {
    if (!Number.isFinite(raw)) {
      setGoalDraft(String(config?.settings.dailyGoal ?? 0))
      return
    }
    const n = Math.max(100, Math.min(100_000, Math.round(raw)))
    setGoalDraft(String(n))
    const ok = await patchSettingsSafe({ dailyGoal: n })
    if (ok) toast(`每日目标已设为 ${n} 字`, 'ok')
  }

  return (
    <div>
      <PageHead title="写作偏好" desc="这些是全局默认值，会作用于所有作品；单个作品可以在工作区里单独调整。" />

      <div className="card px-4 py-2">
        <Row
          title="每日字数目标"
          desc="用于书架与工作区的进度环、连续写作统计"
          control={
            <div className="flex items-center gap-1.5">
              <Input
                value={goalDraft}
                inputMode="numeric"
                onChange={(e) => setGoalDraft(e.target.value)}
                onBlur={() => void commitGoal(Number(goalDraft))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                style={{ width: 92, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
              />
              <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
                字
              </span>
              {GOAL_PRESETS.map((g) => (
                <button
                  key={g}
                  className="chip"
                  onClick={() => void commitGoal(g)}
                  style={{
                    height: 24,
                    cursor: 'default',
                    color: g === config?.settings.dailyGoal ? 'var(--accent)' : 'var(--text-dim)',
                    borderColor:
                      g === config?.settings.dailyGoal ? 'color-mix(in srgb, var(--accent) 32%, transparent)' : 'var(--border)'
                  }}
                >
                  {g}
                </button>
              ))}
            </div>
          }
        />

        <div style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between gap-6 py-2.5">
            <div className="min-w-0">
              <div className="text-[13px]">默认温度</div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
                低温度更稳、更贴合设定；高温度更发散、更有想象力。正文建议 0.7–1.0。
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0" style={{ width: 260 }}>
              <Slider
                value={temperature}
                min={0}
                max={1.5}
                step={0.05}
                onChange={(v) => updateTemperature(Number(v.toFixed(2)))}
              />
              <span
                className="text-[12px] shrink-0"
                style={{ width: 34, textAlign: 'right', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}
              >
                {temperature.toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border)' }}>
          <Row
            title="显示字数统计条"
            desc="在工作区底部常驻显示当前章节与全书进度"
            control={
              <Switch
                checked={config.settings.showWordCountBar}
                onChange={(v) => void patchSettingsSafe({ showWordCountBar: v })}
              />
            }
          />
        </div>

        <div style={{ borderTop: '1px solid var(--border)' }}>
          <Row
            title="新手引导"
            desc="不确定各项功能在哪？可以重新看一遍引导"
            control={
              <Button
                size="sm"
                onClick={() => {
                  void (async () => {
                    const ok = await patchSettingsSafe({ firstRunDone: false })
                    if (ok) toast('已重置，回到书架会重新显示新手引导', 'ok')
                  })()
                }}
              >
                <RotateCcw size={13} /> 重新观看新手引导
              </Button>
            }
          />
        </div>
      </div>
    </div>
  )
}