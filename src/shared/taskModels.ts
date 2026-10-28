import type { AppSettings, TaskKind } from './types'

/**
 * 模型被删掉后，把指向它的任务分配置空，避免留下悬空 id。
 *
 * 任务分配保存的是 ModelEntry.id；删了模型不清理，下次生成会拿一个不存在的 id
 * 去找渠道，最终报出「没有可用模型」这种离删除动作很远的错误。
 *
 * 渠道删除、弹窗里移除单个模型两条路径都走这里，口径必须一致。
 * 纯函数：只依赖类型，主进程与渲染进程都能用，也便于单测。
 */
export function clearTaskRefs(settings: AppSettings, removed: Set<string>): AppSettings {
  let changed = false
  const taskModels = { ...settings.taskModels }
  for (const key of Object.keys(taskModels) as TaskKind[]) {
    const id = taskModels[key]
    if (id && removed.has(id)) {
      taskModels[key] = null
      changed = true
    }
  }
  return changed ? { ...settings, taskModels } : settings
}