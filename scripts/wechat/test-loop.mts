import assert from 'node:assert/strict'
import { deterministicQa } from './wechat-loop.mts'

const source = '## 1. First\n\nBody\n\n### 1.1. Detail\n'
const valid = '<section style="color:#000">文章目录<li class="wx-toc-article-title" style="gap: 4px"><span class="wx-toc-text">Title</span></li></section><h2 class="h2" style="color:#fff">First</h2><h3 class="h3" style="color:#00f">Detail</h3>'.padEnd(900, ' style="x"')
assert.equal(deterministicQa(source, valid, 'cover.jpg').passed, true)
assert.equal(deterministicQa(source, `${valid} 解读版本：v1`, 'cover.jpg').passed, false)
assert.equal(deterministicQa(source, `${valid} 01. First`, 'cover.jpg').passed, false)
assert.equal(deterministicQa(source, '<style>x</style>', undefined).passed, false)
assert.equal(deterministicQa(source, valid.replace('wx-toc-text', 'wx-toc-index'), 'cover.jpg').passed, false)
assert.equal(deterministicQa(source, `${valid}<a href="#wx-section-1">Bad anchor</a>`, 'cover.jpg').passed, false)
const sourceWithCode = `${source}\n\`\`\`text\ncode\n\`\`\`\n`
assert.equal(deterministicQa(sourceWithCode, valid, 'cover.jpg').passed, false)
assert.equal(deterministicQa(sourceWithCode, `${valid}<pre class="hljs code__pre" style="background: #0d1b2a">code</pre>`, 'cover.jpg').passed, true)
console.log('wechat-loop deterministic QA: ok')
