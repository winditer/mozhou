#!/usr/bin/env node
/**
 * 截图/验收脚本：把应用以指定数据目录启动，可选执行一段 JS 切换视图，然后截图退出。
 *
 *   node scripts/shot.cjs <out.png> [js] [--delay=2600] [--wait=1400]
 *
 * 环境变量 MOZHOU_SHOT_WIDTH=<px> 可在截图前把窗口宽度改掉，
 * 用来复现窄窗口下的布局问题（每行元素争宽度之类，宽窗口下往往看不出来）。
 *
 * 例：
 *   node scripts/shot.cjs shots/ws.png "__MZ.openProject('p_demo')"
 *   MOZHOU_SHOT_WIDTH=1080 node scripts/shot.cjs shots/narrow.png "__MZ.openProject('p_demo')"
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const args = process.argv.slice(2)
const out = path.resolve(args[0] || 'shots/shot.png')
const js = args[1] || ''
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=')[1] : d
}
fs.mkdirSync(path.dirname(out), { recursive: true })

const root = process.cwd()
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.HOME = path.join(root, '.home')
env.MOZHOU_USER_DATA = env.MOZHOU_USER_DATA || path.join(root, '.testdata')
env.MOZHOU_SHOT = out
env.MOZHOU_SHOT_DELAY = opt('delay', '2600')
env.MOZHOU_SHOT_JS = js
env.MOZHOU_SHOT_JS_WAIT = opt('wait', '1400')

const bin = path.join(root, 'node_modules', '.bin', 'electron')
const child = spawn(bin, ['out/main/index.js', '--no-sandbox', '--disable-gpu'], {
  env,
  stdio: ['ignore', 'ignore', 'inherit']
})
const timer = setTimeout(() => child.kill('SIGTERM'), Number(opt('timeout', '40000')))
child.on('exit', () => {
  clearTimeout(timer)
  console.log(fs.existsSync(out) ? `ok ${out}` : `missing ${out}`)
  process.exit(fs.existsSync(out) ? 0 : 1)
})