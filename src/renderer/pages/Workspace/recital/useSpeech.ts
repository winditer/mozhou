import { useEffect, useState } from 'react'
import { SpeechPlayer, type SpeechState } from './tts'

export interface SpeechApi {
  state: SpeechState
  /** 换稿并归零（切章 / 换范围 / 重新生成时先 load，再 play） */
  load(text: string, key: string): void
  unload(): void
  play(from?: number): void
  pause(): void
  resume(): void
  stop(): void
  setRate(rate: number): void
  setVoice(index: number): void
}

/**
 * 把一个 SpeechPlayer 挂到 React 上。
 *
 * 为什么整页只留一个播放器实例：浏览器的 speechSynthesis 是**全局单例**，
 * 每张结果卡片各建一个，点两张卡就会出现两段声音排队、互相 cancel 的乱象。
 * 一个播放器 + state.key 记「现在是哪一章在念」，高亮只画给那一张卡。
 */
export function useSpeech(): SpeechApi {
  const [player] = useState(() => new SpeechPlayer())
  const [state, setState] = useState<SpeechState>(() => player.state())

  useEffect(() => {
    player.onChange = setState
    // 挂载后再取一次：构造时 getVoices() 常常还是空的，音色列表要等 voiceschanged
    setState(player.state())
    return () => {
      // 离开页面必须掐断：不许切走了还在后台念
      player.destroy()
    }
  }, [player])

  return {
    state,
    load: (text, key) => player.load(text, key),
    unload: () => player.unload(),
    play: (from) => player.play(from),
    pause: () => player.pause(),
    resume: () => player.resume(),
    stop: () => player.stop(),
    setRate: (rate) => player.setRate(rate),
    setVoice: (index) => player.setVoice(index)
  }
}