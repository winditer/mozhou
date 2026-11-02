/**
 * 搜索接口该用哪把 Key。
 *
 * 单独一个纯函数文件，是为了能在 node 里断言「谁会被当成 DeepSeek 渠道」——
 * 这段逻辑一旦猜错，就是把 A 家的 key 当 B 家的 token 发出去，
 * 而这种事在界面上完全看不出来（只显示「已配置」）。
 */
import type { Channel } from '@shared/types'
import { isDeepSeekEndpoint } from '@shared/webSearch'

/**
 * 找一个能出借 Key 的 DeepSeek 模型渠道。
 *
 * 只认 hostname 恰好是 api.deepseek.com 或其子域：作者自己填的第三方中转
 * （例如 `api.xxx.com/v1` 转发 DeepSeek 模型）不走这条，因为中转的 Key
 * 未必能调 DeepSeek 官方的搜索接口，猜错就是拿别人的 token 去撞 401。
 */
export function deepSeekDonor(channels: Channel[]): Channel | null {
  return channels.find((c) => c.enabled !== false && isDeepSeekEndpoint(c.baseUrl)) ?? null
}