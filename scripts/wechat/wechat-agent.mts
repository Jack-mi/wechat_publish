import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Codex } from '@openai/codex-sdk'
import { deterministicQa } from './wechat-loop.mts'
import { applyTextPatches, removeLegacyTocFiller, removeLegacyTocModule, checkedLayout, defaultLayout, htmlText, imageAttributes, normalizeReferences, readbackImagesMatch, referenceEntries, referenceSection, remoteDigest, removeLegacyTitleCard, scaleSvgFonts, styleProfiles, verifiedPreviewUrl, type Layout, type RevisionScope, type TextPatch } from './article-contract.mts'
import { captureMobile } from './mobile-preview.mts'
import { bodyAssetHashes, importBodyAssets, localBodyImages } from './article-assets.mts'

export const runtime = { exec: promisify(execFile), capture: captureMobile }
const root = path.resolve(import.meta.dirname, '../..')
let vaultRoot = ''
const runsRoot = path.join(root, '.runtime', 'runs')
const maxRevisions = 3
const agentNames = ['orchestrator', 'outline', 'writer', 'structureEditor', 'styleEditor', 'visual', 'visionProbe', 'qa'] as const
type AgentName = typeof agentNames[number]
type Phase = 'intake' | 'plan' | 'outline_review' | 'research_and_write' | 'awaiting_human_fact_resolution' | 'structure_review' | 'style_review' | 'targeted_revision' | 'visual_design' | 'render' | 'full_qa' | 'revise' | 'awaiting_draft_approval' | 'draft_create' | 'draft_update' | 'post_draft_qa' | 'completed' | 'blocked'
type Finding = { severity: 'info' | 'warning' | 'error'; message: string; recommendation: string; category?: 'fact' | 'content' | 'style' | 'layout'; blocking?: boolean; evidence?: string }
type Verdict = 'pass' | 'revise' | 'blocked'
type Claim = { id: string; claim: string; location: { artifact: string; line?: number }; importance: 'supporting' | 'key'; evidence: Array<{ url: string; retrievedAt: string; excerpt: string }> }
type FactConflict = { id: string; draftClaim: string; location: { artifact: string; line?: number }; evidence: Array<{ url: string; retrievedAt: string; excerpt: string }>; severity: 'minor' | 'major'; impact: 'core_conclusion' | 'mechanism' | 'number_or_timeline' | 'recommendation'; status: 'open' | 'resolved'; decision?: 'research_wins' | 'retain_with_qualification' | 'drop_claim'; note?: string }
type AgentTask = { runId: string; agent: Exclude<AgentName, 'orchestrator'>; phase: string; objective: string; inputArtifacts: string[]; requiredOutput: string; acceptanceCriteria: string[] }
type QaMode = 'full' | 'scoped_visual' | 'deterministic'
type Operation = { id: string; action: string; phase: Phase; step?: string; startedAt: string; heartbeatAt: string; deadlineAt?: string }
export type RunState = {
  version: 2; id: string; mode: 'topic' | 'improve'; phase: Phase; title: string; goal: string; audience?: string; angle?: string
  executionMode?: 'real' | 'mock'; revisionReason?: string
  style?: string; layout?: Layout; parentRunId?: string
  localOnly?: boolean
  revision?: { scope: RevisionScope; qaMode?: QaMode; baselineSha256: string; expectedArticleSha256?: string; expectedAssetSha256?: string; expectedBodyAssets?: Record<string, string>; expectedCoverSha256?: string; expectedLayout?: Layout; removeTitleCard?: boolean; removeTocFiller?: boolean; goal: string }
  versions?: Array<{ path: string; sha256: string; phase: Phase; at: string }>
  reviewedFingerprint?: string; renderedFingerprint?: string; blockedFrom?: Phase; revisionFindings?: Finding[]
  target?: { mediaId: string; expectedRemoteDigest?: string; news?: Record<string, unknown>; preserveRemoteThumb?: boolean }
  handoff?: { key: string; url?: string; status: 'unavailable' | 'pending' | 'queued' | 'opened'; tabId?: string; verifiedAt: string }
 source?: string; cover?: string; attempts: number; renderedSourceSha256?: string
  threads: Partial<Record<AgentName, string>>; artifacts: Record<string, string>; tasks: AgentTask[]; qa?: { passed: boolean; checks: Record<string, boolean>; findings: Finding[]; verdict?: Verdict }
  draft?: { mediaId?: string; thumbMediaId?: string; url?: string; urlStatus: 'not_created' | 'pending_editor_url' | 'recorded'; mode?: 'create' | 'update'; requestId?: string; requestStartedAt?: string; resultRecordedAt?: string }
  operation?: Operation
  blockedReason?: string; createdAt: string; updatedAt: string
}

const usage = `Usage:
  pnpm --dir scripts/wechat wechat-agent topic <topic> --vault <vault-path> [--audience <text>] [--angle <text>] [--cover <image>]
  pnpm --dir scripts/wechat wechat-agent improve <article.md> --vault <vault-path> --goal <text> [--cover <image>]
  pnpm --dir scripts/wechat wechat-agent status|resume|preview|report <run-id> [--json]
  pnpm --dir scripts/wechat wechat-agent resolve-facts <run-id> --conflict <id> --decision research_wins|retain_with_qualification|drop_claim [--note <text>]
  pnpm --dir scripts/wechat wechat-agent approve-draft <run-id>
  pnpm --dir scripts/wechat wechat-agent verify-draft <run-id> [--media-id <recovered-media-id>]
  pnpm --dir scripts/wechat wechat-agent update-draft <run-id> --media-id <media-id>
  pnpm --dir scripts/wechat wechat-agent revise <run-id> --scope references|image|layout|content|style [--font-scale <ratio>] [--cover <image>] [--image-width <percent>] [--remove-title-card] [--remove-toc-filler] [--patch <json>] [--assets <json>] [--style khazix] [--goal <text>] [--version <number>] [--local-only]
  pnpm --dir scripts/wechat wechat-agent retry <run-id>
  pnpm --dir scripts/wechat wechat-agent handoff <run-id> [--status queued|opened] [--tab-id <id>]
  pnpm --dir scripts/wechat wechat-agent export <run-id> --output <vault-path>`

const now = () => new Date().toISOString()
const handoffKey = (mediaId: string) => `${process.env.CODEX_THREAD_ID ?? 'local'}:${mediaId}`
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const rel = (value: string) => path.relative(root, value)
const valueAfter = (args: string[], flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
const runDir = (id: string) => path.join(runsRoot, id)
const statePath = (id: string) => path.join(runDir(id), 'state.json')
const eventsPath = (id: string) => path.join(runDir(id), 'events.jsonl')
const operationLockPath = (id: string) => path.join(runDir(id), '.operation-lock')
const artifact = (state: RunState, key: string, fallback: string) => path.resolve(root, state.artifacts[key] ?? rel(path.join(runDir(state.id), fallback)))
const safeCoverPath = async (candidate: string) => {
  const candidates = [path.resolve(vaultRoot, candidate), path.resolve(root, candidate)]
  const allowed = candidates.filter(item => (item.startsWith(`${vaultRoot}${path.sep}`) || item.startsWith(`${root}${path.sep}`)) && Boolean(path.extname(item)))
  const resolved = await (async () => { for (const item of allowed) { try { await fs.access(item); return item } catch { /* try next root */ } } })()
  if (!resolved) throw new Error('Cover must be a file inside the explicit Vault or wechat-agent project.')
  return resolved
}
const safeVaultPath = (candidate: string, label: string) => {
  if (!vaultRoot) throw new Error('A required --vault <absolute-path> was not provided.')
  const resolved = path.resolve(vaultRoot, candidate)
  if (!resolved.startsWith(`${vaultRoot}${path.sep}`) && resolved !== vaultRoot) throw new Error(`${label} must remain inside the explicit Vault.`)
  return resolved
}
function setVault(value: string | undefined) {
  if (!value) throw new Error('This command requires --vault <absolute-path>.')
  vaultRoot = path.resolve(value)
  if (!path.isAbsolute(value) || vaultRoot === root || vaultRoot.startsWith(`${root}${path.sep}`)) throw new Error('--vault must name an external Vault, not the wechat-agent project.')
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, /(secret|token|password|api.?key|appid)/i.test(key) ? '[redacted]' : redact(child)]))
}
async function save(state: RunState) {
  state.updatedAt = now()
  if (state.operation) { state.operation.phase = state.phase; state.operation.heartbeatAt = state.updatedAt }
  const target = statePath(state.id); const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`; await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`); await fs.rename(temporary, target)
}
async function event(state: RunState, type: string, detail: Record<string, unknown> = {}) { await fs.appendFile(eventsPath(state.id), `${JSON.stringify(redact({ at: now(), type, phase: state.phase, ...detail }))}\n`) }
async function writeJson(state: RunState, key: string, fallback: string, data: unknown) {
  const target = artifact(state, key, fallback)
  const serialized = `${JSON.stringify(redact(data), null, 2)}\n`
  await fs.mkdir(path.dirname(target), { recursive: true })
  const history = path.join(runDir(state.id), 'history', `${Date.now()}-${key}-${randomUUID()}.json`)
  await fs.mkdir(path.dirname(history), { recursive: true }); await fs.writeFile(history, serialized, { flag: 'wx' })
  await fs.writeFile(target, serialized); state.artifacts[key] = rel(target); return target
}
async function writeText(state: RunState, key: string, fallback: string, data: string) {
  if (key === 'writingFinal') {
    const target = path.join(runDir(state.id), 'writing', `article-${randomUUID()}.md`)
    await fs.writeFile(target, data, { flag: 'wx' })
    state.versions ??= []; state.versions.push({ path: rel(target), sha256: sha256(data), phase: state.phase, at: now() })
    state.artifacts[key] = rel(target); return target
  }
  const target = artifact(state, key, fallback); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data); state.artifacts[key] = rel(target); return target
}
async function readJson<T>(state: RunState, key: string, fallback: string): Promise<T> { return JSON.parse(await fs.readFile(artifact(state, key, fallback), 'utf8')) as T }
async function load(id: string): Promise<RunState> { if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid run id.'); return JSON.parse(await fs.readFile(statePath(id), 'utf8')) as RunState }
function titleOf(markdown: string, fallback: string) { return (markdown.match(/^title:\s*["']?([^\n"']+)/m)?.[1] ?? markdown.match(/^#\s+(.+)$/m)?.[1] ?? fallback).trim() }
function parseJson(stdout: string) { const line = stdout.trim().split('\n').reverse().find(item => item.trim().startsWith('{')); if (!line) throw new Error('Expected JSON command output.'); return JSON.parse(line) }
async function command(bin: string, args: string[], maxBuffer = 20 * 1024 * 1024) { const output = await runtime.exec(bin, args, { cwd: root, maxBuffer }); return parseJson(output.stdout) }
function finalMarkdown(state: RunState) { return artifact(state, 'writingFinal', 'writing/article-final.md') }
function unresolvedConflicts(conflicts: FactConflict[]) { return conflicts.filter(item => item.severity === 'major' && item.status === 'open') }
function sourceRules() { return ['.agents/skills/wechat-article/references/editorial-rules.md', '.agents/skills/wechat-article/references/publishing-rules.md', '.agents/skills/wechat-article/references/conflict-resolution.md'].map(item => rel(path.join(root, item))) }

function processIsAlive(pid: unknown) {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false
  try { process.kill(Number(pid), 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

async function acquireOperation(state: RunState, action: string) {
  const lock = operationLockPath(state.id)
  const metadataPath = path.join(lock, 'owner.json')
  try { await fs.mkdir(lock) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let owner: Record<string, unknown> = {}
    try { owner = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as Record<string, unknown> } catch { /* report the unrecoverable lock below */ }
    if (!processIsAlive(owner.pid)) {
      await fs.rm(lock, { recursive: true, force: true })
      await fs.mkdir(lock)
      await event(state, 'stale_operation_lock_reclaimed', { previousOwner: owner })
    } else throw new Error(`Run is already processing ${String(owner.action ?? 'an operation')} since ${String(owner.startedAt ?? 'an unknown time')}; use status instead of starting another resume.`)
  }
  const operation: Operation = { id: randomUUID(), action, phase: state.phase, startedAt: now(), heartbeatAt: now() }
  await fs.writeFile(metadataPath, `${JSON.stringify({ ...operation, pid: process.pid }, null, 2)}\n`)
  state.operation = operation; await save(state); await event(state, 'operation_started', { operation })
  return { lock, operation }
}

async function withOperation<T>(state: RunState, action: string, work: () => Promise<T>) {
  const { lock, operation } = await acquireOperation(state, action)
  try { return await work() }
  finally {
    if (state.operation?.id === operation.id) {
      await event(state, 'operation_finished', { operationId: operation.id, action, terminalPhase: state.phase })
      delete state.operation; await save(state)
    }
    await fs.rm(lock, { recursive: true, force: true })
  }
}

function assertExecutionMode(state: RunState, legacyReadback = false) {
  const current = process.env.WECHAT_AGENT_MOCK === '1' ? 'mock' : 'real'
  if (!state.executionMode) {
    if (legacyReadback && current === 'real' && state.draft?.mediaId && !state.draft.mediaId.startsWith('mock-')) return
    throw new Error('Run execution mode is unknown (legacy run); inspect it with status/preview and start a new run before production actions.')
  }
  if (state.executionMode !== current) throw new Error(`Run execution mode is ${state.executionMode}, but the current environment is ${current}; never mix mock and real runs.`)
  if (current === 'real' && state.draft?.mediaId?.startsWith('mock-')) throw new Error('A mock media_id cannot be used in a real run.')
}

export const schemas = {
  orchestrator: { type: 'object', properties: { plan: { type: 'array', items: { type: 'string' } }, tasks: { type: 'array', items: { type: 'object', properties: { agent: { type: 'string', enum: ['outline', 'writer', 'structureEditor', 'styleEditor', 'visual', 'qa'] }, objective: { type: 'string' }, acceptanceCriteria: { type: 'array', items: { type: 'string' } } }, required: ['agent', 'objective', 'acceptanceCriteria'], additionalProperties: false } } }, required: ['plan', 'tasks'], additionalProperties: false },
  outline: { type: 'object', properties: { outline: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 }, rationale: { type: 'array', items: { type: 'string' } }, mergedOrDropped: { type: 'array', items: { type: 'string' } } }, required: ['outline', 'rationale', 'mergedOrDropped'], additionalProperties: false },
  writer: { type: 'object', properties: { outline: { type: 'array', items: { type: 'string' } }, article: { type: 'string' }, sources: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, retrievedAt: { type: 'string' }, summary: { type: 'string' } }, required: ['url', 'title', 'retrievedAt', 'summary'], additionalProperties: false } }, claims: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, claim: { type: 'string' }, location: { type: 'object', properties: { artifact: { type: 'string' }, line: { type: 'number' } }, required: ['artifact', 'line'], additionalProperties: false }, importance: { type: 'string', enum: ['supporting', 'key'] }, evidence: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, retrievedAt: { type: 'string' }, excerpt: { type: 'string' } }, required: ['url', 'retrievedAt', 'excerpt'], additionalProperties: false } } }, required: ['id', 'claim', 'location', 'importance', 'evidence'], additionalProperties: false } }, conflicts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, draftClaim: { type: 'string' }, location: { type: 'object', properties: { artifact: { type: 'string' }, line: { type: 'number' } }, required: ['artifact', 'line'], additionalProperties: false }, evidence: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, retrievedAt: { type: 'string' }, excerpt: { type: 'string' } }, required: ['url', 'retrievedAt', 'excerpt'], additionalProperties: false } }, severity: { type: 'string', enum: ['minor', 'major'] }, impact: { type: 'string', enum: ['core_conclusion', 'mechanism', 'number_or_timeline', 'recommendation'] } }, required: ['id', 'draftClaim', 'location', 'evidence', 'severity', 'impact'], additionalProperties: false } } }, required: ['outline', 'article', 'sources', 'claims', 'conflicts'], additionalProperties: false },
  structureEditor: { type: 'object', properties: { article: { type: 'string' }, summary: { type: 'string' }, checks: { type: 'array', items: { type: 'string' } }, findings: { type: 'array', items: { type: 'string' } } }, required: ['article', 'summary', 'checks', 'findings'], additionalProperties: false },
  styleEditor: { type: 'object', properties: { article: { type: 'string' }, summary: { type: 'string' }, checks: { type: 'array', items: { type: 'string' } }, findings: { type: 'array', items: { type: 'string' } } }, required: ['article', 'summary', 'checks', 'findings'], additionalProperties: false },
  patchEditor: { type: 'object', properties: { patches: { type: 'array', items: { type: 'object', properties: { before: { type: 'string' }, after: { type: 'string' } }, required: ['before', 'after'], additionalProperties: false } }, summary: { type: 'string' } }, required: ['patches', 'summary'], additionalProperties: false },
  visual: { type: 'object', properties: { coverDecision: { type: 'string' }, diagramTitle: { type: 'string' }, diagramNodes: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 5 }, alt: { type: 'string' }, findings: { type: 'array', items: { type: 'string' } } }, required: ['coverDecision', 'diagramTitle', 'diagramNodes', 'alt', 'findings'], additionalProperties: false },
  visionProbe: { type: 'object', properties: { imageCount: { type: 'number' }, firstVisibleLine: { type: 'string' }, visibleItems: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }, required: ['imageCount', 'firstVisibleLine', 'visibleItems', 'notes'], additionalProperties: false },
  qa: { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'revise', 'blocked'] }, summary: { type: 'string' }, stylePassed: { type: 'boolean' }, firstVisibleLine: { type: 'string' }, visibleItems: { type: 'array', items: { type: 'string' } }, findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['info', 'warning', 'error'] }, category: { type: 'string', enum: ['fact', 'content', 'style', 'layout'] }, blocking: { type: 'boolean' }, evidence: { type: 'string' }, message: { type: 'string' }, recommendation: { type: 'string' } }, required: ['severity', 'category', 'blocking', 'evidence', 'message', 'recommendation'], additionalProperties: false } } }, required: ['verdict', 'summary', 'stylePassed', 'firstVisibleLine', 'visibleItems', 'findings'], additionalProperties: false },
} as const

function qaModeForRevision(scope: RevisionScope, baseline: string, article: string, options: { removeTocFiller?: boolean; version?: number }): QaMode {
  if (scope === 'layout' && options.removeTocFiller) return 'deterministic'
  if (scope === 'references' && options.version === undefined) return 'deterministic'
  if (scope !== 'content') return 'full'
  const firstH2 = (value: string) => value.search(/^##\s+/m)
  const beforeOpening = baseline.slice(0, firstH2(baseline) < 0 ? baseline.length : firstH2(baseline))
  const afterOpening = article.slice(0, firstH2(article) < 0 ? article.length : firstH2(article))
  const bodyUnchanged = baseline.slice(beforeOpening.length) === article.slice(afterOpening.length)
  const structural = (value: string) => ({ headings: value.match(/^#{2,3}\s+.+$/gm) ?? [], images: value.match(/!\[[^\]]*\]\([^)]*\)/g) ?? [] })
  return bodyUnchanged && JSON.stringify(structural(baseline)) === JSON.stringify(structural(article)) ? 'scoped_visual' : 'full'
}

async function setOperationStep(state: RunState, step: string, timeoutMs?: number) {
  if (!state.operation) return
  state.operation.step = step
  state.operation.deadlineAt = timeoutMs ? new Date(Date.now() + timeoutMs).toISOString() : undefined
  await save(state); await event(state, 'operation_progress', { operationId: state.operation.id, step, timeoutMs })
}

async function runAgent<T>(state: RunState, agent: AgentName, prompt: string, schema: object, web = false, images: string[] = []): Promise<T> {
  assertExecutionMode(state)
  if (state.executionMode === 'mock') return mockAgent(agent, state) as T
  for (const image of images) {
    if (!path.isAbsolute(image)) throw new Error(`Agent ${agent} image path must be absolute so the model can actually read it: ${image}`)
    await fs.access(image)
  }
  const codex = new Codex({ config: { developer_instructions: 'Complete only the assigned article role. The current role input and JSON schema are authoritative. Do not use memories or unrelated task briefs. Do not run the article harness, edit repository files, or publish. Editing and QA must use only the supplied current article and evidence. Return exactly the requested JSON object.', features: { memories: false } } })
  const options = { workingDirectory: root, model: process.env.WECHAT_AGENT_MODEL, sandboxMode: web ? 'workspace-write' as const : 'read-only' as const, approvalPolicy: 'never' as const, networkAccessEnabled: web, webSearchMode: web ? 'live' as const : 'disabled' as const, additionalDirectories: web ? [runDir(state.id)] : [runDir(state.id), ...(vaultRoot ? [vaultRoot] : [])] }
  const thread = codex.startThread(options)
  const editorialRules = await fs.readFile(path.join(root, '.agents/skills/wechat-article/references/editorial-rules.md'), 'utf8')
  const completePrompt = `${prompt}\n\n强制编辑规则（包括问题推进、禁用分析版本叙述、语义插图）：\n${editorialRules}\n\n完整输出 JSON Schema：${JSON.stringify(schema)}\n只返回严格符合 schema 的对象，不返回文件路径或空文章。`
  const input = images.length ? [{ type: 'text' as const, text: completePrompt }, ...images.map(image => ({ type: 'local_image' as const, path: image }))] : completePrompt
  await writeJson(state, `input-${agent}`, `agents/${agent}-input.json`, { prompt: completePrompt, images, article: state.artifacts.writingFinal ?? null })
  const timeoutMs = Number(agent === 'qa'
    ? state.revision?.qaMode === 'scoped_visual' ? process.env.WECHAT_SCOPED_QA_TIMEOUT_MS ?? 90_000 : process.env.WECHAT_QA_TIMEOUT_MS ?? 240_000
    : process.env.WECHAT_AGENT_TIMEOUT_MS ?? 600_000)
  await setOperationStep(state, `${agent}:running`, timeoutMs)
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let result
  try { result = await thread.run(input, { outputSchema: schema, signal: controller.signal }); await writeJson(state, `output-${agent}`, `agents/${agent}-output.json`, { response: result.finalResponse, usage: result.usage }); await event(state, 'agent_completed', { agent, elapsedMs: Date.now() - startedAt }) }
  catch (error) {
    const timeoutError = controller.signal.aborted ? new Error(`Agent ${agent} timed out after ${Math.round(timeoutMs / 1000)}s and was aborted; it produced no verdict.`) : error
    await writeJson(state, `error-${agent}`, `agents/${agent}-error.json`, { message: timeoutError instanceof Error ? timeoutError.message : String(timeoutError) })
    throw timeoutError
  }
  finally { clearTimeout(timer); state.threads[agent] = thread.id ?? state.threads[agent]; await save(state); await setOperationStep(state, `${agent}:finished`) }
  return JSON.parse(result.finalResponse) as T
}

function mockAgent(agent: AgentName, state: RunState): unknown {
  if (agent === 'visionProbe') return { imageCount: 1, firstVisibleLine: 'Runtime 是用于验证 Harness 的项目', visibleItems: ['Runtime'], notes: 'Mock vision preflight pass.' }
  if (agent === 'orchestrator') return { plan: ['先审目录', '核验事实并写作', '结构精简', '语言润色', '视觉与 QA'], tasks: ['outline', 'writer', 'structureEditor', 'styleEditor', 'visual', 'qa'].map(agent => ({ agent, objective: 'test', acceptanceCriteria: ['test'] })) }
  if (agent === 'outline') return { outline: ['这篇文章要解释什么', '关键机制'], rationale: ['每章回答一个读者问题'], mergedOrDropped: [] }
  if (agent === 'writer') {
    const title = state.title || '未命名文章'
    return { outline: ['问题', '核心机制', '启发'], article: `---\ntitle: "${title}"\n---\n\nRuntime 是一套用于验证公众号生产 Harness 的工作流，它把写作、渲染和检查串在一起，也引出了一个问题：复杂内容怎么才能稳定交付。\n\n## 这篇文章要解释什么\n\n本文把复杂项目拆成读者能理解的工作流、工具和质量门禁。\n\n## 关键机制\n\n### 模型负责判断\n\n模型负责调研、组织和写作。\n\n### 程序负责门禁\n\n确定性工具负责渲染、格式检查与发布前验证。\n\n![架构图](../assets/architecture.svg)\n\n## 结语\n\n把专家 SOP 固化为可审计的流程，比堆叠角色更重要。\n`, sources: [], claims: [], conflicts: [] }
  }
  if (agent === 'structureEditor' || agent === 'styleEditor') return { article: `# Runtime check\n\nRuntime 是用于验证 Harness 的项目，本文从它的工作方式切入。\n\n## First\n\nBody\n\n### Detail\n\nMore\n`, summary: 'Mock editorial review pass.', checks: ['content', 'format', 'tone', 'humanization'], findings: [] }
  if (agent === 'visual') return { coverDecision: state.cover ? 'reuse supplied cover' : 'missing cover', diagramTitle: `${state.title} 的生产结构`, diagramNodes: ['写作 Agent', '编辑 Agent', '视觉 Agent', 'QA Agent'], alt: '四个节点串联展示写作、编辑润色、视觉和质量审核。', findings: [] }
  return { verdict: 'pass', summary: 'Mock QA pass.', stylePassed: true, firstVisibleLine: 'Runtime 是用于验证 Harness 的项目', visibleItems: ['Runtime'], findings: [] }
}

function orchestratorPrompt(state: RunState) { return `你是公众号生产主 Agent。只能规划、派单和裁决，不能改写正文、生成生产 HTML/CSS、上传图片或调用公众号接口。\n运行 ID：${state.id}\n模式：${state.mode}\n目标：${state.goal}\n输入：${state.source ?? '主题：' + state.title}\n规则文件：${sourceRules().join('、')}\n必须依次安排 outline、writer、structureEditor、styleEditor、visual、qa。outline 先审目录；两个编辑 Agent 分别负责结构和语言，不能合并。` }
function outlinePrompt(state: RunState, source: string) { return `你是公众号目录编辑 Agent，只做目录设计，不写正文。\n目标：${state.goal}\n受众：${state.audience ?? '对 AI / Agent 感兴趣的技术读者'}\n输入：\n${source}\n\n给出 1 至 6 个一级章节。每章必须回答一个读者能直接理解的问题，并说明其存在理由；第一章应能在 3 段内讲清，结语不单列，过细或重复内容应合并或删除。避免抽象标题。` }
function writerPrompt(state: RunState, source: string, decisions: FactConflict[], approvedOutline: string[]) { return `你是公众号写作与事实核验 Agent。只读工作区；可以使用公开网页检索核验关键事实；不得调用发布工具或生成 HTML/CSS。\n运行 ID：${state.id}\n目标：${state.goal}\n受众：${state.audience ?? '对 AI / Agent 感兴趣的技术读者'}\n已审定目录（必须遵守）：${JSON.stringify(approvedOutline)}\n原始输入：\n${source}\n\n人工已裁决的事实冲突：${JSON.stringify(decisions.filter(item => item.status === 'resolved').map(item => ({ id: item.id, decision: item.decision, note: item.note })))}\n\n输出完整 Markdown。H1 标题之后、第一章之前必须先用一段通俗易懂的自然文字介绍项目，并顺势引出本文要讨论的话题；不要加“项目引子”“项目因子”或任何字段标签，不要使用引用块或清单。不要自行写文章目录。第一章再补充必要的项目背景（项目是什么、谁在做、为何出现、最近为何被讨论），然后进入问题。第一章不超过 3 段，不单设结语；重大事实冲突写入 conflicts。正文不要显示 [1][2] 引用编号，来源只放文末参考来源。` }
function structurePrompt(state: RunState, markdown: string) { return `你是独立的公众号结构编辑 Agent。只编辑运行副本，不联网，不新增事实。\n目标：${state.goal}\n工作稿：\n${markdown}\n\n实际重写全文：删重复、并细碎章节、压缩开头与第一章；一级章节默认 4 至 6 个，第一章最多 3 段，结语并入最后一章。每章只回答一个具体问题。保留 frontmatter、事实、来源和图片。输出完整 Markdown。` }
function stylePrompt(state: RunState, markdown: string) { return `你是独立的公众号语言编辑 Agent。只编辑运行副本，不联网，不新增事实。\n目标：${state.goal}\n工作稿：\n${markdown}\n\n实际重写全文：去掉空话、机械过渡、反复总结和抽象 AI 词；标题优先写成具体问题、动作或后果。重点检查宿主、自动兑现、canonical workflow、统一口径、赋能、闭环、沉淀、方法论、范式、抓手、底层逻辑。开头和第一章适度加粗重点，正文不显示引用编号。保留 frontmatter、事实、来源、图片和 H2/H3。输出完整 Markdown。` }
function visualPrompt(state: RunState, markdown: string) { return `你是微信公众号视觉 Agent。只读工作区，不改写正文、不调用公众号接口。\n文章标题：${state.title}\n工作稿：\n${markdown}\n\n判断是否复用现有封面，逐图检查图片是否解释附近的具体问题，390px手机上的文字和单位是否清晰。不要为了凑图，把并列关系、实验数据或比较强行改成流程图。只有工作稿已在适当位置引用 architecture.svg 且确实需要顺序机制示意时，才用 diagramTitle、diagramNodes、alt 给出准确的 3-5 节点单链；无需流程图时标题和alt返回空字符串，diagramNodes返回空数组。需要数据图、对照图或其他自定义插图时，在findings说明位置、用途和证据，交由content修订的--assets导入，不虚构数据。程序不再自动在文末插入通用图。` }
function qaPrompt(state: RunState, markdown: string, deterministic: unknown) {
  const scoped = state.revision?.qaMode === 'scoped_visual'
  const images = scoped ? '390px 移动端首屏和独立封面' : '390px 移动端首屏、按顺序的重叠分段截图和独立封面'
  const scope = scoped
    ? '本轮只改了开头自然引入，且章节、图片、封面和其余正文已经由差异校验锁定。只检查首屏开场是否通俗、无标签、可读，以及封面主题。'
    : '全文长图已由分段覆盖，不再单独附上。必须直接依据图片检查开头自然项目介绍、第一章到第二章过渡、正文中段与文章末尾的字号、段距、标题留白、裁切和换行；不能仅根据 Markdown 宣称视觉检查通过。'
  return `你是独立公众号 QA Agent。只读，不改写文章，不操作草稿。\n工作稿：\n${markdown}\n\n确定性 QA：${JSON.stringify(deterministic)}\n附带图片依次为 ${images}。${scope} 禁止运行 OCR、tesseract、Vision、像素分析或任何命令行替代手段；若截图内容不可读，立即 verdict=blocked 并在 summary 说明模型无法读取截图。渲染 HTML：${artifact(state, 'html', 'render/article.html')}。\n检查事实可追溯、读者门槛、标题层级、代码块规则、视觉资产与发布风险。正文开头应是一段自然的项目介绍和话题引入，不能含“项目引子”“项目因子”标签或字段清单。必须返回 firstVisibleLine（首屏最顶部可见文字）和 visibleItems（开头介绍中实际读到的项目名或关键词）；若看不到图，两个字段留空。错误级问题必须 verdict=blocked；需改但可继续则 revise。`
}

export function diagramSvg(title: string, nodes: string[]) {
 const text = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
 const width = 780
 const boxHeight = 132
 const gap = 60
 const top = 150
 const height = top + nodes.length * boxHeight + Math.max(nodes.length - 1, 0) * gap + 60
 const fit = (value: string, wide: number, narrow: number) => value.length > 10 ? narrow : wide
 const boxes = nodes.map((node, index) => {
  const y = top + index * (boxHeight + gap)
  const arrow = index < nodes.length - 1 ? `<path d="M${width / 2} ${y + boxHeight}V${y + boxHeight + gap - 18}" stroke="#78c7ee" stroke-width="6" marker-end="url(#arrow)"/>` : ''
  return `<g>${arrow}<rect x="50" y="${y}" width="${width - 100}" height="${boxHeight}" rx="20" fill="#12355b" stroke="#90ddff" stroke-width="3"/><text x="390" y="${y + 80}" text-anchor="middle" fill="#fff" font-size="${fit(node, 40, 30)}" font-weight="700" font-family="Arial, PingFang SC, sans-serif">${text(node)}</text></g>`
 }).join('')
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#071a36"/><stop offset="1" stop-color="#1b5a88"/></linearGradient><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#78c7ee"/></marker></defs><rect width="${width}" height="${height}" fill="url(#bg)"/><text x="390" y="95" text-anchor="middle" fill="#fff" font-size="${fit(title, 44, 32)}" font-weight="700" font-family="Arial, PingFang SC, sans-serif">${text(title)}</text>${boxes}</svg>`
}

async function createRun(mode: RunState['mode'], input: string, options: { goal: string; audience?: string; angle?: string; cover?: string; style?: string; layout?: Partial<Layout> }) {
  if (options.style && !styleProfiles[options.style]) throw new Error(`Unknown style: ${options.style}. Choose ${Object.keys(styleProfiles).join(', ')}.`)
  const id = randomUUID(); const dir = runDir(id); await fs.mkdir(path.join(dir, 'input'), { recursive: true }); await fs.mkdir(path.join(dir, 'writing'), { recursive: true }); await fs.mkdir(path.join(dir, 'assets'), { recursive: true })
  let source: string | undefined; let raw = ''
  if (mode === 'improve') { source = safeVaultPath(input, 'Article'); if (path.extname(source) !== '.md') throw new Error('improve requires a Markdown article.'); raw = await fs.readFile(source, 'utf8'); await fs.writeFile(path.join(dir, 'input', 'source.md'), raw) }
  else { raw = `# ${input}\n`; await fs.writeFile(path.join(dir, 'input', 'source.md'), raw) }
  let cover: string | undefined
 if (options.cover) { const coverPath = await safeCoverPath(options.cover); const target = path.join(dir, 'assets', `cover${path.extname(coverPath).toLowerCase()}`); await fs.copyFile(coverPath, target); cover = rel(target) }
 const state: RunState = { version: 2, id, mode, executionMode: process.env.WECHAT_AGENT_MOCK === '1' ? 'mock' : 'real', phase: 'intake', title: mode === 'improve' ? titleOf(raw, path.basename(source!, '.md')) : input, goal: options.goal, audience: options.audience, angle: options.angle, source: source ? rel(source) : undefined, cover, attempts: 0, threads: {}, artifacts: { sourceSnapshot: rel(path.join(dir, 'input', 'source.md')) }, tasks: [], draft: { urlStatus: 'not_created' }, createdAt: now(), updatedAt: now() }
  state.style = options.style ?? 'neutral'; state.layout = checkedLayout(options.layout); state.versions = []
  await save(state); await event(state, 'run_created', { mode, source: state.source, title: state.title }); return state
}

export async function createRevision(parent: RunState, options: { scope: RevisionScope; goal?: string; patches?: TextPatch[]; assets?: Record<string, string>; fontScale?: number; cover?: string; imageWidthPercent?: number; removeTitleCard?: boolean; removeTocFiller?: boolean; style?: string; version?: number; localOnly?: boolean }) {
  assertExecutionMode(parent)
  const localOnly = Boolean(options.localOnly || parent.localOnly)
  if (!['completed', 'awaiting_draft_approval', 'blocked', 'post_draft_qa'].includes(parent.phase)) throw new Error('Only a completed, reviewed, blocked or sent-but-unverified run can be revised; resume active work first.')
  if (!['content', 'style', 'references', 'image', 'layout'].includes(options.scope)) throw new Error('Invalid revision scope.')
  for (const [option, scope] of Object.entries({ patches: 'content', assets: 'content', fontScale: 'image', cover: 'image', imageWidthPercent: 'layout', removeTitleCard: 'layout', removeTocFiller: 'layout', style: 'style' })) {
    if (options[option as keyof typeof options] !== undefined && options.scope !== scope) throw new Error(`${option} is outside the ${options.scope} revision scope.`)
  }
  const conflicts = await readJson<FactConflict[]>(parent, 'conflicts', 'research/conflicts.json')
  if (unresolvedConflicts(conflicts).length) throw new Error('Resolve major fact conflicts before revising.')
  if (options.scope === 'content' && !options.patches?.length) throw new Error('Content revisions require an explicit before/after patch file.')
  if (options.scope === 'style' && (!options.style || !options.goal)) throw new Error('Style revisions require --style and --goal.')
  if (options.scope === 'image' && options.fontScale === undefined && !options.cover) throw new Error('Image revisions require --font-scale or --cover.')
  if (options.scope === 'layout' && options.imageWidthPercent === undefined && !options.removeTitleCard && !options.removeTocFiller) throw new Error('Layout revisions require --image-width, --remove-title-card or --remove-toc-filler.')
  const version = options.version === undefined ? undefined : parent.versions?.[options.version - 1]
  if (options.version !== undefined && (!Number.isInteger(options.version) || !version)) throw new Error('Unknown article version.')
  const baseline = await fs.readFile(version ? path.resolve(root, version.path) : finalMarkdown(parent), 'utf8')
  if (version && sha256(baseline) !== version.sha256) throw new Error('Historical version was modified; refusing to restore it.')
  const previousHtml = await fs.readFile(artifact(parent, 'html', 'render/article.html'), 'utf8')
  const width = Number(imageAttributes(previousHtml)[0]?.width.replace('%', ''))
  const layout = checkedLayout(parent.layout ?? { imageWidthPercent: width >= 20 && width <= 100 ? width : 100 })
  if (options.scope === 'layout' && options.imageWidthPercent !== undefined) layout.imageWidthPercent = checkedLayout({ imageWidthPercent: options.imageWidthPercent }).imageWidthPercent
  let article = baseline
  if (options.scope === 'content') article = applyTextPatches(baseline, options.patches!)
  if (options.scope === 'references') article = normalizeReferences(baseline)
  let svg = await fs.readFile(artifact(parent, 'architecture', 'assets/architecture.svg'), 'utf8')
  if (options.scope === 'image' && options.fontScale !== undefined) svg = scaleSvgFonts(svg, options.fontScale)
  let target: RunState['target']
  if (parent.draft?.mediaId || parent.target?.mediaId) {
    const mediaId = parent.draft?.mediaId ?? parent.target!.mediaId
    if (parent.executionMode === 'real' && !localOnly) {
      const news = draftNewsItem(await getDraft(mediaId))
      const prior = parent.draft?.mediaId ? draftNewsItem((await readJson<{ response: Record<string, unknown> }>(parent, 'readback', 'publish/readback.json')).response) : parent.target?.news
      if (!prior || remoteDigest(news) !== remoteDigest(prior)) {
        const priorText = prior ? htmlText(String(prior.content ?? '')) : ''
        if (!prior || !priorText || priorText !== htmlText(String(news.content ?? ''))) throw new Error('Remote draft changed since the last verified baseline; reconcile it before creating a revision.')
        await event(parent, 'remote_reconciled', { mediaId, markupOnly: true })
      }
      const lastUploadedThumb = parent.draft?.thumbMediaId ?? parent.target?.news?.thumb_media_id
      const preserveRemoteThumb = Boolean(lastUploadedThumb && news.thumb_media_id && news.thumb_media_id !== lastUploadedThumb)
      if (preserveRemoteThumb) await event(parent, 'remote_cover_preserved', { mediaId, remoteThumb: news.thumb_media_id })
      target = { mediaId, expectedRemoteDigest: remoteDigest(news), news, preserveRemoteThumb }
    } else target = { mediaId }
  }
  const state = await createRun('topic', parent.title, { goal: options.goal ?? `Only revise ${options.scope}; preserve everything outside this scope.`, audience: parent.audience, cover: options.cover ?? (parent.cover && path.resolve(root, parent.cover)), style: options.style ?? parent.style ?? 'preserve', layout })
  state.parentRunId = parent.id; state.target = target; state.localOnly = localOnly
  if (parent.handoff?.tabId && target && parent.handoff.key === handoffKey(target.mediaId)) state.handoff = { key: parent.handoff.key, status: 'unavailable', verifiedAt: '', tabId: parent.handoff.tabId }
  await fs.writeFile(path.join(runDir(state.id), 'input', 'baseline.md'), baseline)
  state.artifacts.baseline = rel(path.join(runDir(state.id), 'input', 'baseline.md'))
  await fs.writeFile(path.join(runDir(state.id), 'input', 'baseline.html'), previousHtml)
  if (options.version === undefined) state.artifacts.baselineHtml = rel(path.join(runDir(state.id), 'input', 'baseline.html'))
  for (const key of ['sources', 'claims', 'conflicts', 'approvedOutline', 'visualBrief']) {
    if (!parent.artifacts[key]) continue
    const destination = path.join(runDir(state.id), path.relative(runDir(parent.id), path.resolve(root, parent.artifacts[key])))
    if (!destination.startsWith(`${runDir(state.id)}${path.sep}`)) throw new Error('Parent artifact escaped its run directory.')
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(path.resolve(root, parent.artifacts[key]), destination); state.artifacts[key] = rel(destination)
  }
  const asset = path.join(runDir(state.id), 'assets', 'architecture.svg'); await fs.writeFile(asset, svg); state.artifacts.architecture = rel(asset)
  const expectedBodyAssets = await importBodyAssets(article, runDir(parent.id), runDir(state.id), options.assets, root)
  state.revision = { scope: options.scope, baselineSha256: sha256(baseline), expectedArticleSha256: options.scope === 'style' ? undefined : sha256(article), expectedAssetSha256: sha256(svg), expectedCoverSha256: state.cover ? sha256(await fs.readFile(path.resolve(root, state.cover))) : undefined, expectedLayout: { ...layout }, goal: state.goal }
  state.revision.expectedBodyAssets = expectedBodyAssets
  state.revision.qaMode = qaModeForRevision(options.scope, baseline, article, options)
  await writeText(state, 'writingFinal', '', article)
  if (options.removeTitleCard) state.revision.removeTitleCard = true
  if (options.removeTocFiller) state.revision.removeTocFiller = true
  await writeJson(state, 'revisionManifest', 'revision.json', { parentRunId: parent.id, options, qaMode: state.revision.qaMode, baselineSha256: sha256(baseline), expectedArticleSha256: state.revision.expectedArticleSha256, expectedAssetSha256: state.revision.expectedAssetSha256 })
  state.phase = options.scope === 'style' ? 'style_review' : 'render'
  await event(state, 'scoped_revision_created', { scope: options.scope, parentRunId: parent.id }); await save(state)
  return state
}

async function assertRevisionScope(state: RunState) {
  const revision = state.revision
  if (!revision) return
  if (revision.expectedArticleSha256 && sha256(await fs.readFile(finalMarkdown(state))) !== revision.expectedArticleSha256) throw new Error('Revision changed article text outside its approved scope.')
  if (revision.expectedAssetSha256 && sha256(await fs.readFile(artifact(state, 'architecture', 'assets/architecture.svg'))) !== revision.expectedAssetSha256) throw new Error('Revision changed its locked image asset.')
  if (revision.expectedCoverSha256 && (!state.cover || sha256(await fs.readFile(path.resolve(root, state.cover))) !== revision.expectedCoverSha256)) throw new Error('Revision changed its locked cover asset.')
  if (revision.expectedLayout && JSON.stringify(state.layout) !== JSON.stringify(revision.expectedLayout)) throw new Error('Revision changed its locked layout.')
  if (revision.expectedBodyAssets && JSON.stringify(await bodyAssetHashes(await fs.readFile(finalMarkdown(state), 'utf8'), runDir(state.id))) !== JSON.stringify(revision.expectedBodyAssets)) throw new Error('Revision changed its locked body illustrations.')
}

async function artifactFingerprint(state: RunState, includeRender = true) {
  const values: Record<string, string> = { layout: JSON.stringify(state.layout ?? defaultLayout), style: state.style ?? 'neutral' }
  for (const [key, filename] of Object.entries({ article: finalMarkdown(state), architecture: state.artifacts.architecture, cover: state.cover, ...(includeRender ? { html: state.artifacts.html, payload: state.artifacts.draftPayload } : {}) })) {
    if (filename) values[key] = sha256(await fs.readFile(path.resolve(root, filename)))
  }
  const bodyAssets = await bodyAssetHashes(await fs.readFile(finalMarkdown(state), 'utf8'), runDir(state.id))
  for (const [reference, hash] of Object.entries(bodyAssets)) values[`body:${reference}`] = hash
  return sha256(JSON.stringify(values))
}

async function plan(state: RunState) {
  state.phase = 'plan'; await save(state); const output = await runAgent<{ plan: string[]; tasks: Array<{ agent: Exclude<AgentName, 'orchestrator'>; objective: string; acceptanceCriteria: string[] }> }>(state, 'orchestrator', orchestratorPrompt(state), schemas.orchestrator)
  state.tasks = output.tasks.map(item => ({ runId: state.id, agent: item.agent, phase: item.agent === 'outline' ? 'outline_review' : item.agent === 'writer' ? 'research_and_write' : item.agent === 'structureEditor' ? 'structure_review' : item.agent === 'styleEditor' ? 'style_review' : item.agent === 'visual' ? 'visual_design' : 'full_qa', objective: item.objective, inputArtifacts: [state.artifacts.sourceSnapshot, ...sourceRules()], requiredOutput: `${item.agent}.json`, acceptanceCriteria: item.acceptanceCriteria }))
  await writeJson(state, 'plan', 'plan.json', output); await writeJson(state, 'tasks', 'tasks.json', state.tasks); await event(state, 'plan_completed', { tasks: state.tasks.map(task => task.agent) }); state.phase = 'outline_review'; await save(state)
}

async function outlineReview(state: RunState) {
  state.phase = 'outline_review'; await save(state)
  const source = await fs.readFile(artifact(state, 'sourceSnapshot', 'input/source.md'), 'utf8')
  const result = await runAgent<{ outline: string[]; rationale: string[]; mergedOrDropped: string[] }>(state, 'outline', outlinePrompt(state, source), schemas.outline)
  await writeJson(state, 'approvedOutline', 'writing/outline-approved.json', result)
  await event(state, 'outline_completed', { chapters: result.outline.length, mergedOrDropped: result.mergedOrDropped.length })
  state.phase = 'research_and_write'; await save(state)
}

async function researchAndWrite(state: RunState) {
  state.phase = 'research_and_write'; await save(state); const raw = await fs.readFile(artifact(state, 'sourceSnapshot', 'input/source.md'), 'utf8'); let prior: FactConflict[] = []
  try { prior = await readJson<FactConflict[]>(state, 'conflicts', 'research/conflicts.json') } catch { /* first research pass */ }
  const approved = await readJson<{ outline: string[] }>(state, 'approvedOutline', 'writing/outline-approved.json')
  const current = state.artifacts.writingFinal ? await fs.readFile(finalMarkdown(state), 'utf8') : raw
  const prompt = `${writerPrompt(state, current, prior, approved.outline)}\n目标文风：${styleProfiles[state.style ?? 'neutral']}${state.revisionReason ? `\n\n上次 QA 要求修改：${state.revisionReason}。以上是当前稿，只修指定事实，禁止从旧原稿重新写作。` : ''}`
  const result = await runAgent<{ outline: string[]; article: string; sources: unknown[]; claims: Claim[]; conflicts: Omit<FactConflict, 'status'>[] }>(state, 'writer', prompt, schemas.writer, true)
  if (!result.article.includes('## ')) throw new Error('Writer output must contain H2 headings.')
  const revision = state.attempts + 1; await writeJson(state, 'outline', 'writing/outline.json', result.outline); await writeJson(state, 'sources', 'research/sources.json', result.sources); await writeJson(state, 'claims', 'research/claims.json', result.claims)
  const conflicts: FactConflict[] = result.conflicts.map(item => {
    const priorConflict = prior.find(existing => existing.id === item.id)
    return priorConflict?.status === 'resolved' ? { ...item, status: 'resolved', decision: priorConflict.decision, note: priorConflict.note } : { ...item, status: 'open' }
  }); await writeJson(state, 'conflicts', 'research/conflicts.json', conflicts)
  await writeText(state, 'writingFinal', `writing/article-r${revision}.md`, normalizeReferences(result.article)); await event(state, 'writer_completed', { claims: result.claims.length, conflicts: conflicts.length })
  if (unresolvedConflicts(conflicts).length) { state.phase = 'awaiting_human_fact_resolution'; await event(state, 'fact_conflict_requires_human', { conflicts: unresolvedConflicts(conflicts).map(item => item.id) }); await save(state); return }
  state.phase = 'structure_review'; await save(state)
}

async function structureReview(state: RunState) {
  state.phase = 'structure_review'; await save(state)
  const markdown = await fs.readFile(finalMarkdown(state), 'utf8')
  const evidence = await readJson(state, 'claims', 'research/claims.json')
  const result = await runAgent<{ article: string; summary: string; checks: string[]; findings: string[] }>(state, 'structureEditor', `${structurePrompt(state, markdown)}\n事实核对账本（不可当作另一个待重写稿）：${JSON.stringify(evidence)}\n目标文风必须保留：${styleProfiles[state.style ?? 'neutral']}。只改确有问题的部分，不为重写而重写。`, schemas.structureEditor)
  if (!result.article.includes('## ')) throw new Error('Editor output must preserve H2 headings.')
  await writeText(state, 'writingFinal', `writing/article-r${state.attempts + 1}-structured.md`, normalizeReferences(result.article))
  await writeJson(state, 'structureReview', 'editor/structure-review.json', result)
  await event(state, 'structure_editor_completed', { findings: result.findings.length })
  state.phase = 'style_review'; await save(state)
}

async function styleReview(state: RunState) {
  state.phase = 'style_review'; await save(state)
  const markdown = await fs.readFile(finalMarkdown(state), 'utf8')
  const result = await runAgent<{ article: string; summary: string; checks: string[]; findings: string[] }>(state, 'styleEditor', `${stylePrompt(state, markdown)}\n目标文风：${styleProfiles[state.style ?? 'neutral']}\n当前修订范围：${state.revision?.scope ?? 'new article'}；${state.revision?.goal ?? ''}。本轮工作稿是唯一可修改版本，保留事实、来源及图片。不得回读原始稿或历史任务指令。`, schemas.styleEditor)
  if (!result.article.includes('## ')) throw new Error('Editor output must preserve H2 headings.')
  if (/^文章目录\s*$/m.test(result.article)) throw new Error('Editor must not add an article directory; the template has none.')
  if (state.revision?.scope === 'style') {
    if (JSON.stringify(referenceEntries(result.article)) !== JSON.stringify(referenceEntries(markdown))) throw new Error('Style rewrite changed its evidence sources.')
    if (JSON.stringify(result.article.match(/!\[[^\]]*\]\([^)]*\)/g)) !== JSON.stringify(markdown.match(/!\[[^\]]*\]\([^)]*\)/g))) throw new Error('Style rewrite changed image references.')
    if (result.article === markdown) throw new Error('Requested style rewrite returned the unchanged article.')
  }
  await writeText(state, 'writingFinal', `writing/article-r${state.attempts + 1}-styled.md`, normalizeReferences(result.article))
  await writeJson(state, 'styleReview', 'editor/style-review.json', result)
  await event(state, 'style_editor_completed', { findings: result.findings.length })
  state.phase = state.revision && state.artifacts.architecture ? 'render' : 'visual_design'; await save(state)
}

async function targetedRevision(state: RunState) {
  state.phase = 'targeted_revision'; await save(state)
  const markdown = await fs.readFile(finalMarkdown(state), 'utf8')
  const result = await runAgent<{ patches: TextPatch[]; summary: string }>(state, 'styleEditor', `你是局部修改编辑。只修当前稿中下面明确的问题，返回精确before/after替换数组，before必须唯一匹配。不要全文重写，不添加事实，不改图片或来源，不改其他已合格段落。\n所有待修问题：${JSON.stringify(state.revisionFindings?.length ? state.revisionFindings : state.revisionReason)}\n当前唯一工作稿：\n${markdown}`, schemas.patchEditor)
  if (!result.patches.length) throw new Error('QA requested a correction but the editor returned no patches.')
  const article = applyTextPatches(markdown, result.patches)
  if (article === markdown) throw new Error('Targeted correction made no change.')
  if (JSON.stringify(referenceEntries(article)) !== JSON.stringify(referenceEntries(markdown))) throw new Error('QA text correction changed evidence sources.')
  if (JSON.stringify(article.match(/!\[[^\]]*\]\([^)]*\)/g)) !== JSON.stringify(markdown.match(/!\[[^\]]*\]\([^)]*\)/g))) throw new Error('QA text correction changed image references.')
  await writeText(state, 'writingFinal', '', article)
  await writeJson(state, 'revisionPatch', 'editor/revision-patch.json', result)
  state.phase = 'render'; await save(state)
}

async function visualDesign(state: RunState) {
  state.phase = 'visual_design'; await save(state); const markdown = await fs.readFile(finalMarkdown(state), 'utf8'); const result = await runAgent<{ coverDecision: string; diagramTitle: string; diagramNodes: string[]; alt: string; findings: string[] }>(state, 'visual', visualPrompt(state, markdown), schemas.visual)
  if (!state.cover && state.mode === 'topic') {
    const cover = state.executionMode === 'mock'
      ? path.join(runDir(state.id), 'assets', 'cover.png')
      : undefined
    if (cover) { await fs.writeFile(cover, 'mock cover'); state.cover = rel(cover) }
    else {
      const generated = state.artifacts.coverGeneration
        ? await readJson<Record<string, unknown>>(state, 'coverGeneration', 'visual/cover-generation.json')
        : await command('md2wechat', ['generate_cover', '--title', state.title, '--summary', state.goal, '--keywords', state.angle ?? 'AI, Agent, 技术解读', '--preset', 'cover-data-visual', '--style', '主题相关、克制可信、无人物、无文字、无品牌标识、无水印', '--aspect', '2.35:1', '--size', '3000x1277', '--model', process.env.WECHAT_COVER_MODEL ?? 'doubao-seedream-5-0-lite-260128', '--json'])
      if (generated.success === false) throw new Error(`Cover generation failed: ${generated.message ?? generated.code ?? 'unknown error'}`)
      const data = generated.data as Record<string, unknown> | undefined
      const output = data?.output_file
      if (!state.artifacts.coverGeneration) { await writeJson(state, 'coverGeneration', 'visual/cover-generation.json', generated); await save(state) }
      if (typeof output === 'string' && output) {
        const target = path.join(runDir(state.id), 'assets', `cover${path.extname(output) || '.png'}`)
        await fs.copyFile(output, target); state.cover = rel(target)
      } else {
        const remote = data?.original_url
        if (typeof remote !== 'string' || !remote.startsWith('https://')) throw new Error('Cover generation returned no local file or HTTPS original_url.')
        const response = await fetch(remote, { signal: AbortSignal.timeout(60000) })
        const type = response.headers.get('content-type')?.split(';')[0]
        const extension = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' } as Record<string, string>)[type ?? '']
        if (!response.ok || !extension) throw new Error(`Cover download failed: HTTP ${response.status}, ${type ?? 'missing content type'}`)
        const bytes = Buffer.from(await response.arrayBuffer())
        if (!bytes.length) throw new Error('Cover download returned an empty image.')
        const target = path.join(runDir(state.id), 'assets', `cover${extension}`)
        await fs.writeFile(target, bytes); state.cover = rel(target)
      }
      await save(state)
    }
    await event(state, 'cover_generated', { cover: state.cover })
  }
  if (!state.cover) { state.phase = 'blocked'; state.blockedReason = 'A dedicated cover is required before visual production.'; await event(state, 'blocked', { reason: state.blockedReason }); await save(state); return }
  if (localBodyImages(markdown).includes('../assets/architecture.svg') && (!result.diagramTitle.trim() || !result.alt.trim() || result.diagramNodes.length < 3)) throw new Error('A referenced mechanism diagram requires a title, alt text and at least three meaningful nodes.')
  const svg = path.join(runDir(state.id), 'assets', 'architecture.svg'); await fs.writeFile(svg, diagramSvg(result.diagramTitle, result.diagramNodes)); state.artifacts.architecture = rel(svg); await writeJson(state, 'visualBrief', 'visual/brief.json', result); await writeJson(state, 'assetManifest', 'assets/manifest.json', { cover: state.cover, architecture: state.artifacts.architecture, alt: result.alt, generatedAt: now() })
  await event(state, 'visual_completed', { architecture: state.artifacts.architecture }); state.phase = 'render'; await save(state)
}

async function render(state: RunState) {
  state.phase = 'render'; await save(state); const source = finalMarkdown(state); const bytes = await fs.readFile(source); state.renderedSourceSha256 = sha256(bytes)
  const html = path.join(runDir(state.id), 'render', 'article.html'); const draftPayload = path.join(runDir(state.id), 'render', 'draft-payload.json'); await fs.mkdir(path.dirname(html), { recursive: true }); await fs.mkdir(path.dirname(draftPayload), { recursive: true })
  await assertRevisionScope(state)
  const inputFingerprint = await artifactFingerprint(state, false)
  const result = await command('pnpm', ['--dir', 'vendor/doocs-md/packages/mcp-server', 'exec', 'tsx', '../../../../scripts/wechat/publish-tech-draft.mts', source, '--html', html, '--draft-json', draftPayload, '--image-width', String((state.layout ?? defaultLayout).imageWidthPercent)])
  state.artifacts.html = rel(String(result.html)); state.artifacts.draftPayload = rel(draftPayload); const output = await fs.readFile(html, 'utf8'); state.qa = deterministicQa(await fs.readFile(source, 'utf8'), output, state.cover)
  if (state.artifacts.baselineHtml && ['references', 'image', 'layout'].includes(state.revision?.scope ?? '')) {
    const baseline = await fs.readFile(path.resolve(root, state.artifacts.baselineHtml), 'utf8')
    let comparable = state.revision?.scope === 'layout' && state.revision.removeTitleCard ? removeLegacyTitleCard(baseline) : baseline
    if (state.revision?.scope === 'layout' && (state.revision.removeTocFiller || state.revision.removeTitleCard)) comparable = removeLegacyTocModule(comparable)
    const before = htmlText(comparable); const after = htmlText(output)
    const sameText = state.revision?.scope === 'references' ? before.split('参考来源')[0] === after.split('参考来源')[0] : before === after
    if (!sameText) throw new Error('Scoped rendering changed visible text outside the requested area.')
    await writeJson(state, 'scopeCheck', 'qa/scope-check.json', { scope: state.revision?.scope, removedTitleCard: Boolean(state.revision?.removeTitleCard) && comparable !== baseline, removedTocFiller: Boolean(state.revision?.removeTocFiller) && removeLegacyTocModule(baseline) !== baseline, unchangedBody: true, unchangedCompleteText: htmlText(baseline) === after, inheritedTemplateText: htmlText(baseline.match(/<section\b[^>]*class="wx-cta"[\s\S]*$/)?.[0] ?? ''), beforeSha256: sha256(baseline), afterSha256: sha256(output) })
  }
  await writeJson(state, 'deterministicQa', 'qa/deterministic.json', state.qa); await event(state, 'render_completed', { passed: state.qa.passed })
  if (inputFingerprint !== await artifactFingerprint(state, false)) throw new Error('Article or assets changed during rendering; rerender before review.')
  state.renderedFingerprint = await artifactFingerprint(state)
  state.phase = state.qa.passed ? 'full_qa' : 'blocked'
  if (!state.qa.passed) { state.blockedFrom = 'render'; state.blockedReason = state.qa.findings.map(item => item.message).join('; '); await event(state, 'blocked', { reason: state.blockedReason }) }
  state.reviewedFingerprint = undefined
  await save(state)
}

async function screenshots(state: RunState, fullArticle = true) {
  const html = artifact(state, 'html', 'render/article.html')
  try {
    const captured = await runtime.capture(html, path.join(runDir(state.id), 'render'), { fullArticle })
    const files = captured.files
    state.artifacts.mobileFirst = rel(files[0])
    if (fullArticle) state.artifacts.mobileFull = rel(files[1])
    else delete state.artifacts.mobileFull
    await writeJson(state, 'mobileMetrics', 'render/mobile-metrics.json', captured.metrics)
    state.artifacts.screenshot = state.artifacts.mobileFirst
    return captured
  } catch (error) { throw new Error(`Mobile screenshot failed: ${error instanceof Error ? error.message : String(error)}`) }
}

async function fullQa(state: RunState) {
  state.phase = 'full_qa'; await save(state)
  const markdown = await fs.readFile(finalMarkdown(state), 'utf8')
  const before = await artifactFingerprint(state)
  if (before !== state.renderedFingerprint) throw new Error('Rendered artifacts changed before QA; rerender before review.')
  const qaMode = state.revision?.qaMode ?? 'full'
  await setOperationStep(state, qaMode === 'full' ? 'mobile_capture:full_article' : 'mobile_capture:first_screen')
  const captured = await screenshots(state, qaMode === 'full')
  const shots = [...captured.files.filter(file => !file.endsWith('article-mobile-full.png')), ...(state.cover ? [path.resolve(root, state.cover)] : [])]
  const claims = await readJson(state, 'claims', 'research/claims.json')
  const baseline = state.artifacts.baseline ? await fs.readFile(path.resolve(root, state.artifacts.baseline), 'utf8') : undefined
  const scopeCheck = state.artifacts.scopeCheck ? await readJson<{ removedTocFiller?: boolean; unchangedBody?: boolean }>(state, 'scopeCheck', 'qa/scope-check.json') : undefined
  if (qaMode === 'deterministic') {
    const html = await fs.readFile(artifact(state, 'html', 'render/article.html'), 'utf8')
    if (state.revision?.removeTocFiller && (!scopeCheck?.removedTocFiller || !scopeCheck.unchangedBody)) throw new Error('TOC filler removal must match the locked legacy template diff exactly.')
    if (state.revision?.removeTocFiller && /wx-toc-title|wx-toc-article-title|全文导航/.test(html)) throw new Error('TOC filler is still present after the layout revision.')
    if (state.revision?.scope === 'references' && !scopeCheck?.unchangedBody) throw new Error('Reference-only revision changed visible body text.')
    if (captured.metrics.scrollWidth !== 390) throw new Error(`TOC filler removal caused horizontal overflow: ${captured.metrics.scrollWidth}px.`)
    const orphan = captured.metrics.headings.find(heading => heading.orphan)
    if (orphan) throw new Error(`TOC filler removal introduced a heading orphan: ${orphan.text}`)
    const deterministicResult = { verdict: 'pass' as const, stylePassed: true, firstVisibleLine: '', visibleItems: [], findings: [], summary: '确定性局部修订验收通过：范围差异、390px渲染、正文与图片指纹均通过。' }
    if (before !== await artifactFingerprint(state)) throw new Error('Article or assets changed during deterministic QA; rerun validation.')
    const visualQa = { screenshots: shots.map(rel), verdict: deterministicResult.verdict, findings: deterministicResult.findings, summary: deterministicResult.summary }; await writeJson(state, 'visualQa', 'qa/visual.json', visualQa); await writeJson(state, 'finalQa', 'qa/final.json', deterministicResult)
    state.qa = { ...state.qa!, verdict: 'pass' }; state.reviewedFingerprint = await artifactFingerprint(state)
    await writeJson(state, 'deliveryChecklist', 'qa/delivery-checklist.json', { style: state.style, styleReviewed: state.style !== 'preserve', fingerprint: state.reviewedFingerprint, checks: state.qa.checks, scope: state.revision?.scope, deterministicOnly: true, qaMode, references: referenceEntries(markdown), layout: state.layout, screenshots: shots.map(rel) })
    state.phase = 'awaiting_draft_approval'; await event(state, 'awaiting_draft_approval', { cover: Boolean(state.cover), deterministicOnly: true, qaMode }); await save(state)
    return
  }
  const prompt = `${qaPrompt(state, markdown, state.qa)}\n目标文风：${state.style ?? 'neutral'}，${styleProfiles[state.style ?? 'neutral']}\n本轮修改范围：${state.revision?.scope ?? 'new article'}；${state.revision?.goal ?? state.goal}\n事实账本：${JSON.stringify(claims)}\n移动端实测：${JSON.stringify(captured.metrics)}\n已通过的真实渲染前后差异检查：${JSON.stringify(scopeCheck)}。inheritedTemplateText是修改前已存在且本轮未变的模板尾注，不能将其当作本轮新增内容。模板尾注由模板正常处理，判断越界要对比父稿渲染而非只比Markdown。\n${state.revision?.scope === 'style' ? `改写前稿（仅作风格变化和事实保真比较，不是当前稿）：\n${baseline}` : ''}\n一次列出所有有证据的缺陷。事实、明确用户要求、丢内容、裁切不可读属于必须修；纯审美偏好写为info建议且不触发revise。不要把正常比较、技术区别“触发不等于通过”判为翻案。每个需改项必须引用当前原句或截图位置，不读历史QA来猜问题。范围已锁定的小修不要追加全文文风改写。截图包含真实首屏、全高和重叠分段，逐段核验。`
  const result = await runAgent<{ verdict: Verdict; summary: string; stylePassed: boolean; firstVisibleLine: string; visibleItems: string[]; findings: Finding[] }>(state, 'qa', `${prompt}\n最后一张附件为独立封面，前面的附件是正文截图。请核验封面主题、文字准确性及本轮明确视觉要求。`, schemas.qa, false, shots)
  if (!result || !['pass', 'revise', 'blocked'].includes(result.verdict) || typeof result.stylePassed !== 'boolean' || typeof result.summary !== 'string' || typeof result.firstVisibleLine !== 'string' || !Array.isArray(result.visibleItems) || !Array.isArray(result.findings)) throw new Error('Invalid independent QA response.')
  if (state.executionMode === 'real') {
    const titleLine = /^#\s+(.+?)\s*$/m.exec(markdown)?.[1] ?? state.title
    const projectKeyword = titleLine.match(/[A-Za-z][A-Za-z0-9]{2,}/)?.[0] ?? titleLine.replace(/^[#\s\d.、]+/, '').slice(0, 4)
    const projectVisible = Boolean(projectKeyword) && result.visibleItems.some(entry => entry.includes(projectKeyword))
    if (!result.firstVisibleLine.trim() || !projectVisible || /项目(?:因子|引子)/.test(result.firstVisibleLine)) {
      state.phase = 'blocked'; state.blockedFrom = 'full_qa'
      state.blockedReason = `QA vision evidence is insufficient: the QA response did not reliably transcribe the opening screenshot. Set a vision-capable model with WECHAT_AGENT_MODEL and retry. QA result: ${JSON.stringify({ firstVisibleLine: result.firstVisibleLine, visibleItems: result.visibleItems })}`
      await event(state, 'blocked', { reason: state.blockedReason }); await save(state); return
    }
  }
  for (const finding of result.findings) {
    if (!['info', 'warning', 'error'].includes(finding.severity) || !['fact', 'content', 'style', 'layout'].includes(finding.category ?? '') || typeof finding.blocking !== 'boolean' || typeof finding.evidence !== 'string' || !finding.evidence.trim() || typeof finding.message !== 'string' || typeof finding.recommendation !== 'string') throw new Error('Invalid QA finding: category, blocking and concrete evidence are required.')
  }
  if (result.stylePassed === false && !result.findings.some(finding => finding.blocking && finding.category === 'style')) {
    result.findings.push({ severity: 'info', category: 'style', blocking: false, evidence: result.summary.slice(0, 200), message: 'QA marked stylePassed=false without an evidenced blocking style finding; treated as advisory only.', recommendation: 'No action required unless a blocking style finding appears.' })
    result.stylePassed = true
  }
  if (result.verdict !== 'blocked') result.verdict = result.findings.some(finding => finding.blocking && finding.category === 'fact') ? 'blocked' : result.findings.some(finding => finding.blocking) ? 'revise' : 'pass'
  if (before !== await artifactFingerprint(state)) throw new Error('Article or assets changed during independent QA; rerun validation.')
  const orphans = captured.metrics.headings.filter(heading => heading.orphan)
  if (orphans.length) {
    if (result.verdict !== 'blocked') result.verdict = 'revise'
    result.findings.push(...orphans.map(heading => ({ severity: 'warning' as const, category: 'content' as const, blocking: true, evidence: JSON.stringify(heading), message: `390px title has a one-character orphan: ${heading.text}`, recommendation: 'Shorten only this heading; preserve body and type size.' })))
  }
  const visualQa = { screenshots: shots.map(rel), verdict: result.verdict, findings: result.findings, summary: result.summary }; await writeJson(state, 'visualQa', 'qa/visual.json', visualQa); await writeJson(state, 'finalQa', 'qa/final.json', result)
  if (result.verdict === 'blocked') { state.phase = 'blocked'; state.blockedFrom = 'full_qa'; state.blockedReason = result.summary; await event(state, 'qa_blocked', { summary: result.summary }); await save(state); return }
  if (result.verdict === 'revise') { state.revisionFindings = result.findings.filter(item => item.blocking); await revise(state, result.summary); return }
  state.qa = { ...state.qa!, verdict: 'pass' }; state.reviewedFingerprint = await artifactFingerprint(state)
  await writeJson(state, 'deliveryChecklist', 'qa/delivery-checklist.json', { style: state.style, styleReviewed: state.style !== 'preserve', fingerprint: state.reviewedFingerprint, checks: state.qa.checks, scope: state.revision?.scope ?? 'new article', qaMode, references: referenceEntries(markdown), layout: state.layout, screenshots: shots.map(rel) })
  state.phase = 'awaiting_draft_approval'; await event(state, 'awaiting_draft_approval', { cover: Boolean(state.cover), qaMode }); await save(state)
}

async function revise(state: RunState, reason: string) {
  state.revisionReason = reason
  if (state.revision?.expectedArticleSha256) { state.phase = 'blocked'; state.blockedFrom = 'full_qa'; state.blockedReason = `Scoped revision requires an explicit correction; no automatic scope expansion: ${reason}`; await save(state); return }
  state.attempts += 1; if (state.attempts >= maxRevisions) { state.phase = 'blocked'; state.blockedFrom = 'full_qa'; state.blockedReason = `QA did not pass after ${maxRevisions} attempts: ${reason}`; await event(state, 'blocked', { reason: state.blockedReason }); await save(state); return }
  state.phase = 'targeted_revision'; await event(state, 'revision_required', { reason, attempt: state.attempts }); await save(state)
}

async function advance(state: RunState) {
  assertExecutionMode(state)
  while (true) {
    switch (state.phase) {
      case 'intake': case 'plan': await plan(state); break
      case 'outline_review': await outlineReview(state); break
      case 'research_and_write': case 'revise': await researchAndWrite(state); break
      case 'structure_review': await structureReview(state); break
      case 'style_review': await styleReview(state); break
      case 'targeted_revision': await targetedRevision(state); break
      case 'visual_design': await visualDesign(state); break
      case 'render': await render(state); break
      case 'full_qa':
        if (sha256(await fs.readFile(finalMarkdown(state))) !== state.renderedSourceSha256 || state.renderedFingerprint !== await artifactFingerprint(state)) await render(state)
        else await fullQa(state)
        break
      case 'awaiting_draft_approval':
        if (sha256(await fs.readFile(finalMarkdown(state))) === state.renderedSourceSha256 && state.reviewedFingerprint === await artifactFingerprint(state)) return state
        await event(state, 'working_copy_changed', { reason: 'working copy edited after QA; rerendering before draft' })
        await render(state); break
      case 'draft_create': case 'draft_update': await continueDraft(state); return state
      case 'post_draft_qa': await postDraftQa(state); return state
      case 'awaiting_human_fact_resolution': case 'blocked': case 'completed': return state
      default: throw new Error(`Unsupported run phase: ${state.phase}`)
    }
  }
}

async function resolveFacts(state: RunState, id: string, decision: FactConflict['decision'], note?: string) {
  assertExecutionMode(state)
  if (state.phase !== 'awaiting_human_fact_resolution') throw new Error(`Run is ${state.phase}; no fact decision is pending.`)
  const conflicts = await readJson<FactConflict[]>(state, 'conflicts', 'research/conflicts.json'); const conflict = conflicts.find(item => item.id === id); if (!conflict || conflict.severity !== 'major' || conflict.status !== 'open') throw new Error('No open major conflict with that id.')
  conflict.status = 'resolved'; conflict.decision = decision; conflict.note = note; await writeJson(state, 'conflicts', 'research/conflicts.json', conflicts); await event(state, 'fact_conflict_resolved', { id, decision, note })
  if (!unresolvedConflicts(conflicts).length) { state.phase = 'revise'; await save(state); await advance(state) } else await save(state)
}

function summary(state: RunState) { return { runId: state.id, parentRunId: state.parentRunId, mode: state.mode, executionMode: state.executionMode ?? 'unknown', localOnly: state.localOnly ?? false, phase: state.phase, operation: state.operation, title: state.title, goal: state.goal, style: state.style, layout: state.layout, revision: state.revision, versions: state.versions, attempts: state.attempts, blockedReason: state.blockedReason, artifacts: state.artifacts, qa: state.qa, draft: state.draft, handoff: handoffRequest(state), nextAction: state.operation ? `Run is processing ${state.operation.action}${state.operation.step ? ` (${state.operation.step})` : ''}; use status and wait for it to finish.` : state.phase === 'awaiting_human_fact_resolution' ? 'Resolve every major fact conflict with resolve-facts.' : state.phase === 'awaiting_draft_approval' ? state.localOnly ? 'Local review complete. This run cannot create or update remote drafts.' : state.target ? `Update the explicit target ${state.target.mediaId}.` : 'Explicitly request draft creation.' : state.phase === 'blocked' ? 'Inspect all findings, create a scoped revision, or explicitly retry the failed stage.' : state.phase === 'completed' ? 'Use the verified handoff in the current Codex right panel; record its actual result.' : 'Use resume to continue.' } }

async function beforeDraft(state: RunState, expectedPhase: Phase = 'awaiting_draft_approval') {
  assertExecutionMode(state)
  if (state.localOnly) throw new Error('This run is permanently local-only; remote draft mutations are forbidden.')
  if (state.phase !== expectedPhase) throw new Error(`Run is ${state.phase}; draft mutation is forbidden.`)
  if (!state.cover || !state.qa?.passed || state.qa.verdict !== 'pass') throw new Error('Draft mutation requires a cover and passing QA.')
  await fs.access(path.resolve(root, state.cover))
  const conflicts = await readJson<FactConflict[]>(state, 'conflicts', 'research/conflicts.json'); if (unresolvedConflicts(conflicts).length) throw new Error('Draft mutation is forbidden while major fact conflicts are unresolved.')
  if (sha256(await fs.readFile(finalMarkdown(state))) !== state.renderedSourceSha256) throw new Error('Working article changed after QA; resume to rerender and recheck it.')
  await assertRevisionScope(state)
  if (!state.reviewedFingerprint || state.reviewedFingerprint !== await artifactFingerprint(state)) throw new Error('Article, layout, image or cover changed after QA; resume to revalidate before publishing.')
}

export async function retryRun(state: RunState) {
  assertExecutionMode(state)
  if (state.phase !== 'blocked' || !state.blockedFrom) throw new Error('No resumable blocked stage; create an explicit scoped revision instead.')
  if (state.draft?.requestStartedAt) throw new Error('A sent draft request must be recovered with verify-draft, never retried blindly.')
  const conflicts = await readJson<FactConflict[]>(state, 'conflicts', 'research/conflicts.json')
  if (unresolvedConflicts(conflicts).length) throw new Error('Resolve major facts first.')
  await event(state, 'explicit_retry', { from: state.blockedFrom, previousReason: state.blockedReason })
  state.phase = state.blockedFrom; delete state.blockedReason; await save(state); await advance(state)
}

async function draftPreflight(article: string, cover: string) {
  const check = await command('md2wechat', ['inspect', rel(article), '--mode', 'api', '--theme', 'elegant-navy', '--draft', '--cover', cover, '--json'])
  if (check?.data?.readiness?.targets?.draft !== 'ready') throw new Error(`WeChat draft preflight blocked: ${(check?.data?.readiness?.blockers ?? []).map((x: { message?: string }) => x.message ?? 'unknown').join('; ')}`)
}

async function rasterizeSvg(source: string, target: string) {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
 const svg = await fs.readFile(source, 'utf8')
 const width = Number(svg.match(/\bwidth="(\d+(?:\.\d+)?)"/)?.[1] ?? 1600)
 const height = Number(svg.match(/\bheight="(\d+(?:\.\d+)?)"/)?.[1] ?? 900)
 const size = `${Number.isFinite(width) ? Math.round(width) : 1600},${Number.isFinite(height) ? Math.round(height) : 900}`
 await fs.mkdir(path.dirname(target), { recursive: true })
 await runtime.exec(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', `--window-size=${size}`, `--screenshot=${target}`, pathToFileURL(source).href], { cwd: root, maxBuffer: 1024 * 1024 })
  await fs.access(target)
}

function uploadedUrl(result: Record<string, unknown>) {
  const data = result.data as Record<string, unknown> | undefined
  const url = data?.url ?? data?.image_url ?? data?.media_url ?? data?.wechat_url
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('Image upload returned no usable remote URL for the article body.')
  return url
}

async function publishWorkingCopy(state: RunState) {
  const original = await fs.readFile(finalMarkdown(state), 'utf8')
  const reviewed = await readJson<{ title: string; digest: string; content: string }>(state, 'draftPayload', 'render/draft-payload.json')
  const localImages = imageAttributes(reviewed.content)
  const remoteImages = state.target?.news ? imageAttributes(String(state.target.news.content)) : []
  const parent = state.parentRunId ? await load(state.parentRunId) : undefined
  const mappings: Record<string, string> = {}
  for (const reference of localBodyImages(original)) {
    const sourceAsset = path.join(runDir(state.id), 'assets', path.basename(reference))
    let remoteUrl: string | undefined
    if (parent && localImages.length === remoteImages.length) {
      const parentArticle = await fs.readFile(finalMarkdown(parent), 'utf8')
      if (localBodyImages(parentArticle).includes(reference)) {
        const parentAsset = path.join(runDir(parent.id), 'assets', path.basename(reference))
        const unchanged = sha256(await fs.readFile(sourceAsset)) === sha256(await fs.readFile(parentAsset))
        const index = localImages.findIndex(image => image.src === reference)
        if (unchanged && index >= 0 && /^https:\/\//.test(remoteImages[index]?.src ?? '')) remoteUrl = remoteImages[index].src
      }
    }
    const reused = Boolean(remoteUrl)
    if (!remoteUrl) {
      const uploadPath = reference.endsWith('.svg') ? sourceAsset.replace(/\.svg$/, '.png') : sourceAsset
      if (uploadPath !== sourceAsset) await rasterizeSvg(sourceAsset, uploadPath)
      const uploaded = state.executionMode === 'mock' ? { data: { url: `https://example.invalid/wechat-agent/${path.basename(uploadPath)}` } } : await command('md2wechat', ['upload_image', uploadPath, '--json'])
      remoteUrl = uploadedUrl(uploaded)
      if (reference === '../assets/architecture.svg') state.artifacts.architecturePng = rel(uploadPath)
    }
    mappings[reference] = remoteUrl
    await event(state, reused ? 'body_asset_reused' : 'body_asset_uploaded', { reference, remote: remoteUrl })
  }
  let publishMarkdown = original
  let expectedContent = reviewed.content
  for (const [reference, remote] of Object.entries(mappings)) {
    publishMarkdown = publishMarkdown.replaceAll(reference, remote)
    expectedContent = expectedContent.replaceAll(reference, remote.replaceAll('&', '&amp;'))
  }
  if (localBodyImages(publishMarkdown).length || /<img[^>]+(?:src|href)=["'](?:file:|\.\.\/assets\/)/i.test(publishMarkdown)) throw new Error('Publish working copy still contains a local body asset path.')
  const output = await writeText(state, 'publishArticle', 'publish/article.md', publishMarkdown)
  const html = path.join(runDir(state.id), 'publish', 'article.html')
  const draftPayload = path.join(runDir(state.id), 'publish', 'draft-payload.json')
  const rendered = await command('pnpm', ['--dir', 'vendor/doocs-md/packages/mcp-server', 'exec', 'tsx', '../../../../scripts/wechat/publish-tech-draft.mts', output, '--html', html, '--draft-json', draftPayload, '--image-width', String((state.layout ?? defaultLayout).imageWidthPercent)])
  const content = await fs.readFile(html, 'utf8')
  if (/(?:file:|\.\.\/assets\/)/i.test(content)) throw new Error('Publish HTML has not fully replaced local body assets.')
  state.artifacts.publishHtml = rel(String(rendered.html)); state.artifacts.publishDraftPayload = rel(draftPayload)
  const payload = await readJson<{ title: string; digest: string; content: string }>(state, 'publishDraftPayload', 'publish/draft-payload.json')
  if (payload.title !== reviewed.title || payload.digest !== reviewed.digest || payload.content !== expectedContent) throw new Error('Publish payload differs from the reviewed rendering beyond image URL replacement.')
  await save(state)
  return payload
}

async function uploadCover(state: RunState) {
  assertExecutionMode(state)
  if (!state.cover) throw new Error('A dedicated cover is required before upload.')
  const cover = path.resolve(root, state.cover)
  await fs.access(cover)
  const uploadPath = path.extname(cover).toLowerCase() === '.svg' ? path.join(runDir(state.id), 'assets', 'cover.png') : cover
  if (uploadPath !== cover) await rasterizeSvg(cover, uploadPath)
  if (state.executionMode !== 'mock') await draftPreflight(artifact(state, 'publishArticle', 'publish/article.md'), uploadPath)
  if (state.parentRunId && typeof state.target?.news?.thumb_media_id === 'string') {
    const parent = await load(state.parentRunId)
    if (parent.cover && sha256(await fs.readFile(cover)) === sha256(await fs.readFile(path.resolve(root, parent.cover)))) {
      await event(state, 'cover_reused'); return state.target.news.thumb_media_id
    }
  }
  const uploaded = state.executionMode === 'mock' ? { data: { media_id: 'mock-cover-media-id' } } : await command('md2wechat', ['upload_image', uploadPath, '--json'])
  const mediaId = (uploaded.data as Record<string, unknown> | undefined)?.media_id
  if (typeof mediaId !== 'string' || !mediaId) throw new Error('Cover upload returned no media_id.')
  return mediaId
}

async function createDraft(state: RunState) {
  if (state.target?.mediaId) throw new Error('This revision belongs to an existing draft; use update-draft with its explicit media_id.')
  await beforeDraft(state); state.draft = { urlStatus: 'not_created', mode: 'create' }; state.phase = 'draft_create'; await save(state); await event(state, 'draft_create_started')
  await continueDraft(state); return state
}

async function continueDraft(state: RunState) {
  assertExecutionMode(state)
  const mode = state.draft?.mode
  if (!mode || state.phase !== (mode === 'create' ? 'draft_create' : 'draft_update')) throw new Error('Interrupted draft action has no matching saved approval.')
  if (state.draft?.requestStartedAt) {
    let result: { mediaId: string } | undefined
    try { result = await readJson(state, 'draftResult', 'publish/draft-result.json') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!result?.mediaId) throw new Error('Draft request outcome is unknown; do not retry creation/update. Check the WeChat draft box, then use verify-draft <run-id> --media-id <confirmed-media-id>.')
    if (mode === 'update' && result.mediaId !== state.draft.mediaId) throw new Error('Recovered draft result does not match the approved update target.')
    state.draft.mediaId = result.mediaId
  } else {
    await setOperationStep(state, 'draft:preparing')
    await beforeDraft(state, state.phase)
    if (mode === 'update' && !state.draft?.mediaId) throw new Error('Interrupted update has no explicit media_id.')
    if (mode === 'update' && state.executionMode === 'real') {
      const news = draftNewsItem(await getDraft(state.draft!.mediaId!))
      if (state.target?.expectedRemoteDigest && remoteDigest(news) !== state.target.expectedRemoteDigest) throw new Error('Remote draft changed after approval; refusing to overwrite it.')
      const reviewed = await readJson<{ title: string }>(state, 'draftPayload', 'render/draft-payload.json')
      if (news.title !== reviewed.title) throw new Error('Update target title does not match the reviewed article.')
      state.target = { mediaId: state.draft!.mediaId!, expectedRemoteDigest: remoteDigest(news), news, preserveRemoteThumb: state.target?.preserveRemoteThumb }; await save(state)
    }
    const payload = await publishWorkingCopy(state)
    let thumbMediaId: string
    if (state.target?.preserveRemoteThumb) {
      thumbMediaId = String(state.target.news?.thumb_media_id ?? '')
      if (!thumbMediaId) throw new Error('preserveRemoteThumb is set but the remote draft has no thumb_media_id.')
    } else thumbMediaId = await uploadCover(state)
    const requestPath = path.join(runDir(state.id), 'publish', 'create-draft.json')
    if (mode === 'create') await fs.writeFile(requestPath, JSON.stringify({ articles: [{ ...payload, thumb_media_id: thumbMediaId }] }, null, 2))
    const accessToken = mode === 'update' && state.executionMode === 'real' ? await wechatToken() : undefined
    if (mode === 'update' && state.executionMode === 'real') {
      const news = draftNewsItem(await getDraft(state.draft!.mediaId!))
      if (remoteDigest(news) !== state.target!.expectedRemoteDigest) throw new Error('Remote draft changed while assets were uploading; update was not sent.')
    }
    await beforeDraft(state, state.phase)
    state.draft!.requestId = randomUUID(); state.draft!.requestStartedAt = now(); await setOperationStep(state, `draft:request:${mode}`); await save(state)
    let mediaId = state.draft!.mediaId
    if (state.executionMode === 'mock') mediaId = mode === 'create' ? 'mock-draft-media-id' : mediaId
    else if (mode === 'create') {
      const created = await command('md2wechat', ['create_draft', requestPath, '--json'])
      mediaId = (created.data as Record<string, unknown> | undefined)?.media_id as string | undefined
    } else {
      const existing = state.target?.news ?? {}
      const response = await fetch(`https://api.weixin.qq.com/cgi-bin/draft/update?access_token=${encodeURIComponent(accessToken!)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_id: mediaId, index: 0, articles: { title: payload.title, author: existing.author ?? '', digest: payload.digest, content: payload.content, content_source_url: existing.content_source_url ?? '', thumb_media_id: thumbMediaId, show_cover_pic: existing.show_cover_pic ?? 0, need_open_comment: existing.need_open_comment ?? 0, only_fans_can_comment: existing.only_fans_can_comment ?? 0 } }) })
      const responsePayload = await response.json() as Record<string, unknown>; if (responsePayload.errcode) throw new Error(`WeChat draft/update failed: ${responsePayload.errmsg ?? responsePayload.errcode}`)
    }
    if (typeof mediaId !== 'string' || !mediaId) throw new Error('Draft mutation returned no media_id.')
    state.draft!.thumbMediaId = thumbMediaId
    await writeJson(state, 'draftResult', 'publish/draft-result.json', { mediaId, requestId: state.draft!.requestId, mode, recordedAt: now() })
    state.draft!.mediaId = mediaId; state.draft!.resultRecordedAt = now(); state.draft!.urlStatus = 'pending_editor_url'; state.phase = 'post_draft_qa'; await save(state)
    await event(state, 'draft_result_recorded', { mediaId, requestId: state.draft!.requestId, mode })
  }
  state.draft!.urlStatus = 'pending_editor_url'; state.phase = 'post_draft_qa'; await save(state)
  await event(state, mode === 'create' ? 'draft_created' : 'draft_updated', { mediaId: state.draft!.mediaId }); await postDraftQa(state)
}

async function wechatToken() {
  const config = await fs.readFile(path.join(process.env.HOME ?? '', '.config', 'md2wechat', 'config.yaml'), 'utf8'); const appid = config.match(/^\s*appid:\s*([^\s#]+)/m)?.[1]; const secret = config.match(/^\s*secret:\s*([^\s#]+)/m)?.[1]; if (!appid || !secret) throw new Error('Local WeChat app credentials are unavailable.')
  const response = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`); const payload = await response.json() as { access_token?: string; errmsg?: string }; if (!payload.access_token) throw new Error(`WeChat token request failed: ${payload.errmsg ?? 'unknown error'}`); return payload.access_token
}
async function getDraft(mediaId: string) { const token = await wechatToken(); const response = await fetch(`https://api.weixin.qq.com/cgi-bin/draft/get?access_token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_id: mediaId }) }); const payload = await response.json() as Record<string, unknown>; if (payload.errcode) throw new Error(`WeChat draft/get failed: ${payload.errmsg ?? payload.errcode}`); return payload }
export function draftNewsItem(readback: Record<string, unknown>): Record<string, unknown> {
 const pool: unknown[] = []
 const collect = (value: unknown) => { if (Array.isArray(value)) pool.push(...value); else if (value && typeof value === 'object') pool.push(value) }
 collect(readback.news_item)
 const entries = Array.isArray(readback.item) ? readback.item : readback.item ? [readback.item] : []
 for (const entry of entries) {
  if (!entry || typeof entry !== 'object') continue
  const record = entry as Record<string, unknown>
  collect(record.news_item)
  collect((record.content as Record<string, unknown> | undefined)?.news_item)
  pool.push(record)
 }
 const isNews = (value: unknown) => Boolean(value) && typeof value === 'object' && typeof (value as Record<string, unknown>).content === 'string'
 return (pool.find(isNews) as Record<string, unknown> | undefined) ?? (pool[0] as Record<string, unknown> | undefined) ?? {}
}

async function postDraftQa(state: RunState, recoveredMediaId?: string) {
 assertExecutionMode(state, true)
 if (recoveredMediaId) {
   const reconcilingCompletedUpdate = state.phase === 'awaiting_draft_approval' && state.target?.mediaId === recoveredMediaId
   if (!['draft_create', 'draft_update', 'post_draft_qa', 'awaiting_draft_approval'].includes(state.phase)) throw new Error('A recovered media_id is only accepted for an interrupted draft action.')
   if (!state.draft?.requestStartedAt && !reconcilingCompletedUpdate) throw new Error('No draft request was sent; use resume instead of adopting a draft.')
   if (state.draft.mediaId && state.draft.mediaId !== recoveredMediaId) throw new Error('Recovered media_id differs from the approved draft target.')
   if (state.executionMode !== 'mock' && recoveredMediaId.startsWith('mock-')) throw new Error('A mock media_id cannot be used in a real run.')
   state.draft = { ...state.draft, mediaId: recoveredMediaId, mode: state.draft?.mode ?? 'update', urlStatus: 'not_created', requestStartedAt: state.draft?.requestStartedAt ?? now(), thumbMediaId: state.draft?.thumbMediaId ?? (typeof state.target?.news?.thumb_media_id === 'string' ? state.target.news.thumb_media_id : undefined) }
   state.phase = 'post_draft_qa'; await save(state)
 }
 if (!['post_draft_qa', 'completed'].includes(state.phase)) throw new Error('Draft outcome is not recorded; use resume or verify-draft with a confirmed --media-id after an uncertain request.')
 const mediaId = state.draft?.mediaId
 if (!mediaId) throw new Error('No draft media_id to verify.')
 const payload = await readJson<{ title?: string; content?: string }>(state, 'publishDraftPayload', 'publish/draft-payload.json')
 const expectedTitle = payload.title ?? state.title
 state.phase = 'post_draft_qa'
 state.draft!.url = undefined; state.draft!.urlStatus = 'pending_editor_url'
 if (state.handoff) { state.handoff.url = undefined; state.handoff.status = 'unavailable' }
 await save(state)
 let readback: Record<string, unknown>
 try {
   readback = state.executionMode === 'mock'
    ? { news_item: [{ title: expectedTitle, content: payload.content ?? '<p>这是用于验证草稿回读的项目介绍。</p><h2>验证</h2>', thumb_media_id: state.draft?.thumbMediaId }] }
    : await getDraft(mediaId)
 } catch (error) {
   await writeJson(state, 'readbackFailure', 'publish/readback-failure.json', { mediaId, at: now(), message: error instanceof Error ? error.message : String(error) })
   await save(state); throw error
 }
 const news = draftNewsItem(readback)
 const content = typeof news.content === 'string' ? news.content : ''
 const expectedHeadings = [...(payload.content ?? '').matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi)].map(match => match[1].replace(/<[^>]+>/g, '').trim())
 const actualHeadings = [...content.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi)].map(match => match[1].replace(/<[^>]+>/g, '').trim())
 const body = content.split(/参考来源/)[0]
 const checks = {
  title: news.title === expectedTitle, noOpeningLabel: !/项目(?:因子|引子)/.test(content), firstH2: /class="h2"|<h2/i.test(content),
  noTitleCard: !/\bclass="[^"]*\bwx-(?:hero|kicker)\b/.test(content),
  headings: JSON.stringify(actualHeadings) === JSON.stringify(expectedHeadings),
  noLocalAsset: !/(?:file:|\.\.\/assets\/)/i.test(body),
  noInlineCitationMarkers: !/\[(?:[1-9]|[1-9]\d+)\]/.test(body),
  mobileTypography: state.executionMode === 'mock' || (/font-size:\s*15px/i.test(content) && /line-height:\s*1\.82/i.test(content)),
  cover: state.executionMode === 'mock' || !state.draft?.thumbMediaId || news.thumb_media_id === state.draft.thumbMediaId,
  completeText: htmlText(content) === htmlText(payload.content ?? ''),
  images: readbackImagesMatch(content, payload.content ?? ''),
 }
 await writeJson(state, 'readback', 'publish/readback.json', { checks, expectedTitle, mediaId, response: readback })
 if (!Object.values(checks).every(Boolean)) throw new Error(`Draft readback verification failed: ${Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(', ')}`)
 state.phase = 'completed'
 state.draft!.url = state.executionMode === 'real' ? verifiedPreviewUrl(news.url) : undefined
 state.draft!.urlStatus = state.draft!.url ? 'recorded' : 'pending_editor_url'
 state.target = { mediaId, expectedRemoteDigest: remoteDigest(news), news }
 const previousHandoff = state.handoff
 const key = handoffKey(mediaId)
 state.handoff = { key, url: state.draft!.url, status: state.draft!.url ? 'pending' : 'unavailable', verifiedAt: now(), tabId: previousHandoff?.key === key ? previousHandoff.tabId : undefined }
 await writeJson(state, 'handoff', 'publish/handoff.json', handoffRequest(state))
 await event(state, 'draft_readback_completed', { mediaId, checks, urlStatus: state.draft?.urlStatus })
 await save(state)
}

async function updateDraft(state: RunState, mediaId: string) {
  await beforeDraft(state)
  if (!mediaId || (state.executionMode === 'real' && mediaId.startsWith('mock-'))) throw new Error('update-draft requires an explicit media_id matching the run execution mode.')
  if (state.target?.mediaId && state.target.mediaId !== mediaId) throw new Error('Explicit media_id differs from this revision target.')
  state.draft = { mediaId, urlStatus: 'not_created', mode: 'update' }; state.phase = 'draft_update'; await save(state)
  await continueDraft(state); return state
}

export function handoffRequest(state: RunState) {
  if (state.phase !== 'completed' || !state.handoff?.url || !verifiedPreviewUrl(state.handoff.url)) return { status: 'unavailable', reason: 'No verified completed draft URL.' }
  if (!state.draft?.mediaId || state.handoff.key !== handoffKey(state.draft.mediaId)) return { status: 'unavailable', reason: 'Refresh handoff in the current task before opening a draft.' }
  return { status: state.handoff.status, key: state.handoff.key, verifiedAt: state.handoff.verifiedAt, tool: 'open_in_codex', args: { placement: 'right', target: { type: 'browser', ...(state.handoff.tabId ? { tabId: state.handoff.tabId } : {}), url: state.handoff.url } }, note: 'Reuse the matching tab if its id is known. queued is not confirmation that the page is visible.' }
}

export async function recordHandoff(state: RunState, status: 'queued' | 'opened', tabId?: string) {
  if (handoffRequest(state).status === 'unavailable' || !state.handoff) throw new Error('Only a verified draft in the current task can be handed off.')
  if (!['queued', 'opened'].includes(status)) throw new Error('Handoff status must reflect the actual app tool result.')
  state.handoff.status = status; if (tabId) state.handoff.tabId = tabId
  await writeJson(state, 'handoff', 'publish/handoff.json', handoffRequest(state)); await save(state)
}

async function main() {
  const args = process.argv.slice(2); const action = args.shift(); if (!action || action === '--help') throw new Error(usage)
  if (['topic', 'improve', 'start', 'export'].includes(action)) setVault(valueAfter(args, '--vault'))
  if (action === 'topic') { const topic = args.find(arg => !arg.startsWith('-')); if (!topic) throw new Error('topic requires a topic.'); const state = await createRun('topic', topic, { goal: valueAfter(args, '--goal') ?? `围绕“${topic}”形成适合公众号的技术文章`, audience: valueAfter(args, '--audience'), angle: valueAfter(args, '--angle'), cover: valueAfter(args, '--cover'), style: valueAfter(args, '--style'), layout: { imageWidthPercent: Number(valueAfter(args, '--image-width') ?? 100) } }); await withOperation(state, 'topic', () => advance(state)); console.log(JSON.stringify(summary(await load(state.id)), null, 2)); return }
  if (action === 'improve' || action === 'start') { const source = args.find(arg => !arg.startsWith('-')); const goal = valueAfter(args, '--goal') ?? '完成公众号审校、渲染和视觉 QA'; if (!source) throw new Error(`${action} requires <article.md>.`); const state = await createRun('improve', source, { goal, cover: valueAfter(args, '--cover'), style: valueAfter(args, '--style'), layout: { imageWidthPercent: Number(valueAfter(args, '--image-width') ?? 100) } }); await withOperation(state, action, () => advance(state)); console.log(JSON.stringify(summary(await load(state.id)), null, 2)); return }
  const id = args[0]; if (!id) throw new Error(usage); const state = await load(id)
  if (action === 'status' || action === 'report') { console.log(JSON.stringify(summary(state), null, 2)); return }
  if (action === 'resume') { await withOperation(state, 'resume', () => advance(state)); console.log(JSON.stringify(summary(await load(id)), null, 2)); return }
  if (action === 'revise') {
    const patchFile = valueAfter(args, '--patch')
    const revision = await createRevision(state, { scope: valueAfter(args, '--scope') as RevisionScope, goal: valueAfter(args, '--goal'), assets: valueAfter(args, '--assets') ? JSON.parse(await fs.readFile(path.resolve(valueAfter(args, '--assets')!), 'utf8')) : undefined, patches: patchFile ? JSON.parse(await fs.readFile(path.resolve(patchFile), 'utf8')) : undefined, fontScale: valueAfter(args, '--font-scale') === undefined ? undefined : Number(valueAfter(args, '--font-scale')), cover: valueAfter(args, '--cover'), removeTitleCard: args.includes('--remove-title-card') ? true : undefined, removeTocFiller: args.includes('--remove-toc-filler') ? true : undefined, imageWidthPercent: valueAfter(args, '--image-width') === undefined ? undefined : Number(valueAfter(args, '--image-width')), style: valueAfter(args, '--style'), version: valueAfter(args, '--version') === undefined ? undefined : Number(valueAfter(args, '--version')), localOnly: args.includes('--local-only') })
    console.error(`Article revision ${revision.id}`); await withOperation(revision, 'revise', () => advance(revision)); console.log(JSON.stringify(summary(await load(revision.id)), null, 2)); return
  }
  if (action === 'retry') { await withOperation(state, 'retry', () => retryRun(state)); console.log(JSON.stringify(summary(await load(id)), null, 2)); return }
  if (action === 'handoff') {
    const status = valueAfter(args, '--status') as 'queued' | 'opened' | undefined
    if (status) await withOperation(state, 'handoff', () => recordHandoff(state, status, valueAfter(args, '--tab-id')))
    else await withOperation(state, 'handoff_readback', () => postDraftQa(state))
    console.log(JSON.stringify(handoffRequest(await load(id)), null, 2)); return
  }
  if (action === 'preview') { const html = artifact(state, 'html', 'render/article.html'); await fs.access(html); console.log(JSON.stringify({ runId: id, html: rel(html), url: pathToFileURL(html).href }, null, 2)); return }
  if (action === 'resolve-facts') { const decision = valueAfter(args, '--decision') as FactConflict['decision']; if (!decision || !['research_wins', 'retain_with_qualification', 'drop_claim'].includes(decision)) throw new Error('resolve-facts requires a valid --decision.'); await withOperation(state, 'resolve_facts', () => resolveFacts(state, valueAfter(args, '--conflict') ?? '', decision, valueAfter(args, '--note'))); console.log(JSON.stringify(summary(await load(id)), null, 2)); return }
  if (action === 'verify-draft') { await withOperation(state, 'verify_draft', () => postDraftQa(state, valueAfter(args, '--media-id'))); console.log(JSON.stringify(summary(await load(id)), null, 2)); return }
  if (action === 'approve-draft') { await withOperation(state, 'approve_draft', () => createDraft(state)); console.log(JSON.stringify(summary(await load(id)), null, 2)); return }
  if (action === 'update-draft') { const mediaId = valueAfter(args, '--media-id'); if (!mediaId) throw new Error('update-draft requires --media-id.'); await withOperation(state, 'update_draft', () => updateDraft(state, mediaId)); console.log(JSON.stringify(summary(await load(id)), null, 2)); return }
  if (action === 'export') { const output = valueAfter(args, '--output'); if (!output) throw new Error('export requires --output.'); const target = safeVaultPath(output, 'Export target'); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(finalMarkdown(state), target); await event(state, 'article_exported', { output: rel(target) }); await save(state); console.log(JSON.stringify({ runId: id, output: rel(target) }, null, 2)); return }
  throw new Error(usage)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 })

export { unresolvedConflicts, advance, beforeDraft, createRun, createDraft, updateDraft, postDraftQa, resolveFacts, uploadCover, withOperation }
