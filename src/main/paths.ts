import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * 开发/测试时可通过 MOZHOU_USER_DATA 指定数据目录，
 * 避免污染真实用户目录，也便于沙箱内验证。
 */
export function applyUserDataOverride(): string | null {
  const override = process.env.MOZHOU_USER_DATA
  if (override && override.trim()) {
    mkdirSync(override, { recursive: true })
    app.setPath('userData', override)
    app.setPath('sessionData', join(override, 'session'))
    return override
  }
  return null
}

export function dataRoot(): string {
  return app.getPath('userData')
}

export function projectDir(id: string): string {
  return join(dataRoot(), 'projects', id)
}

export function projectFile(id: string): string {
  return join(projectDir(id), 'project.json')
}

export function configFile(): string {
  return join(dataRoot(), 'config.json')
}

export function secretsFile(): string {
  return join(dataRoot(), 'secrets.json')
}

/** 系统文风分身库（全局共享，跨书引用） */
export function styleLibraryFile(): string {
  return join(dataRoot(), 'style-library.json')
}

/** 写作技法卡库（全局共享，书内只存 id 引用） */
export function skillLibraryFile(): string {
  return join(dataRoot(), 'skills.json')
}

export function backupDir(): string {
  return join(dataRoot(), 'backups')
}