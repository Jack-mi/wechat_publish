import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Codex } from '@openai/codex-sdk'
import { deterministicQa } from './wechat-loop.mts'

const exec = promisify(execFile)
const root = path.resolve(import.meta.dirname, '../..')
let vaultRoot = ''
const runsRoot = path.join(root, '.runtime', 'runs')
const maxRevisions = 3
const agentNames = ['orchestrator', 'writer', 'visual', 'qa'] as const
type AgentName = typeof agentNames[number]
type Phase = 'intake' | 'plan' | 'research_and_write' | 'awaiting_human_fact_resolution' | 'visual_design' | 'render' | 'full_qa' | 'revise' | 'awaiting_draft_approval' | 'draft_create' | 'draft_update' | 'post_draft_qa' | 'completed' | 'blocked'
type Finding = { severity: 'info' | 'warning' | 'error'; message: string; recommendation: string }
type Verdict = 'pass' | 'revise' | 'blocked'
type Claim = { id: string; claim: string; location: { artifact: string; line?: number }; importance: 'supporting' | 'key'; evidence: Array<{ url: string; retrievedAt: string; excerpt: string }> }
type FactConflict = { id: string; draftClaim: string; location: { artifact: string; line?: number }; evidence: Array<{ url: string; retrievedAt: string; excerpt: string }>; severity: 'minor' | 'major'; impact: 'core_conclusion' | 'mechanism' | 'number_or_timeline' | 'recommendation'; status: 'open' | 'resolved'; decision?: 'research_wins' | 'retain_with_qualification' | 'drop_claim'; note?: string }
type AgentTask = { runId: string; agent: Exclude<AgentName, 'orchestrator'>; phase: string; objective: string; inputArtifacts: string[]; requiredOutput: string; acceptanceCriteria: string[] }
type RunState = {
  version: 2; id: string; mode: 'topic' | 'improve'; phase: Phase; title: string; goal: string; audience?: string; angle?: string
 source?: string; cover?: string; attempts: number; renderedSourceSha256?: string
  threads: Partial<Record<AgentName, string>>; artifacts: Record<string, string>; tasks: AgentTask[]; qa?: { passed: boolean; checks: Record<string, boolean>; findings: Finding[]; verdict?: Verdict }
  draft?: { mediaId?: string; url?: string; urlStatus: 'not_created' | 'pending_editor_url' | 'recorded'; mode?: 'create' | 'update' }
  blockedReason?: string; createdAt: string; updatedAt: string
}

const usage = `Usage:
  pnpm --dir scripts/wechat wechat-agent topic <topic> --vault <vault-path> [--audience <text>] [--angle <text>] [--cover <image>]
  pnpm --dir scripts/wechat wechat-agent improve <article.md> --vault <vault-path> --goal <text> [--cover <image>]
  pnpm --dir scripts/wechat wechat-agent status|resume|preview|report <run-id> [--json]
  pnpm --dir scripts/wechat wechat-agent resolve-facts <run-id> --conflict <id> --decision research_wins|retain_with_qualification|drop_claim [--note <text>]
  pnpm --dir scripts/wechat wechat-agent approve-draft <run-id>
 pnpm --dir scripts/wechat wechat-agent verify-draft <run-id>
  pnpm --dir scripts/wechat wechat-agent update-draft <run-id> --media-id <media-id>
  pnpm --dir scripts/wechat wechat-agent export <run-id> --output <vault-path>`

const now = () => new Date().toISOString()
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const rel = (value: string) => path.relative(root, value)
const valueAfter = (args: string[], flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
const runDir = (id: string) => path.join(runsRoot, id)
const statePath = (id: string) => path.join(runDir(id), 'state.json')
const eventsPath = (id: string) => path.join(runDir(id), 'events.jsonl')
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
async function save(state: RunState) { state.updatedAt = now(); await fs.writeFile(statePath(state.id), `${JSON.stringify(state, null, 2)}\n`) }
async function event(state: RunState, type: string, detail: Record<string, unknown> = {}) { await fs.appendFile(eventsPath(state.id), `${JSON.stringify(redact({ at: now(), type, phase: state.phase, ...detail }))}\n`) }
async function writeJson(state: RunState, key: string, fallback: string, data: unknown) { const target = artifact(state, key, fallback); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, `${JSON.stringify(redact(data), null, 2)}\n`); state.artifacts[key] = rel(target); return target }
async function writeText(state: RunState, key: string, fallback: string, data: string) { const target = artifact(state, key, fallback); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data); state.artifacts[key] = rel(target); return target }
async function readJson<T>(state: RunState, key: string, fallback: string): Promise<T> { return JSON.parse(await fs.readFile(artifact(state, key, fallback), 'utf8')) as T }
async function load(id: string): Promise<RunState> { if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid run id.'); return JSON.parse(await fs.readFile(statePath(id), 'utf8')) as RunState }
function titleOf(markdown: string, fallback: string) { return (markdown.match(/^title:\s*["']?([^\n"']+)/m)?.[1] ?? markdown.match(/^#\s+(.+)$/m)?.[1] ?? fallback).trim() }
function parseJson(stdout: string) { const line = stdout.trim().split('\n').reverse().find(item => item.trim().startsWith('{')); if (!line) throw new Error('Expected JSON command output.'); return JSON.parse(line) }
async function command(bin: string, args: string[], maxBuffer = 20 * 1024 * 1024) { const output = await exec(bin, args, { cwd: root, maxBuffer }); return parseJson(output.stdout) }
function finalMarkdown(state: RunState) { return artifact(state, 'writingFinal', 'writing/article-final.md') }
function unresolvedConflicts(conflicts: FactConflict[]) { return conflicts.filter(item => item.severity === 'major' && item.status === 'open') }
function sourceRules() { return ['.agents/skills/wechat-article/references/editorial-rules.md', '.agents/skills/wechat-article/references/publishing-rules.md', '.agents/skills/wechat-article/references/conflict-resolution.md'].map(item => rel(path.join(root, item))) }

export const schemas = {
  orchestrator: { type: 'object', properties: { plan: { type: 'array', items: { type: 'string' } }, tasks: { type: 'array', items: { type: 'object', properties: { agent: { type: 'string', enum: ['writer', 'visual', 'qa'] }, objective: { type: 'string' }, acceptanceCriteria: { type: 'array', items: { type: 'string' } } }, required: ['agent', 'objective', 'acceptanceCriteria'], additionalProperties: false } } }, required: ['plan', 'tasks'], additionalProperties: false },
  writer: { type: 'object', properties: { outline: { type: 'array', items: { type: 'string' } }, article: { type: 'string' }, sources: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, retrievedAt: { type: 'string' }, summary: { type: 'string' } }, required: ['url', 'title', 'retrievedAt', 'summary'], additionalProperties: false } }, claims: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, claim: { type: 'string' }, location: { type: 'object', properties: { artifact: { type: 'string' }, line: { type: 'number' } }, required: ['artifact', 'line'], additionalProperties: false }, importance: { type: 'string', enum: ['supporting', 'key'] }, evidence: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, retrievedAt: { type: 'string' }, excerpt: { type: 'string' } }, required: ['url', 'retrievedAt', 'excerpt'], additionalProperties: false } } }, required: ['id', 'claim', 'location', 'importance', 'evidence'], additionalProperties: false } }, conflicts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, draftClaim: { type: 'string' }, location: { type: 'object', properties: { artifact: { type: 'string' }, line: { type: 'number' } }, required: ['artifact', 'line'], additionalProperties: false }, evidence: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, retrievedAt: { type: 'string' }, excerpt: { type: 'string' } }, required: ['url', 'retrievedAt', 'excerpt'], additionalProperties: false } }, severity: { type: 'string', enum: ['minor', 'major'] }, impact: { type: 'string', enum: ['core_conclusion', 'mechanism', 'number_or_timeline', 'recommendation'] } }, required: ['id', 'draftClaim', 'location', 'evidence', 'severity', 'impact'], additionalProperties: false } } }, required: ['outline', 'article', 'sources', 'claims', 'conflicts'], additionalProperties: false },
  visual: { type: 'object', properties: { coverDecision: { type: 'string' }, diagramTitle: { type: 'string' }, diagramNodes: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5 }, alt: { type: 'string' }, findings: { type: 'array', items: { type: 'string' } } }, required: ['coverDecision', 'diagramTitle', 'diagramNodes', 'alt', 'findings'], additionalProperties: false },
  qa: { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'revise', 'blocked'] }, summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['info', 'warning', 'error'] }, message: { type: 'string' }, recommendation: { type: 'string' } }, required: ['severity', 'message', 'recommendation'], additionalProperties: false } } }, required: ['verdict', 'summary', 'findings'], additionalProperties: false },
} as const

async function runAgent<T>(state: RunState, agent: AgentName, prompt: string, schema: object, web = false): Promise<T> {
  if (process.env.WECHAT_AGENT_MOCK === '1') return mockAgent(agent, state) as T
  const codex = new Codex()
  const options = { workingDirectory: root, model: process.env.WECHAT_AGENT_MODEL ?? 'gpt-5.6-terra', sandboxMode: web ? 'workspace-write' as const : 'read-only' as const, approvalPolicy: 'never' as const, networkAccessEnabled: web, webSearchMode: web ? 'live' as const : 'disabled' as const, additionalDirectories: web ? [runDir(state.id)] : [runDir(state.id), ...(vaultRoot ? [vaultRoot] : [])] }
  const thread = state.threads[agent] ? codex.resumeThread(state.threads[agent]!, options) : codex.startThread(options)
  const result = await thread.run(prompt, { outputSchema: schema })
  state.threads[agent] = thread.id ?? undefined
  await save(state)
  return JSON.parse(result.finalResponse) as T
}

function mockAgent(agent: AgentName, state: RunState): unknown {
  if (agent === 'orchestrator') return { plan: ['核验关键公开事实', '生成适合公众号的工作稿', '生成必要图解并进行独立 QA'], tasks: [{ agent: 'writer', objective: '调研、改写并生成主张映射', acceptanceCriteria: ['关键事实有来源', '原稿不被覆盖'] }, { agent: 'visual', objective: '提供封面/图解方案', acceptanceCriteria: ['移动端可读'] }, { agent: 'qa', objective: '独立准出', acceptanceCriteria: ['格式和内容通过'] }] }
  if (agent === 'writer') {
    const title = state.title || '未命名文章'
    return { outline: ['问题', '核心机制', '启发'], article: `---\ntitle: "${title}"\n---\n\n这是一份用于验证公众号生产 Harness 的工作稿。\n\n## 这篇文章要解释什么\n\n本文把复杂项目拆成读者能理解的工作流、工具和质量门禁。\n\n## 关键机制\n\n### 模型负责判断\n\n模型负责调研、组织和写作。\n\n### 程序负责门禁\n\n确定性工具负责渲染、格式检查与发布前验证。\n\n![架构图](../assets/architecture.svg)\n\n## 结语\n\n把专家 SOP 固化为可审计的流程，比堆叠角色更重要。\n`, sources: [], claims: [], conflicts: [] }
  }
  if (agent === 'visual') return { coverDecision: state.cover ? 'reuse supplied cover' : 'missing cover', diagramTitle: `${state.title} 的生产结构`, diagramNodes: ['写作 Agent', '视觉 Agent', 'QA Agent', '确定性工具'], alt: '四个节点串联展示写作、视觉、质量审核和确定性工具。', findings: [] }
  return { verdict: 'pass', summary: 'Mock QA pass.', findings: [] }
}

function orchestratorPrompt(state: RunState) { return `你是公众号生产主 Agent。只能规划、派单和裁决，不能改写正文、生成生产 HTML/CSS、上传图片或调用公众号接口。\n运行 ID：${state.id}\n模式：${state.mode}\n目标：${state.goal}\n输入：${state.source ?? '主题：' + state.title}\n规则文件：${sourceRules().join('、')}\n输出一个简短可审计计划，并分别给 writer、visual、qa 任务。` }
function writerPrompt(state: RunState, source: string, decisions: FactConflict[]) { return `你是公众号写作与事实核验 Agent。只读工作区；可以使用公开网页检索核验关键事实；不得调用发布工具或生成 HTML/CSS。\n运行 ID：${state.id}\n目标：${state.goal}\n受众：${state.audience ?? '对 AI / Agent 感兴趣的技术读者'}\n原始输入：\n${source}\n\n人工已裁决的事实冲突（必须遵守，不得重新打开）：${JSON.stringify(decisions.filter(item => item.status === 'resolved').map(item => ({ id: item.id, decision: item.decision, note: item.note })))}\n\n输出适合微信公众号的完整 Markdown 工作稿。文章开头不要自行写目录，渲染器会注入“文章目录”。使用 H2/H3。保留有证据的关键事实；对外部调研与原稿存在重大冲突时，必须写入 conflicts，不能自行选择改法。每个关键事实都应映射到 sources/claims。如果正文使用 [1][2] 这类编号引用，文末必须给出编号一一对应的「参考来源」列表，每条含可点击 URL；没有对应条目的编号标记不得出现。公众号草稿标题上限为 32 个字符，一级标题（H1）必须控制在该上限内。渲染器会在文末自动注入一张按纵向串联流程绘制的架构图，因此正文不要自绘 ASCII 结构图，也不要使用与纵向串联冲突的并列、双列或汇合式结构描述。` }
function visualPrompt(state: RunState, markdown: string) { return `你是微信公众号视觉 Agent。只读工作区，不改写正文、不调用公众号接口。\n文章标题：${state.title}\n工作稿：\n${markdown}\n\n判断是否复用现有封面，并给出一张必要、极简的架构图标题和 3-5 个节点。图必须适合 390px 手机阅读，避免复杂、AI 味和密集小字。架构图由渲染器按这 3-5 个节点绘制成纵向串联流程：diagramNodes 必须是顺序递进的单链，alt 必须准确描述这条纵向串联链路，不得出现并列、双列或汇合描述。` }
function qaPrompt(state: RunState, markdown: string, deterministic: unknown) { return `你是独立公众号 QA Agent。只读，不改写文章，不操作草稿。\n工作稿：\n${markdown}\n\n确定性 QA：${JSON.stringify(deterministic)}\n检查事实可追溯、读者门槛、标题层级、目录和代码块规则、视觉资产与发布风险。以下属于渲染前的正常状态，不得作为阻断或需改项：正文中的 ../assets/architecture.svg 等本地相对路径（发布阶段会替换为公众号可访问的远程地址）；由渲染器注入的“文章目录”。错误级问题必须 verdict=blocked；需改但可继续则 revise。` }

function diagramSvg(title: string, nodes: string[]) {
 const text = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
 const width = 780
 const boxHeight = 132
 const gap = 60
 const top = 250
 const height = top + nodes.length * boxHeight + Math.max(nodes.length - 1, 0) * gap + 140
 const fit = (value: string, wide: number, narrow: number) => value.length > 10 ? narrow : wide
 const boxes = nodes.map((node, index) => {
  const y = top + index * (boxHeight + gap)
  const arrow = index < nodes.length - 1 ? `<path d="M${width / 2} ${y + boxHeight}V${y + boxHeight + gap - 18}" stroke="#78c7ee" stroke-width="6" marker-end="url(#arrow)"/>` : ''
  return `<g>${arrow}<rect x="80" y="${y}" width="${width - 160}" height="${boxHeight}" rx="20" fill="#12355b" stroke="#90ddff" stroke-width="3"/><circle cx="124" cy="${y + 44}" r="11" fill="#90ddff"/><text x="152" y="${y + 58}" fill="#fff" font-size="${fit(node, 40, 30)}" font-weight="700" font-family="Arial, PingFang SC, sans-serif">${text(node)}</text></g>`
 }).join('')
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#071a36"/><stop offset="1" stop-color="#1b5a88"/></linearGradient><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#78c7ee"/></marker></defs><rect width="${width}" height="${height}" fill="url(#bg)"/><text x="80" y="140" fill="#9de1ff" font-size="26" font-weight="700" letter-spacing="6" font-family="Arial, PingFang SC, sans-serif">WECHAT ARTICLE HARNESS</text><text x="80" y="200" fill="#fff" font-size="${fit(title, 44, 32)}" font-weight="700" font-family="Arial, PingFang SC, sans-serif">${text(title)}</text>${boxes}<text x="80" y="${height - 60}" fill="#c8e7f8" font-size="28" font-family="Arial, PingFang SC, sans-serif">模型做判断，确定性工具守住质量和发布边界</text></svg>`
}

async function createRun(mode: RunState['mode'], input: string, options: { goal: string; audience?: string; angle?: string; cover?: string }) {
  const id = randomUUID(); const dir = runDir(id); await fs.mkdir(path.join(dir, 'input'), { recursive: true }); await fs.mkdir(path.join(dir, 'writing'), { recursive: true }); await fs.mkdir(path.join(dir, 'assets'), { recursive: true })
  let source: string | undefined; let raw = ''
  if (mode === 'improve') { source = safeVaultPath(input, 'Article'); if (path.extname(source) !== '.md') throw new Error('improve requires a Markdown article.'); raw = await fs.readFile(source, 'utf8'); await fs.writeFile(path.join(dir, 'input', 'source.md'), raw) }
  else { raw = `# ${input}\n`; await fs.writeFile(path.join(dir, 'input', 'source.md'), raw) }
  let cover: string | undefined
 if (options.cover) { const coverPath = await safeCoverPath(options.cover); const target = path.join(dir, 'assets', `cover${path.extname(coverPath).toLowerCase()}`); await fs.copyFile(coverPath, target); cover = rel(target) }
 const state: RunState = { version: 2, id, mode, phase: 'intake', title: mode === 'improve' ? titleOf(raw, path.basename(source!, '.md')) : input, goal: options.goal, audience: options.audience, angle: options.angle, source: source ? rel(source) : undefined, cover, attempts: 0, threads: {}, artifacts: { sourceSnapshot: rel(path.join(dir, 'input', 'source.md')) }, tasks: [], draft: { urlStatus: 'not_created' }, createdAt: now(), updatedAt: now() }
  await save(state); await event(state, 'run_created', { mode, source: state.source, title: state.title }); return state
}

async function plan(state: RunState) {
  state.phase = 'plan'; await save(state); const output = await runAgent<{ plan: string[]; tasks: Array<{ agent: Exclude<AgentName, 'orchestrator'>; objective: string; acceptanceCriteria: string[] }> }>(state, 'orchestrator', orchestratorPrompt(state), schemas.orchestrator)
  state.tasks = output.tasks.map(item => ({ runId: state.id, agent: item.agent, phase: item.agent === 'writer' ? 'research_and_write' : item.agent === 'visual' ? 'visual_design' : 'full_qa', objective: item.objective, inputArtifacts: [state.artifacts.sourceSnapshot, ...sourceRules()], requiredOutput: `${item.agent}.json`, acceptanceCriteria: item.acceptanceCriteria }))
  await writeJson(state, 'plan', 'plan.json', output); await writeJson(state, 'tasks', 'tasks.json', state.tasks); await event(state, 'plan_completed', { tasks: state.tasks.map(task => task.agent) }); await save(state)
}

async function researchAndWrite(state: RunState) {
  state.phase = 'research_and_write'; await save(state); const raw = await fs.readFile(artifact(state, 'sourceSnapshot', 'input/source.md'), 'utf8'); let prior: FactConflict[] = []
  try { prior = await readJson<FactConflict[]>(state, 'conflicts', 'research/conflicts.json') } catch { /* first research pass */ }
  const result = await runAgent<{ outline: string[]; article: string; sources: unknown[]; claims: Claim[]; conflicts: Omit<FactConflict, 'status'>[] }>(state, 'writer', writerPrompt(state, raw, prior), schemas.writer, true)
  if (!result.article.includes('## ')) throw new Error('Writer output must contain H2 headings.')
  const revision = state.attempts + 1; await writeJson(state, 'outline', 'writing/outline.json', result.outline); await writeJson(state, 'sources', 'research/sources.json', result.sources); await writeJson(state, 'claims', 'research/claims.json', result.claims)
  const conflicts: FactConflict[] = result.conflicts.map(item => {
    const priorConflict = prior.find(existing => existing.id === item.id)
    return priorConflict?.status === 'resolved' ? { ...item, status: 'resolved', decision: priorConflict.decision, note: priorConflict.note } : { ...item, status: 'open' }
  }); await writeJson(state, 'conflicts', 'research/conflicts.json', conflicts)
  await writeText(state, 'writingFinal', `writing/article-r${revision}.md`, result.article); await event(state, 'writer_completed', { claims: result.claims.length, conflicts: conflicts.length })
  if (unresolvedConflicts(conflicts).length) { state.phase = 'awaiting_human_fact_resolution'; await event(state, 'fact_conflict_requires_human', { conflicts: unresolvedConflicts(conflicts).map(item => item.id) }); await save(state); return }
  await save(state)
}

async function visualDesign(state: RunState) {
  state.phase = 'visual_design'; await save(state); const markdown = await fs.readFile(finalMarkdown(state), 'utf8'); const result = await runAgent<{ coverDecision: string; diagramTitle: string; diagramNodes: string[]; alt: string; findings: string[] }>(state, 'visual', visualPrompt(state, markdown), schemas.visual)
  if (!state.cover && state.mode === 'topic') {
    const cover = process.env.WECHAT_AGENT_MOCK === '1'
      ? path.join(runDir(state.id), 'assets', 'cover.png')
      : undefined
    if (cover) { await fs.writeFile(cover, 'mock cover'); state.cover = rel(cover) }
    else {
      const generated = await command('md2wechat', ['generate_cover', '--title', state.title, '--summary', state.goal, '--keywords', state.angle ?? 'AI, Agent, 技术解读', '--aspect', '16:9', '--size', '1600x900', '--json'])
      const output = (generated.data as Record<string, unknown> | undefined)?.output_file
      if (typeof output !== 'string') throw new Error('Cover generation returned no output file.')
      const target = path.join(runDir(state.id), 'assets', `cover${path.extname(output) || '.png'}`)
      await fs.copyFile(output, target); state.cover = rel(target)
    }
    await event(state, 'cover_generated', { cover: state.cover })
  }
  if (!state.cover) { state.phase = 'blocked'; state.blockedReason = 'A dedicated cover is required before visual production.'; await event(state, 'blocked', { reason: state.blockedReason }); await save(state); return }
  const svg = path.join(runDir(state.id), 'assets', 'architecture.svg'); await fs.writeFile(svg, diagramSvg(result.diagramTitle, result.diagramNodes)); state.artifacts.architecture = rel(svg); await writeJson(state, 'visualBrief', 'visual/brief.json', result); await writeJson(state, 'assetManifest', 'assets/manifest.json', { cover: state.cover, architecture: state.artifacts.architecture, alt: result.alt, generatedAt: now() })
  const final = finalMarkdown(state); let article = markdown
  if (!/!\[[^\]]*\]\(\.\.\/assets\/architecture\.svg\)/.test(article)) article = `${article.trim()}\n\n![${result.alt}](../assets/architecture.svg)\n`
  await fs.writeFile(final, article); await event(state, 'visual_completed', { architecture: state.artifacts.architecture }); await save(state)
}

async function render(state: RunState) {
  state.phase = 'render'; await save(state); const source = finalMarkdown(state); const bytes = await fs.readFile(source); state.renderedSourceSha256 = sha256(bytes)
  const html = path.join(runDir(state.id), 'render', 'article.html'); const draftPayload = path.join(runDir(state.id), 'publish', 'draft-payload.json'); await fs.mkdir(path.dirname(html), { recursive: true }); await fs.mkdir(path.dirname(draftPayload), { recursive: true })
  const result = await command('pnpm', ['--dir', 'vendor/doocs-md/packages/mcp-server', 'exec', 'tsx', '../../../../scripts/wechat/publish-tech-draft.mts', source, '--html', html, '--draft-json', draftPayload])
  state.artifacts.html = rel(String(result.html)); state.artifacts.draftPayload = rel(draftPayload); const output = await fs.readFile(html, 'utf8'); state.qa = deterministicQa(await fs.readFile(source, 'utf8'), output, state.cover)
  await writeJson(state, 'deterministicQa', 'qa/deterministic.json', state.qa); await event(state, 'render_completed', { passed: state.qa.passed }); await save(state)
  if (!state.qa.passed) { state.phase = 'blocked'; state.blockedReason = state.qa.findings.map(item => item.message).join('; '); await event(state, 'blocked', { reason: state.blockedReason }); await save(state) }
}

async function screenshot(state: RunState) {
  const target = path.join(runDir(state.id), 'render', 'article-mobile.png'); const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  try { await exec(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', '--window-size=390,844', `--screenshot=${target}`, pathToFileURL(artifact(state, 'html', 'render/article.html')).href], { cwd: root, maxBuffer: 1024 * 1024 }); state.artifacts.screenshot = rel(target); return target } catch (error) { throw new Error(`Mobile screenshot failed: ${error instanceof Error ? error.message : String(error)}`) }
}

async function fullQa(state: RunState) {
  state.phase = 'full_qa'; await save(state); const markdown = await fs.readFile(finalMarkdown(state), 'utf8'); const shot = await screenshot(state); const result = await runAgent<{ verdict: Verdict; summary: string; findings: Finding[] }>(state, 'qa', qaPrompt(state, markdown, state.qa), schemas.qa)
  const visualQa = { screenshot: rel(shot), verdict: result.verdict, findings: result.findings, summary: result.summary }; await writeJson(state, 'visualQa', 'qa/visual.json', visualQa); await writeJson(state, 'finalQa', 'qa/final.json', result)
  if (result.verdict === 'blocked' || result.findings.some(item => item.severity === 'error')) { state.phase = 'blocked'; state.blockedReason = result.summary; await event(state, 'qa_blocked', { summary: result.summary }); await save(state); return }
  if (result.verdict === 'revise') { await revise(state, result.summary); return }
 state.qa = { ...state.qa!, verdict: 'pass' }; state.phase = 'awaiting_draft_approval'; await event(state, 'awaiting_draft_approval', { cover: Boolean(state.cover) }); await save(state)
}

async function revise(state: RunState, reason: string) {
  state.attempts += 1; if (state.attempts >= maxRevisions) { state.phase = 'blocked'; state.blockedReason = `QA did not pass after ${maxRevisions} attempts: ${reason}`; await event(state, 'blocked', { reason: state.blockedReason }); await save(state); return }
  state.phase = 'revise'; await event(state, 'revision_required', { reason, attempt: state.attempts }); await save(state); await researchAndWrite(state)
}

async function advance(state: RunState) {
  if (state.phase === 'intake') await plan(state)
  if (state.phase === 'plan') await researchAndWrite(state)
 if (state.phase === 'awaiting_draft_approval' && sha256(await fs.readFile(finalMarkdown(state))) !== state.renderedSourceSha256) {
 await event(state, 'working_copy_changed', { reason: 'working copy edited after QA; rerendering before draft' })
 await render(state)
 if (state.phase === 'blocked') return state
 await fullQa(state)
 return state
 }
 if (state.phase === 'awaiting_human_fact_resolution' || state.phase === 'blocked' || state.phase === 'awaiting_draft_approval' || state.phase === 'completed') return state
  if (state.phase === 'research_and_write' || state.phase === 'revise') await visualDesign(state)
  if (state.phase === 'blocked') return state
  if (state.phase === 'visual_design') await render(state)
  if (state.phase === 'render') await fullQa(state)
  return state
}

async function resolveFacts(state: RunState, id: string, decision: FactConflict['decision'], note?: string) {
  if (state.phase !== 'awaiting_human_fact_resolution') throw new Error(`Run is ${state.phase}; no fact decision is pending.`)
  const conflicts = await readJson<FactConflict[]>(state, 'conflicts', 'research/conflicts.json'); const conflict = conflicts.find(item => item.id === id); if (!conflict || conflict.severity !== 'major' || conflict.status !== 'open') throw new Error('No open major conflict with that id.')
  conflict.status = 'resolved'; conflict.decision = decision; conflict.note = note; await writeJson(state, 'conflicts', 'research/conflicts.json', conflicts); await event(state, 'fact_conflict_resolved', { id, decision, note })
  if (!unresolvedConflicts(conflicts).length) { state.phase = 'revise'; await save(state); await researchAndWrite(state); await advance(state) } else await save(state)
}

function summary(state: RunState) { return { runId: state.id, mode: state.mode, phase: state.phase, title: state.title, goal: state.goal, attempts: state.attempts, blockedReason: state.blockedReason, artifacts: state.artifacts, qa: state.qa, draft: state.draft, nextAction: state.phase === 'awaiting_human_fact_resolution' ? 'Resolve every major fact conflict with resolve-facts.' : state.phase === 'awaiting_draft_approval' ? 'Explicitly request draft creation; the CLI consumes its internal guard automatically.' : state.phase === 'blocked' ? 'Read report and start a corrected run.' : 'Use resume to continue.' } }

async function beforeDraft(state: RunState) {
  if (state.phase !== 'awaiting_draft_approval') throw new Error(`Run is ${state.phase}; draft mutation is forbidden.`)
  if (!state.cover || !state.qa?.passed || state.qa.verdict !== 'pass') throw new Error('Draft mutation requires a cover and passing QA.')
  const conflicts = await readJson<FactConflict[]>(state, 'conflicts', 'research/conflicts.json'); if (unresolvedConflicts(conflicts).length) throw new Error('Draft mutation is forbidden while major fact conflicts are unresolved.')
  if (sha256(await fs.readFile(finalMarkdown(state))) !== state.renderedSourceSha256) throw new Error('Working article changed after QA; resume to rerender and recheck it.')
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
 await exec(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', `--window-size=${size}`, `--screenshot=${target}`, pathToFileURL(source).href], { cwd: root, maxBuffer: 1024 * 1024 })
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
  const sourceAsset = artifact(state, 'architecture', 'assets/architecture.svg')
  const pngAsset = path.join(runDir(state.id), 'assets', 'architecture.png')
  await rasterizeSvg(sourceAsset, pngAsset)
  const uploaded = process.env.WECHAT_AGENT_MOCK === '1'
    ? { data: { url: 'https://example.invalid/wechat-agent/architecture.png' } }
    : await command('md2wechat', ['upload_image', pngAsset, '--json'])
  const remoteUrl = uploadedUrl(uploaded)
  const publishMarkdown = original
    .replaceAll('../assets/architecture.svg', remoteUrl)
    .replaceAll('../assets/architecture.png', remoteUrl)
  if (/\]\(\.\.\/assets\/|<img[^>]+(?:src|href)=["'](?:file:|\.\.\/assets\/)/i.test(publishMarkdown)) throw new Error('Publish working copy still contains a local body asset path.')
  const output = await writeText(state, 'publishArticle', 'publish/article.md', publishMarkdown)
  const html = path.join(runDir(state.id), 'publish', 'article.html')
  const draftPayload = path.join(runDir(state.id), 'publish', 'draft-payload.json')
  const rendered = await command('pnpm', ['--dir', 'vendor/doocs-md/packages/mcp-server', 'exec', 'tsx', '../../../../scripts/wechat/publish-tech-draft.mts', output, '--html', html, '--draft-json', draftPayload])
  const content = await fs.readFile(html, 'utf8')
  if (!content.includes(remoteUrl) || /(?:file:|\.\.\/assets\/)/i.test(content)) throw new Error('Publish HTML has not fully replaced local body assets.')
  state.artifacts.publishHtml = rel(String(rendered.html)); state.artifacts.publishDraftPayload = rel(draftPayload); state.artifacts.architecturePng = rel(pngAsset)
  await event(state, 'body_asset_uploaded', { local: rel(pngAsset), remote: remoteUrl })
  await save(state)
  return readJson<{ title: string; digest: string; content: string }>(state, 'publishDraftPayload', 'publish/draft-payload.json')
}

async function uploadCover(state: RunState) {
  const cover = artifact(state, 'cover', 'assets/cover.svg')
  const uploadPath = path.extname(cover).toLowerCase() === '.svg' ? path.join(runDir(state.id), 'assets', 'cover.png') : cover
  if (uploadPath !== cover) await rasterizeSvg(cover, uploadPath)
  await draftPreflight(artifact(state, 'publishArticle', 'publish/article.md'), uploadPath)
  const uploaded = process.env.WECHAT_AGENT_MOCK === '1' ? { data: { media_id: 'mock-cover-media-id' } } : await command('md2wechat', ['upload_image', uploadPath, '--json'])
  const mediaId = (uploaded.data as Record<string, unknown> | undefined)?.media_id
  if (typeof mediaId !== 'string' || !mediaId) throw new Error('Cover upload returned no media_id.')
  return mediaId
}

async function createDraft(state: RunState) {
  await beforeDraft(state); state.phase = 'draft_create'; await save(state); await event(state, 'draft_create_started')
  const payload = await publishWorkingCopy(state); const thumbMediaId = await uploadCover(state)
  let mediaId: string | undefined
  if (process.env.WECHAT_AGENT_MOCK === '1') mediaId = 'mock-draft-media-id'
  else { const requestPath = path.join(runDir(state.id), 'publish', 'create-draft.json'); await fs.writeFile(requestPath, JSON.stringify({ articles: [{ ...payload, thumb_media_id: thumbMediaId }] }, null, 2)); const created = await command('md2wechat', ['create_draft', requestPath, '--json']); mediaId = (created.data as Record<string, unknown> | undefined)?.media_id as string | undefined }
  if (!mediaId) throw new Error('Draft creation returned no media_id.')
 state.draft = { mediaId, urlStatus: 'pending_editor_url', mode: 'create' }; state.phase = 'post_draft_qa'; await save(state); await event(state, 'draft_created', { mediaId }); await postDraftQa(state); return state
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

async function postDraftQa(state: RunState) {
 const mediaId = state.draft?.mediaId
 if (!mediaId) throw new Error('No draft media_id to verify.')
 const payload = await readJson<{ title?: string }>(state, 'publishDraftPayload', 'publish/draft-payload.json')
 const expectedTitle = payload.title ?? state.title
 const readback: Record<string, unknown> = process.env.WECHAT_AGENT_MOCK === '1'
  ? { news_item: [{ title: expectedTitle, content: '<h2>验证</h2><section>文章目录</section>' }] }
  : await getDraft(mediaId)
 const news = draftNewsItem(readback)
 const content = typeof news.content === 'string' ? news.content : ''
 const checks = { title: news.title === expectedTitle, toc: content.includes('文章目录'), firstH2: /class="h2"|<h2/i.test(content), noLocalAsset: !/(?:file:|\.\.\/assets\/)/i.test(content) }
 await writeJson(state, 'readback', 'publish/readback.json', { checks, expectedTitle, mediaId, response: readback })
 if (!Object.values(checks).every(Boolean)) throw new Error(`Draft readback verification failed: ${Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(', ')}`)
 state.phase = 'completed'
 await event(state, 'draft_readback_completed', { mediaId, checks, urlStatus: state.draft?.urlStatus })
 await save(state)
}

async function updateDraft(state: RunState, mediaId: string) {
  await beforeDraft(state); state.phase = 'draft_update'; await save(state); const payload = await publishWorkingCopy(state); const thumbMediaId = await uploadCover(state)
  if (process.env.WECHAT_AGENT_MOCK !== '1') { const accessToken = await wechatToken(); const response = await fetch(`https://api.weixin.qq.com/cgi-bin/draft/update?access_token=${encodeURIComponent(accessToken)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_id: mediaId, index: 0, articles: { title: payload.title, author: '', digest: payload.digest, content: payload.content, content_source_url: '', thumb_media_id: thumbMediaId, show_cover_pic: 0, need_open_comment: 0, only_fans_can_comment: 0 } }) }); const responsePayload = await response.json() as Record<string, unknown>; if (responsePayload.errcode) throw new Error(`WeChat draft/update failed: ${responsePayload.errmsg ?? responsePayload.errcode}`) }
 state.draft = { mediaId, urlStatus: 'pending_editor_url', mode: 'update' }; state.phase = 'post_draft_qa'; await save(state); await event(state, 'draft_updated', { mediaId }); await postDraftQa(state); return state
}

async function main() {
  const args = process.argv.slice(2); const action = args.shift(); if (!action || action === '--help') throw new Error(usage)
  if (['topic', 'improve', 'start', 'export'].includes(action)) setVault(valueAfter(args, '--vault'))
  if (action === 'topic') { const topic = args.find(arg => !arg.startsWith('-')); if (!topic) throw new Error('topic requires a topic.'); const state = await createRun('topic', topic, { goal: valueAfter(args, '--goal') ?? `围绕“${topic}”形成适合公众号的技术文章`, audience: valueAfter(args, '--audience'), angle: valueAfter(args, '--angle'), cover: valueAfter(args, '--cover') }); await advance(state); console.log(JSON.stringify(summary(await load(state.id)), null, 2)); return }
  if (action === 'improve' || action === 'start') { const source = args.find(arg => !arg.startsWith('-')); const goal = valueAfter(args, '--goal') ?? '完成公众号审校、渲染和视觉 QA'; if (!source) throw new Error(`${action} requires <article.md>.`); const state = await createRun('improve', source, { goal, cover: valueAfter(args, '--cover') }); await advance(state); console.log(JSON.stringify(summary(await load(state.id)), null, 2)); return }
  const id = args[0]; if (!id) throw new Error(usage); const state = await load(id)
  if (action === 'status' || action === 'report') { console.log(JSON.stringify(summary(state), null, 2)); return }
  if (action === 'resume') { await advance(state); console.log(JSON.stringify(summary(await load(id)), null, 2)); return }
  if (action === 'preview') { const html = artifact(state, 'html', 'render/article.html'); await fs.access(html); console.log(JSON.stringify({ runId: id, html: rel(html), url: pathToFileURL(html).href }, null, 2)); return }
  if (action === 'resolve-facts') { const decision = valueAfter(args, '--decision') as FactConflict['decision']; if (!['research_wins', 'retain_with_qualification', 'drop_claim'].includes(decision)) throw new Error('resolve-facts requires a valid --decision.'); await resolveFacts(state, valueAfter(args, '--conflict') ?? '', decision, valueAfter(args, '--note')); console.log(JSON.stringify(summary(await load(id)), null, 2)); return }
  if (action === 'verify-draft') { await postDraftQa(state); console.log(JSON.stringify(summary(await load(id)), null, 2)); return }
 if (action === 'approve-draft') { await createDraft(state); console.log(JSON.stringify(summary(await load(id)), null, 2)); return }
  if (action === 'update-draft') { const mediaId = valueAfter(args, '--media-id'); if (!mediaId) throw new Error('update-draft requires --media-id.'); await updateDraft(state, mediaId); console.log(JSON.stringify(summary(await load(id)), null, 2)); return }
  if (action === 'export') { const output = valueAfter(args, '--output'); if (!output) throw new Error('export requires --output.'); const target = safeVaultPath(output, 'Export target'); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(finalMarkdown(state), target); await event(state, 'article_exported', { output: rel(target) }); await save(state); console.log(JSON.stringify({ runId: id, output: rel(target) }, null, 2)); return }
  throw new Error(usage)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 })

export { unresolvedConflicts }
