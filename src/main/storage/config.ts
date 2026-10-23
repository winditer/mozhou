import { promises as fs } from 'node:fs'
import { safeStorage } from 'electron'
import type { AppSettings, Channel, Config, ModelEntry } from '@shared/types'
import { configFile, secretsFile } from '../paths'
import { readJson, writeJsonAtomic } from './jsonStore'

export const DEFAULT_SETTINGS: AppSettings = {
  themeId: 'paper',
  typography: {
    fontFamily: '"Songti SC", "STSong", "Noto Serif SC", Georgia, serif',
    fontSize: 17,
    lineHeight: 1.9,
    pageWidth: 760,
    indent: true,
    paragraphSpacing: 0.6,
    dimUnfocused: false
  },
  typewriter: false,
  focusMode: false,
  shelfCoverSize: 'm',
  dailyGoal: 3000,
  taskModels: {
    draft: null,
    outline: null,
    polish: null,
    naming: null,
    summary: null,
    audit: null,
    chat: null
  },
  lastProjectId: null,
  temperature: 0.85,
  firstRunDone: false,
  showWordCountBar: true,
  // 空表 = 全部沿用 genres.ts 的内置公约；作者在设置里改过谁就出现谁
  genreConventions: {}
}

export const DEFAULT_CONFIG: Config = {
  version: 1,
  channels: [],
  models: [],
  settings: DEFAULT_SETTINGS
}

export async function loadConfig(): Promise<Config> {
  const raw = await readJson<Partial<Config>>(configFile(), {})
  return {
    version: raw.version ?? 1,
    channels: (raw.channels ?? []).map(normalizeChannel),
    models: (raw.models ?? []).map(normalizeModel),
    settings: {
      ...DEFAULT_SETTINGS,
      ...(raw.settings ?? {}),
      shelfCoverSize: normalizeCoverSize(raw.settings?.shelfCoverSize),
      typography: { ...DEFAULT_SETTINGS.typography, ...(raw.settings?.typography ?? {}) },
      taskModels: { ...DEFAULT_SETTINGS.taskModels, ...(raw.settings?.taskModels ?? {}) },
      genreConventions: normalizeConventions(raw.settings?.genreConventions)
    }
  }
}

/**
 * 题材公约覆盖表是用户手写正文，落盘前必须洗一遍：
 * 丢掉空值 / 非字符串（空值等于「恢复默认」，存着只会让解析逻辑多绕一步），
 * 顺手去首尾空白，避免「改了两个空格」也算覆盖、在设置页里显示成已自定义。
 */
function normalizeConventions(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') continue
    const text = val.trim()
    if (text) out[k] = text
  }
  return out
}

/** 老配置里可能存着已下线的 'sl' 档位，统一落到新的最小档 's' */
function normalizeCoverSize(v: unknown): 's' | 'm' | 'l' {
  if (v === 'l' || v === 'm' || v === 's') return v
  return v === 'sl' ? 's' : 'm'
}

function normalizeChannel(c: Channel): Channel {
  return {
    id: c.id,
    name: c.name ?? '未命名渠道',
    protocol: c.protocol ?? 'openai',
    baseUrl: c.baseUrl ?? '',
    headers: c.headers ?? {},
    enabled: c.enabled !== false,
    presetId: c.presetId,
    models: c.models ?? [],
    note: c.note
  }
}

function normalizeModel(m: ModelEntry): ModelEntry {
  return {
    id: m.id,
    channelId: m.channelId,
    model: m.model ?? '',
    label: m.label || m.model || '未命名模型',
    contextWindow: m.contextWindow,
    priceIn: m.priceIn,
    priceOut: m.priceOut,
    enabled: m.enabled !== false
  }
}

export async function saveConfig(config: Config): Promise<Config> {
  const next: Config = {
    version: 1,
    channels: (config.channels ?? []).map(normalizeChannel),
    models: (config.models ?? []).map(normalizeModel),
    settings: {
      ...DEFAULT_SETTINGS,
      ...config.settings,
      // 保存时也洗一遍：设置页删空某条公约＝删掉这个键，不能留空串占位
      genreConventions: normalizeConventions(config.settings?.genreConventions)
    }
  }
  await writeJsonAtomic(configFile(), next)
  return next
}

/* ───────────────────────── 密钥：safeStorage 加密落盘 ───────────────────────── */

type SecretBag = Record<string, { v: string; enc: boolean }>

/**
 * 钥匙串可用性探测。
 * macOS 上 `isEncryptionAvailable()` 在应用未签名 / 钥匙串被锁时可能同步阻塞，
 * 因此：只探测一次并缓存；MOZHOU_NO_KEYCHAIN=1 可强制跳过（便携模式 / 无头环境）。
 */
let encAvailableCache: boolean | null = null

function keychainDisabled(): boolean {
  return process.env['MOZHOU_NO_KEYCHAIN'] === '1'
}

function encryptionAvailable(): boolean {
  if (keychainDisabled()) return false
  if (encAvailableCache !== null) return encAvailableCache
  try {
    encAvailableCache = safeStorage.isEncryptionAvailable()
  } catch {
    encAvailableCache = false
  }
  return encAvailableCache
}

async function readSecrets(): Promise<SecretBag> {
  return readJson<SecretBag>(secretsFile(), {})
}

export async function setSecret(ref: string, value: string): Promise<boolean> {
  const bag = await readSecrets()
  if (!value) {
    delete bag[ref]
    await writeJsonAtomic(secretsFile(), bag)
    return true
  }
  let enc = false
  let v = value
  if (encryptionAvailable()) {
    try {
      v = safeStorage.encryptString(value).toString('base64')
      enc = true
    } catch {
      enc = false
    }
  }
  bag[ref] = { v: enc ? v : Buffer.from(value, 'utf8').toString('base64'), enc }
  await writeJsonAtomic(secretsFile(), bag)
  return enc
}

export async function getSecret(ref: string): Promise<string> {
  const bag = await readSecrets()
  const item = bag[ref]
  if (!item) return ''
  try {
    if (item.enc && !keychainDisabled()) {
      return safeStorage.decryptString(Buffer.from(item.v, 'base64'))
    }
    return Buffer.from(item.v, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

export async function hasSecret(ref: string): Promise<boolean> {
  const bag = await readSecrets()
  return Boolean(bag[ref]?.v)
}

export async function clearSecret(ref: string): Promise<void> {
  const bag = await readSecrets()
  delete bag[ref]
  await writeJsonAtomic(secretsFile(), bag)
}

export async function secretsFileExists(): Promise<boolean> {
  try {
    await fs.access(secretsFile())
    return true
  } catch {
    return false
  }
}