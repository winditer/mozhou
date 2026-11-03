/**
 * Markdown 渲染的回归测试。
 * 运行：node scripts/test-markdown.mjs
 *
 * 这里钉的是三件事：①HTML 必须被转义（模型回答里出现 <script> 不能执行）；
 * ②链接只认 http/https；③来源编号 [1] 这类方括号不能被误当成链接引用。
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outdir = mkdtempSync(join(tmpdir(), 'mozhou-markdown-'))
const outfile = join(outdir, 'markdown.mjs')

await build({
  entryPoints: [join(root, 'src/renderer/lib/markdown.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'silent'
})
const { mdToHtml, escapeHtml } = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

console.log('转义')
check('尖括号被转义', mdToHtml('<script>alert(1)</script>').includes('&lt;script&gt;'))
check('没有裸露的 script 标签', !mdToHtml('<script>alert(1)</script>').includes('<script>'))
check('引号被转义', escapeHtml('a"b') === 'a&quot;b')
check('& 被转义', escapeHtml('a&b') === 'a&amp;b')
check('代码块里的标签也被转义', mdToHtml('```\n<b>x</b>\n```').includes('&lt;b&gt;'))

console.log('行内')
check('加粗', mdToHtml('这是**重点**内容').includes('<strong>重点</strong>'))
check('斜体', mdToHtml('这是*强调*内容').includes('<em>强调</em>'))
check('行内代码', mdToHtml('用 `maxTokens` 控制').includes('<code>maxTokens</code>'))
check('行内代码里的星号不求值', mdToHtml('`a**b**c`').includes('<code>a**b**c</code>'))
check('删除线', mdToHtml('~~删掉~~').includes('<del>删掉</del>'))
check('中文标点紧贴加粗', mdToHtml('**第一**，然后是**第二**。').match(/<strong>/g)?.length === 2)
check('来源编号不变成链接', mdToHtml('依据 [1][2] 的说法').includes('[1][2]') && !mdToHtml('依据 [1][2]').includes('<a '))

console.log('链接')
check('http 链接生成 a 标签', mdToHtml('[例子](https://e.com/a)').includes('href="https://e.com/a"'))
check('javascript: 不生成 a 标签', !mdToHtml('[点我](javascript:alert(1))').includes('<a '), mdToHtml('[点我](javascript:alert(1))'))
check('javascript: 保持原文', mdToHtml('[点我](javascript:alert(1))').includes('[点我](javascript:alert(1))'))

console.log('块级')
check('标题', mdToHtml('## 标题').includes('<h4>标题</h4>'))
check('无序列表', mdToHtml('- 一\n- 二').includes('<ul>\n<li>一</li>\n<li>二</li>\n</ul>'))
check('有序列表', mdToHtml('1. 一\n2. 二').includes('<ol>'))
check('引用', mdToHtml('> 引用一句').includes('<blockquote>引用一句</blockquote>'))
check('分隔线', mdToHtml('---').includes('<hr>'))
check('代码块带语言标记', mdToHtml('```ts\nconst a = 1\n```').includes('data-lang="ts"'))
check('代码块内容不被行内解析', mdToHtml('```\n**不是加粗**\n```').includes('**不是加粗**'))
check('列表后接段落会闭合列表', (() => {
  const h = mdToHtml('- 一\n\n段落')
  return h.indexOf('</ul>') < h.indexOf('<p>段落</p>')
})())
check('空输入不产出内容', mdToHtml('') === '')
check('纯文本段落', mdToHtml('一句话。').trim() === '<p>一句话。</p>')

console.log('真实回答片段')
const sample = `今日 AI 相关要闻有三条 [1][2][3]：

- **芯片**：某厂商发布新卡，算力提升 2 倍 [1]
- **插件**：DeepSeek 开放检索插件 [2]
- **开源**：某 7B 模型权重公开 [3]

> 注：以上均来自公开报道，未逐条核实原文。

\`\`\`
model = "deepseek-chat"
\`\`\``
const html = mdToHtml(sample)
check('列表被渲染', html.includes('<ul>') && html.match(/<li>/g)?.length === 3)
check('加粗与编号共存', html.includes('<strong>芯片</strong>') && html.includes('[1]'))
check('引用被渲染', html.includes('<blockquote>'))
check('代码块被渲染', html.includes('<pre><code'))
check('没有把编号渲染成链接', !html.includes('<a '))

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)