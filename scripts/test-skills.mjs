/**
 * 技法卡（CraftSkill）的回归测试。
 * 运行：node scripts/test-skills.mjs
 *
 * 钉住的四类事，每一类都对应一个「会静默出错、作者却查不出来」的坑：
 *
 * 一、**过滤**：不适配的卡绝不能注入。网红长篇的卡被勾着进了论文，
 *    作者只会觉得「AI 写得怪」，不会想到是技法卡越界。
 * 二、**截断**：超过字数上限要按顺序砍尾部，并且**必须回报砍了谁**。
 *    静默截断＝作者在面板上看着「已注入 5 张」，提示词里其实只有 2 张。
 * 三、**顺序**：必须等于作者勾选顺序。自动排序会让同一组勾选产出不同结果，
 *    模型表现一抖，作者会以为是模型坏了。
 * 四、**零回归**：没传技法库 / 全部裁剪掉时，渲染结果必须是空串——
 *    这样引入技法卡之前的任何调用方（试写页、一键开书前四步、测试）行为完全不变。
 *
 * 直接打包真正的实现来测，不复制一份逻辑——测另一份实现在这里毫无意义。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const outdir = mkdtempSync(join(tmpdir(), 'mozhou-skills-'))

async function load(entry, name) {
  const outfile = join(outdir, name)
  await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile, logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

const skills = await load(join(here, '../src/shared/skills.ts'), 'skills.mjs')
const seeds = await load(join(here, '../src/shared/skillSeeds.ts'), 'seeds.mjs')
const aiTone = await load(join(here, '../src/shared/aiTone.ts'), 'aitone.mjs')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
  } else {
    fail++
    console.error(`✗ ${name}`)
    if (extra !== undefined) console.error('  ', typeof extra === 'string' ? extra : JSON.stringify(extra))
  }
}

function makeLib(list) {
  return { version: 1, seedVersion: 1, skills: list }
}

function fakeSkill(over) {
  return {
    id: 'fake',
    name: '假卡',
    group: 'quality',
    tagline: '测试用',
    whenToUse: '测试',
    rules: '一、这是规则。',
    version: 1,
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

/* ───────────────────── 一、条件过滤 ───────────────────── */

const ctxNovel = { sceneId: 'long-novel', genreId: 'xuanhuan', targetWords: 2500 }
const ctxAcademic = { sceneId: 'academic', genreId: 'xianshi', targetWords: 4000 }

const infoTiming = seeds.SEED_SKILLS.find((s) => s.id === 'info-timing')
const toneFree = seeds.SEED_SKILLS.find((s) => s.id === 'ai-tone-free')

check('种子卡齐全', seeds.SEED_SKILLS.length === 2, seeds.SEED_SKILLS.map((s) => s.id))
check('信息节奏适配长篇', skills.skillApplicable(infoTiming, ctxNovel))
check('信息节奏不适配论文', !skills.skillApplicable(infoTiming, ctxAcademic))
check('去机器腔适配一切场景', skills.skillApplicable(toneFree, ctxAcademic) && skills.skillApplicable(toneFree, ctxNovel))

// 篇幅门槛：短篇目标字数低于 800 时不该出现
check('低于篇幅门槛即不适配', !skills.skillApplicable(infoTiming, { ...ctxNovel, targetWords: 500 }))
check('达到门槛即适配', skills.skillApplicable(infoTiming, { ...ctxNovel, targetWords: 800 }))

// 退役卡不出现
const retired = fakeSkill({ id: 'old', deprecated: { since: '1.4.0', reason: '被新卡取代' } })
check('退役卡不适配', !skills.skillApplicable(retired, ctxNovel))
check('退役卡原因带说明', skills.skillInapplicableReason(retired, ctxNovel).includes('退役'))

/* ───────────────────── 二、解析与截断 ───────────────────── */

const lib2 = makeLib([toneFree, infoTiming])

{
  const r = skills.resolveSkills(['ai-tone-free'], lib2, ctxNovel)
  check('单卡解析成功', r.applied.length === 1 && r.applied[0].id === 'ai-tone-free')
  check('单卡有正文', r.text.includes('去机器腔'))
  check('单卡 chars > 0', r.chars > 0)
}

{
  // 不适配的卡勾了也不注入，且要进 missing 让界面提示
  const r = skills.resolveSkills(['info-timing'], lib2, ctxAcademic)
  check('不适配卡不注入', r.applied.length === 0)
  check('不适配卡进 missing', r.missing.includes('info-timing'))
  check('不适配时文本为空串', r.text === '')
}

{
  // 不存在的 id 进 missing，不影响其它卡
  const r = skills.resolveSkills(['ghost', 'ai-tone-free'], lib2, ctxNovel)
  check('未知 id 进 missing', r.missing.includes('ghost'))
  check('未知 id 不挡住好卡', r.applied.length === 1)
}

{
  // 顺序必须等于勾选顺序
  const a = skills.resolveSkills(['ai-tone-free', 'info-timing'], lib2, ctxNovel)
  const b = skills.resolveSkills(['info-timing', 'ai-tone-free'], lib2, ctxNovel)
  check('顺序随勾选变化', a.applied[0].id !== b.applied[0].id)
  check('顺序 a 正确', a.applied.map((s) => s.id).join() === 'ai-tone-free,info-timing')
  check('顺序 b 正确', b.applied.map((s) => s.id).join() === 'info-timing,ai-tone-free')
}

{
  // 截断：给一个很小的上限，第一张进、第二张被砍
  const r = skills.resolveSkills(['ai-tone-free', 'info-timing'], lib2, ctxNovel, 60)
  check('超限时至少保留一张', r.applied.length === 1)
  check('被砍的进 trimmed', r.trimmed.length === 1 && r.trimmed[0].id === 'info-timing')
  check('截断后文本只含保留的卡', !r.text.includes('信息释放节奏'))
}

{
  // 上限比单张卡还小时，仍要保留第一张——否则作者勾了等于什么都没发生
  const r = skills.resolveSkills(['ai-tone-free'], lib2, ctxNovel, 1)
  check('极小上限仍保留首张', r.applied.length === 1)
}

{
  // 空输入
  check('undefined 返回空', skills.resolveSkills(undefined, lib2, ctxNovel).text === '')
  check('空数组返回空', skills.resolveSkills([], lib2, ctxNovel).text === '')
  check('空库返回空', skills.resolveSkills(['ai-tone-free'], null, ctxNovel).text === '')
  check('空库时 id 全进 missing', skills.resolveSkills(['ai-tone-free'], null, ctxNovel).missing.length === 1)
}

/* ───────────────────── 三、默认上限下的实际占用 ───────────────────── */

{
  const r = skills.resolveSkills(['ai-tone-free', 'info-timing'], lib2, ctxNovel)
  check('两张内置卡在默认上限内', r.applied.length === 2, `占用 ${r.chars} / 上限 ${skills.SKILL_TOTAL_CHAR_LIMIT}`)
  check('占用未超上限', r.chars <= skills.SKILL_TOTAL_CHAR_LIMIT, `${r.chars}`)
  // 上限存在的意义是别比场景提示词还显眼：长篇场景提示词 615 字，技法块不该翻倍压过它
  check('技法块小于场景提示词两倍', r.chars < 615 * 2, `${r.chars}`)
}

/* ───────────────────── 四、零回归 ───────────────────── */

{
  const r = skills.resolveSkills([], lib2, ctxNovel)
  check('未勾选时渲染为空串（零回归）', r.text === '' && r.chars === 0)
}

/* ───────────────────── 五、对话轻量版 ───────────────────── */

{
  const chat = skills.renderSkillsForChat(['ai-tone-free'], lib2, ctxNovel)
  check('对话版非空', chat.length > 0)
  check('对话版含卡名', chat.includes('去机器腔'))
  check('对话版不含完整规则', !chat.includes('段末禁止升华'))
  check('对话版空勾选为空串', skills.renderSkillsForChat([], lib2, ctxNovel) === '')
}

/* ───────────────────── 六、版本提示 ───────────────────── */

{
  const bumped = skills.skillVersionNotice(['ai-tone-free'], { 'ai-tone-free': 0 }, lib2)
  check('版本落后时给提示', bumped.includes('去机器腔'))
  const same = skills.skillVersionNotice(['ai-tone-free'], { 'ai-tone-free': 1 }, lib2)
  check('版本一致不提示', same === '')
  const none = skills.skillVersionNotice(['ai-tone-free'], undefined, lib2)
  check('无记录不提示', none === '')
  const snap = skills.snapshotSkillVersions(['ai-tone-free', 'ghost'], lib2)
  check('快照只收存在的卡', Object.keys(snap).join() === 'ai-tone-free')
}

/* ───────────────────── 七、AI 味规则单一来源 ───────────────────── */

{
  // 生成期提示必须包含六条禁令本体，否则「生成时避开」和「体检时改掉」就是两套标准
  check('生成提示含禁令本体', aiTone.DE_AI_GENERATE_HINT.includes(aiTone.DE_AI_RULES))
  check('改写指令含禁令本体', aiTone.DE_AI_INSTRUCTION.includes(aiTone.DE_AI_RULES))
  check('六条禁令齐全', aiTone.DE_AI_RULES.split('\n').filter((l) => l.startsWith('- ')).length === 6)
  // 生成期是软偏好：措辞必须是「尽量」而非「必须/严禁」，否则模型会把句子写僵
  check('生成期是软偏好措辞', aiTone.DE_AI_GENERATE_HINT.includes('尽量'))
  check('生成期不是硬禁令', !aiTone.DE_AI_GENERATE_HINT.includes('严禁'))
  // 改写指令必须保留原来的开头与结尾，改写链路的手感不能变
  check('改写指令开头未变', aiTone.DE_AI_INSTRUCTION.startsWith('改写选中文字，去掉机器味。'))
  check('改写指令结尾未变', aiTone.DE_AI_INSTRUCTION.endsWith('保持原意与情节信息，只输出改写后的正文，不要任何说明或前后对比。'))
}

/* ───────────────────── 八、种子卡自身质量 ───────────────────── */

{
  for (const s of seeds.SEED_SKILLS) {
    check(`[${s.id}] 有 whenToUse`, Boolean(s.whenToUse.trim()))
    check(`[${s.id}] 有 tagline`, Boolean(s.tagline.trim()))
    check(`[${s.id}] 有规则正文`, s.rules.trim().length > 40)
    check(`[${s.id}] 有反例`, Array.isArray(s.antiPatterns) && s.antiPatterns.length > 0)
    check(`[${s.id}] 有版本号`, typeof s.version === 'number' && s.version >= 1)
    check(`[${s.id}] 有 changelog`, Array.isArray(s.changelog) && s.changelog.length > 0)
    check(`[${s.id}] 是内置卡`, s.builtin === true)
    check(`[${s.id}] 反例都非空`, (s.antiPatterns ?? []).every((x) => x.trim().length > 0))
  }
  // id 不能重复：重复会让 Map 静默取后者，作者改第一张不生效
  const ids = seeds.SEED_SKILLS.map((s) => s.id)
  check('种子 id 唯一', new Set(ids).size === ids.length, ids.join())
  // 种子版本号必须是个正整数，主进程据此判断补种
  check('种子版本为正整数', Number.isInteger(seeds.SKILL_SEED_VERSION) && seeds.SKILL_SEED_VERSION > 0)
}

/* ───────────────────── 结果 ───────────────────── */

console.log(`\n${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)