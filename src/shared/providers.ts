import type { Protocol } from './types'

export interface ProviderPreset {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  /** 常用模型，填入后可直接选用 */
  models: string[]
  keyHint: string
  keyUrl?: string
  note?: string
  /** 是否需要把 baseUrl 提示给用户（自定义渠道） */
  custom?: boolean
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.2', 'gpt-5.2-mini', 'gpt-4.1', 'o4-mini'],
    keyHint: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
    keyHint: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    keyHint: 'AIza...',
    keyUrl: 'https://aistudio.google.com/apikey'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 深度求索',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyHint: 'sk-...',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '中文长文性价比最高，推荐作为默认正文模型'
  },
  {
    id: 'dashscope',
    name: '通义千问 DashScope',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-max', 'qwen-plus', 'qwen-turbo'],
    keyHint: 'sk-...',
    keyUrl: 'https://bailian.console.aliyun.com/'
  },
  {
    id: 'moonshot',
    name: 'Kimi Moonshot',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-turbo', 'moonshot-v1-128k'],
    keyHint: 'sk-...',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'],
    keyHint: 'xxxx.xxxx',
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys'
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3-235B-A22B'],
    keyHint: 'sk-...',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '聚合多家开源模型，按量计费便宜'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4.6', 'deepseek/deepseek-chat', 'google/gemini-2.5-pro'],
    keyHint: 'sk-or-...',
    keyUrl: 'https://openrouter.ai/keys',
    note: '一个 Key 用遍全球模型'
  },
  {
    id: 'ark',
    name: '火山方舟 豆包',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1.6', 'doubao-pro-32k'],
    keyHint: '...',
    keyUrl: 'https://console.volcengine.com/ark'
  },
  {
    id: 'ollama',
    name: '本地 Ollama',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen3:14b', 'llama3.3:70b', 'deepseek-r1:14b'],
    keyHint: '留空即可',
    note: '完全离线，无需 Key'
  },
  {
    id: 'custom',
    name: '自定义渠道',
    protocol: 'openai',
    baseUrl: '',
    models: [],
    keyHint: '按你的服务商要求填写',
    note: '任何 OpenAI / Anthropic / Gemini 兼容端点',
    custom: true
  }
]

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 兼容',
  gemini: 'Gemini 原生'
}