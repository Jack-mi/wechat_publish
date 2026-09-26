import assert from 'node:assert/strict'
import { deterministicQa } from './wechat-loop.mts'

const source = 'Runtime 是一个用于验证 Harness 的项目，它把复杂流程拆成读者能看懂的步骤。\n\n## 1. First\n\nBody\n\n### 1.1. Detail\n'
const valid = '<p class="p" style="font-size: 15px; line-height: 1.82">Runtime 是一个用于验证 Harness 的项目，它把复杂流程拆成读者能看懂的步骤。</p><h2 class="h2" style="color:#fff">First</h2><h3 class="h3" style="color:#00f">Detail</h3><p class="p" style="font-size: 15px; line-height: 1.82">Body</p>'.padEnd(900, ' style="x"')
assert.equal(deterministicQa(source, valid, 'cover.jpg').passed, true)
assert.equal(deterministicQa(source, '<p>Extra title</p>' + valid, 'cover.jpg').checks.openingParagraphFirst, false)
assert.equal(deterministicQa(source, valid + '<section class="wx-hero">Duplicate title</section>', 'cover.jpg').checks.noTitleCard, false)
assert.equal(deterministicQa(source, `${valid} 解读版本：v1`, 'cover.jpg').passed, false)
assert.equal(deterministicQa(source, `${valid} 01. First`, 'cover.jpg').passed, false)
assert.equal(deterministicQa(source, '<style>x</style>', undefined).passed, false)
assert.equal(deterministicQa(source, '<section class="wx-toc">文章目录</section>' + valid, 'cover.jpg').passed, false)
assert.equal(deterministicQa(source, `${valid}<a href="#wx-section-1">Bad anchor</a>`, 'cover.jpg').passed, false)
const sourceWithCode = `${source}\n\`\`\`text\ncode\n\`\`\`\n`
assert.equal(deterministicQa(sourceWithCode, valid, 'cover.jpg').passed, false)
assert.equal(deterministicQa(sourceWithCode, `${valid}<pre class="hljs code__pre" style="background: #0d1b2a">code</pre>`, 'cover.jpg').passed, true)
assert.equal(deterministicQa('## 1. 宿主的价值\n\nBody', valid, 'cover.jpg').passed, false)
assert.equal(deterministicQa('## 1. First\n\nA\n\nB\n\nC\n\nD', valid, 'cover.jpg').passed, false)
assert.equal(deterministicQa(`${source}\n<strong>参考来源</strong>\n\n[1. Source](https://example.org/)\nhttps://example.org/`, `${valid}<strong>参考来源</strong><p>1. Source<br>https://example.org/</p>`, 'cover.jpg').checks.firstChapterAtMostThreeParagraphs, true)
assert.equal(deterministicQa('## 1. First\n\n正文 [1]\n\n## 参考来源\n\n[1] source', valid, 'cover.jpg').passed, false)
console.log('wechat-loop deterministic QA: ok')
