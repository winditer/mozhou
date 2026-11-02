import { promises as fs } from 'node:fs'
import { safeStorage } from 'electron'
import type { Channel, Config, ModelEntry, SearchChannel } from '@shared/types'
import { configFile, secretsFile } from '../paths'
import { readJson, writeJsonAtomic } from './jsonStore'
import { DEFAULT_SETTINGS, mergeSettings, normalizeConventions } from './mergeSettings'
import { normalizeSearchChannel } from '@shared/webSearch'

/** 默认设置定义在 mergeSettings.ts（纯模块，便于单测），这里转出去保持既有引用 */
export { DEFAULT_SETTINGS } from './mergeSettings'

export const DEFAULT_CONFIG: Config = {
  version: 1,
  channels: [],
  models: [],
  searchChannels: [],
  settings: DEFAULT_SETTINGS
}

export async function loadConfig(): Promise<Config> {
  const raw = await readJson<Partial<Config>>(configFile(), {})
  return {
    version: raw.version ?? 1,
    channels: (raw.channels ?? []).map(normalizeChannel),
    models: (raw.models ?? []).map(normalizeModel),
    searchChannels: (raw.searchChannels ?? []).map((c) => normalizeSearchChannel(c as Partial<SearchChannel>)),
    settings: mergeSettings(raw.settings)
  }
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
    searchChannels: (config.searchChannels ?? []).map((c) => normalizeSearchChannel(c)),
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