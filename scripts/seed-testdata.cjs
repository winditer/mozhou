/* 生成演示用测试数据（不进入产品包，仅用于本地验收） */
const fs = require('node:fs')
const path = require('node:path')

const root = process.argv[2] || path.join(process.cwd(), '.testdata')
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(path.join(root, 'projects'), { recursive: true })

const now = Date.now()

const config = {
  version: 1,
  channels: [
    {
      id: 'ch_deepseek',
      name: 'DeepSeek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      headers: {},
      enabled: true,
      presetId: 'deepseek',
      models: ['deepseek-chat'],
      note: ''
    },
    {
      id: 'ch_ollama',
      name: '本地 Ollama',
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
      headers: {},
      enabled: true,
      presetId: 'ollama',
      models: ['qwen3:14b'],
      note: ''
    }
  ],
  models: [
    { id: 'm_ds', channelId: 'ch_deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat', contextWindow: 64000, priceIn: 2, priceOut: 8, enabled: true },
    { id: 'm_ds_r', channelId: 'ch_deepseek', model: 'deepseek-reasoner', label: 'DeepSeek Reasoner', contextWindow: 64000, priceIn: 4, priceOut: 16, enabled: true },
    { id: 'm_ollama', channelId: 'ch_ollama', model: 'qwen3:14b', label: 'Qwen3 14B（本地）', contextWindow: 32000, enabled: true }
  ],
  settings: {
    themeId: 'paper',
    typography: {
      fontFamily: '"Songti SC", "STSong", "Noto Serif SC", Georgia, serif',
      fontSize: 17,
      lineHeight: 1.9,
      pageWidth: 760,
      indent: true,
      paragraphSpacing: 0.6,
      dimUnfocused: false
    },
    typewriter: false,
    focusMode: false,
    dailyGoal: 3000,
    taskModels: { draft: 'm_ds', outline: 'm_ds_r', polish: 'm_ds', naming: 'm_ds', summary: 'm_ds', audit: 'm_ds_r', chat: 'm_ds' },
    lastProjectId: 'p_demo',
    temperature: 0.85,
    firstRunDone: true,
    showWordCountBar: true
  }
}

const ch1 = `<h1>第 1 章 她把最后一封信烧了</h1><p>邮局的玻璃门在身后合拢，冷气一下子被关在外面。周砚秋把那只牛皮纸信封按在胸口，隔着两层布料还能感觉到纸角的硬度。</p><p>这是第七十三封。前七十二封她都寄出去了，寄到一个早已无人居住的地址，收件人写着父亲的名字。</p><p>她走到巷口的铁皮桶边，划了根火柴。火苗舔上纸角的瞬间，她忽然想起小时候父亲教她认星星的样子——他总是先指北斗，再讲别的。北斗在哪里，回家的路就在哪里，他说。</p><p>信封烧到一半时，她发现自己记住了上面的每一个字。</p>`

const ch2 = `<h1>第 2 章 老槐树</h1><p>小区花坛里那棵老槐树有一百年了，树干中空，能塞进一个小孩。周砚秋十三岁那年真进去过，为了躲一场雨，也为了躲母亲的巴掌。</p><p>现在她站在树下，听见有人在树里说话。</p><p>声音很轻，像有人用指甲刮玻璃。她屏住呼吸，把耳朵贴上去——"你父亲不是走的，"那个声音说，"他是被换走的。"</p><p>周砚秋后退了半步，鞋跟磕在水泥沿上，发出一声脆响。她抬头，槐树的枝条在无风的夜里轻轻晃了一下。</p>`

const project = {
  id: 'p_demo',
  title: '听风者',
  author: '海风',
  coverColor: '#2b6cb0',
  sceneId: 'long-novel',
  genreId: 'xuanyi',
  createdAt: now - 86400000 * 9,
  updatedAt: now - 3600000,
  brief: {
    logline: '一个能听见植物说话的都市女孩，发现小区花坛里的老槐树知道三十年前一桩悬案的真相。',
    premise:
      '周砚秋在父亲失踪七年后回到老城区，发现自己重新获得了童年时那种与植物交谈的能力。老槐树告诉她：父亲不是失踪，是被"换"走了。随着调查深入，她发现整片街区的地基下埋着一个用活人做交换的旧契约，而母亲、邻居、甚至她自己，都是这场交换的一部分。',
    keywords: ['都市悬疑', '植物通感', '旧城区', '父女', '契约']
  },
  settings: {
    targetWordsPerChapter: 2500,
    targetTotalWords: 300000,
    lengthMode: 'soft',
    pov: '第三人称限知',
    tense: '过去时',
    tone: ['冷峻', '克制'],
    audience: '喜欢都市悬疑与家庭秘密的成年读者',
    extraRules: '每章结尾必须留一个具体的悬念物件或动作，不要用心理独白收尾。',
    context: { brief: true, bible: true, characters: true, outline: true, previous: true, style: true, genre: true },
    previousChapters: 2,
    modelOverrides: {}
  },
  bible: {
    characters: [
      {
        id: 'c1',
        name: '周砚秋',
        role: '主角',
        age: '29',
        identity: '市立图书馆古籍修复员',
        appearance: '个子不高，右手虎口有一道旧疤，习惯把头发扎得很紧',
        personality: '克制、较真，越是慌张越显得平静',
        motivation: '找到父亲失踪的真相，同时证明自己没有疯',
        flaw: '过度理性，凡事先找证据，因此一次次错过直觉给出的答案',
        arc: '从"只信证据"到"学会相信自己的感知"',
        speechStyle: '句子短，少用形容词，回答问题前会停顿半秒',
        relations: [
          { name: '周启山', desc: '父亲，七年前失踪' },
          { name: '李素云', desc: '母亲，对女儿疏远但隐瞒着某事' }
        ],
        hidden: false,
        notes: ''
      },
      {
        id: 'c2',
        name: '李素云',
        role: '配角',
        age: '56',
        identity: '退休小学教师',
        appearance: '瘦，爱穿深色开衫，手指关节粗大',
        personality: '温和表面下有极强的控制欲',
        motivation: '守住三十年前的秘密，保护女儿不再被卷进去',
        flaw: '用沉默代替解释',
        arc: '从守秘者到坦白者',
        speechStyle: '习惯用"你别问了"结束对话',
        relations: [{ name: '周砚秋', desc: '女儿' }],
        hidden: false,
        notes: ''
      },
      {
        id: 'c3',
        name: '陈九',
        role: '反派',
        age: '不详',
        identity: '街道办的临时工 / 契约的执行人',
        appearance: '总是戴一顶旧帽子，走路时右脚略拖',
        personality: '礼貌、耐心，几乎不动怒',
        motivation: '完成契约的最后一次交换',
        flaw: '把规则看得比人重',
        arc: '从执行者到被契约反噬',
        speechStyle: '敬语很多，喜欢说"按规矩"',
        relations: [],
        hidden: false,
        notes: '真名未知'
      }
    ],
    world: [
      {
        id: 'w1',
        category: 'rule',
        title: '交换的规则',
        content: '契约以"等价"为前提：被换走的人必须有一个自愿的替代者。替代者可以在不知情的情况下自愿——这是契约最大的漏洞。',
        visible: true
      },
      {
        id: 'w2',
        category: 'world',
        title: '植物通感',
        content: '极少数人能听见植物的"记忆"，而非语言。植物记得的是发生过的事，不记得人后来怎么解释它。因此植物的证词永远比人的可靠，也永远比人的残忍。',
        visible: true
      },
      {
        id: 'w3',
        category: 'place',
        title: '红星巷十七号',
        content: '老城区一片待拆迁的居民区，地基下埋着 1996 年一次事故的遗留物。整片街区只有花坛的老槐树还在原地。',
        visible: true
      }
    ],
    terms: [
      { id: 't1', term: '听风', definition: '本地方言，指能与植物交换记忆的能力' },
      { id: 't2', term: '换走', definition: '被契约移除，从所有记录与记忆中淡出' }
    ],
    timeline: [
      { id: 'tl1', time: '1996 年春', title: '红星巷事故', desc: '一起被定性为燃气爆炸的事故，实际是第一次交换' },
      { id: 'tl2', time: '七年前', title: '周启山失踪', desc: '最后一次露面是在老槐树下' },
      { id: 'tl3', time: '现在', title: '周砚秋回乡', desc: '重新听见植物说话' }
    ],
    threads: [
      { id: 'th1', title: '父亲的第七十三封信', setup: '第 1 章烧信，收件地址无人居住', payoff: '地址其实是契约登记处的旧址', status: 'open', level: 'main' },
      { id: 'th2', title: '母亲的沉默', setup: '第 2 章母亲对老槐树的反应异常', payoff: '母亲是三十年前的自愿替代者', status: 'open', level: 'main' }
    ]
  },
  outline: [
    {
      id: 'o1',
      title: '第一卷 回声',
      summary: '周砚秋回到红星巷，重新听见植物说话，第一次触到父亲失踪的真相边缘。',
      type: 'volume',
      status: 'writing',
      children: [
        { id: 'o1c1', title: '第 1 章 她把最后一封信烧了', summary: '建立城市与人物，抛出第七十三封信的悬念', type: 'chapter', status: 'done', children: [] },
        { id: 'o1c2', title: '第 2 章 老槐树', summary: '第一次听见植物说话，得知父亲是被换走的', type: 'chapter', status: 'done', children: [] },
        { id: 'o1c3', title: '第 3 章 母亲的抽屉', summary: '在母亲房间发现 1996 年的旧报纸，第一次怀疑母亲知情', type: 'chapter', status: 'planned', children: [] },
        { id: 'o1c4', title: '第 4 章 陈九上门', summary: '契约执行人出现，以街道办名义要求她签署拆迁同意书', type: 'chapter', status: 'planned', children: [] }
      ]
    }
  ],
  chapters: [
    { id: 'ch_1', title: '第 1 章 她把最后一封信烧了', content: ch1, summary: '周砚秋烧掉第七十三封寄给失踪父亲的信，并记住了上面的每个字。', status: 'done', targetWords: 2500, words: 0, createdAt: now - 86400000, updatedAt: now - 7200000, versions: [] },
    { id: 'ch_2', title: '第 2 章 老槐树', content: ch2, summary: '老槐树告诉她父亲是被换走的，母亲的反应异常。', status: 'draft', targetWords: 2500, words: 0, createdAt: now - 7200000, updatedAt: now - 3600000, versions: [] },
    { id: 'ch_3', title: '第 3 章 母亲的抽屉', content: '', summary: '', status: 'planned', targetWords: 2500, words: 0, createdAt: now - 3600000, updatedAt: now - 3600000, versions: [] }
  ],
  styleProfiles: [
    {
      id: 'sp1',
      name: '冷叙述体',
      samples: [
        '邮局的玻璃门在身后合拢，冷气一下子被关在外面。她走到巷口的铁皮桶边，划了根火柴。',
        '声音很轻，像有人用指甲刮玻璃。她屏住呼吸，把耳朵贴上去。'
      ],
      traits: [
        '以短句为主，一句话通常不超过 20 字，长句只用于回忆段落',
        '动作与物件承担情绪，几乎不直接写"她很难过"',
        '比喻取自日常物件（火柴、铁皮桶、玻璃），不用华丽意象',
        '对白简短，人物用沉默和停顿说话'
      ],
      active: true
    }
  ],
  ideas: [
    { id: 'i1', text: '老槐树的年轮里刻着一串名字，最后一个名字被刮掉了', at: now - 86400000, pinned: true },
    { id: 'i2', text: '母亲每年清明都去一个没有墓碑的地方，周砚秋直到现在才发现', at: now - 40000000, pinned: false },
    { id: 'i3', text: '图书馆里有一本 1996 年的借阅登记，父亲的名字出现在事故之后', at: now - 20000000, pinned: false }
  ],
  chat: [],
  usage: [
    { id: 'u1', at: now - 5000000, model: 'deepseek-chat', task: 'draft', promptTokens: 4200, completionTokens: 2600, cost: 0.0292 },
    { id: 'u2', at: now - 4900000, model: 'deepseek-chat', task: 'polish', promptTokens: 1800, completionTokens: 900, cost: 0.0108 }
  ],
  summaries: { ch_1: '周砚秋烧掉第七十三封寄给失踪父亲的信，并记住了上面的每个字。' }
}

// 简易字数统计（与 App 内口径一致）
function countWords(html) {
  const text = html.replace(/<[^>]+>/g, '')
  const cjk = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g)
  const latin = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)
  return (cjk ? cjk.length : 0) + (latin ? latin.length : 0)
}
for (const c of project.chapters) c.words = countWords(c.content)

fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2))
fs.mkdirSync(path.join(root, 'projects', 'p_demo'), { recursive: true })
fs.writeFileSync(path.join(root, 'projects', 'p_demo', 'project.json'), JSON.stringify(project, null, 2))

// 第二个作品：短篇，用于书架有多张卡
const p2 = JSON.parse(JSON.stringify(project))
p2.id = 'p_demo2'
p2.title = '最后一个夏天'
p2.author = '海风'
p2.coverColor = '#8a6a3b'
p2.sceneId = 'short-story'
p2.genreId = 'qingchun'
p2.chapters = p2.chapters.slice(0, 1)
p2.chapters[0].id = 'c2_1'
p2.createdAt = now - 86400000 * 2
p2.updatedAt = now - 86400000
fs.mkdirSync(path.join(root, 'projects', 'p_demo2'), { recursive: true })
fs.writeFileSync(path.join(root, 'projects', 'p_demo2', 'project.json'), JSON.stringify(p2, null, 2))

console.log('seeded', root, countWords(ch1) + countWords(ch2), 'words')