import { useEffect, useState, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import type { Channel, ModelEntry, Protocol } from '@shared/types'
import { PROTOCOL_LABELS, PROVIDER_PRESETS } from '@shared/providers'
import { uid } from '@shared/utils'
import { mz } from '../../lib/bridge'
import { Button, Field, Input, Modal, Select, Spinner, Switch, Textarea } from '../../components/ui'
import { useApp } from '../../store/app'
import { commitConfig, errMsg, MONO } from './common'

/* ───────────────────────── 渠道编辑弹窗 ───────────────────────── */

export function ChannelDialog({
  open,
  channel,
  hasKey,
  onClose,
  onSaved
}: {
  open: boolean
  channel: Channel | null
  /** 该渠道是否已保存 Key（false = 未配置） */
  hasKey: boolean
  onClose: () => void
  onSaved: (saved: Channel, keyWritten: boolean) => void
}): ReactNode {
  const toast = useApp((s) => s.toast)

  const [name, setName] = useState('')
  const [protocol, setProtocol] = useState<Protocol>('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [presetId, setPresetId] = useState('custom')
  const [presetModels, setPresetModels] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 每次打开时用渠道当前值重置表单
  useEffect(() => {
    if (!open) return
    setName(channel?.name ?? '')
    setProtocol(channel?.protocol ?? 'openai')
    setBaseUrl(channel?.baseUrl ?? '')
    setApiKey('')
    setHeadersText(channel?.headers && Object.keys(channel.headers).length > 0 ? JSON.stringify(channel.headers, null, 2) : '')
    setEnabled(channel?.enabled ?? true)
    setPresetId(channel?.presetId ?? 'custom')
    setPresetModels([])
    setError('')
    setBusy(false)
  }, [open, channel])

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId)
  const keyHint = preset?.keyHint && preset.keyHint !== '留空即可' ? preset.keyHint : '粘贴你的 API Key'

  function applyPreset(id: string): void {
    setPresetId(id)
    const p = PROVIDER_PRESETS.find((x) => x.id === id)
    if (!p || p.id === 'custom') {
      setPresetModels([])
      return
    }
    // 预设负责把名称 / 协议 / 地址 / 常用模型一次性填好，用户仍可逐项改
    setName(p.name)
    setProtocol(p.protocol)
    setBaseUrl(p.baseUrl)
    setPresetModels(p.models)
    setError('')
  }

  async function handleSave(): Promise<void> {
    if (busy) return
    if (!name.trim()) {
      setError('请填写渠道名称')
      return
    }
    if (!baseUrl.trim()) {
      setError('请填写 BaseURL，例如 https://api.deepseek.com/v1')
      return
    }

    // headers 必须是「字符串键 → 字符串值」的对象
    let headers: Record<string, string> | undefined
    if (headersText.trim()) {
      let parsed: unknown
      try {
        parsed = JSON.parse(headersText)
      } catch {
        setError('额外 headers 不是合法的 JSON，请检查括号与引号（可直接留空）')
        return
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setError('额外 headers 必须是 JSON 对象，例如 {"HTTP-Referer": "https://example.com"}')
        return
      }
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          setError(`header「${k}」的值必须是字符串`)
          return
        }
        out[k] = v
      }
      headers = Object.keys(out).length > 0 ? out : undefined
    }

    const id = channel?.id ?? uid('ch')
    const next: Channel = {
      id,
      name: name.trim(),
      protocol,
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      headers,
      enabled,
      presetId
    }

    setBusy(true)
    setError('')
    try {
      const ok = await commitConfig((c) => {
        const exists = c.channels.some((x) => x.id === id)
        const channels = exists ? c.channels.map((x) => (x.id === id ? next : x)) : [...c.channels, next]
        // 预设自带的常用模型：保存时并入模型表（按 model 字段去重）
        const have = new Set(c.models.filter((m) => m.channelId === id).map((m) => m.model))
        const additions = presetModels
          .filter((m) => !have.has(m))
          .map((m): ModelEntry => ({ id: uid('m'), channelId: id, model: m, label: m, enabled: true }))
        return { ...c, channels, models: additions.length > 0 ? [...c.models, ...additions] : c.models }
      })
      if (!ok) return

      // Key 留空 = 不修改；只有填写了才写入系统钥匙串
      let keyWritten = false
      const key = apiKey.trim()
      if (key) {
        try {
          await mz.config.secretSet(`channel:${id}`, key)
          keyWritten = true
        } catch (e) {
          toast(`渠道已保存，但 Key 写入失败：${errMsg(e)}`, 'error')
        }
      }
      onSaved(next, keyWritten)
      if (!key && !hasKey) toast('渠道已保存。别忘了填入 API Key 才能使用', 'info')
      else toast(channel ? '渠道已更新' : '渠道已添加', 'ok')
      onClose()
    } catch (e) {
      setError(`保存失败：${errMsg(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={channel ? `编辑渠道 · ${channel.name}` : '新增渠道'}
      width={680}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={busy}>
            {busy ? <Spinner size={12} /> : null} 保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="服务商预设" hint="选择预设会自动填好协议、接口地址与常用模型；也可以选「自定义渠道」手动填写。">
          <Select value={presetId} onChange={(e) => applyPreset(e.target.value)}>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.note ? ` · ${p.note}` : ''}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 200px' }}>
          <Field label="渠道名称">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 我的 DeepSeek" />
          </Field>
          <Field label="协议">
            <Select value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol)}>
              {(Object.keys(PROTOCOL_LABELS) as Protocol[]).map((p) => (
                <option key={p} value={p}>
                  {PROTOCOL_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="BaseURL"
          hint={
            protocol === 'anthropic'
              ? 'Anthropic 可填 https://api.anthropic.com（会自动补 /v1/messages），也可直接写到 /v1 结尾。'
              : protocol === 'gemini'
                ? '留空则使用 https://generativelanguage.googleapis.com/v1beta'
                : 'OpenAI 兼容接口通常以 /v1 结尾，例如 https://api.deepseek.com/v1'
          }
        >
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            style={{ fontFamily: MONO, fontSize: 12.5 }}
          />
        </Field>

        <Field
          hint={
            hasKey
              ? '已保存 Key：留空则不修改，填写则覆盖。Key 存放在本机钥匙串，不会写入配置文件。'
              : 'Key 只保存在本机钥匙串，不会上传到任何服务器。'
          }
          label="API Key"
        >
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? '••••••••（留空 = 不修改）' : keyHint}
              autoComplete="new-password"
              spellCheck={false}
            />
            {preset?.keyUrl && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const url = preset.keyUrl
                  if (!url) return
                  void mz.app
                    .openExternal(url)
                    .catch((e: unknown) => toast(`打开链接失败：${errMsg(e)}`, 'error'))
                }}
              >
                去申请 Key <ExternalLink size={12} />
              </Button>
            )}
          </div>
        </Field>

        <Field
          label="额外请求头（可选）"
          hint='JSON 对象，例如 {"HTTP-Referer": "https://myapp.com", "X-Title": "墨舟"}；留空即不发送额外头。'
        >
          <Textarea
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            rows={3}
            placeholder='{"HTTP-Referer": "https://myapp.com"}'
            spellCheck={false}
            style={{ fontFamily: MONO, fontSize: 12 }}
          />
        </Field>

        <div className="flex items-center justify-between pt-1">
          <div className="text-[12.5px]">启用该渠道</div>
          <Switch checked={enabled} onChange={setEnabled} />
        </div>

        {presetModels.length > 0 && (
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            保存后会带入预设模型：{presetModels.join('、')}
          </div>
        )}

        {error && (
          <div
            className="text-[12px] leading-relaxed rounded-md px-3 py-2"
            style={{ color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }}
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  )
}
