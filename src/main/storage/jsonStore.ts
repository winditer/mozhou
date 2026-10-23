import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 原子写：先写临时文件，再 rename 覆盖；覆盖前保留一份 .bak */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const dir = dirname(file)
  await ensureDir(dir)
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}.json`)
  const text = JSON.stringify(data, null, 2)
  await fs.writeFile(tmp, text, 'utf8')
  if (await exists(file)) {
    try {
      await fs.copyFile(file, `${file}.bak`)
    } catch {
      /* 备份失败不阻塞主流程 */
    }
  }
  await fs.rename(tmp, file)
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(file, 'utf8')
    if (!text.trim()) return fallback
    return JSON.parse(text) as T
  } catch {
    // 主文件损坏时尝试 .bak
    try {
      const bak = await fs.readFile(`${file}.bak`, 'utf8')
      return JSON.parse(bak) as T
    } catch {
      return fallback
    }
  }
}

export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

export async function writeText(file: string, text: string): Promise<void> {
  await ensureDir(dirname(file))
  await fs.writeFile(file, text, 'utf8')
}