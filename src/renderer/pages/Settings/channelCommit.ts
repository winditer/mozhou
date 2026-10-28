import type { Config, Channel, ModelEntry } from '@shared/types'
import { clearTaskRefs } from '@shared/taskModels'

/**
 * 把「弹窗里配好的渠道 + 它的整套模型」合并进配置（纯函数，便于单测）。
 *
 * 三条必须守住的规则：
 * 1. 模型按渠道整组替换：弹窗里的列表就是最终状态，取消掉的模型要真的消失；
 * 2. 被删掉的模型 id 要从任务分配里清掉，否则下次生成会拿悬空 id 发请求；
 * 3. 不碰别的渠道的模型，哪怕 id 看起来相似。
 */
export function commitChannelAndModels(config: Config, channel: Channel, staged: ModelEntry[]): Config {
  const id = channel.id
  const exists = config.channels.some((c) => c.id === id)
  const channels = exists ? config.channels.map((c) => (c.id === id ? channel : c)) : [...config.channels, channel]

  const nextModels = staged.map((m) => ({ ...m, channelId: id }))
  const keep = new Set(nextModels.map((m) => m.id))
  const removed = new Set(
    config.models
      .filter((m) => m.channelId === id && !keep.has(m.id))
      .map((m) => m.id)
  )

  return {
    ...config,
    channels,
    models: [...config.models.filter((m) => m.channelId !== id), ...nextModels],
    settings: clearTaskRefs(config.settings, removed)
  }
}