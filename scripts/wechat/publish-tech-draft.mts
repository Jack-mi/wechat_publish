import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildRenderedOutput } from '../../vendor/doocs-md/packages/mcp-server/src/render-article.ts'
import juice from '../../vendor/doocs-md/apps/web/node_modules/juice/index.js'
import { template } from './tech-article-template.mjs'

const run = promisify(execFile)
const usage = `Usage: pnpm --dir vendor/doocs-md/packages/mcp-server exec tsx \\
  ../../../../scripts/wechat/publish-tech-draft.mts <article.md> [--html <file>] [--draft-json <file>] [--draft --cover <image>]`
const args = process.argv.slice(2)
const valueAfter = (flag: string) => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
const source = args.find(arg => !arg.startsWith('-'))
const wantsDraft = args.includes('--draft')
const projectRoot = path.resolve(import.meta.dirname, '../..')

if (!source || args.includes('--help') || (wantsDraft && !valueAfter('--cover')))
  throw new Error(`${usage}\n${wantsDraft ? '--draft requires --cover <image>.' : ''}`)

const htmlOutput = path.resolve(valueAfter('--html') ?? '/tmp/wechat-article.html')
const draftOutput = valueAfter('--draft-json') && path.resolve(valueAfter('--draft-json'))
const sourcePath = path.resolve(source)
const raw = await fs.readFile(sourcePath, 'utf8')
const frontMatter = raw.match(/^---\n([\s\S]*?)\n---\n?/)
const title = (frontMatter?.[1].match(/^title:\s*([^\n]+)$/m)?.[1] ?? path.basename(sourcePath, '.md')).trim().replace(/^['"]|['"]$/g, '')
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const cleanHeading = (value: string) => value
  .replace(/^\s*\d+(?:\.\d+)?[.、]?\s+/, '')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\*\*|__|\*|_/g, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .trim()
let body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^#\s+[^\n]+\n+/m, '')
body = body.replace(/<!-- WECHAT_PUBLISH_EXCLUDE_START -->[\s\S]*?<!-- WECHAT_PUBLISH_EXCLUDE_END -->\s*/g, '')
body = body.replace(/^(?:>\s*)?(?:解读|季度)\s*版本\s*[:：].*(?:\n|$)/gmi, '')
body = body.replace(/^(\s*[-*+]\s+)•\s+/gm, '$1')
let fenced = false
const normalizedLines: string[] = []
const headings: Array<{ level: number, text: string, number: string }> = []
let chapterNumber = 0
let subsectionNumber = 0
for (const line of body.split('\n')) {
  if (/^\s*```/.test(line)) {
    fenced = !fenced
    normalizedLines.push(line)
    continue
  }
  const match = !fenced && line.match(/^(#{2,3})\s+(.+)$/)
  if (!match) {
    normalizedLines.push(line)
    continue
  }
  const level = match[1].length
  const text = cleanHeading(match[2])
  if (level === 2) {
    chapterNumber += 1
    subsectionNumber = 0
    headings.push({ level, text, number: `${chapterNumber}` })
    normalizedLines.push(`${match[1]} ${chapterNumber}. ${text}`)
  }
  else {
    subsectionNumber += 1
    const number = `${chapterNumber || 1}.${subsectionNumber}`
    headings.push({ level, text, number })
    normalizedLines.push(`${match[1]} ${number} ${text}`)
  }
}
body = normalizedLines.join('\n')
const blocks = body.split(/\n\n+/).map(block => block.trim()).filter(Boolean)
const intro = blocks.find(block => !/^(#|>|---$|[-*+]\s|```|\|)/.test(block)) ?? ''
const digest = intro.replace(/[>*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
const articleBody = body
const tocRows = [
  `<li class="wx-toc-item wx-toc-article-title"><span class="wx-toc-text">${escapeHtml(title)}</span></li>`,
  ...headings.map(({ level, text, number }) => {
  const index = level === 2 ? `${number}.` : number
  return `<li class="wx-toc-item wx-toc-level-${level}"><span class="wx-toc-index">${index}</span><span class="wx-toc-text">${escapeHtml(text)}</span></li>`
  }),
].join('')
const toc = `<section class="wx-toc"><p class="wx-card-label">${template.toc.label}</p><p class="wx-toc-title">${template.toc.titleLabel}</p><ol>${tocRows}</ol></section>`

const rendered = await buildRenderedOutput({
  markdown: articleBody,
  theme: 'grace',
  primaryColor: template.palette.blue,
  fontSize: '16px',
  lineHeight: '1.9',
  blockSpacing: '1.15',
  linkColor: template.palette.blue,
  isUseJustify: true,
  isMacCodeBlock: true,
  headingStyles: { h2: 'border-left', h3: 'border-bottom' },
  customCSS: `.container { background: transparent !important; } .h2 { color: ${template.palette.ink}; font-weight: 700; } .h3 { color: ${template.palette.blue}; } .p { color: #293b53; } .strong { color: ${template.palette.ink}; }`,
})

const content = rendered.html.replace(/<style>[\s\S]*?<\/style>\s*/i, '')
const shell = `<section class="wx-article"><section class="wx-hero"><p class="wx-kicker">AGENT ENGINEERING · OPEN SOURCE</p><h1>${escapeHtml(title)}</h1></section>${toc}${content}<section class="wx-cta"><p class="wx-card-label">持续更新</p><p>${escapeHtml(template.cta)}</p></section></section>`
const css = `.wx-article{width:100%;max-width:677px;box-sizing:border-box;margin:0 auto;padding:8px 14px 32px;background:#fff;color:#293b53;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;word-break:break-all;overflow-wrap:anywhere;overflow:hidden}.wx-hero{margin:8px 0 26px;padding:32px 26px 30px;background:linear-gradient(135deg,#14213d 0%,#1d4e89 100%);border-radius:14px}.wx-kicker{margin:0 0 13px;color:#a8d8ff;font-size:12px;font-weight:700;letter-spacing:1.4px}.wx-hero h1{display:block!important;max-width:100%!important;margin:0!important;overflow:visible!important;white-space:normal!important;color:#fff;font-size:19px;line-height:1.42;letter-spacing:.2px;word-break:break-all;overflow-wrap:anywhere}.wx-card-label{margin:0 0 9px;color:#1d4e89;font-size:13px;font-weight:700;letter-spacing:1.2px}.wx-toc{margin:0 0 30px;padding:20px;background:#f8fbfe;border:1px solid #cfe3f6;border-radius:12px}.wx-toc-title{margin:0 0 13px;color:#14213d;font-size:17px;line-height:1.55;font-weight:700}.wx-toc ol{margin:0;padding:0;list-style:none}.wx-toc-item{display:flex;align-items:flex-start;gap:4px;margin:9px 0;color:#42627f;font-size:14px;line-height:1.65}.wx-toc-index{display:block;flex:0 0 auto;color:#1d4e89;font-weight:700;white-space:nowrap}.wx-toc-text{flex:1;min-width:0;word-break:break-all;overflow-wrap:anywhere}.wx-toc-article-title{margin-bottom:12px;color:#14213d;font-weight:700}.wx-toc-level-3{margin-left:18px;color:#5c7088;font-size:13px}.wx-toc-level-3 .wx-toc-index{color:#7da5c4}.wx-article .container{padding:0!important}.wx-article .h2{margin:38px 0 18px!important;padding:13px 16px!important;background:#14213d!important;border-left:6px solid #7ed2ff!important;border-radius:0 9px 9px 0!important;box-shadow:none!important;color:#fff!important;font-size:21px!important;line-height:1.45!important}.wx-article .h3{display:inline-block!important;margin:26px 0 13px!important;padding:6px 11px!important;background:#edf6ff!important;border-left:3px solid #2b6cb0!important;border-radius:0 6px 6px 0!important;color:#1d4e89!important;font-size:17px!important;line-height:1.5!important}.wx-article .ul{margin:12px 0 20px!important;padding-left:10px!important}.wx-article .listitem{margin:11px 0!important;padding-left:7px;line-height:1.85!important}.wx-article .codespan{padding:2px 5px;background:#f2f6fa;border-radius:4px;color:#1d4e89;font-size:14px}.wx-article .code__pre{box-sizing:border-box!important;max-width:100%!important;margin:18px 0!important;padding:14px 16px!important;overflow-x:auto!important;background:#0d1b2a!important;border:1px solid #274a68!important;border-radius:10px!important;box-shadow:0 4px 14px rgba(13,27,42,.12)!important;white-space:pre-wrap!important;word-break:break-word!important;color:#e6edf3!important;font-family:SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace!important;font-size:13px!important;line-height:1.72!important}.wx-article .code__pre .mac-sign{display:flex!important;box-sizing:border-box!important;margin:-14px -16px 10px!important;padding:11px 15px 9px!important;background:#10283c!important;border-bottom:1px solid #274a68!important;border-radius:10px 10px 0 0!important}.wx-article .code__pre code{display:block!important;background:transparent!important;color:#e6edf3!important;white-space:pre-wrap!important;word-break:break-word!important;font-family:inherit!important;font-size:inherit!important;line-height:inherit!important}.wx-article .code__pre .code-block__inner{color:inherit!important}.wx-article .code__line{font-size:inherit!important;line-height:inherit!important;white-space:pre-wrap!important;word-break:break-word!important}.wx-cta{margin:36px 0 0;padding:22px 20px;background:#14213d;border-radius:12px}.wx-cta .wx-card-label{color:#a8d8ff}.wx-cta p:last-child{margin:0;color:#edf6ff;font-size:15px;line-height:1.8}`
const fragment = juice(`<style>${css}</style>${shell}`, { inlinePseudoElements: true, preserveImportant: true, resolveCSSVariables: false })
  .replace(/<style[^>]*>[\s\S]*?<\/style>\s*/gi, '')
  .replace(/<img\b(?![^>]*\bstyle=)/gi, '<img style="display:block!important;box-sizing:border-box!important;max-width:100%!important;width:auto!important;height:auto!important;margin:18px auto!important"')
  .replace(/(<li\b[^>]*>)•\s*/g, '$1')
  .replace(/var\(--[^)]+\)/g, '')

const tocTitle = /<li\b[^>]*\bwx-toc-article-title\b[^>]*>([\s\S]*?)<\/li>/i.exec(fragment)?.[1] ?? ''
const fencedCodeBlockCount = (articleBody.match(/^\s*```/gm) ?? []).length / 2
const styledCodeBlockCount = (fragment.match(/<pre class="hljs code__pre"[^>]*style="[^"]*background:\s*#0d1b2a/gi) ?? []).length
if (/<style\b/i.test(fragment) || /var\(--/i.test(fragment) || /(?:href="#wx-section-|\bid="wx-section-|\bname="wx-section-)/i.test(fragment) || /<li\b[^>]*>•\s*/i.test(fragment) || /wx-toc-index|•/.test(tocTitle) || (fencedCodeBlockCount > 0 && styledCodeBlockCount < fencedCodeBlockCount) || /核心速览|(?:解读|季度)\s*版本\s*[:：]/i.test(fragment) || /(?:^|[>\s])0\d+(?:\.\d+)?[.、](?=\s|<)/m.test(fragment) || (headings.length > 0 && !fragment.includes(template.toc.label)))
  throw new Error('Render gate failed: output contains non-inline CSS, forbidden article metadata, or non-canonical heading numbering.')

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">${fragment}</body></html>`
await fs.mkdir(path.dirname(htmlOutput), { recursive: true })
await fs.writeFile(htmlOutput, html)

const result: Record<string, unknown> = { title, html: htmlOutput, bytes: Buffer.byteLength(html), inlineStyles: (fragment.match(/\sstyle="/gi) ?? []).length }
if (draftOutput) {
  await fs.mkdir(path.dirname(draftOutput), { recursive: true })
  await fs.writeFile(draftOutput, JSON.stringify({ title, digest, content: fragment }, null, 2))
  result.draft_json = draftOutput
}
if (wantsDraft) {
  const cover = valueAfter('--cover')!
  const uploaded = JSON.parse((await run('md2wechat', ['upload_image', cover, '--json'])).stdout)
  const thumbMediaId = uploaded?.data?.media_id
  if (!thumbMediaId)
    throw new Error('Cover upload returned no media_id.')
  const requestFile = path.join('/tmp', `wechat-draft-${Date.now()}.json`)
  await fs.writeFile(requestFile, JSON.stringify({ articles: [{ title, digest, content: fragment, thumb_media_id: thumbMediaId }] }))
  const created = JSON.parse((await run('md2wechat', ['create_draft', requestFile, '--json'])).stdout)
  result.draft = created.data
  result.note = 'WeChat returns a media_id, not a stable draft URL. Retrieve the draft link from the editor and report it with the media_id.'
}
console.log(JSON.stringify(result))
