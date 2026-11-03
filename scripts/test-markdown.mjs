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

console.log('表格')
const table = `| 朝代 | 起止 | 备注 |
| :--- | :---: | ---: |
| 明 | 1368–1644 | 十六帝 |
| 清 | 1636–1912 | 十二帝 |`
const th = mdToHtml(table)
check('生成 table 标签', th.includes('<table>') && th.includes('</table>'))
check('表头是 th', th.match(/<th style/g)?.length === 3, String(th.match(/<th style/g)?.length))
check('两行数据 6 个 td', th.match(/<td/g)?.length === 6, String(th.match(/<td/g)?.length))
check('左对齐', th.includes('text-align:left'), th)
check('居中对齐', th.includes('text-align:center'))
check('右对齐', th.includes('text-align:right'))
check('单元格内容正确', th.includes('>明<') && th.includes('>1368–1644<'))
check('表格外面套了可滚动容器', th.includes('md-table-wrap'))
check('行内格式在单元格里生效', mdToHtml('| a | b |\n| --- | --- |\n| **粗** | `代码` |').includes('<strong>粗</strong>'))
check('缺列时补空单元格', mdToHtml('| a | b | c |\n| --- | --- | --- |\n| 1 |').match(/<td/g)?.length === 3)
check('正文里的单个竖线不变成表格', !mdToHtml('用 | 分隔的文本').includes('<table>'))
check('没有分隔行就不是表格', !mdToHtml('| a | b |\n| 1 | 2 |').includes('<table>'))
check('表格后接段落能正常收尾', (() => {
  const h = mdToHtml(table + '\n\n后面的段落')
  return h.includes('</table>') && h.includes('<p>后面的段落</p>')
})())
check('两列表格也能解析', mdToHtml('| 项 | 值 |\n| --- | --- |\n| 一 | 1 |').includes('<table>'))
check('单元格里的链接照常渲染', mdToHtml('| 源 | 链接 |\n| --- | --- |\n| 官方 | [点这里](https://e.com/x) |').includes('<a href="https://e.com/x"'))

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)