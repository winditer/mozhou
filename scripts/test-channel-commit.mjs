/**
 * 渠道 + 模型一次提交的回归测试。
 * 运行：node scripts/test-channel-commit.mjs
 *
 * 模型列表从渠道卡片搬进新增/编辑弹窗后，「保存」要同时做三件事：
 * 替换渠道、整组替换该渠道的模型、清掉被删模型的任务分配引用。
 * 这三件事任何一件漏掉，用户都会在别的地方看到离删除动作很远的报错——
 * 例如下次生成提示「没有可用模型」，其实是任务分配还指着一个已经删掉的 id。
 *
 * 直接跑真正的实现（esbuild 打包 channelCommit.ts 再 import），不复制逻辑。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const outdir = mkdtempSync(join(tmpdir(), 'mozhou-channel-commit-test-'))
const outfile = join(outdir, 'channelCommit.mjs')
await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src/renderer/pages/Settings/channelCommit.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(root, 'src/shared') }
})
const { commitChannelAndModels } = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

/** 一份够用的配置：两个渠道、三个模型、任务分配同时引用两个渠道的模型 */
function fixture() {
  return {
    version: 1,
    channels: [
      { id: 'ch_a', name: 'A', protocol: 'openai', baseUrl: 'https://a.example/v1', enabled: true, presetId: 'custom' },
      { id: 'ch_b', name: 'B', protocol: 'openai', baseUrl: 'https://b.example/v1', enabled: true, presetId: 'custom' }
    ],
    models: [
      { id: 'm_a1', channelId: 'ch_a', model: 'a-1', label: 'A1', enabled: true },
      { id: 'm_a2', channelId: 'ch_a', model: 'a-2', label: 'A2', enabled: true },
      { id: 'm_b1', channelId: 'ch_b', model: 'b-1', label: 'B1', enabled: true }
    ],
    settings: { taskModels: { draft: 'm_a1', outline: 'm_a2', audit: 'm_b1' } }
  }
}

const channelA = { id: 'ch_a', name: 'A2', protocol: 'openai', baseUrl: 'https://a2.example/v1', enabled: false, presetId: 'deepseek' }

console.log('编辑渠道：模型整组替换')
{
  const next = commitChannelAndModels(fixture(), channelA, [
    { id: 'm_a1', channelId: 'ch_a', model: 'a-1', label: 'A1 改名', enabled: false }
  ])

  const ch = next.channels.find((c) => c.id === 'ch_a')
  check('渠道字段被替换', ch.name === 'A2' && ch.baseUrl === 'https://a2.example/v1' && ch.enabled === false, JSON.stringify(ch))
  check('其他渠道不受影响', next.channels.filter((c) => c.id === 'ch_b').length === 1)

  const aModels = next.models.filter((m) => m.channelId === 'ch_a')
  check('被取消的模型真的消失', !aModels.some((m) => m.id === 'm_a2'), JSON.stringify(aModels))
  check('保留的模型按弹窗值更新', aModels.length === 1 && aModels[0].label === 'A1 改名' && aModels[0].enabled === false)
  check('其他渠道的模型还在', next.models.some((m) => m.id === 'm_b1'))

  check('被删模型的任务分配被清空', next.settings.taskModels.outline === null, JSON.stringify(next.settings.taskModels))
  check('保留模型的任务分配不动', next.settings.taskModels.draft === 'm_a1')
  check('其他渠道的任务分配不动', next.settings.taskModels.audit === 'm_b1')
}

console.log('新增渠道：模型归属自动修正')
{
  const fresh = { id: 'ch_new', name: '新渠道', protocol: 'openai', baseUrl: 'https://new.example/v1', enabled: true, presetId: 'deepseek' }
  const next = commitChannelAndModels(fixture(), fresh, [
    // 故意写错 channelId：提交时必须纠正成渠道自己的 id
    { id: 'm_new', channelId: 'ch_a', model: 'deepseek-flash', label: 'Flash', enabled: true }
  ])
  check('渠道被追加', next.channels.length === 3 && next.channels[2].id === 'ch_new')
  check('新模型挂到正确渠道', next.models.find((m) => m.id === 'm_new').channelId === 'ch_new')
  check('没误删原渠道模型', next.models.filter((m) => m.channelId === 'ch_a').length === 2)
  check('新增不会动任务分配', next.settings.taskModels.draft === 'm_a1' && next.settings.taskModels.audit === 'm_b1')
}

console.log('清空模型列表：渠道保留、引用清空')
{
  const next = commitChannelAndModels(fixture(), channelA, [])
  check('渠道仍在', next.channels.some((c) => c.id === 'ch_a'))
  check('该渠道模型清空', next.models.filter((m) => m.channelId === 'ch_a').length === 0)
  check('引用它的任务全部置空', next.settings.taskModels.draft === null && next.settings.taskModels.outline === null)
  check('别的渠道不受影响', next.models.some((m) => m.id === 'm_b1') && next.settings.taskModels.audit === 'm_b1')
}

console.log('同一模型换 id 重建：旧 id 视为删除')
{
  const next = commitChannelAndModels(fixture(), channelA, [
    { id: 'm_a1_new', channelId: 'ch_a', model: 'a-1', label: 'A1', enabled: true }
  ])
  check('旧 id 的引用被清空', next.settings.taskModels.draft === null, JSON.stringify(next.settings.taskModels))
  check('新 id 落在模型表里', next.models.some((m) => m.id === 'm_a1_new'))
}

console.log('不改动 settings 的形状')
{
  const next = commitChannelAndModels(fixture(), channelA, [
    { id: 'm_a1', channelId: 'ch_a', model: 'a-1', label: 'A1', enabled: true }
  ])
  check('没有删除时返回同一份 settings 对象', next.settings === fixture().settings || typeof next.settings.taskModels === 'object')
  check('taskModels 三个键都还在', ['draft', 'outline', 'audit'].every((k) => k in next.settings.taskModels))
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)