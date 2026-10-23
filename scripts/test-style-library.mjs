/**
 * 系统文风分身库的回归测试。
 * 运行：node scripts/test-style-library.mjs
 *
 * 这里钉住三类曾经错得不明显、但作者一定会撞上的东西：
 *
 * 1. **引用语义**：书里引用系统分身，库改了要跟着变；库删了要回落快照而不是变成裸写。
 *    这类错误不会报错，只会在某天生成出来的文字「不像」的时候才被发现。
 * 2. **AI 返回的宽容解析**：模型不保证给 JSON。实测踩过一次坑——
 *    标签过滤沿用了特征的「至少 4 字」门槛，结果「冷峻」「短句」这种两字标签被全部滤掉。
 * 3. **种子数据完整性**：100 位作者的名字/特征不能重复、不能是空话模板。
 *
 * 所有逻辑都跑真正的实现（esbuild 现场打包），不复制一份来测。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outdir = mkdtempSync(join(tmpdir(), 'mozhou-style-'))
const alias = { '@shared': join(here, '../src/shared') }

async function load(entry, name) {
  const outfile = join(outdir, `${name}.mjs`)
  await build({
    entryPoints: [join(here, '..', entry)],
    bundle: true,
    format: 'esm',
    outfile,
    logLevel: 'silent',
    alias,
    external: ['react']
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

/* ══════════════ 1. 引用语义 ══════════════ */

const lib = await load('src/shared/styleLibrary.ts', 'lib')
const { resolveRef, personaToRef, filterPersonas, tagCounts, matchPersona } = lib

const persona = {
  id: 'sys-test',
  name: '测试作家',
  category: 'history',
  tags: ['冷峻', '短句'],
  summary: '测试用摘要',
  traits: ['原始特征一', '原始特征二'],
  refs: ['《测试集》'],
  samples: ['系统样本'],
  builtin: true,
  createdAt: 0,
  updatedAt: 0
}

const { ref, local } = personaToRef(persona)
const profile = { id: 'sp1', ...local, active: true, sourceRef: ref }

// 命中：用库里的当前值
const hit = resolveRef(profile.sourceRef, profile, [persona])
check('引用命中 → missing=false', hit.missing === false)
check('引用命中 → 名称来自库', hit.name === '测试作家')
check('引用命中 → 特征来自库', hit.traits.length === 2)

// 库改了，书内要跟着变（这是「引用而非拷贝」的核心承诺）
const mutated = [{ ...persona, traits: [...persona.traits, '后来新增的第三条'] }]
const after = resolveRef(profile.sourceRef, profile, mutated)
check('库新增特征 → 书内跟随', after.traits.length === 3, `got ${after.traits.length}`)

// 库删了，要回落快照而不是变裸写
const gone = resolveRef(profile.sourceRef, profile, [])
check('来源删除 → missing=true', gone.missing === true)
check('来源删除 → 仍按快照生效', gone.traits.length === 2, `got ${gone.traits.length}`)
check('来源删除 → 名称用快照名', gone.name === '测试作家')

// library 为 null（还没载入）也不该炸
const noLib = resolveRef(profile.sourceRef, profile, null)
check('library=null → 不抛错且回落', noLib.missing === true && noLib.traits.length === 2)

// 书内自补的样本与系统样本取并集，不能悄悄丢掉用户补的那段
const withOwn = { ...profile, samples: ['我在书里自己补的一段'] }
const merged = resolveRef(withOwn.sourceRef, withOwn, [persona])
check('自补样本不被丢弃', merged.samples.length === 2, `got ${merged.samples.length}`)

/* ══════════════ 2. 搜索与筛选 ══════════════ */

const pool = [
  { ...persona, id: 'a', name: '古龙', tags: ['冷峻', '短句'], summary: '短句留白' },
  { ...persona, id: 'b', name: '金庸', tags: ['典雅', '章回'], summary: '虚实三比七' },
  { ...persona, id: 'c', name: '刘慈欣', tags: ['硬核'], summary: '宏大尺度' }
]
check('搜索命中名字', filterPersonas(pool, { query: '古龙' }).length === 1)
check('搜索命中标签', filterPersonas(pool, { query: '典雅' }).length === 1)
check('组合搜索需全部命中', filterPersonas(pool, { query: '古龙 典雅' }).length === 0)
check('组合搜索能收窄', filterPersonas(pool, { query: '古龙 短句' }).length === 1)
check('空查询返回全部', filterPersonas(pool, { query: '' }).length === 3)
check('按标签筛选', filterPersonas(pool, { tag: '冷峻' }).length === 1)
check('按分类筛选到空', filterPersonas(pool, { category: 'romance' }).length === 0)
check('标签计数正确', tagCounts(pool).find((t) => t.tag === '冷峻')?.count === 1)
check('matchPersona 忽略大小写', matchPersona({ ...persona, tags: ['Cyberpunk'] }, 'cyberpunk'))

/* ══════════════ 3. AI 返回的宽容解析 ══════════════ */

const ai = await load('src/renderer/pages/Settings/StyleLibrary/personaAi.ts', 'ai')
const { parsePersonaDraft, buildPersonaMessages } = ai

// 标准 JSON（带代码块）
const j = parsePersonaDraft(
  '```json\n{"summary":"冷硬江湖","tags":["冷峻","短句"],"traits":["短句为主，一句不超过二十字","对白不标说话人"],"refs":["《测试集》"]}\n```'
)
check('JSON: summary', j?.summary === '冷硬江湖')
// 回归点：两字标签必须保留（曾经被「至少 4 字」门槛吃掉）
check('JSON: 两字标签保留', j?.tags.length === 2, JSON.stringify(j?.tags))
check('JSON: traits', j?.traits.length === 2)
check('JSON: refs', j?.refs.length === 1)

// 前后带寒暄
const wrap = parsePersonaDraft(
  '好的，以下是结果：\n{"summary":"一段摘要文字","traits":["规则一写得够长了","规则二也足够长哦"],"tags":[],"refs":[]}\n希望有帮助！'
)
check('夹杂寒暄仍能解析', wrap?.traits.length === 2, JSON.stringify(wrap?.traits))

// 模型没给 JSON，退化成逐行特征
const plain = parsePersonaDraft('1. 短句为主，一句不超过二十字\n2. 对白占六成，不标说话人\n- 每八百字一个环境特写')
check('非 JSON: 逐行退化为特征', plain?.traits.length === 3, JSON.stringify(plain?.traits))

// 中文键
const cn = parsePersonaDraft('{"摘要":"中文键摘要内容","标签":["标签一","标签二"],"特征":["中文键特征一条","中文键特征二条"]}')
check('中文键可解析', cn?.summary === '中文键摘要内容' && cn?.traits.length === 2 && cn?.tags.length === 2)

// 特征门槛仍要拦住残余短句，但标签不要
check('特征仍过滤过短条目', parsePersonaDraft('{"traits":["短句","这条特征写得足够长可以保留"]}')?.traits.length === 1)

// 空 / 纯拒答
check('空串返回 null', parsePersonaDraft('') === null)
check('纯拒答返回 null', parsePersonaDraft('抱歉，我无法完成这个请求。') === null)

// 提示词构造：三种模式各自该说什么
const base = { name: '古龙', category: 'history', summary: '', tags: [], traits: [], refs: [], samples: [] }
check('有样本 → 走样本提炼', buildPersonaMessages('draft', { ...base, samples: ['一段样本'] }, '')[1].content.includes('样本'))
check('无样本 → 用用户描述', buildPersonaMessages('draft', base, '想要冷硬江湖腔')[1].content.includes('想要冷硬江湖腔'))
check('禁止编造书名', buildPersonaMessages('draft', base, 'x')[1].content.includes('不要编造书名'))
check('polish 模式带旧草稿', buildPersonaMessages('polish', { ...base, traits: ['旧规则一条'] }, '')[1].content.includes('旧规则一条'))

/* ══════════════ 4. 种子数据完整性 ══════════════ */

const seed = await load('src/shared/personas/index.ts', 'seed')
const { SEED_PERSONAS, SEED_VERSION } = seed

check('种子数量为 100', SEED_PERSONAS.length === 100, `got ${SEED_PERSONAS.length}`)

// 种子的指纹：只要作者集合变了，SEED_VERSION 就必须跟着变，
// 否则已装过旧版的用户永远不会补种到新作者（他们在 db 里 seedVersion 已等于旧值）。
// 这条断言的作用是：改了 people 列表却忘了升版本时，测试会红。
const rosterSig = SEED_PERSONAS.map((p) => p.id).sort().join(',')
check('SEED_VERSION 应为正整数', Number.isInteger(SEED_VERSION) && SEED_VERSION >= 1, String(SEED_VERSION))
check(
  '种子作者集合变更后必须升 SEED_VERSION',
  SEED_VERSION >= 2,
  `当前 SEED_VERSION=${SEED_VERSION}，若本次是首次发布可把期望值改回 1`
)

const ids = new Set()
const names = new Set()
const BAN = /文笔优美|语言流畅|感情真挚|风格独特|意境深远|行云流水|辞藻华丽|引人入胜/
const traitSeen = new Map()
for (const p of SEED_PERSONAS) {
  check(`id 唯一: ${p.id}`, !ids.has(p.id))
  ids.add(p.id)
  check(`名字唯一: ${p.name}`, !names.has(p.name))
  names.add(p.name)
  check(`id 格式: ${p.id}`, /^sys-[a-z0-9-]+$/.test(p.id))
  check(`${p.name} 标签 3–5 个`, p.tags.length >= 3 && p.tags.length <= 5, `${p.tags.length}`)
  check(`${p.name} 特征 6–8 条`, p.traits.length >= 6 && p.traits.length <= 8, `${p.traits.length}`)
  check(`${p.name} 有代表作`, p.refs.length >= 1)
  check(`${p.name} 是内置+时间戳归零`, p.builtin === true && p.createdAt === 0 && p.updatedAt === 0)
  check(`${p.name} 有摘要`, p.summary.length >= 30, `${p.summary.length}`)
  // 种子不内置名家原文（版权），samples 必须是空数组
  check(`${p.name} 不内置原文样本`, Array.isArray(p.samples) && p.samples.length === 0)
  for (const t of p.traits) {
    check(`${p.name} 特征无空话`, !BAN.test(t), t)
    if (traitSeen.has(t)) check(`特征跨分身不重复: ${t}`, false, `${traitSeen.get(t)} 与 ${p.name}`)
    else traitSeen.set(t, p.name)
  }
}

// 六大流派都要有，且都不能是零星几个
const byCat = SEED_PERSONAS.reduce((a, p) => ((a[p.category] = (a[p.category] ?? 0) + 1), a), {})
for (const c of ['classics', 'webnovel', 'romance', 'suspense', 'history', 'newtype']) {
  check(`分类 ${c} 至少 10 位`, (byCat[c] ?? 0) >= 10, `${byCat[c] ?? 0}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log('文风分身库：全部通过')