import { useEffect, useState, type ReactNode } from 'react'
import { Check, Plus, Trash2 } from 'lucide-react'
import type { SearchChannel } from '@shared/types'
import { SEARCH_PRESETS, canReuseModelKey, isDeepSeekEndpoint, normalizeSearchChannel } from '@shared/webSearch'
import { mz } from '../../lib/bridge'
import { Button, Input, Modal, Switch } from '../../components/ui'
import { useApp } from '../../store/app'
import { commitConfig, MONO, PageHead, Row } from './common'

/**
 * 联网搜索。
 *
 * 与「渠道与模型」是平级但独立的一套：模型渠道服务于生成，搜索源只服务于
 * 对话里的「查资料」。两件事的计费方式、失败方式、可用性都不同，
 * 合在一张卡片里会让作者以为「配了模型就能联网」。
 */
export function SearchSection(): ReactNode {
  const config = useApp((s) => s.config)
  const toast = useApp((s) => s.toast)
  const ws = config?.settings.webSearch
  const channels = config?.searchChannels ?? []

  // 三种状态：'own' 自己存了 Key、'reuse' 可复用 DeepSeek 模型渠道的 Key、'none' 还没有
  const [keyState, setKeyState] = useState<Record<string, 'own' | 'reuse' | 'none'>>({})
  // isNew 只影响弹窗标题：normalizeSearchChannel 一定会生成 id，光看 id 分不出新增还是编辑
  const [editing, setEditing] = useState<{ ch: SearchChannel; isNew: boolean } | null>(null)
  const idsKey = channels.map((c) => c.id).join('|')

  useEffect(() => {
    let alive = true
    void (async () => {
      const cfg = useApp.getState().config
      const list = cfg?.searchChannels ?? []
      // DeepSeek 的搜索接口与 chat 接口共用同一个 Key（主进程侧确实会复用），
      // 所以这里只要模型渠道有 Key，搜索源就显示「复用」而不是「未配置」
      const dsDonor = (cfg?.channels ?? []).find((c) => c.enabled !== false && isDeepSeekEndpoint(c.baseUrl))
      const donorHasKey = dsDonor ? await mz.config.secretHas(`channel:${dsDonor.id}`).catch(() => false) : false
      const pairs = await Promise.all(
        list.map(async (c): Promise<[string, 'own' | 'reuse' | 'none']> => {
          if (c.auth === 'none') return [c.id, 'own']
          try {
            if (await mz.config.secretHas(`search:${c.id}`)) return [c.id, 'own']
          } catch {
            /* 钥匙串读不到就当没有 */
          }
          return [c.id, canReuseModelKey(c) && donorHasKey ? 'reuse' : 'none']
        })
      )
      if (alive) setKeyState(Object.fromEntries(pairs))
    })()
    return () => {
      alive = false
    }
  }, [idsKey])

  if (!config || !ws) return null

  const patchSearch = (patch: Partial<typeof ws>): void => {
    void commitConfig((c) => ({ ...c, settings: { ...c.settings, webSearch: { ...c.settings.webSearch, ...patch } } }))
  }

  const remove = async (ch: SearchChannel): Promise<void> => {
    if (ch.auth !== 'none') await mz.config.secretClear(`search:${ch.id}`).catch(() => {})
    const ok = await commitConfig((c) => ({
      ...c,
      searchChannels: (c.searchChannels ?? []).filter((x) => x.id !== ch.id),
      settings: {
        ...c.settings,
        webSearch: { ...c.settings.webSearch, channelId: c.settings.webSearch.channelId === ch.id ? null : c.settings.webSearch.channelId }
      }
    }))
    if (ok) toast('搜索源已删除', 'ok')
  }

  const save = async (ch: SearchChannel, key: string): Promise<void> => {
    if (ch.auth !== 'none' && key.trim()) await mz.config.secretSet(`search:${ch.id}`, key.trim())
    const ok = await commitConfig((c) => {
      const exists = (c.searchChannels ?? []).some((x) => x.id === ch.id)
      const list = exists ? (c.searchChannels ?? []).map((x) => (x.id === ch.id ? ch : x)) : [...(c.searchChannels ?? []), ch]
      return {
        ...c,
        searchChannels: list,
        // 第一个搜索源自动设为默认，省掉「配好了却还得再点一次」的困惑
        settings: {
          ...c.settings,
          webSearch: { ...c.settings.webSearch, channelId: c.settings.webSearch.channelId ?? ch.id }
        }
      }
    })
    if (ok) {
      setEditing(null)
      toast('搜索源已保存', 'ok')
    }
  }

  return (
    <div>
      <PageHead
        title="联网搜索"
        desc="AI 对话里的「联网」按钮从这里取数。事实类问题（史料、工艺、参数）建议开着；虚构体系不用查——搜到的都是别人小说里的设定。"
      />

      <div className="card px-4 py-2 mb-4">
        <Row
          title="启用联网搜索"
          desc="关掉后对话界面不再出现「联网」按钮，一切与从前一致"
          control={<Switch checked={ws.enabled} onChange={(v) => patchSearch({ enabled: v })} />}
        />
      </div>

      <div className="card px-4 py-3 mb-4">
        <div className="text-[12.5px] font-medium mb-1">搜索源</div>
        {channels.length === 0 ? (
          <div className="text-[11.5px] leading-relaxed py-2" style={{ color: 'var(--text-faint)' }}>
            还没有搜索源。推荐「博查 Bocha」：国内可直连，中文史料与工艺类结果质量最好。
            也可以用智谱、Tavily、Serper，或填一个自建 SearXNG 实例。
          </div>
        ) : (
          <div className="flex flex-col">
            {channels.map((c) => {
              const active = ws.channelId === c.id
              return (
                <div key={c.id} className="flex items-center gap-2 py-2" style={{ borderTop: '1px solid var(--border)' }}>
                  <button
                    className="chip surface-hover shrink-0"
                    style={{ height: 20, color: active ? 'var(--ok)' : 'var(--text-faint)' }}
                    title={active ? '这就是默认搜索源' : '设为默认搜索源'}
                    onClick={() => patchSearch({ channelId: active ? null : c.id })}
                  >
                    {active ? <Check size={11} /> : null}
                    {active ? '默认' : '设为默认'}
                  </button>
                  <span className="text-[12.5px] min-w-0 truncate">{c.name}</span>
                  <span className="text-[10.5px] shrink-0" style={{ color: 'var(--text-faint)', fontFamily: MONO }}>
                    {c.presetId}
                  </span>
                  <span
                    className="ml-auto text-[10.5px] shrink-0"
                    style={{ color: keyState[c.id] === 'none' ? 'var(--text-faint)' : 'var(--ok)' }}
                    title={
                      keyState[c.id] === 'reuse'
                        ? '复用「渠道与模型」里 DeepSeek 渠道的 Key，不用再填一次'
                        : undefined
                    }
                  >
                    {c.auth === 'none'
                      ? '无需 Key'
                      : keyState[c.id] === 'own'
                        ? '已配置 Key'
                        : keyState[c.id] === 'reuse'
                          ? '复用模型 Key'
                          : '未配置 Key'}
                  </span>
                  <button className="chip surface-hover shrink-0" style={{ height: 20 }} onClick={() => setEditing({ ch: c, isNew: false })}>
                    编辑
                  </button>
                  <button
                    className="chip surface-hover shrink-0"
                    style={{ height: 20, color: 'var(--danger, #B91C1C)' }}
                    title="删除这个搜索源"
                    onClick={() => void remove(c)}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        <div className="mt-2">
          <Button
            size="sm"
            onClick={() => setEditing({ ch: normalizeSearchChannel({ name: SEARCH_PRESETS[0].name, presetId: SEARCH_PRESETS[0].id }), isNew: true })}
          >
            <Plus size={12} /> 新增搜索源
          </Button>
        </div>
      </div>

      <div className="card px-4 py-2">
        <Row
          title="每次检索条数"
          desc="3–8 条。条数越多提示词越占预算，5 条通常够用"
          control={
            <Input
              type="number"
              min={3}
              max={8}
              value={ws.maxResults}
              style={{ width: 72 }}
              onChange={(e) => patchSearch({ maxResults: Number(e.target.value) })}
            />
          }
        />
        <Row
          title="每次最多几条查询"
          desc="1–3 条。作者一次问了两件事时才会真的发两条"
          control={
            <Input
              type="number"
              min={1}
              max={3}
              value={ws.maxQueries}
              style={{ width: 72 }}
              onChange={(e) => patchSearch({ maxQueries: Number(e.target.value) })}
            />
          }
        />
        <Row
          title="缓存有效期（小时）"
          desc="同一件事重复问不会重复计费；0 = 不缓存"
          control={
            <Input
              type="number"
              min={0}
              max={168}
              value={ws.cacheTtlHours}
              style={{ width: 72 }}
              onChange={(e) => patchSearch({ cacheTtlHours: Number(e.target.value) })}
            />
          }
        />
        <Row
          title="先压缩再注入"
          desc="用当前对话模型把检索结果压成要点，省上下文；关掉则直接塞原始摘要"
          control={<Switch checked={ws.summarize} onChange={(v) => patchSearch({ summarize: v })} />}
        />
      </div>

      {editing && (
        <SearchDialog
          channel={editing.ch}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  )
}

/** 新增/编辑搜索源。key 只在保存时进 keytar，不进 config.json */
function SearchDialog({
  channel,
  isNew,
  onClose,
  onSave
}: {
  channel: SearchChannel
  isNew: boolean
  onClose: () => void
  onSave: (ch: SearchChannel, key: string) => Promise<void>
}): ReactNode {
  const [draft, setDraft] = useState<SearchChannel>(channel)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const preset = SEARCH_PRESETS.find((p) => p.id === draft.presetId)

  const pickPreset = (id: string): void => {
    const p = SEARCH_PRESETS.find((x) => x.id === id)
    setDraft((d) => ({
      ...d,
      presetId: id as SearchChannel['presetId'],
      name: p?.id === d.presetId ? d.name : (p?.name ?? d.name),
      baseUrl: p?.baseUrl ?? d.baseUrl,
      auth: p?.auth ?? d.auth,
      authParam: p?.authParam
    }))
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? '新增搜索源' : '编辑搜索源'}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={saving || !draft.baseUrl.trim()}
            onClick={async () => {
              setSaving(true)
              try {
                await onSave(draft, key)
              } finally {
                setSaving(false)
              }
            }}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="text-[12px]">
          服务商
          <select
            className="input mt-1 w-full"
            value={draft.presetId}
            onChange={(e) => pickPreset(e.target.value)}
          >
            {SEARCH_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {preset?.note && (
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {preset.note}
            </div>
          )}
        </label>

        <label className="text-[12px]">
          名称
          <Input className="mt-1 w-full" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>

        <label className="text-[12px]">
          接口地址
          <Input
            className="mt-1 w-full"
            style={{ fontFamily: MONO }}
            placeholder={preset?.baseUrl || 'https://…'}
            value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          />
        </label>

        {draft.auth !== 'none' && (
          <label className="text-[12px]">
            API Key
            <Input
              className="mt-1 w-full"
              style={{ fontFamily: MONO }}
              type="password"
              placeholder={preset?.keyHint ?? '填服务商给的 Key'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              只存在本机钥匙串里，不会写进 config.json，也不会传给任何模型。
            </div>
            {draft.presetId === 'deepseek' && (
              <div className="mt-1 text-[11px]" style={{ color: 'var(--ok)' }}>
                留空即可：会自动复用「渠道与模型」里 DeepSeek 渠道的同一个 Key。
              </div>
            )}
          </label>
        )}
      </div>
    </Modal>
  )
}