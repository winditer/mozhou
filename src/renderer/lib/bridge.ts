import type { MzApi } from '@shared/types'

const bridge = (globalThis as unknown as { mz?: MzApi }).mz

export const hasBridge = Boolean(bridge)

export const mz = bridge as MzApi

export function assertBridge(): void {
  if (!bridge) {
    throw new Error('未检测到桌面桥接层（window.mz）。请通过 Electron 客户端启动，而不是浏览器直接打开。')
  }
}