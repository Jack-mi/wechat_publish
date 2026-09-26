import assert from 'node:assert/strict'
import { applyTextPatches, checkedLayout, hasAnalysisVersionFraming, htmlText, imageAttributes, normalizeReferences, readbackImagesMatch, referenceEntries, referencesMatchHtml, remoteDigest, removeLegacyTitleCard, removeLegacyTocFiller, removeLegacyTocModule, scaleSvgFonts, verifiedPreviewUrl } from './article-contract.mts'
import { diagramSvg } from './wechat-agent.mts'

const original = '# Article\n\n## First\n\n正文不变。\n\n<strong>参考来源</strong>\n\n[来源甲](https://example.org/a)\n\n[来源乙](https://example.org/b?q=1&v=2)'
assert(hasAnalysisVersionFraming('旧实验能代表当前版本吗？'))
assert(hasAnalysisVersionFraming('本文基于 main 快照分析。提交号67eb910，包版本0.37.0。'))
assert(!hasAnalysisVersionFraming('原实验发现输入215M降至132M，但没有证明稳定省钱。'))
assert(!hasAnalysisVersionFraming('[代码](https://github.com/org/repo/blob/67eb910/file.py)'))
const legacyHeader = '<section class="wx-article"><section class="wx-hero"><p>AGENT ENGINEERING · OPEN SOURCE</p><h1>Title</h1></section><section class="wx-toc">文章目录</section><p>正文不变</p></section>'
assert.equal(removeLegacyTitleCard(legacyHeader), '<section class="wx-article"><section class="wx-toc">文章目录</section><p>正文不变</p></section>')
assert.equal(removeLegacyTitleCard('<section class="other">Keep me</section>'), '<section class="other">Keep me</section>')
const legacyToc = '<section class="wx-toc"><p class="wx-card-label">文章目录</p><p class="wx-toc-title">全文导航</p><ol><li class="wx-toc-item wx-toc-article-title"><span>标题</span></li><li class="wx-toc-item"><span>1. 章节</span></li></ol></section>'
assert.equal(removeLegacyTocFiller(legacyToc), '<section class="wx-toc"><p class="wx-card-label">文章目录</p><ol><li class="wx-toc-item"><span>1. 章节</span></li></ol></section>')
assert.equal(removeLegacyTocFiller('<section class="wx-toc"><p>文章目录</p></section>'), '<section class="wx-toc"><p>文章目录</p></section>')
assert.equal(removeLegacyTocModule('<section class="wx-toc"><p class="wx-card-label">文章目录</p><ol><li>1. 章节</li></ol></section><p>正文</p>'), '<p>正文</p>')
assert.equal(removeLegacyTocModule('<p>正文</p>'), '<p>正文</p>')
const numbered = normalizeReferences(original)
assert.match(numbered, /\[1\. 来源甲\]/)
assert.match(numbered, /\[2\. 来源乙\]/)
assert.ok(numbered.includes('https://example.org/b?q=1&v=2'))
assert.equal(normalizeReferences(numbered), numbered)
assert.equal(referenceEntries(numbered).length, 2)
assert.throws(() => normalizeReferences(original + '\n\n重要的附注不能丢失。'), /additional prose/)
assert.throws(() => normalizeReferences('# Title\n\n<strong>参考来源</strong>\n无链接'), /named HTTP/)
assert.equal(applyTextPatches(original, [{ before: '正文不变。', after: '只替换这里。' }]), original.replace('正文不变。', '只替换这里。'))
assert.throws(() => applyTextPatches('same same', [{ before: 'same', after: 'different' }]), /exactly once/)
assert.throws(() => applyTextPatches('same', [{ before: 'missing', after: 'different' }]), /exactly once/)
assert.throws(() => checkedLayout({ imageWidthPercent: Number.NaN }), /20 and 100/)
assert.throws(() => checkedLayout({ imageWidthPercent: 101 }), /20 and 100/)
assert.equal(checkedLayout({ imageWidthPercent: 50 }).imageWidthPercent, 50)
const svg = '<svg width="780" height="1185"><text font-size="56">节点</text><text style="font-size: 54px">标题</text></svg>'
assert.equal(scaleSvgFonts(svg, 0.75), '<svg width="780" height="1185"><text font-size="42">节点</text><text style="font-size: 40.5px">标题</text></svg>')
assert.throws(() => scaleSvgFonts(svg, 0), /between/)
assert.throws(() => scaleSvgFonts('<svg/>', 1), /no explicit/)
const html = '<strong>参考来源</strong><p>1. 来源甲<br>https://example.org/a</p><p>2. 来源乙<br>https://example.org/b?q=1&amp;v=2</p>'
assert.equal(referencesMatchHtml(numbered, html), true)
assert.equal(referencesMatchHtml(numbered, html.replace('2. 来源乙', '来源乙')), false)
assert.equal(referencesMatchHtml(numbered, html.replace('https://example.org/a', '')), false)
assert.equal(htmlText('<p>A &amp; B</p>'), 'A&B')
assert.equal(htmlText('<p>&#x4e2d;&#25991;</p>'), '中文')
assert.deepEqual(imageAttributes('<img style="width:50%!important;height:auto!important" src="http://example.org/a?x=1&amp;y=2">'), [{ src: 'https://example.org/a?x=1&y=2', width: '50%', height: 'auto' }])
const uploadedImage = '<img src="http://mmbiz.qpic.cn/mmbiz_png/asset/0?wx_fmt=png" style="width:100%!important;height:auto!important">'
const readbackImage = '<img data-src="https://mmbiz.qpic.cn/mmbiz_png/asset/640?wx_fmt=png" style="width:100%!important;height:auto!important">'
assert.equal(readbackImagesMatch(readbackImage, uploadedImage), true)
assert.equal(readbackImagesMatch(readbackImage.replace('/asset/', '/different/'), uploadedImage), false)
assert.equal(readbackImagesMatch(readbackImage.replace('width:100%', 'width:50%'), uploadedImage), false)
assert.equal(readbackImagesMatch('', uploadedImage), false)
assert.equal(readbackImagesMatch(readbackImage.replace('mmbiz.qpic.cn', 'example.org'), uploadedImage.replace('mmbiz.qpic.cn', 'example.org')), false)
assert.notEqual(remoteDigest({ title: 'A', content: 'text' }), remoteDigest({ title: 'A', content: 'changed' }))
assert.equal(remoteDigest({ title: 'A', content: 'text', url: 'old' }), remoteDigest({ title: 'A', content: 'text', url: 'new' }))
assert.equal(verifiedPreviewUrl('javascript:alert(1)'), undefined)
assert.equal(verifiedPreviewUrl('https://mp.weixin.qq.com.evil.invalid/s'), undefined)
assert.equal(verifiedPreviewUrl('http://mp.weixin.qq.com/s?tempkey=test'), 'http://mp.weixin.qq.com/s?tempkey=test')
const generated = diagramSvg('经验流程', ['保留证据', '核验条目', '反馈修订'])
assert(!generated.includes('WECHAT ARTICLE HARNESS'))
assert(!generated.includes('模型做判断'))
assert.equal((generated.match(/<text\b/g) ?? []).length, 4)
console.log('article contract: scoped patches, numbered visible sources, independent image sizing, URL and remote identity: ok')
