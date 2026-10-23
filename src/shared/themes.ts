export interface VisualTheme {
  id: string
  name: string
  hint: string
  /** 用于卡片预览的三个代表色 */
  swatch: [string, string, string]
  vars: Record<string, string>
}

export const VISUAL_THEMES: VisualTheme[] = [
  {
    id: 'paper',
    name: '纸白',
    hint: '默认·清爽',
    swatch: ['#ffffff', '#f4f5f7', '#2b6cb0'],
    vars: {
      '--bg': '#f7f8fa',
      '--panel': '#ffffff',
      '--panel-2': '#f4f5f7',
      '--sidebar': '#fbfbfc',
      '--text': '#1c2024',
      '--text-dim': '#5b6470',
      '--text-faint': '#8b95a3',
      '--border': '#e4e7ec',
      '--border-strong': '#d3d8e0',
      '--accent': '#2b6cb0',
      '--accent-hover': '#245a94',
      '--accent-soft': '#e8f1fb',
      '--accent-text': '#ffffff',
      '--editor-bg': '#ffffff',
      '--editor-text': '#1a1d21',
      '--selection': '#cfe3fa',
      '--danger': '#c94141',
      '--ok': '#2f8a5b',
      '--warn': '#b7791f',
      '--shadow': '0 1px 2px rgba(16,24,40,.06), 0 8px 24px rgba(16,24,40,.06)'
    }
  },
  {
    id: 'midnight',
    name: '墨黑',
    hint: '夜间·沉浸',
    swatch: ['#171a1f', '#1f242b', '#6aa9f0'],
    vars: {
      '--bg': '#111417',
      '--panel': '#171b20',
      '--panel-2': '#1d2229',
      '--sidebar': '#14181c',
      '--text': '#e6e9ee',
      '--text-dim': '#a2abb8',
      '--text-faint': '#6f7a89',
      '--border': '#262d36',
      '--border-strong': '#333c48',
      '--accent': '#6aa9f0',
      '--accent-hover': '#8bbdf6',
      '--accent-soft': '#1b2a3c',
      '--accent-text': '#0b1016',
      '--editor-bg': '#14181c',
      '--editor-text': '#e2e6ec',
      '--selection': '#274a6d',
      '--danger': '#e07070',
      '--ok': '#5cc08a',
      '--warn': '#d9a441',
      '--shadow': '0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.35)'
    }
  },
  {
    id: 'sepia',
    name: '护眼米黄',
    hint: '久写不累',
    swatch: ['#f6efe1', '#efe6d4', '#8a6a3b'],
    vars: {
      '--bg': '#f2ead9',
      '--panel': '#f8f2e6',
      '--panel-2': '#efe6d4',
      '--sidebar': '#f5eee0',
      '--text': '#3a3227',
      '--text-dim': '#6d6152',
      '--text-faint': '#9a8d7b',
      '--border': '#e0d4bd',
      '--border-strong': '#cdbfa4',
      '--accent': '#8a6a3b',
      '--accent-hover': '#755a31',
      '--accent-soft': '#ece0c9',
      '--accent-text': '#fffaf0',
      '--editor-bg': '#faf5e9',
      '--editor-text': '#332c22',
      '--selection': '#e6d3ad',
      '--danger': '#a8433b',
      '--ok': '#4d7c4a',
      '--warn': '#a3771f',
      '--shadow': '0 1px 2px rgba(90,70,40,.08), 0 8px 24px rgba(90,70,40,.08)'
    }
  },
  {
    id: 'mist',
    name: '雾蓝',
    hint: '冷静·专注',
    swatch: ['#eef3f8', '#e3ebf3', '#3a6b8f'],
    vars: {
      '--bg': '#eaf0f6',
      '--panel': '#f4f8fc',
      '--panel-2': '#e3ebf3',
      '--sidebar': '#eff4f9',
      '--text': '#1d2a35',
      '--text-dim': '#4e5f6e',
      '--text-faint': '#8496a6',
      '--border': '#d5e0ea',
      '--border-strong': '#c0cfdd',
      '--accent': '#3a6b8f',
      '--accent-hover': '#2f5a79',
      '--accent-soft': '#dbe8f2',
      '--accent-text': '#ffffff',
      '--editor-bg': '#f7fafd',
      '--editor-text': '#1b2730',
      '--selection': '#c9dcec',
      '--danger': '#b04a4a',
      '--ok': '#3d7d6a',
      '--warn': '#a97b28',
      '--shadow': '0 1px 2px rgba(30,50,70,.07), 0 8px 24px rgba(30,50,70,.07)'
    }
  },
  {
    id: 'forest',
    name: '森林',
    hint: '沉静·古典',
    swatch: ['#1b241f', '#232e27', '#8fbf8a'],
    vars: {
      '--bg': '#161d19',
      '--panel': '#1b241f',
      '--panel-2': '#222d27',
      '--sidebar': '#182019',
      '--text': '#e3eae2',
      '--text-dim': '#a3b2a5',
      '--text-faint': '#728372',
      '--border': '#2a352d',
      '--border-strong': '#37453a',
      '--accent': '#8fbf8a',
      '--accent-hover': '#a8d2a3',
      '--accent-soft': '#22301f',
      '--accent-text': '#0e1410',
      '--editor-bg': '#1a221d',
      '--editor-text': '#dfe7dd',
      '--selection': '#39543a',
      '--danger': '#d37474',
      '--ok': '#79c08a',
      '--warn': '#cfae5a',
      '--shadow': '0 1px 2px rgba(0,0,0,.45), 0 8px 24px rgba(0,0,0,.4)'
    }
  }
]

export const FONT_OPTIONS = [
  { id: 'system-serif', name: '系统宋体（衬线）', value: '"Songti SC", "STSong", "Noto Serif SC", Georgia, serif' },
  { id: 'system-sans', name: '系统黑体', value: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif' },
  { id: 'kai', name: '楷体', value: '"Kaiti SC", "KaiTi", "STKaiti", serif' },
  { id: 'lxgw', name: '霞鹜文楷（若已安装）', value: '"LXGW WenKai", "霞鹜文楷", "Songti SC", serif' },
  { id: 'mono', name: '等宽（写代码/剧本）', value: '"SF Mono", "JetBrains Mono", Menlo, monospace' }
]

export function themeVars(themeId: string): Record<string, string> {
  const t = VISUAL_THEMES.find((x) => x.id === themeId) ?? VISUAL_THEMES[0]
  return t.vars
}