import type { CraftSkill } from './skills'
import { DE_AI_GENERATE_HINT } from './aiTone'

/**
 * 内置技法卡种子。
 *
 * 设计立场（与产品确认过）：
 *
 * 一、**不重复场景 systemPrompt 已经说过的话**。12 个场景各自已经是一份完整的
 *    「正文规范」——长篇有黄金三章、单章节奏、章末钩子；小红书有 emoji 节制、
 *    第一人称；论文有 IMRaD。技法卡若把那些再讲一遍，system prompt 里就有两套
 *    规范并存，模型要么重复遵守要么折中，结果是两边都不像。
 *    所以内置卡只补**跨场景、且现有提示词没覆盖**的三块空洞：
 *      ① 生成期就去掉机器腔（现有禁令只针对体裁，没有一条针对 AI 自身腔调）
 *      ② 信息释放节奏（哪些信息现在还不能说——现有提示词只讲「要发生什么」）
 *      ③ 跨章手法状态（钩子/爽点轮换需要前几章的数据，systemPrompt 写不出这个）
 *
 * 二、**卡 C（跨章手法状态）暂不做**。它需要给 Chapter 存钩子类型等字段并迁移老数据，
 *    权衡后跳过。等真有人反馈「钩子重复了」再做，那时候才知道要存哪几个字段。
 *
 * 三、rename 与 id 一旦发布就不改。书内只存 id，改 id 等于把所有书的勾选静默清空。
 */

const NOW = 1750000000000

/** 卡 A：生成期去机器腔 */
const AI_TONE_FREE: CraftSkill = {
  id: 'ai-tone-free',
  name: '去机器腔',
  group: 'quality',
  tagline: '写的时候就别带 AI 腔，省掉生成后再洗一遍',
  whenToUse:
    '几乎永远该开。初稿自带机器味时，后面要靠「全书去 AI 味」逐段花钱改；写着的时候就避开，能省掉一整轮改写。',
  rules: DE_AI_GENERATE_HINT,
  antiPatterns: [
    '他放下手机，忽然意识到，这一切都变了。（动作后紧跟心理注解）',
    '她缓缓地、轻轻地推开门，仿佛怕惊扰了什么。（万能修饰词连用）',
    '她心里涌起一种复杂的情绪，像是失落，又像是不甘。（抽象名词代替具体画面）',
    '而这一切，才刚刚开始。（段末升华）',
    '“其实我早就知道了，”他说，“因为我是从北京来的。”（台词交代设定）'
  ],
  version: 1,
  changelog: [{ version: 1, note: '首次发布', at: NOW }],
  builtin: true,
  // 不设 sceneIds：AI 腔不是体裁问题，公文、论文、童话一样会被写虚
  createdAt: NOW,
  updatedAt: NOW
}

/** 卡 B：信息释放节奏 */
const INFO_TIMING: CraftSkill = {
  id: 'info-timing',
  name: '信息释放节奏',
  group: 'structure',
  tagline: '哪些信息现在不能说，比说了什么更要紧',
  whenToUse:
    '写章节正文时用，尤其是有伏笔、有反转、有谜面的故事。它管的是「藏」：把该留到后面揭的信息按住，而不是急着交代清楚。',
  rules: `动笔前先分清本章的三类信息，并分别处理：
一、**必须让读者知道的**：这一章不给，读者就看不懂当下的场景。这类直接写清，不要含糊其辞。
二、**必须让读者怀疑的**：给一个具体的异常信号（一个物件、一句反常的话、一个不合时宜的动作），但不解释它。信号要能被后文指认，不要写成「总觉得哪里不对」。
三、**这一章绝对不能说的**：人物动机的真相、幕后者的身份、伏笔的答案。绝不因为「怕读者不明白」就提前解释——读者不明白正是他读下去的理由。
每个场景最多释放一条新信息。一次交代两件事，读者的注意力会被分掉，两件都记不牢。
信息要由人物在处境里自然撞见，不要用旁白直接告诉读者。`,
  antiPatterns: [
    '本章结尾用一段旁白把前因后果解释清楚，不留悬念。',
    '一个场景里同时交代了主角身世、反派身份和世界观规则三件事。',
    '在读者还不知道「为什么」之前，先用一大段解释了「所以其实是这样」。'
  ],
  // 只给叙事类：论文/公文/小红书没有「藏信息」这回事，硬套会写得很别扭
  sceneIds: ['long-novel', 'short-story', 'fanfic', 'script'],
  minChapterWords: 800,
  version: 1,
  changelog: [{ version: 1, note: '首次发布', at: NOW }],
  builtin: true,
  createdAt: NOW,
  updatedAt: NOW
}

export const SEED_SKILLS: CraftSkill[] = [AI_TONE_FREE, INFO_TIMING]

/** 种子版本：增删内置卡或改结构时 +1，主进程据此决定是否补种 */
export const SKILL_SEED_VERSION = 1