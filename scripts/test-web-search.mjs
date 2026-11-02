/**
 * 联网查资料的纯逻辑回归测试。
 * 运行：node scripts/test-web-search.mjs
 *
 * 要守住三件事：
 *   1. 默认值与夹取范围（配置坏了不能把请求打爆）；
 *   2. 各家响应格式的差异只允许存在 normalize 一处；
 *   3. 请求构造与错误分类不依赖网络，可在 node 里直测。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outdir = mkdtempSync(join(tmpdir(), 'mozhou-websearch-test-'))

async function load(entry, name) {
  const outfile = join(outdir, name + '.mjs')
  await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent',
    alias: { '@shared': join(root, 'src/shared') }
  })
  return import(pathToFileURL(outfile).href)
}

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

const web = await load('src/shared/webSearch.ts', 'webSearch')

console.log('默认值与夹取')
check('默认关闭', web.DEFAULT_WEB_SEARCH.enabled === false)
check('默认 maxResults=5', web.DEFAULT_WEB_SEARCH.maxResults === 5)
check('默认 maxQueries=2', web.DEFAULT_WEB_SEARCH.maxQueries === 2)
check('默认 ttl=24', web.DEFAULT_WEB_SEARCH.cacheTtlHours === 24)
check('默认汇总开', web.DEFAULT_WEB_SEARCH.summarize === true)

const wild = web.normalizeWebSearch({ maxResults: 99, maxQueries: 0, cacheTtlHours: -5 })
check('maxResults 夹到 8', wild.maxResults === 8, String(wild.maxResults))
check('maxQueries 夹到 1', wild.maxQueries === 1, String(wild.maxQueries))
check('ttl 夹到 0', wild.cacheTtlHours === 0, String(wild.cacheTtlHours))
check('残缺配置补全', web.normalizeWebSearch({}).enabled === false)

const ch = web.normalizeSearchChannel({ name: '', baseUrl: '  ' })
check('渠道名兜底', ch.name === '未命名搜索源', ch.name)
check('非预设渠道名兜底为 custom', ch.presetId === 'custom', String(ch.presetId))
check('预设渠道补 baseUrl', web.normalizeSearchChannel({ name: 'b', presetId: 'bocha' }).baseUrl.startsWith('https://'))

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)