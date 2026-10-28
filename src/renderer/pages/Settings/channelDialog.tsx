import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import type { Channel, ModelEntry, Protocol } from '@shared/types'
import { PROTOCOL_LABELS, PROVIDER_PRESETS } from '@shared/providers'
import { uid } from '@shared/utils'
import { mz } from '../../lib/bridge'
import { Button, Field, Input, Modal, Select, Spinner, Switch, Textarea } from '../../components/ui'
import { useApp } from '../../store/app'
import { ChannelModels } from './channelModels'
import { commitConfig, errMsg, MONO } from './common'
import { commitChannelAndModels } from './channelCommit'

/* ───────────────────────── 渠道编辑弹窗 ───────────────────────── */

/**
 * 新增 / 编辑渠道。渠道本身和它的模型列表在同一个弹窗里配完，点「保存」一次性落盘。
 *
 * 为什么模型要搬进来：模型是渠道的从属物，分开放会让人配完 Key 就走，
 * 结果渠道有了、模型为空，生成时又报「没有可用模型」。
 * 这里的模型增删改全是内存态（staged），取消即丢弃——不会在配置里留下半成品。
 */
export function ChannelDialog({
  open,
  channel,
  models,
  hasKey,
  onClose,
  onSaved
}: {
  open: boolean
  channel: Channel | null
  /** 该渠道当前的模型（新增时为 []） */
  models: ModelEntry[]
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
  const [stagedModels, setStagedModels] = useState<ModelEntry[]>([])
  /** 新建渠道时先定下 id：模型要挂 channelId，保存前不能是空串 */
  const [draftId, setDraftId] = useState('')
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
    setStagedModels(models.map((m) => ({ ...m })))
    setDraftId(channel?.id ?? uid('ch'))
    setError('')
    setBusy(false)
    // models 只在打开的那一刻取快照；保存后由父组件重新传入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, channel])

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId)
  const keyHint = preset?.keyHint && preset.keyHint !== '留空即可' ? preset.keyHint : '粘贴你的 API Key'
  const targetId = channel?.id ?? draftId

  /** 表单值拼出的渠道对象：给「拉取模型」用，也保证保存前后字段口径一致 */
  const draftChannel = useMemo(
    (): Channel => ({
      id: targetId,
      name: name.trim() || '未命名渠道',
      protocol,
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      enabled,
      presetId
    }),
    [targetId, name, protocol, baseUrl, enabled, presetId]
  )

  function applyPreset(id: string): void {
    setPresetId(id)
    const p = PROVIDER_PRESETS.find((x) => x.id === id)
    if (!p || p.id === 'custom') {
      setError('')
      return
    }
    // 预设负责把名称 / 协议 / 地址 / 常用模型一次性填好，用户仍可逐项改
    setName(p.name)
    setProtocol(p.protocol)
    setBaseUrl(p.baseUrl)
    setStagedModels((list) => {
      const have = new Set(list.map((m) => m.model))
      const additions = p.models
        .filter((m) => !have.has(m))
        .map((m): ModelEntry => ({ id: uid('m'), channelId: targetId, model: m, label: m, enabled: true }))
      return [...list, ...additions]
    })
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

    const id = targetId
    const next: Channel = {
      id,
      name: name.trim(),
      protocol,
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      headers,
      enabled,
      presetId
    }
    const nextModels = stagedModels.map((m) => ({ ...m, channelId: id }))

    setBusy(true)
    setError('')
    try {
      // 渠道与它的整套模型一次提交（纯函数，见 channelCommit.ts）
      const ok = await commitConfig((c) => commitChannelAndModels(c, next, nextModels))
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
      else if (nextModels.length === 0) toast('渠道已保存，但还没有可用模型；可以再点「编辑」补上', 'info')
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
      width={720}
      footer={
        <>
          <Button onClick={onClose} type="button">
            取消
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={busy} type="button">
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
                type="button"
                onClick={() => {
                  const url = preset.keyUrl
                  if (!url) return
                  void mz.app.openExternal(url).catch((e: unknown) => toast(`打开链接失败：${errMsg(e)}`, 'error'))
                }}
              >
                去申请 Key <ExternalLink size={12} />
              </Button>
            )}
          </div>
        </Field>

        <Field
          hint={
            hasKey || apiKey.trim()
              ? '可以直接填模型 ID，也可以从接口拉取。停用的模型不会出现在任务分配里。'
              : '配好 Key 后可以点「从接口拉取」自动获取模型；也可以手填一个模型 ID。'
          }
        >
          <ChannelModels channel={draftChannel} models={stagedModels} apiKey={apiKey} onChange={setStagedModels} />
        </Field>

        <Field
          label="额外请求头（可选）"
          hint='JSON 对象，例如 {"HTTP-Referer": "https://myapp.com", "X-Title": "墨舟"}；留空即不发送额外头。'
        >
          <Textarea
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            rows={2}
            placeholder='{"HTTP-Referer": "https://myapp.com"}'
            spellCheck={false}
            style={{ fontFamily: MONO, fontSize: 12 }}
          />
        </Field>

        <div className="flex items-center justify-between pt-1">
          <div className="text-[12.5px]">启用该渠道</div>
          <Switch checked={enabled} onChange={setEnabled} />
        </div>

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