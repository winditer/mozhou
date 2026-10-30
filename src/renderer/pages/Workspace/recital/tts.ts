/**
 * 朗读用的纯逻辑与浏览器语音封装。
 *
 * 为什么切句要自己做：SpeechSynthesis 只认整段文本，丢一段两千字的稿子进去，
 * 一句话都高亮不了，用户不知道念到哪儿；而且「暂停」在某些系统上对长文本直接
 * 失效。切成短句逐句排队，既能高亮当前句，也能在切章时立刻掐断。
 */

/** 单句超过这个长度再按逗号切：太长的句子在部分系统上根本不出声 */
export const LONG_SENTENCE = 100

const HAS_WORD = /[\u3400-\u9FFF\u3040-\u30FFA-Za-z0-9]/
/** 只有标点或空白的「句子」不念（「……」单独成句时会让 TTS 卡一下） */
function hasSpeechContent(s: string): boolean {
  return HAS_WORD.test(s)
}

/** 句末切分：句号/问号/感叹号/分号/省略号/换行；连续的「……」当一处停顿，不拆成两句 */
const SENTENCE_SPLIT = /(?<=[。！？；\n])|(?<=…)(?!…)/

/** 逗号级再切：只在整句超过 LONG_SENTENCE 时才用 */
const CLAUSE_SPLIT = /(?<=[，、,])/

function hardSplit(s: string): string[] {
  if (s.length <= LONG_SENTENCE) return [s]
  const out: string[] = []
  for (let i = 0; i < s.length; i += LONG_SENTENCE) out.push(s.slice(i, i + LONG_SENTENCE))
  return out
}

function splitLongSentence(sentence: string): string[] {
  const t = sentence.trim()
  if (t.length <= LONG_SENTENCE) return [t]

  // 按逗号/顿号切成小段，再贪心拼回不超过上限的整块：既不念得太碎，也不超长
  const clauses = t.split(CLAUSE_SPLIT).filter((c) => c.trim())
  const out: string[] = []
  let buf = ''
  for (const c of clauses) {
    if (buf && buf.length + c.length > LONG_SENTENCE) {
      out.push(buf)
      buf = c
    } else {
      buf += c
    }
  }
  if (buf) out.push(buf)
  // 一段里一个逗号都没有（比如 200 字的无标点灌水）：只能硬切，否则整段念不出来
  return out.flatMap(hardSplit)
}

/**
 * 把评书稿切成逐句朗读的数组。
 * 纯函数、无副作用，测试直接跑。
 */
export function splitForSpeech(text: string): string[] {
  const src = (text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!src) return []
  return src
    .split(SENTENCE_SPLIT)
    .flatMap(splitLongSentence)
    .map((s) => s.trim())
    .filter(hasSpeechContent)
}

/* ───────────────────────── 播放器 ───────────────────────── */

export type SpeechMode = 'idle' | 'playing' | 'paused' | 'stalled' | 'ended'

export interface SpeechState {
  /** 系统没有可用中文语音：界面要置灰并给文案，而不是报错 */
  supported: boolean
  hint: string
  /** 当前念到第几句（0 基），-1 表示没在念 */
  index: number
  total: number
  mode: SpeechMode
  rate: number
  voiceIndex: number
  voices: { label: string; lang: string }[]
  /** 这份稿子属于哪一章：多章结果并排时靠它决定高亮显示在哪张卡片上 */
  key: string
}

export const TTS_UNSUPPORTED_HINT = '当前系统没有可用中文语音，可导出评书稿到别处朗读'

const INITIAL: SpeechState = {
  supported: false,
  hint: TTS_UNSUPPORTED_HINT,
  index: -1,
  total: 0,
  mode: 'idle',
  rate: 1,
  voiceIndex: 0,
  voices: [],
  key: ''
}

function synthOf(): SpeechSynthesis | null {
  if (typeof window === 'undefined') return null
  return window.speechSynthesis ?? null
}

export class SpeechPlayer {
  private synth: SpeechSynthesis | null = synthOf()
  private chunks: string[] = []
  private voices: SpeechSynthesisVoice[] = []
  private key = ''
  private index = -1
  private rate = 1
  private voiceIndex = 0
  private mode: SpeechMode = 'idle'
  /**
   * 每次播放自增。cancel 之后旧 utterance 的 onend 仍可能迟到，
   * 带上 token 就能把它们全部丢掉，不会出现「停了还在往下念下一句」。
   */
  private token = 0
  /** 状态回调由外部随时替换（React 的 setState 每次渲染都可能换引用） */
  onChange: (s: SpeechState) => void

  constructor(onChange: (s: SpeechState) => void = () => {}) {
    this.onChange = onChange
    if (this.synth) {
      // Chrome / Electron 的 getVoices() 首次调用常常是空数组，
      // 必须等 voiceschanged 才有真正的音色列表（否则会被误判成「不支持」）。
      this.synth.addEventListener?.('voiceschanged', this.reloadVoices)
      this.reloadVoices()
    }
  }

  private reloadVoices = (): void => {
    const all = this.synth?.getVoices?.() ?? []
    this.voices = all.filter((v) => (v.lang || '').toLowerCase().startsWith('zh'))
    if (this.voiceIndex >= this.voices.length) this.voiceIndex = 0
    this.emit()
  }

  private get supported(): boolean {
    return Boolean(this.synth) && this.voices.length > 0
  }

  state(): SpeechState {
    return {
      supported: this.supported,
      hint: this.supported ? '' : TTS_UNSUPPORTED_HINT,
      index: this.index,
      total: this.chunks.length,
      mode: this.mode,
      rate: this.rate,
      voiceIndex: this.voiceIndex,
      voices: this.voices.map((v) => ({ label: v.name, lang: v.lang })),
      key: this.key
    }
  }

  private emit(): void {
    this.onChange(this.state())
  }

  /** 换稿（切章 / 换章范围 / 重新生成）：先掐断，再重切句 */
  load(text: string, key = ''): void {
    this.cancel()
    this.chunks = splitForSpeech(text)
    this.key = key
    this.index = -1
    this.mode = 'idle'
    this.emit()
  }

  unload(): void {
    this.cancel()
    this.chunks = []
    this.key = ''
    this.index = -1
    this.mode = 'idle'
    this.emit()
  }

  setRate(rate: number): void {
    const next = Math.min(1.5, Math.max(0.7, Number.isFinite(rate) ? rate : 1))
    if (Math.abs(next - this.rate) < 0.001) return
    this.rate = next
    // 语速不能在念到一半时改：只能从当前句重来
    if (this.mode === 'playing' || this.mode === 'paused') this.play(this.index < 0 ? 0 : this.index)
    else this.emit()
  }

  setVoice(index: number): void {
    if (index === this.voiceIndex) return
    this.voiceIndex = Math.max(0, Math.min(this.voices.length - 1, index))
    if (this.mode === 'playing' || this.mode === 'paused') this.play(this.index < 0 ? 0 : this.index)
    else this.emit()
  }

  play(from = 0): void {
    if (!this.synth || !this.chunks.length) return
    const start = Math.max(0, Math.min(this.chunks.length - 1, from))
    const token = ++this.token
    try {
      this.synth.cancel()
    } catch {
      /* cancel 在已停止状态下个别系统会抛，忽略 */
    }
    this.index = start
    this.mode = 'playing'
    this.emit()

    const step = (k: number): void => {
      if (token !== this.token) return
      if (k >= this.chunks.length) {
        this.index = -1
        this.mode = 'ended'
        this.emit()
        return
      }
      const u = new SpeechSynthesisUtterance(this.chunks[k])
      u.rate = this.rate
      const voice = this.voices[this.voiceIndex]
      if (voice) {
        u.voice = voice
        u.lang = voice.lang
      } else {
        u.lang = 'zh-CN'
      }
      u.onstart = () => {
        if (token !== this.token) return
        this.index = k
        this.mode = 'playing'
        this.emit()
      }
      // 念完（或这句念不出来）都往下走一句：一句坏了不该让整篇卡死
      u.onend = () => {
        if (token !== this.token) return
        step(k + 1)
      }
      u.onerror = () => {
        if (token !== this.token) return
        step(k + 1)
      }
      this.synth!.speak(u)
    }
    step(start)
  }

  /**
   * 暂停。已知坑：部分系统上 pause() 会直接把队列停掉，speaking 立刻变 false，
   * 之后再 resume() 一点反应都没有——按钮成了死键。这里当场分诊：
   * 还在 speaking 才算真暂停，否则退化成「停在当前句」，由界面把按钮改成
   * 「从第 N 句重播」。
   */
  pause(): void {
    if (!this.synth) return
    try {
      this.synth.pause()
    } catch {
      /* 同上 */
    }
    if (!this.synth.speaking) {
      this.token++
      this.mode = 'stalled'
    } else {
      this.mode = 'paused'
    }
    this.emit()
  }

  resume(): void {
    if (!this.synth) return
    if (this.mode === 'paused') {
      this.synth.resume()
      this.mode = 'playing'
      this.emit()
      return
    }
    if (this.mode === 'stalled') this.play(this.index < 0 ? 0 : this.index)
  }

  stop(): void {
    this.cancel()
    this.index = -1
    this.mode = 'idle'
    this.emit()
  }

  /** 只掐断，不通知（load/destroy 里用，避免连续 emit） */
  private cancel(): void {
    this.token++
    try {
      this.synth?.cancel()
    } catch {
      /* 忽略 */
    }
  }

  destroy(): void {
    this.cancel()
    this.synth?.removeEventListener?.('voiceschanged', this.reloadVoices)
    this.synth = null
    this.chunks = []
    this.index = -1
    this.mode = 'idle'
  }
}