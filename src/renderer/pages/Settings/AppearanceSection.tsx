import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import type { Typography } from '@shared/types'
import { FONT_OPTIONS, VISUAL_THEMES } from '@shared/themes'
import { Select, Slider, Switch } from '../../components/ui'
import { useApp } from '../../store/app'
import { LoadingHint, PageHead, patchSettingsSafe, Row, useDebounced } from './common'

const SAMPLE_A =
  '雨停在半空，像有人把整座城按进了水里。她推开窗，檐下的风卷着纸墨味扑上来，远处钟楼敲了七下，声音被雾气吞掉一半。'
const SAMPLE_B =
  '他把稿纸摊平，用指腹压住翘起的边角。写下的第一行被划掉了，第二行也是。到第三行时，他终于肯承认：这个故事要从那年的雪开始讲。'

export function AppearanceSection(): ReactNode {
  const config = useApp((s) => s.config)

  // 拖滑块时本地即时生效，停顿后再落盘
  const [typo, updateTypo] = useDebounced<Typography>(config?.settings.typography, (v) => {
    void patchSettingsSafe({ typography: v })
  })

  if (!config || !typo) return <LoadingHint />

  const fontValue = FONT_OPTIONS.some((f) => f.value === typo.fontFamily) ? typo.fontFamily : '__custom__'

  function patch(p: Partial<Typography>): void {
    if (!typo) return
    updateTypo({ ...typo, ...p })
  }

  return (
    <div>
      <PageHead title="外观与排版" desc="主题只管界面色，排版只管正文。改动会立刻作用到编辑器与下方预览。" />

      {/* ── 主题 ── */}
      <div className="card p-4 mb-4">
        <div className="text-[13px] font-medium mb-3">界面主题</div>
        <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
          {VISUAL_THEMES.map((t) => {
            const active = config.settings.themeId === t.id
            return (
              <button
                key={t.id}
                onClick={() => void patchSettingsSafe({ themeId: t.id })}
                className="text-left rounded-lg p-1.5"
                style={{
                  background: 'var(--panel)',
                  border: active ? '2px solid var(--accent)' : '1px solid var(--border)',
                  cursor: 'default'
                }}
              >
                <div className="flex rounded-md overflow-hidden" style={{ height: 40 }}>
                  {t.swatch.map((color, i) => (
                    <div key={`${t.id}-${i}`} style={{ background: color, flex: 1 }} />
                  ))}
                </div>
                <div className="px-0.5 pt-1.5 pb-0.5">
                  <div className="flex items-center gap-1 text-[12.5px] font-medium">
                    {t.name}
                    {active && <Check size={12} style={{ color: 'var(--accent)' }} />}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                    {t.hint}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* ── 排版 ── */}
      <div className="card p-4 mb-4">
        <div className="text-[13px] font-medium mb-3">正文排版</div>
        <div className="grid gap-x-8 gap-y-4" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="text-[12.5px] mb-1">字体</div>
            <Select
              value={fontValue}
              onChange={(e) => {
                const f = FONT_OPTIONS.find((x) => x.value === e.target.value)
                if (f) patch({ fontFamily: f.value })
              }}
            >
              {fontValue === '__custom__' && <option value="__custom__">自定义（{typo.fontFamily.slice(0, 24)}…）</option>}
              {FONT_OPTIONS.map((f) => (
                <option key={f.id} value={f.value}>
                  {f.name}
                </option>
              ))}
            </Select>
          </div>

          <SliderField
            label="字号"
            display={`${typo.fontSize} px`}
            value={typo.fontSize}
            min={13}
            max={24}
            step={1}
            onChange={(v) => patch({ fontSize: v })}
          />
          <SliderField
            label="行距"
            display={typo.lineHeight.toFixed(1)}
            value={typo.lineHeight}
            min={1.4}
            max={2.2}
            step={0.1}
            onChange={(v) => patch({ lineHeight: Number(v.toFixed(2)) })}
          />
          <SliderField
            label="页宽"
            display={`${typo.pageWidth} px`}
            value={typo.pageWidth}
            min={560}
            max={1100}
            step={20}
            onChange={(v) => patch({ pageWidth: v })}
          />
          <SliderField
            label="段间距"
            display={`${typo.paragraphSpacing.toFixed(1)} em`}
            value={typo.paragraphSpacing}
            min={0.2}
            max={1.5}
            step={0.1}
            onChange={(v) => patch({ paragraphSpacing: Number(v.toFixed(2)) })}
          />

          <Row title="首行缩进" desc="中文正文的常规做法：每段空两格" control={<Switch checked={typo.indent} onChange={(v) => patch({ indent: v })} />} />
          <Row
            title="聚焦段落变暗"
            desc="非当前段落降低不透明度，减少视觉干扰"
            control={<Switch checked={typo.dimUnfocused} onChange={(v) => patch({ dimUnfocused: v })} />}
          />
        </div>
      </div>

      {/* ── 预览 ── */}
      <div className="card p-5" style={{ background: 'var(--panel-2)' }}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-dim)' }}>
            实时预览
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {typo.fontSize}px / 行距 {typo.lineHeight.toFixed(1)} / 页宽 {typo.pageWidth}px
          </span>
        </div>
        <div
          style={{
            fontFamily: typo.fontFamily,
            fontSize: typo.fontSize,
            lineHeight: typo.lineHeight,
            color: 'var(--text)',
            maxWidth: typo.pageWidth,
            margin: '0 auto'
          }}
        >
          <p
            style={{
              margin: 0,
              marginBottom: `${typo.paragraphSpacing}em`,
              textIndent: typo.indent ? '2em' : 0,
              textAlign: 'justify',
              opacity: typo.dimUnfocused ? 0.42 : 1
            }}
          >
            {SAMPLE_A}
          </p>
          <p style={{ margin: 0, textIndent: typo.indent ? '2em' : 0, textAlign: 'justify' }}>{SAMPLE_B}</p>
        </div>
      </div>
    </div>
  )
}

function SliderField({
  label,
  display,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string
  display: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}): ReactNode {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12.5px]">{label}</span>
        <span className="text-[11.5px]" style={{ color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
          {display}
        </span>
      </div>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} />
    </div>
  )
}