import { createHash } from 'node:crypto'

export type Layout = { imageWidthPercent: number }
export type RevisionScope = 'content' | 'style' | 'references' | 'image' | 'layout'
export type TextPatch = { before: string; after: string }
export type Reference = { title: string; url: string }
export const defaultLayout: Layout = { imageWidthPercent: 100 }

export function digest(value: string | Buffer) { return createHash('sha256').update(value).digest('hex') }

export function referenceSection(markdown: string) {
  const marker = /^(?:<strong>参考来源<\/strong>|\*\*参考来源\*\*|#{1,6}\s+参考来源)\s*$/m.exec(markdown)
  return marker ? { body: markdown.slice(0, marker.index), references: markdown.slice(marker.index + marker[0].length) } : { body: markdown, references: '' }
}

export function referenceEntries(markdown: string): Reference[] {
  const section = referenceSection(markdown).references
  const entries: Reference[] = []
  for (const match of section.matchAll(/^(?:\d+[.、]\s*)?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gm)) {
    const title = match[1].replace(/^\d+[.、]\s*/, '').trim()
    const url = new URL(match[2]).href
    if (!entries.some(entry => entry.url === url)) entries.push({ title, url })
  }
  if (section.trim() && !entries.length) throw new Error('Reference section must contain named HTTP(S) Markdown links; refuse to discard unparsed sources.')
  if (section.trim()) {
    const remainder = section.replace(/^(?:\d+[.、]\s*)?\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)\s*/gm, '').replace(/^https?:\/\/\S+\s*/gm, '').trim()
    if (remainder) throw new Error('Reference section contains additional prose; preserve it with an explicit content patch rather than dropping it.')
  }
  return entries
}

export function normalizeReferences(markdown: string) {
  const { body, references } = referenceSection(markdown)
  if (!references.trim()) return markdown
  const entries = referenceEntries(markdown)
  return `${body}<strong>参考来源</strong>\n\n${entries.map((entry, index) => `[${index + 1}. ${entry.title}](${entry.url})  \n${entry.url}`).join('\n\n')}`
}

export function referencesMatchHtml(markdown: string, html: string) {
  try {
    const entries = referenceEntries(markdown)
    if (!entries.length) return !referenceSection(markdown).references.trim()
    const text = htmlText(html).split('参考来源')[1] ?? ''
    let position = 0
    for (const [index, entry] of entries.entries()) {
      const label = htmlText(`${index + 1}. ${entry.title}`)
      const next = text.indexOf(label, position)
      if (next < 0 || text.indexOf(label, next + label.length) >= 0) return false
      const url = text.indexOf(htmlText(entry.url), next + label.length)
      if (url < 0) return false
      position = url + htmlText(entry.url).length
    }
    return true
  } catch { return false }
}

export function applyTextPatches(markdown: string, patches: TextPatch[]) {
  let result = markdown
  for (const patch of patches) {
    if (!patch.before || typeof patch.after !== 'string') throw new Error('Each patch needs nonempty before and string after.')
    const position = result.indexOf(patch.before)
    if (position < 0 || result.indexOf(patch.before, position + 1) >= 0) throw new Error('Patch target must occur exactly once in the current article.')
    result = result.slice(0, position) + patch.after + result.slice(position + patch.before.length)
  }
  return result
}

export function checkedLayout(value: Partial<Layout> = {}): Layout {
  const layout = { ...defaultLayout, ...value }
  if (!Number.isFinite(layout.imageWidthPercent) || layout.imageWidthPercent < 20 || layout.imageWidthPercent > 100) throw new Error('Image width must be between 20 and 100 percent.')
  return layout
}

export function scaleSvgFonts(svg: string, scale: number) {
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 2) throw new Error('Font scale must be between 0.5 and 2; image dimensions are unchanged.')
  let count = 0
  const output = svg.replace(/(font-size(?:="|:\s*))([\d.]+)(px)?/g, (_, prefix, size, unit = '') => {
    count += 1
    return `${prefix}${Math.round(Number(size) * scale * 100) / 100}${unit}`
  })
  if (!count) throw new Error('SVG has no explicit font sizes; cannot safely resize its text.')
  return output
}

export function htmlText(html: string) {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/g, (_, name: string) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name])
    .replace(/[\s\u200b\ufeff]+/g, '').trim()
}

export function removeLegacyTitleCard(html: string) {
  return html.replace(/<section\b[^>]*class="wx-hero"[^>]*>[\s\S]*?<\/section>(?=\s*<section\b[^>]*class="wx-toc")/, '')
}

export function removeLegacyTocModule(html: string) {
  return html.replace(/<section\b[^>]*class="[^"]*wx-toc[^"]*"[^>]*>[\s\S]*?<\/section>/i, '')
}

export function removeLegacyTocFiller(html: string) {
  return html
    .replace(/<p\b[^>]*class="[^"]*wx-toc-title[^"]*"[^>]*>[\s\S]*?<\/p>/i, '')
    .replace(/<li\b[^>]*class="[^"]*wx-toc-article-title[^"]*"[^>]*>[\s\S]*?<\/li>/i, '')
}

export function hasAnalysisVersionFraming(markdown: string) {
  const prose = markdown.replace(/https?:\/\/[^\s)]+/g, '').replace(/```[\s\S]*?```/g, '')
  return /(?:基于|依据|固定在|对应|截至|读取的|核验时的).{0,65}(?:版本|快照|提交|main)|(?:当前|固定|旧|发布|项目|规则|模型).{0,8}版本|提交号|提交记录|包版本|版本字段|\bv?\d+\.\d+\.\d+\b|\b[0-9a-f]{7,40}\b/i.test(prose)
}

export function imageAttributes(html: string) {
  return [...html.matchAll(/<img\b[^>]*>/gi)].map(([tag]) => {
    const attribute = (name: string) => tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1] ?? ''
    const style = attribute('style')
    return { src: attribute('src').replace(/&amp;/g, '&').replace(/^http:/, 'https:'), width: style.match(/(?:^|;)\s*width:\s*([^;!]+)/)?.[1]?.trim() ?? '', height: style.match(/(?:^|;)\s*height:\s*([^;!]+)/)?.[1]?.trim() ?? '' }
  })
}

export function remoteDigest(news: Record<string, unknown>) {
  return digest(JSON.stringify(Object.fromEntries(['title', 'content', 'author', 'digest', 'thumb_media_id', 'content_source_url', 'show_cover_pic', 'need_open_comment', 'only_fans_can_comment'].map(key => [key, news[key] ?? null]))))
}

export function readbackImagesMatch(actual: string, expected: string) {
  const canonical = (html: string) => imageAttributes(html).map(image => {
    try {
      const url = new URL(image.src)
      if (url.hostname === 'mmbiz.qpic.cn') url.pathname = url.pathname.replace(/\/(?:0|640)$/, '/0')
      return { ...image, src: url.href }
    } catch { return image }
  })
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected))
}

export function verifiedPreviewUrl(value: unknown) {
  if (typeof value !== 'string') return undefined
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.hostname === 'mp.weixin.qq.com' && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}

export const styleProfiles: Record<string, string> = {
  preserve: '保持当前稿的既有文风；旧稿未记录命名风格，不得推断或宣称它是某个作者版本。只核验局部修改没有改变原有表达。',
  neutral: '自然、具体的技术说明，准确保留事实边界，不添加个人经历。',
  conversational: '面向读者自然交谈，用具体问题推动阅读，长短句交替，有依据的明确判断，避免说明书腔和夸张口号。',
  khazix: '借鉴卡兹克公开写作规范的聊天节奏：从具体麻烦切入，用读者追问和自然转场推进，保留明确个人判断与长短句变化。保留账号目录和章节结构。不冒充作者，不复制署名或原句，不捏造亲历、测试、事故和收益。事实与技术边界不能为了文风删掉。禁止的是虚构误区后翻案，不禁止正常技术区分。',
}
