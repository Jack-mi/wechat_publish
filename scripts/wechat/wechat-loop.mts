import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Codex } from '@openai/codex-sdk'
import { template } from './tech-article-template.mjs'
import { editorialPrompt, reviewSchema, visualPrompt } from './prompts.mts'

const run = promisify(execFile)
const root = path.resolve(import.meta.dirname, '../..')
const runsRoot = path.join(root, '.vault-meta', 'wechat-runs')
const maxAttempts = 3
const phases = ['intake', 'editorial_review', 'render', 'visual_qa', 'revise', 'awaiting_draft_approval', 'draft', 'post_draft_qa', 'completed', 'blocked'] as const
type Phase = typeof phases[number]
type Finding = { severity: 'info' | 'warning' | 'error', message: string, recommendation: string }
type Review = { verdict: 'pass' | 'revise' | 'blocked', summary: string, findings: Finding[], coverBrief: string }
type Qa = { passed: boolean, checks: Record<string, boolean>, findings: Finding[] }
type RunState = {
  version: 1
  id: string
  phase: Phase
  article: string
  title: string
  cover?: string
  approvalToken: string
  attempts: number
  renderedSourceSha256?: string
  threadIds: { editorial?: string, visual?: string }
  artifacts: Record<string, string>
  qa?: Qa
  editorial?: Review
  visual?: Review
  draft?: { mediaId?: string, url?: string, urlStatus: 'not_created' | 'pending_editor_url' | 'recorded' }
  blockedReason?: string
  createdAt: string
  updatedAt: string
}

const usage = `Usage:
  pnpm --dir scripts/wechat wechat-loop start <article.md> [--cover <image>]
  pnpm --dir scripts/wechat wechat-loop status <run-id>
  pnpm --dir scripts/wechat wechat-loop resume <run-id>
  pnpm --dir scripts/wechat wechat-loop approve-draft <run-id> --token <token>
  pnpm --dir scripts/wechat wechat-loop record-draft-url <run-id> <https-url>
  pnpm --dir scripts/wechat wechat-loop report <run-id> [--json]`
const args = process.argv.slice(2)
const command = args.shift()
const valueAfter = (flag: string) => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}
const now = () => new Date().toISOString()
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const relative = (target: string) => path.relative(root, target)
const statePath = (id: string) => path.join(runsRoot, id, 'state.json')
const eventPath = (id: string) => path.join(runsRoot, id, 'events.jsonl')
const safePath = (input: string, label: string) => {
  const resolved = path.resolve(root, input)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${label} must be inside the Vault.`)
  return resolved
}
const redacted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redacted)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [/(secret|token|password|api.?key|appid)/i.test(key) ? key : key, /(secret|token|password|api.?key|appid)/i.test(key) ? '[redacted]' : redacted(entry)]))
}
async function save(state: RunState) {
  state.updatedAt = now()
  await fs.writeFile(statePath(state.id), `${JSON.stringify(state, null, 2)}\n`)
}
async function event(state: RunState, type: string, detail: Record<string, unknown> = {}) {
  await fs.appendFile(eventPath(state.id), `${JSON.stringify(redacted({ at: now(), type, phase: state.phase, ...detail }))}\n`)
}
async function load(id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid run id.')
  return JSON.parse(await fs.readFile(statePath(id), 'utf8')) as RunState
}
function parseJson(stdout: string) {
  const line = stdout.trim().split('\n').reverse().find(value => value.trim().startsWith('{'))
  if (!line) throw new Error('Expected JSON output from command.')
  return JSON.parse(line)
}
async function invoke(command: string, args: string[]) {
  const output = await run(command, args, { cwd: root, maxBuffer: 10 * 1024 * 1024 })
  return parseJson(output.stdout)
}
function findTitle(markdown: string, fallback: string) {
  return (markdown.match(/^title:\s*["']?([^\n"']+)/m)?.[1] ?? markdown.match(/^#\s+(.+)$/m)?.[1] ?? fallback).trim()
}
function headings(markdown: string) {
  markdown = markdown.replace(/<!-- WECHAT_PUBLISH_EXCLUDE_START -->[\s\S]*?<!-- WECHAT_PUBLISH_EXCLUDE_END -->\s*/g, '')
  markdown = markdown.replace(/^(?:>\s*)?(?:解读|季度)\s*版本\s*[:：].*(?:\n|$)/gmi, '')
  let fenced = false
  return markdown.split('\n').flatMap(line => {
    if (/^\s*```/.test(line)) fenced = !fenced
    const match = !fenced && line.match(/^(#{2,3})\s+(.+)$/)
    return match ? [{ level: match[1].length, text: match[2].replace(/^\s*\d+(?:\.\d+)?[.、]?\s+/, '').trim() }] : []
  })
}
function fencedCodeBlockCount(markdown: string) {
  markdown = markdown.replace(/<!-- WECHAT_PUBLISH_EXCLUDE_START -->[\s\S]*?<!-- WECHAT_PUBLISH_EXCLUDE_END -->\s*/g, '')
  return (markdown.match(/^\s*```/gm) ?? []).length / 2
}
export function deterministicQa(markdown: string, html: string, cover?: string): Qa {
  const sourceHeadings = headings(markdown)
  const tocTitle = /<li\b[^>]*\bwx-toc-article-title\b[^>]*>([\s\S]*?)<\/li>/i.exec(html)?.[1] ?? ''
  const checks = {
    articleHasH2: sourceHeadings.some(item => item.level === 2),
    tocPresent: html.includes(template.toc.label),
    noStyleTag: !/<style\b/i.test(html),
    noCssVariables: !/var\(--/i.test(html),
    noCoreOverview: !/核心速览/.test(html),
    noArticleVersionMetadata: !/(?:解读|季度)\s*版本\s*[:：]/i.test(html),
    noPaddedHeadingNumbers: !/(?:^|[>\s])0\d+(?:\.\d+)?[.、](?=\s|<)/m.test(html),
    tocTitleHasNoBullet: Boolean(tocTitle) && !/wx-toc-index|•/.test(tocTitle),
    tocNumberSpacingCompact: /gap:\s*4px/i.test(html),
    noUnsupportedIntraArticleAnchors: !/(?:href="#wx-section-|\bid="wx-section-|\bname="wx-section-)/i.test(html),
    fencedCodeBlocksAreStyled: fencedCodeBlockCount(markdown) === 0 || (html.match(/<pre class="hljs code__pre"[^>]*style="[^"]*background:\s*#0d1b2a/gi) ?? []).length >= fencedCodeBlockCount(markdown),
    inlineStyles: (html.match(/\sstyle="/gi) ?? []).length > 20,
    h2Visible: (html.match(/class="h2"/g) ?? []).length >= sourceHeadings.filter(item => item.level === 2).length,
    h3Visible: (html.match(/class="h3"/g) ?? []).length >= sourceHeadings.filter(item => item.level === 3).length,
    coverPresent: Boolean(cover),
  }
  const findings: Finding[] = Object.entries(checks).flatMap(([name, passed]) => passed ? [] : [{ severity: name === 'coverPresent' ? 'warning' : 'error', message: `QA check failed: ${name}`, recommendation: name === 'coverPresent' ? 'Provide a dedicated JPEG/PNG cover before approving the draft.' : 'Fix the renderer or article structure, then resume the run.' }])
  return { passed: findings.every(item => item.severity !== 'error'), checks, findings }
}
async function agentReview(kind: 'editorial' | 'visual', state: RunState, screenshot?: string): Promise<Review> {
  if (process.env.WECHAT_LOOP_MOCK_AGENT === '1') return { verdict: 'pass', summary: `${kind} mock pass`, findings: [], coverBrief: state.cover ? 'Dedicated cover supplied.' : '待补封面' }
  const codex = new Codex()
  const options = { workingDirectory: root, sandboxMode: 'read-only' as const, approvalPolicy: 'never' as const, networkAccessEnabled: false, webSearchMode: 'disabled' as const }
  const threadId = state.threadIds[kind]
  const thread = threadId ? codex.resumeThread(threadId, options) : codex.startThread(options)
  const prompt = kind === 'editorial'
    ? editorialPrompt(state.article, path.join('.vault-meta', 'wechat-runs', state.id))
    : visualPrompt(state.article, state.artifacts.html, state.artifacts.qa)
  const input = screenshot ? [{ type: 'text' as const, text: prompt }, { type: 'local_image' as const, path: screenshot }] : prompt
  const result = await thread.run(input, { outputSchema: reviewSchema })
  state.threadIds[kind] = thread.id ?? undefined
  const parsed = JSON.parse(result.finalResponse) as Review
  if (!['pass', 'revise', 'blocked'].includes(parsed.verdict) || !Array.isArray(parsed.findings)) throw new Error('Codex review did not match the expected schema.')
  return parsed
}
async function render(state: RunState) {
  state.phase = 'render'
  await save(state)
  await event(state, 'render_started')
  const source = await fs.readFile(safePath(state.article, 'Article'), 'utf8')
  const sourceSnapshot = path.join(runsRoot, state.id, `source-render-${state.attempts + 1}.md`)
  await fs.writeFile(sourceSnapshot, source)
  state.artifacts.renderedSource = relative(sourceSnapshot)
  state.renderedSourceSha256 = sha256(source)
  const html = path.join(runsRoot, state.id, 'article.html')
  const draftJson = path.join(runsRoot, state.id, 'draft-payload.json')
  const result = await invoke('pnpm', ['--dir', 'vendor/doocs-md/packages/mcp-server', 'exec', 'tsx', '../../../../scripts/wechat/publish-tech-draft.mts', state.article, '--html', html, '--draft-json', draftJson])
  state.artifacts.html = relative(String(result.html))
  state.artifacts.draftPayload = relative(String(result.draft_json))
  const htmlContent = await fs.readFile(html, 'utf8')
  state.qa = deterministicQa(source, htmlContent, state.cover)
  const qaPath = path.join(runsRoot, state.id, 'qa.json')
  await fs.writeFile(qaPath, `${JSON.stringify(state.qa, null, 2)}\n`)
  state.artifacts.qa = relative(qaPath)
  await save(state)
  await event(state, 'render_completed', { qaPassed: state.qa.passed })
}
async function screenshot(state: RunState) {
  const target = path.join(runsRoot, state.id, 'article-mobile.png')
  try {
    await run('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless', '--disable-gpu', '--hide-scrollbars', '--window-size=390,844', `--screenshot=${target}`, pathToFileURL(path.join(root, state.artifacts.html)).href], { cwd: root, timeout: 60_000 })
    state.artifacts.screenshot = relative(target)
    return target
  }
  catch (error) {
    await event(state, 'screenshot_unavailable', { reason: error instanceof Error ? error.message.slice(0, 500) : String(error) })
    return undefined
  }
}
async function proceed(state: RunState) {
  if (state.phase === 'intake' || state.phase === 'revise') {
    state.phase = 'editorial_review'
    await save(state)
    state.editorial = await agentReview('editorial', state)
    await save(state)
    await event(state, 'editorial_completed', { verdict: state.editorial.verdict })
    if (state.editorial.verdict === 'blocked') return block(state, state.editorial.summary)
    if (state.editorial.verdict === 'revise') {
      state.attempts += 1
      if (state.attempts >= maxAttempts) return block(state, `Editorial review did not pass after ${maxAttempts} attempts: ${state.editorial.summary}`)
      state.phase = 'revise'
      await event(state, 'revision_required', { nextAction: 'Update the source Markdown externally, then resume this run.' })
      return save(state)
    }
    await render(state)
  }
  if (!state.qa?.passed) return block(state, state.qa?.findings.map(item => item.message).join('; ') ?? 'Deterministic QA failed.')
  state.phase = 'visual_qa'
  await save(state)
  const shot = await screenshot(state)
  state.visual = await agentReview('visual', state, shot)
  await save(state)
  await event(state, 'visual_completed', { verdict: state.visual.verdict, attempt: state.attempts })
  if (state.visual.verdict === 'blocked') return block(state, state.visual.summary)
  if (state.visual.verdict === 'revise') {
    state.attempts += 1
    if (state.attempts >= maxAttempts) return block(state, `Visual QA did not pass after ${maxAttempts} attempts: ${state.visual.summary}`)
    state.phase = 'revise'
    await event(state, 'revision_required', { nextAction: 'Update the source Markdown externally, then resume this run.' })
    return save(state)
  }
  state.phase = 'awaiting_draft_approval'
  await event(state, 'awaiting_draft_approval', { coverPresent: Boolean(state.cover) })
  await save(state)
}
async function block(state: RunState, reason: string) {
  state.phase = 'blocked'
  state.blockedReason = reason
  await event(state, 'blocked', { reason })
  await save(state)
}
async function start(articleArg: string, coverArg?: string) {
  const articlePath = safePath(articleArg, 'Article')
  if (path.extname(articlePath) !== '.md') throw new Error('Article must be a Markdown file.')
  const markdown = await fs.readFile(articlePath, 'utf8')
  const cover = coverArg && path.resolve(coverArg)
  if (cover) await fs.access(cover)
  const id = randomUUID()
  const dir = path.join(runsRoot, id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'source.md'), markdown)
  const coverSnapshot = cover && path.join(dir, `cover${path.extname(cover).toLowerCase()}`)
  if (coverSnapshot) await fs.copyFile(cover!, coverSnapshot)
  const state: RunState = { version: 1, id, phase: 'intake', article: relative(articlePath), title: findTitle(markdown, path.basename(articlePath, '.md')), cover: coverSnapshot && relative(coverSnapshot), approvalToken: randomBytes(18).toString('base64url'), attempts: 0, threadIds: {}, artifacts: { source: relative(path.join(dir, 'source.md')), sourceSha256: sha256(markdown), protocol: 'scripts/wechat/PROTOCOL.md', ...(coverSnapshot ? { cover: relative(coverSnapshot) } : {}) }, draft: { urlStatus: 'not_created' }, createdAt: now(), updatedAt: now() }
  await save(state)
  await event(state, 'started', { article: state.article, cover: state.cover, template: template.name })
  await proceed(state)
  return state
}
async function approveDraft(state: RunState, token: string | undefined) {
  if (state.phase !== 'awaiting_draft_approval') throw new Error(`Run is ${state.phase}; only awaiting_draft_approval can create a draft.`)
  if (!token || token !== state.approvalToken) throw new Error('A matching one-time approval token is required.')
  if (!state.cover) throw new Error('A dedicated cover is required before draft approval.')
  const currentHash = sha256(await fs.readFile(safePath(state.article, 'Article'), 'utf8'))
  if (currentHash !== state.renderedSourceSha256) throw new Error('Article changed after QA. Run resume to render and review the current version before approving a draft.')
  state.phase = 'draft'
  await event(state, 'draft_approved')
  const preflight = await invoke('md2wechat', ['inspect', state.article, '--mode', 'api', '--theme', 'elegant-navy', '--draft', '--cover', safePath(state.cover, 'Cover'), '--json'])
  if (preflight?.data?.readiness?.targets?.draft !== 'ready') {
    const blockers = preflight?.data?.readiness?.blockers ?? []
    return block(state, `WeChat draft preflight blocked: ${blockers.map((item: { message?: string }) => item.message ?? 'unknown blocker').join('; ')}`)
  }
  const output = await invoke('pnpm', ['--dir', 'vendor/doocs-md/packages/mcp-server', 'exec', 'tsx', '../../../../scripts/wechat/publish-tech-draft.mts', state.article, '--draft', '--cover', safePath(state.cover, 'Cover')])
  const mediaId = output?.draft?.media_id
  if (!mediaId) return block(state, 'WeChat draft creation returned no media_id.')
  state.draft = { mediaId, urlStatus: 'pending_editor_url' }
  state.approvalToken = '[used]'
  state.phase = 'post_draft_qa'
  await event(state, 'draft_created', { mediaId })
  state.phase = 'completed'
  await event(state, 'completed', { mediaId, urlStatus: 'pending_editor_url' })
  await save(state)
}
function summary(state: RunState) {
  return { runId: state.id, phase: state.phase, title: state.title, article: state.article, template: template.name, attempts: state.attempts, blockedReason: state.blockedReason, qa: state.qa, artifacts: state.artifacts, draft: state.draft, nextAction: state.phase === 'awaiting_draft_approval' ? `Approve with token: ${state.approvalToken}` : state.phase === 'revise' ? 'Update source Markdown externally, then run resume.' : undefined }
}
async function main() {
  if (!command || args.includes('--help')) throw new Error(usage)
  if (command === 'start') {
    const article = args.find(arg => !arg.startsWith('-'))
    if (!article) throw new Error(usage)
    const state = await start(article, valueAfter('--cover'))
    console.log(JSON.stringify(summary(await load(state.id)), null, 2))
    return
  }
  const id = args[0]
  if (!id) throw new Error(usage)
  const state = await load(id)
  if (command === 'status' || command === 'report') console.log(JSON.stringify(summary(state), null, 2))
  else if (command === 'resume') { await proceed(state); console.log(JSON.stringify(summary(await load(id)), null, 2)) }
  else if (command === 'approve-draft') { await approveDraft(state, valueAfter('--token')); console.log(JSON.stringify(summary(await load(id)), null, 2)) }
  else if (command === 'record-draft-url') {
    const url = args[1]
    if (!/^https:\/\//.test(url)) throw new Error('Draft URL must be an https URL obtained from the editor.')
    if (!state.draft?.mediaId) throw new Error('No created draft exists for this run.')
    state.draft.url = url; state.draft.urlStatus = 'recorded'; await event(state, 'draft_url_recorded'); await save(state); console.log(JSON.stringify(summary(state), null, 2))
  }
  else throw new Error(usage)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 })
