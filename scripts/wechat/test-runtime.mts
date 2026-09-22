import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Thread } from '@openai/codex-sdk'
import { advance, createDraft, createRevision, createRun, handoffRequest, postDraftQa, recordHandoff, resolveFacts, retryRun, runtime, schemas, updateDraft, uploadCover, withOperation, type RunState } from './wechat-agent.mts'
import { normalizeReferences, referencesMatchHtml } from './article-contract.mts'

const root = path.resolve(import.meta.dirname, '../..')
const createdRuns: string[] = []
const originalExec = runtime.exec
const originalCapture = runtime.capture
const originalRun = Thread.prototype.run
const originalFetch = globalThis.fetch
const originalReadFile = fs.readFile
const originalMock = process.env.WECHAT_AGENT_MOCK
const originalThread = process.env.CODEX_THREAD_ID
const historicalRuns = await fs.readdir(path.join(root, '.runtime/runs'))
async function historicalDigest() {
  const digest = createHash('sha256')
  for (const id of historicalRuns.sort()) {
    const directory = path.join(root, '.runtime/runs', id)
    for (const entry of (await fs.readdir(directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).sort((left, right) => path.join(left.parentPath, left.name).localeCompare(path.join(right.parentPath, right.name)))) {
      const file = path.join(entry.parentPath, entry.name)
      digest.update(file).update(await originalReadFile(file))
    }
  }
  return digest.digest('hex')
}
const originalHistoricalDigest = await historicalDigest()
const article = '# Runtime check\n\nRuntime 是用于验证 Harness 的项目，本文从它的工作方式切入。\n\n## First\n\nBody\n\n### Detail\n\nMore\n\n![Runtime pipeline](../assets/architecture.svg)\n'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTf8AAAAASUVORK5CYII=', 'base64')
const execCalls: Array<{ bin: string; args: string[] }> = []
const agentCalls: Array<{ agent: string; input: unknown; thread: Thread }> = []
const captureCalls: Array<{ fullArticle?: boolean }> = []
const fetchCalls: Array<{ url: string; body?: unknown }> = []
let failure = ''
let remoteCover = false
let qaVerdicts: Array<'pass' | 'revise' | 'blocked'> = []
let writerConflicts: unknown[] = []
let lastDraftPayload: { title: string; content: string } | undefined
let styleFails = false
let qaOverride: Record<string, unknown> | undefined
let mutateDuringPublish = false
let mutateDuringCapture = false
let mutateDuringUpload = ''
let realRendering = false
let bodyImageUrl = 'https://example.invalid/test-architecture.png'
const remoteDrafts = new Map<string, Record<string, unknown>>()

runtime.capture = async (html, directory, options = {}) => {
  failAt('screenshot')
  captureCalls.push(options)
  if (realRendering) return originalCapture(html, directory, options)
  await fs.mkdir(directory, { recursive: true })
  const names = options.fullArticle === false ? ['article-mobile-first.png'] : ['article-mobile-first.png', 'article-mobile-full.png', 'article-mobile-0.png']
  const files = names.map(name => path.join(directory, name))
  for (const file of files) await fs.writeFile(file, png)
  if (mutateDuringCapture) { await fs.appendFile(html, '<p>tampered during capture</p>'); mutateDuringCapture = false }
  return { files, metrics: { width: 390, scrollWidth: 390, height: 844, headings: [], images: [], ending: 'test' } }
}

function rendered(markdown: string) {
  const heading = (level: number) => (markdown.match(new RegExp(`^#{${level}} `, 'gm')) ?? []).map(() => `<h${level} class="h${level}">Heading</h${level}>`).join('')
  const images = [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => `<img src="${match[1]}">`).join('')
  const opening = markdown.split('\n').find(line => line.trim() && !line.startsWith('#') && line !== '---' && !line.startsWith('title:')) ?? ''
  return `<p class="p" style="color:#000;font-size: 15px;line-height: 1.82">${opening}</p>${heading(2)}${heading(3)}${images}` + '<p class="p" style="color:#000;font-size: 15px;line-height: 1.82">Body</p>'.repeat(25)
}

function failAt(name: string) { if (failure === name) throw new Error(`injected ${name}`) }

runtime.exec = (async (bin: string, args: string[]) => {
  execCalls.push({ bin, args })
  if (realRendering && (bin === 'pnpm' || bin.includes('Google Chrome'))) return originalExec(bin, args, { cwd: root, maxBuffer: 20 * 1024 * 1024 })
  if (bin === 'pnpm') {
    failAt('render')
    const source = args[args.indexOf('../../../../scripts/wechat/publish-tech-draft.mts') + 1]
    const markdown = await originalReadFile(source, 'utf8')
    const html = args[args.indexOf('--html') + 1]
    const payloadPath = args[args.indexOf('--draft-json') + 1]
    const payload = { title: 'Runtime check', digest: 'test', content: rendered(markdown) }
    if (mutateDuringPublish && source.endsWith('/publish/article.md')) { payload.content += '<p>unexpected publishing change</p>'; mutateDuringPublish = false }
    await fs.writeFile(html, payload.content)
    await fs.writeFile(payloadPath, JSON.stringify(payload))
    lastDraftPayload = payload
    return { stdout: JSON.stringify({ html }), stderr: '' }
  }
  if (bin.includes('Google Chrome')) {
    failAt('screenshot')
    const target = args.find(value => value.startsWith('--screenshot='))!.slice('--screenshot='.length)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, png)
    return { stdout: '', stderr: '' }
  }
  assert.equal(bin, 'md2wechat', `unexpected executable: ${bin}`)
  failAt(args[0])
  if (args[0] === 'inspect') return { stdout: JSON.stringify({ data: { readiness: { targets: { draft: 'ready' } } } }), stderr: '' }
  if (args[0] === 'upload_image') {
    if (mutateDuringUpload) { remoteDrafts.get(mutateDuringUpload)!.content = 'human edited during upload'; mutateDuringUpload = '' }
    return { stdout: JSON.stringify({ data: { media_id: 'test-cover', wechat_url: bodyImageUrl } }), stderr: '' }
  }
  if (args[0] === 'create_draft') {
    lastDraftPayload = JSON.parse(await originalReadFile(args[1], 'utf8')).articles[0]
    remoteDrafts.set('test-draft-id', { ...lastDraftPayload, thumb_media_id: 'test-cover' })
    return { stdout: JSON.stringify({ data: { media_id: 'test-draft-id' } }), stderr: '' }
  }
  if (args[0] === 'generate_cover') {
    if (remoteCover) return { stdout: JSON.stringify({ success: true, data: { original_url: 'https://example.invalid/generated-cover.png', media_id: 'generated-cover' } }), stderr: '' }
    const output = path.join(root, '.runtime/runs', createdRuns.at(-1)!, 'assets/generated.png')
    await fs.writeFile(output, png)
    return { stdout: JSON.stringify({ data: { output_file: output } }), stderr: '' }
  }
  throw new Error(`Unexpected md2wechat action: ${args[0]}`)
}) as typeof runtime.exec

Thread.prototype.run = async function (input, options) {
  const agent = Object.entries(schemas).find(([, schema]) => schema === options?.outputSchema)?.[0]
  assert.ok(agent, 'all agent calls must have a known schema')
  agentCalls.push({ agent, input, thread: this })
  Object.assign(this, { _id: this.id ?? randomUUID() })
  failAt(agent)
  const outputs = {
    orchestrator: { plan: ['test'], tasks: ['outline', 'writer', 'structureEditor', 'styleEditor', 'visual', 'qa'].map(agent => ({ agent, objective: 'test', acceptanceCriteria: ['test'] })) },
    outline: { outline: ['First'], rationale: ['test'], mergedOrDropped: [] },
    writer: { outline: ['First', 'Detail'], article, sources: [], claims: [], conflicts: writerConflicts },
    structureEditor: { article, summary: 'Structured independently', checks: ['structure'], findings: [] },
    styleEditor: { article, summary: 'Styled independently', checks: ['tone', 'humanization'], findings: [] },
    patchEditor: { patches: [{ before: String(input).includes('Body changed') ? 'Body changed' : 'Body', after: String(input).includes('Body changed') ? 'Body revised' : 'Body changed' }], summary: 'A single targeted change' },
    visual: { coverDecision: 'reuse', diagramTitle: 'Runtime', diagramNodes: ['Write', 'Render', 'Review'], alt: 'Runtime pipeline', findings: [] },
    visionProbe: { imageCount: 1, firstVisibleLine: 'Runtime 是用于验证 Harness 的项目', visibleItems: ['Runtime'], notes: 'Stub vision preflight pass.' },
    qa: { verdict: agent === 'qa' ? qaVerdicts.shift() ?? 'pass' : 'pass', stylePassed: !styleFails, summary: 'Increase heading contrast', firstVisibleLine: 'Runtime 是用于验证 Harness 的项目', visibleItems: ['Runtime'], findings: [] },
  }
  if (agent === 'qa' && (outputs.qa.verdict === 'revise' || styleFails)) Object.assign(outputs.qa, { findings: [{ severity: 'warning', category: styleFails ? 'style' : 'layout', blocking: true, evidence: 'First heading in first screenshot', message: 'Increase heading contrast', recommendation: 'Increase heading contrast' }] })
  if (agent === 'qa' && qaOverride) Object.assign(outputs.qa, qaOverride)
  if (agent === 'styleEditor' && String(input).includes('当前修订范围：style')) {
    const current = String(input).split('工作稿：\n')[1].split('\n\n实际重写全文')[0]
    outputs.styleEditor.article = current.replace('Body', 'Conversational body')
  }
  return { finalResponse: JSON.stringify(outputs[agent as keyof typeof outputs]), items: [], usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (realRendering && url.startsWith('http://127.0.0.1:')) return originalFetch(input, init)
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  fetchCalls.push({ url, body })
  if (url === 'https://example.invalid/generated-cover.png') {
    failAt('cover-download')
    return new Response(png, { headers: { 'content-type': 'image/png' } })
  }
  if (url.includes('/token?')) return Response.json({ access_token: 'test-token' })
  if (url.includes('/draft/get?')) {
    failAt('readback')
    if (failure === 'readback-mismatch') return Response.json({ news_item: [{ title: 'Wrong title', content: '<p>wrong draft</p>' }] })
    if (!remoteDrafts.has(body.media_id)) remoteDrafts.set(body.media_id, { ...lastDraftPayload, thumb_media_id: 'test-cover' })
    return Response.json({ news_item: [remoteDrafts.get(body.media_id)] })
  }
  if (url.includes('/draft/update?')) { failAt('update'); lastDraftPayload = body.articles; remoteDrafts.set(body.media_id, body.articles); return Response.json({ errcode: 0 }) }
  throw new Error(`Unexpected fetch: ${url}`)
}) as typeof fetch

fs.readFile = ((filename: Parameters<typeof fs.readFile>[0], ...options: unknown[]) => {
  if (String(filename).endsWith('/.config/md2wechat/config.yaml')) return Promise.resolve('appid: test-app\nsecret: test-secret\n')
  return (originalReadFile as (...args: unknown[]) => unknown)(filename, ...options)
}) as typeof fs.readFile

async function stateFile(state: RunState) { return JSON.parse(await originalReadFile(path.join(root, '.runtime/runs', state.id, 'state.json'), 'utf8')) as RunState }
async function persist(state: RunState) { await fs.writeFile(path.join(root, '.runtime/runs', state.id, 'state.json'), JSON.stringify(state)) }
async function fixture(mode: 'real' | 'mock' = 'real', cover = true) {
  process.env.WECHAT_AGENT_MOCK = mode === 'mock' ? '1' : '0'
  const state = await createRun('topic', 'Runtime check', { goal: 'test' })
  createdRuns.push(state.id)
  if (cover) { state.cover = path.join('.runtime/runs', state.id, 'assets/cover.png'); await fs.writeFile(path.resolve(root, state.cover), png); await persist(state) }
  return state
}

async function ready(mode: 'real' | 'mock' = 'real') { const state = await fixture(mode); await advance(state); assert.equal(state.phase, 'awaiting_draft_approval'); return state }
function resetCalls() { execCalls.length = 0; agentCalls.length = 0; fetchCalls.length = 0; captureCalls.length = 0 }
function assertNoSideEffects() { assert.equal(execCalls.length, 0); assert.equal(agentCalls.length, 0); assert.equal(fetchCalls.length, 0) }

try {
  const mock = await ready('mock')
  assert.equal((await stateFile(mock)).executionMode, 'mock')
  assert.equal(mock.phase, 'awaiting_draft_approval')
  process.env.WECHAT_AGENT_MOCK = '0'
  resetCalls()
  await assert.rejects(() => advance(mock), /never mix mock and real/)
  await assert.rejects(() => createDraft(mock), /never mix mock and real/)
  await assert.rejects(() => updateDraft(mock, 'test-target'), /never mix mock and real/)
  await assert.rejects(() => postDraftQa(mock), /never mix mock and real/)
  const legacy = { ...mock, executionMode: undefined }
  await assert.rejects(() => createDraft(legacy), /execution mode is unknown/)
  await assert.rejects(() => updateDraft(legacy, 'test-target'), /execution mode is unknown/)
  await assert.rejects(() => advance(legacy), /execution mode is unknown/)
  await assert.rejects(() => postDraftQa({ ...legacy, phase: 'completed', draft: { mediaId: 'mock-draft-media-id', urlStatus: 'pending_editor_url' } }), /execution mode is unknown/)
  assertNoSideEffects()

  const noAutomaticDiagram = await fixture()
  failure = 'visual'
  await assert.rejects(() => advance(noAutomaticDiagram), /injected visual/)
  const withoutDiagram = article.replace('\n\n![Runtime pipeline](../assets/architecture.svg)', '')
  await fs.writeFile(path.resolve(root, noAutomaticDiagram.artifacts.writingFinal), withoutDiagram)
  failure = ''
  await advance(noAutomaticDiagram)
  assert.equal(noAutomaticDiagram.phase, 'awaiting_draft_approval')
  assert.equal(await originalReadFile(path.resolve(root, noAutomaticDiagram.artifacts.writingFinal), 'utf8'), withoutDiagram)
  assert(!JSON.parse(await originalReadFile(path.resolve(root, noAutomaticDiagram.artifacts.draftPayload), 'utf8')).content.includes('<img'))

  const real = await ready()
  const qaCall = agentCalls.findLast(call => call.agent === 'qa')!
  assert.ok(Array.isArray(qaCall.input))
  const images = qaCall.input.filter(item => item.type === 'local_image')
  assert.equal(images.length, 3)
  assert.equal(images.at(-1)!.path, path.resolve(root, real.cover!))
  assert.equal(images[0].path, path.join(root, '.runtime/runs', real.id, 'render/article-mobile-first.png'))
  assert.equal(images[1].path, path.join(root, '.runtime/runs', real.id, 'render/article-mobile-0.png'))
  assert(!images.some(image => image.path.endsWith('article-mobile-full.png')))
  assert.deepEqual(await originalReadFile(images[0].path), png)
  assert.match(qaCall.input[0].text, /必须直接依据图片检查开头自然项目介绍/)
  process.env.WECHAT_AGENT_MOCK = '1'
  resetCalls()
  await assert.rejects(() => advance(real), /never mix mock and real/)
  await assert.rejects(() => postDraftQa(real), /never mix mock and real/)
  assertNoSideEffects()
  process.env.WECHAT_AGENT_MOCK = '0'

  for (const extension of ['jpg', 'jpeg', 'png', 'svg', 'SVG']) {
    real.cover = path.join('.runtime/runs', real.id, `assets/custom.${extension}`)
    await fs.writeFile(path.resolve(root, real.cover), extension.toLowerCase() === 'svg' ? '<svg width="780" height="900"></svg>' : png)
    real.artifacts.cover = 'intentionally-stale.svg'
    resetCalls()
    assert.equal(await uploadCover(real), 'test-cover')
    const raster = execCalls.find(call => call.bin.includes('Google Chrome'))
    const upload = execCalls.find(call => call.args[0] === 'upload_image')!
    if (extension.toLowerCase() === 'svg') {
      assert.equal(fileURLToPath(raster!.args.at(-1)!), path.resolve(root, real.cover))
      assert.ok(upload.args[1].endsWith('/assets/cover.png'))
    } else { assert.equal(raster, undefined); assert.equal(upload.args[1], path.resolve(root, real.cover)) }
  }
  resetCalls()
  await assert.rejects(() => uploadCover({ ...real, cover: undefined }), /dedicated cover/)
  await assert.rejects(() => uploadCover({ ...real, cover: 'does-not-exist.png' }), /ENOENT/)
  assertNoSideEffects()

  for (const [injected, phase, resumedAgent] of [
    ['orchestrator', 'plan', 'orchestrator'], ['outline', 'outline_review', 'outline'], ['writer', 'research_and_write', 'writer'],
    ['structureEditor', 'structure_review', 'structureEditor'], ['styleEditor', 'style_review', 'styleEditor'],
    ['visual', 'visual_design', 'visual'], ['render', 'render', 'qa'],
    ['screenshot', 'full_qa', 'qa'], ['qa', 'full_qa', 'qa'],
  ] as const) {
    const state = await fixture()
    failure = injected
    await assert.rejects(() => advance(state), new RegExp(`injected ${injected}`))
    const checkpoint = await stateFile(state)
    assert.equal(checkpoint.phase, phase)
    if (injected === 'writer') assert.ok(checkpoint.threads.writer)
    failure = ''; resetCalls()
    await advance(checkpoint)
    assert.equal(checkpoint.phase, 'awaiting_draft_approval')
    if (resumedAgent === 'qa') assert.equal(agentCalls.at(-1)!.agent, 'qa')
    else assert.equal(agentCalls[0].agent, resumedAgent)
    if (injected === 'writer') assert.equal(agentCalls[0].thread.id, checkpoint.threads.writer)
    console.log(`runtime resume after ${injected}: ok`)
  }

  const revision = await fixture()
  qaVerdicts = ['revise', 'pass']; resetCalls()
  await advance(revision)
  assert.equal(revision.phase, 'awaiting_draft_approval')
  assert.equal(revision.attempts, 1)
  assert.equal(agentCalls.filter(call => call.agent === 'writer').length, 1)
  assert.match(String(agentCalls.find(call => call.agent === 'patchEditor')!.input), /Increase heading contrast/)
  assert.ok(revision.versions!.length >= 4)
  assert.equal(new Set(revision.versions!.map(version => version.path)).size, revision.versions!.length)
  for (const version of revision.versions!) assert.equal(createHash('sha256').update(await originalReadFile(path.resolve(root, version.path))).digest('hex'), version.sha256)
  const interruptedRevision = await ready()
  interruptedRevision.phase = 'revise'; interruptedRevision.attempts = 1; interruptedRevision.revisionReason = 'Resume this saved revision'
  await persist(interruptedRevision); resetCalls()
  const revisionCheckpoint = await stateFile(interruptedRevision)
  await advance(revisionCheckpoint)
  assert.equal(revisionCheckpoint.phase, 'awaiting_draft_approval')
  assert.equal(revisionCheckpoint.attempts, 1)
  assert.equal(agentCalls[0].agent, 'writer')
  assert.match(String(agentCalls[0].input), /Resume this saved revision/)
  const exhausted = await fixture()
  qaVerdicts = ['revise', 'revise', 'revise']
  await advance(exhausted)
  assert.equal(exhausted.phase, 'blocked')
  assert.equal(exhausted.attempts, 3)
  qaVerdicts = []

  const edited = await ready()
  await fs.appendFile(path.resolve(root, edited.artifacts.writingFinal), '\nChanged after QA\n')
  resetCalls()
  await assert.rejects(() => createDraft(edited), /changed after QA/)
  assertNoSideEffects()
  await advance(edited)
  assert.equal(edited.phase, 'awaiting_draft_approval')
  assert.equal(agentCalls.at(-1)!.agent, 'qa')
  assert.ok(execCalls.some(call => call.bin === 'pnpm'))

  const staleQa = await ready()
  staleQa.phase = 'full_qa'; await persist(staleQa)
  await fs.appendFile(path.resolve(root, staleQa.artifacts.writingFinal), '\nChanged during QA interruption\n')
  resetCalls()
  await advance(staleQa)
  assert.equal(staleQa.phase, 'awaiting_draft_approval')
  assert.ok(execCalls.some(call => call.bin === 'pnpm'))

  writerConflicts = [{ id: 'fact-1', draftClaim: 'test', location: { artifact: 'input/source.md', line: 1 }, evidence: [], severity: 'major', impact: 'core_conclusion' }]
  const facts = await fixture()
  await advance(facts)
  assert.equal(facts.phase, 'awaiting_human_fact_resolution')
  resetCalls()
  await advance(facts)
  await assert.rejects(() => createDraft(facts), /draft mutation is forbidden/)
  assertNoSideEffects()
  await resolveFacts(facts, 'fact-1', 'drop_claim')
  assert.equal(facts.phase, 'awaiting_draft_approval')
  writerConflicts = []

  const generated = await fixture('real', false)
  await advance(generated)
  assert.ok(generated.cover!.endsWith('.png'))
  await createDraft(generated)
  assert.equal(generated.phase, 'completed')
  assert.equal(generated.draft!.mediaId, 'test-draft-id')
  remoteDrafts.delete('test-draft-id')

  remoteCover = true
  const downloaded = await fixture('real', false)
  failure = 'cover-download'
  await assert.rejects(() => advance(downloaded), /injected cover-download/)
  assert.ok((await stateFile(downloaded)).artifacts.coverGeneration)
  failure = ''; resetCalls()
  await advance(await stateFile(downloaded))
  const recoveredCover = await stateFile(downloaded)
  assert.equal(recoveredCover.phase, 'awaiting_draft_approval')
  assert.deepEqual(await originalReadFile(path.resolve(root, recoveredCover.cover!)), png)
  assert.equal(execCalls.filter(call => call.args[0] === 'generate_cover').length, 0)
  remoteCover = false

  const publishing = await ready()
  failure = 'upload_image'
  await assert.rejects(() => createDraft(publishing), /injected upload_image/)
  let checkpoint = await stateFile(publishing)
  assert.equal(checkpoint.phase, 'draft_create')
  assert.equal(checkpoint.draft!.requestStartedAt, undefined)
  failure = ''; resetCalls()
  await advance(checkpoint)
  assert.equal(checkpoint.phase, 'completed')
  assert.equal(execCalls.filter(call => call.args[0] === 'create_draft').length, 1)

  const uncertain = await ready()
  failure = 'create_draft'
  await assert.rejects(() => createDraft(uncertain), /injected create_draft/)
  checkpoint = await stateFile(uncertain)
  assert.ok(checkpoint.draft!.requestStartedAt)
  failure = ''; resetCalls()
  await assert.rejects(() => advance(checkpoint), /outcome is unknown/)
  await assert.rejects(() => createDraft(checkpoint), /draft mutation is forbidden/)
  await assert.rejects(() => postDraftQa(checkpoint), /outcome is not recorded/)
  assertNoSideEffects()
  await assert.rejects(() => postDraftQa(checkpoint, 'mock-wrong-target'), /mock media_id/)
  failure = 'readback'
  await assert.rejects(() => postDraftQa(checkpoint, 'manually-confirmed-id'), /injected readback/)
  const recovery = await stateFile(checkpoint)
  assert.equal(recovery.phase, 'post_draft_qa')
  assert.equal(recovery.draft!.mediaId, 'manually-confirmed-id')
  failure = ''; resetCalls()
  await advance(recovery)
  assert.equal(recovery.phase, 'completed')
  assert.equal(execCalls.length, 0)

  const mismatchedReadback = await ready()
  failure = 'readback-mismatch'
  await assert.rejects(() => createDraft(mismatchedReadback), /Draft readback verification failed/)
  checkpoint = await stateFile(mismatchedReadback)
  assert.equal(checkpoint.phase, 'post_draft_qa')
  failure = ''; await advance(checkpoint)
  assert.equal(checkpoint.phase, 'completed')

  const failedReadback = await ready()
  failure = 'readback'
  await assert.rejects(() => createDraft(failedReadback), /injected readback/)
  checkpoint = await stateFile(failedReadback)
  assert.equal(checkpoint.phase, 'post_draft_qa')
  assert.equal(checkpoint.draft!.mediaId, 'test-draft-id')
  failure = ''; resetCalls()
  await advance(checkpoint)
  assert.equal(checkpoint.phase, 'completed')
  assert.equal(execCalls.length, 0)
  checkpoint.phase = 'draft_create'; delete checkpoint.draft!.mediaId
  await persist(checkpoint); resetCalls()
  await advance(checkpoint)
  assert.equal(checkpoint.phase, 'completed')
  assert.equal(checkpoint.draft!.mediaId, 'test-draft-id')
  assert.equal(execCalls.length, 0)

  const regressedUpdate = await ready()
  await updateDraft(regressedUpdate, 'regressed-update-target')
  const regressedCheckpoint = await stateFile(regressedUpdate)
  regressedCheckpoint.phase = 'awaiting_draft_approval'
  await persist(regressedCheckpoint)
  resetCalls()
  await postDraftQa(regressedCheckpoint, 'regressed-update-target')
  assert.equal(regressedCheckpoint.phase, 'completed')
  assert.equal(fetchCalls.filter(call => call.url.includes('/draft/get?')).length, 1)
  assert.equal(fetchCalls.filter(call => call.url.includes('/draft/update?')).length, 0)

  const updating = await ready()
  failure = 'upload_image'
  await assert.rejects(() => updateDraft(updating, 'explicit-update-target'), /injected upload_image/)
  checkpoint = await stateFile(updating)
  assert.equal(checkpoint.phase, 'draft_update')
  assert.equal(checkpoint.draft!.mediaId, 'explicit-update-target')
  failure = ''; resetCalls()
  await advance(checkpoint)
  assert.equal(checkpoint.phase, 'completed')
  const update = fetchCalls.find(call => call.url.includes('/draft/update?'))!
  assert.equal((update.body as { media_id: string }).media_id, 'explicit-update-target')
  assert.equal(execCalls.filter(call => call.args[0] === 'create_draft').length, 0)

  const uncertainUpdate = await ready()
  failure = 'update'
  await assert.rejects(() => updateDraft(uncertainUpdate, 'fixed-target'), /injected update/)
  checkpoint = await stateFile(uncertainUpdate)
  failure = ''; resetCalls()
  await assert.rejects(() => advance(checkpoint), /outcome is unknown/)
  await assert.rejects(() => postDraftQa(checkpoint, 'different-target'), /differs from the approved draft target/)
  assertNoSideEffects()
  lastDraftPayload = JSON.parse(await originalReadFile(path.resolve(root, checkpoint.artifacts.publishDraftPayload), 'utf8'))
  remoteDrafts.set('fixed-target', { ...lastDraftPayload, thumb_media_id: 'test-cover' })
  await postDraftQa(checkpoint, 'fixed-target')
  assert.equal(checkpoint.phase, 'completed')

  const missingTarget = await ready()
  missingTarget.phase = 'draft_update'; missingTarget.draft = { mode: 'update', urlStatus: 'not_created' }
  resetCalls()
  await assert.rejects(() => advance(missingTarget), /no explicit media_id/)
  assertNoSideEffects()

  const mockDraft = await ready('mock')
  resetCalls()
  await createDraft(mockDraft)
  assert.equal(mockDraft.phase, 'completed')
  assert.equal(mockDraft.draft!.mediaId, 'mock-draft-media-id')
  assert.equal(fetchCalls.length, 0)
  assert.ok(execCalls.every(call => call.bin !== 'md2wechat'))
  process.env.WECHAT_AGENT_MOCK = '0'

  const legacyCompleted = { ...generated, executionMode: undefined }
  lastDraftPayload = JSON.parse(await originalReadFile(path.resolve(root, generated.artifacts.publishDraftPayload), 'utf8'))
  remoteDrafts.set('test-draft-id', { ...lastDraftPayload, thumb_media_id: 'test-cover' })
  await postDraftQa(legacyCompleted)
  assert.equal(legacyCompleted.executionMode, undefined)
  assert.equal(legacyCompleted.phase, 'completed')

  const scopedBase = await ready()
  const openingBefore = 'Runtime 是用于验证 Harness 的项目，本文从它的工作方式切入。'
  const openingRevision = await createRevision(scopedBase, { scope: 'content', patches: [{ before: openingBefore, after: 'Runtime 是一个用于验证 Harness 的项目，它把复杂流程拆成读者能看懂的步骤。' }] }); createdRuns.push(openingRevision.id)
  assert.equal(openingRevision.revision!.qaMode, 'scoped_visual')
  resetCalls(); await advance(openingRevision)
  assert.equal(openingRevision.phase, 'awaiting_draft_approval', JSON.stringify({ blockedReason: openingRevision.blockedReason, qa: openingRevision.qa, revision: openingRevision.revision }))
  assert.deepEqual(agentCalls.map(call => call.agent), ['qa'])
  assert.deepEqual(captureCalls, [{ fullArticle: false }])

  const lockedRun = await fixture()
  let releaseLock: (() => void) | undefined
  const running = withOperation(lockedRun, 'slow_test', () => new Promise<void>(resolve => { releaseLock = resolve }))
  for (let attempt = 0; !releaseLock && attempt < 100; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(releaseLock, 'operation should acquire its run lock before the competing request')
  const competingState = await stateFile(lockedRun)
  assert.ok(competingState.operation)
  await assert.rejects(() => withOperation(competingState, 'competing_resume', async () => {}), /already processing/)
  releaseLock!(); await running
  assert.equal((await stateFile(lockedRun)).operation, undefined)

  const renamedTopic = await ready()
  renamedTopic.title = 'Original topic before editorial title'
  resetCalls()
  await updateDraft(renamedTopic, 'renamed-topic-target')
  assert.equal(renamedTopic.phase, 'completed')
  assert.equal(fetchCalls.filter(call => call.url.includes('/draft/update?')).length, 1)
  const wrongTitle = await ready()
  remoteDrafts.set('wrong-title-target', { ...lastDraftPayload, title: 'Unrelated article', thumb_media_id: 'test-cover' })
  resetCalls()
  await assert.rejects(() => updateDraft(wrongTitle, 'wrong-title-target'), /title does not match/)
  assert(!fetchCalls.some(call => call.url.includes('/draft/update?')))
  const legacyLayout = await ready()
  const legacyHtmlPath = path.resolve(root, legacyLayout.artifacts.html)
  const legacyHtml = await originalReadFile(legacyHtmlPath, 'utf8')
  await fs.writeFile(legacyHtmlPath, '<section class="wx-hero"><p>AGENT ENGINEERING · OPEN SOURCE</p><h1>Runtime check</h1></section><section class="wx-toc"><p class="wx-card-label">文章目录</p><ol><li>1. First</li></ol></section>' + legacyHtml)
  const removeCard = await createRevision(legacyLayout, { scope: 'layout', removeTitleCard: true }); createdRuns.push(removeCard.id)
  resetCalls()
  await advance(removeCard)
  assert.equal(removeCard.phase, 'awaiting_draft_approval')
  assert.deepEqual(agentCalls.map(call => call.agent), ['qa'])
  assert.equal(await originalReadFile(path.resolve(root, removeCard.artifacts.writingFinal), 'utf8'), await originalReadFile(path.resolve(root, legacyLayout.artifacts.writingFinal), 'utf8'))
  assert.equal(JSON.parse(await originalReadFile(path.resolve(root, removeCard.artifacts.scopeCheck), 'utf8')).removedTitleCard, true)
  const wrongScope = await createRevision(legacyLayout, { scope: 'layout', imageWidthPercent: 100 }); createdRuns.push(wrongScope.id)
  await assert.rejects(() => advance(wrongScope), /outside the requested area/)
  const scopedText = await originalReadFile(path.resolve(root, scopedBase.artifacts.writingFinal), 'utf8')
  const addedImage = path.join(root, '.runtime/runs', scopedBase.id, 'assets/additional.png')
  await fs.writeFile(addedImage, png)
  const illustrated = await createRevision(scopedBase, { scope: 'content', patches: [{ before: 'Body', after: 'Body\n\n![comparison](../assets/comparison.png)\n\n![evidence](../assets/evidence.png)' }], assets: { 'comparison.png': addedImage, 'evidence.png': addedImage } }); createdRuns.push(illustrated.id)
  await advance(illustrated)
  assert.equal(illustrated.phase, 'awaiting_draft_approval')
  resetCalls(); await createDraft(illustrated)
  assert.equal(illustrated.phase, 'completed')
  assert.equal(execCalls.filter(call => call.args[0] === 'upload_image').length, 4)
  assert.equal((lastDraftPayload!.content.match(/<img/g) ?? []).length, 3)
  const tamperedIllustration = await createRevision(illustrated, { scope: 'references' }); createdRuns.push(tamperedIllustration.id)
  await fs.appendFile(path.join(root, '.runtime/runs', tamperedIllustration.id, 'assets/comparison.png'), 'changed')
  await assert.rejects(() => advance(tamperedIllustration), /locked body illustrations/)
  const scopedSvg = await originalReadFile(path.resolve(root, scopedBase.artifacts.architecture), 'utf8')
  await assert.rejects(() => createRevision(scopedBase, { scope: 'references', style: 'khazix' }), /outside/)
  await assert.rejects(() => createRevision(scopedBase, { scope: 'references', fontScale: 0.5 }), /outside/)
  await assert.rejects(() => createRevision(scopedBase, { scope: 'content', cover: scopedBase.cover }), /outside/)
  const coverOnly = await createRevision(scopedBase, { scope: 'image', cover: path.resolve(root, generated.cover!) }); createdRuns.push(coverOnly.id)
  resetCalls()
  await advance(coverOnly)
  assert.equal(coverOnly.phase, 'awaiting_draft_approval')
  assert.deepEqual(agentCalls.map(call => call.agent), ['qa'])
  assert.equal(await originalReadFile(path.resolve(root, coverOnly.artifacts.writingFinal), 'utf8'), scopedText)
  assert.equal(await originalReadFile(path.resolve(root, coverOnly.artifacts.architecture), 'utf8'), scopedSvg)
  const lockedCover = await createRevision(scopedBase, { scope: 'references' }); createdRuns.push(lockedCover.id)
  await fs.appendFile(path.resolve(root, lockedCover.cover!), 'changed cover')
  await assert.rejects(() => advance(lockedCover), /locked cover/)
  const lockedLayout = await createRevision(scopedBase, { scope: 'references' }); createdRuns.push(lockedLayout.id)
  lockedLayout.layout!.imageWidthPercent = 60
  await assert.rejects(() => advance(lockedLayout), /locked layout/)
  for (const options of [
    { scope: 'references' as const },
    { scope: 'image' as const, fontScale: 0.75 },
    { scope: 'layout' as const, imageWidthPercent: 50 },
    { scope: 'content' as const, patches: [{ before: 'Body', after: 'Updated body' }] },
  ]) {
    resetCalls()
    const change = await createRevision(scopedBase, options); createdRuns.push(change.id)
    await advance(change)
    assert.equal(change.phase, 'awaiting_draft_approval')
    assert.deepEqual(agentCalls.map(call => call.agent), options.scope === 'references' ? [] : ['qa'], 'Local corrections must not rerun writer or editors')
    const text = await originalReadFile(path.resolve(root, change.artifacts.writingFinal), 'utf8')
    assert.equal(text, options.scope === 'content' ? scopedText.replace('Body', 'Updated body') : options.scope === 'references' ? normalizeReferences(scopedText) : scopedText)
    const asset = await originalReadFile(path.resolve(root, change.artifacts.architecture), 'utf8')
    if (options.scope !== 'image') assert.equal(asset, scopedSvg)
    else { assert.notEqual(asset, scopedSvg); assert.equal(asset.match(/<svg[^>]*>/)![0], scopedSvg.match(/<svg[^>]*>/)![0]) }
    assert.equal(change.layout!.imageWidthPercent, options.scope === 'layout' ? 50 : 100)
    await fs.appendFile(path.resolve(root, change.artifacts.writingFinal), '\nout of scope')
    resetCalls(); await assert.rejects(() => advance(change), /outside its approved scope/); assert.equal(agentCalls.length, 0)
  }

  const assetChanged = await ready()
  await fs.appendFile(path.resolve(root, assetChanged.artifacts.architecture), '\n<!-- changed -->')
  resetCalls(); await assert.rejects(() => createDraft(assetChanged), /image or cover changed/); assertNoSideEffects()
  await advance(assetChanged)
  assert.equal(assetChanged.phase, 'awaiting_draft_approval')
  assert.deepEqual(agentCalls.map(call => call.agent), ['qa'])

  qaOverride = { stylePassed: null }
  const invalidQa = await fixture()
  await assert.rejects(() => advance(invalidQa), /Invalid independent QA/)
  qaOverride = { verdict: 'pass', stylePassed: true, findings: [{ severity: 'warning', category: 'layout', blocking: true, message: 'Unsubstantiated defect', recommendation: 'Rewrite' }] }
  await assert.rejects(() => advance(invalidQa), /concrete evidence are required/)
  qaOverride = { verdict: 'revise', stylePassed: true, findings: [{ severity: 'info', category: 'layout', blocking: false, evidence: 'First heading', message: 'Could use another color', recommendation: 'Optional color change' }] }
  await advance(invalidQa)
  assert.equal(invalidQa.phase, 'awaiting_draft_approval')
  assert.equal(invalidQa.attempts, 0)
  qaOverride = undefined

  const captureRace = await fixture()
  mutateDuringCapture = true
  await assert.rejects(() => advance(captureRace), /changed during independent QA/)
  const payloadTamper = await ready()
  await fs.appendFile(path.resolve(root, payloadTamper.artifacts.draftPayload), ' ')
  resetCalls(); await assert.rejects(() => createDraft(payloadTamper), /changed after QA/); assertNoSideEffects()
  const publishingTamper = await ready()
  mutateDuringPublish = true
  resetCalls(); await assert.rejects(() => createDraft(publishingTamper), /differs from the reviewed/)
  assert(!execCalls.some(call => call.args[0] === 'create_draft'))

  const wrongStyle = await createRevision(scopedBase, { scope: 'style', style: 'khazix', goal: 'Rewrite in conversational Chinese without changing facts.' }); createdRuns.push(wrongStyle.id)
  styleFails = true; qaVerdicts = ['blocked']
  await advance(wrongStyle)
  assert.equal(wrongStyle.phase, 'blocked')
  await assert.rejects(() => createDraft(wrongStyle), /draft mutation is forbidden/)
  styleFails = false
  await retryRun(wrongStyle)
  assert.equal(wrongStyle.phase, 'awaiting_draft_approval')
  const restored = await createRevision(scopedBase, { scope: 'references', version: 1 }); createdRuns.push(restored.id)
  assert.equal(await originalReadFile(path.resolve(root, restored.artifacts.writingFinal), 'utf8'), await originalReadFile(path.resolve(root, scopedBase.versions![0].path), 'utf8'))
  await advance(restored)
  assert.equal(restored.phase, 'awaiting_draft_approval')

  const guarded = await ready(); await updateDraft(guarded, 'guarded-target')
  remoteDrafts.get('guarded-target')!.url = 'http://mp.weixin.qq.com/s?tempkey=one'
  await postDraftQa(guarded)
  assert.equal(guarded.draft!.urlStatus, 'recorded')
  assert.equal(handoffRequest(guarded).status, 'pending')
  await recordHandoff(guarded, 'queued', 'known-tab')
  assert.equal(handoffRequest(guarded).status, 'queued')
  assert.deepEqual(handoffRequest(guarded).args, { placement: 'right', target: { type: 'browser', tabId: 'known-tab', url: remoteDrafts.get('guarded-target')!.url } })
  remoteDrafts.get('guarded-target')!.url = 'http://mp.weixin.qq.com/s?tempkey=two'
  await postDraftQa(guarded)
  assert.equal(handoffRequest(guarded).status, 'pending')
  assert.deepEqual(handoffRequest(guarded).args, { placement: 'right', target: { type: 'browser', tabId: 'known-tab', url: 'http://mp.weixin.qq.com/s?tempkey=two' } })
  await recordHandoff(guarded, 'opened', 'known-tab')
  assert.equal(handoffRequest(guarded).status, 'opened')
  process.env.CODEX_THREAD_ID = 'different-test-task'
  assert.equal(handoffRequest(guarded).status, 'unavailable')
  await assert.rejects(() => recordHandoff(guarded, 'opened', 'known-tab'), /current task/)
  const otherTask = await createRevision(guarded, { scope: 'references' }); createdRuns.push(otherTask.id)
  assert.equal(otherTask.handoff?.tabId, undefined)
  await postDraftQa(guarded)
  assert.equal(handoffRequest(guarded).args!.target.tabId, undefined)
  if (originalThread === undefined) delete process.env.CODEX_THREAD_ID
  else process.env.CODEX_THREAD_ID = originalThread
  await postDraftQa(guarded)
  await recordHandoff(guarded, 'queued', 'known-tab')
  const guardedRevision = await createRevision(guarded, { scope: 'layout', imageWidthPercent: 50 }); createdRuns.push(guardedRevision.id); await advance(guardedRevision)
  assert.equal(guardedRevision.handoff!.tabId, 'known-tab')
  await assert.rejects(() => createDraft(guardedRevision), /existing draft/)
  await assert.rejects(() => updateDraft(guardedRevision, 'wrong-target'), /differs/)
  remoteDrafts.get('guarded-target')!.content = 'human edit before approval'
  resetCalls(); await assert.rejects(() => updateDraft(guardedRevision, 'guarded-target'), /Remote draft changed/)
  assert(!fetchCalls.some(call => call.url.includes('/draft/update?')))
  assert(!execCalls.some(call => call.args[0] === 'upload_image'))

  const reuse = await ready(); await updateDraft(reuse, 'reuse-target')
  Object.assign(remoteDrafts.get('reuse-target')!, { author: 'Existing author', content_source_url: 'https://example.org/original', need_open_comment: 1, only_fans_can_comment: 1, show_cover_pic: 1 })
  await postDraftQa(reuse)
  const reuseRevision = await createRevision(reuse, { scope: 'references' }); createdRuns.push(reuseRevision.id); await advance(reuseRevision)
  resetCalls(); await updateDraft(reuseRevision, 'reuse-target')
  assert.equal(reuseRevision.phase, 'completed')
  assert(!execCalls.some(call => call.args[0] === 'upload_image'), 'Unchanged body image and cover must be reused')
  for (const field of ['author', 'content_source_url', 'need_open_comment', 'only_fans_can_comment', 'show_cover_pic']) assert.equal(remoteDrafts.get('reuse-target')![field], reuse.target!.news![field])

  const drifted = await ready(); await updateDraft(drifted, 'drifted-target')
  const driftedRemote = remoteDrafts.get('drifted-target')!
  driftedRemote.thumb_media_id = 'user-replaced-cover'
  driftedRemote.content = String(driftedRemote.content).replace(/<p class="p"/g, '<p')
  const driftedRevision = await createRevision(drifted, { scope: 'references' }); createdRuns.push(driftedRevision.id)
  assert.equal(driftedRevision.target!.preserveRemoteThumb, true)
  resetCalls(); await advance(driftedRevision)
  await updateDraft(driftedRevision, 'drifted-target')
  assert.equal(driftedRevision.phase, 'completed')
  assert(!execCalls.some(call => call.args[0] === 'upload_image'), 'A user-replaced remote cover must be preserved, not re-uploaded')
  assert.equal(remoteDrafts.get('drifted-target')!.thumb_media_id, 'user-replaced-cover')

  const reVerified = await ready(); await updateDraft(reVerified, 're-verified-target')
  remoteDrafts.get('re-verified-target')!.thumb_media_id = 'user-cover-after-reverify'
  await assert.rejects(() => postDraftQa(reVerified), /Draft readback verification failed/)
  const reVerifiedRevision = await createRevision(reVerified, { scope: 'references' }); createdRuns.push(reVerifiedRevision.id)
  assert.equal(reVerifiedRevision.target!.preserveRemoteThumb, true)
  resetCalls(); await advance(reVerifiedRevision)
  await updateDraft(reVerifiedRevision, 're-verified-target')
  assert(!execCalls.some(call => call.args[0] === 'upload_image'), 'A cover replaced after a failed re-verify must still be preserved')
  assert.equal(remoteDrafts.get('re-verified-target')!.thumb_media_id, 'user-cover-after-reverify')

  const textDrifted = await ready(); await updateDraft(textDrifted, 'text-drifted-target')
  remoteDrafts.get('text-drifted-target')!.content = `${remoteDrafts.get('text-drifted-target')!.content}<p>human addition</p>`
  await assert.rejects(() => createRevision(textDrifted, { scope: 'references' }), /Remote draft changed/)

  const concurrent = await ready(); await updateDraft(concurrent, 'concurrent-target')
  const concurrentRevision = await createRevision(concurrent, { scope: 'image', fontScale: 0.9 }); createdRuns.push(concurrentRevision.id); await advance(concurrentRevision)
  mutateDuringUpload = 'concurrent-target'; resetCalls()
  await assert.rejects(() => updateDraft(concurrentRevision, 'concurrent-target'), /while assets were uploading/)
  assert(!fetchCalls.some(call => call.url.includes('/draft/update?')))
  assert.equal(concurrentRevision.draft!.requestStartedAt, undefined)

  const truncated = await ready(); await updateDraft(truncated, 'truncated-target')
  remoteDrafts.get('truncated-target')!.content = String(remoteDrafts.get('truncated-target')!.content).replace('Body', 'lost')
  await assert.rejects(() => postDraftQa(truncated), /completeText/)
  assert.equal(handoffRequest(truncated).status, 'unavailable')
  assert.equal((await stateFile(truncated)).phase, 'post_draft_qa')
  failure = 'readback'
  const localReview = await createRevision(truncated, { scope: 'references', localOnly: true }); createdRuns.push(localReview.id)
  failure = ''
  await advance(localReview)
  resetCalls(); await assert.rejects(() => updateDraft(localReview, 'truncated-target'), /permanently local-only/); assertNoSideEffects()
  const localChild = await createRevision(localReview, { scope: 'references' }); createdRuns.push(localChild.id)
  assert.equal(localChild.localOnly, true)
  await assert.rejects(() => createDraft(localChild), /existing draft|local-only/)
  console.log('scoped revisions, locked images, immutable versions, style gate, remote edits, concurrent updates and right-panel handoff: ok')

  resetCalls()
  await advance(generated)
  await advance(exhausted)
  assertNoSideEffects()
  if (process.env.WECHAT_AGENT_INTEGRATION === '1') {
    realRendering = true
    bodyImageUrl = 'https://example.invalid/test-architecture.png?wx_fmt=png&from=app'
    const smoke = await ready()
    const smokeHtml = await originalReadFile(path.resolve(root, smoke.artifacts.html), 'utf8')
    assert.match(smokeHtml, /class="container"[^>]*><p class="p"[^>]*>Runtime 是用于验证 Harness 的项目/)
    assert(!smokeHtml.includes('wx-hero'))
    assert(!smokeHtml.includes('AGENT ENGINEERING'))
    const screenshot = await originalReadFile(path.resolve(root, smoke.artifacts.screenshot))
    assert.equal(screenshot.readUInt32BE(16), 390)
    assert.equal(screenshot.readUInt32BE(20), 844)
    await createDraft(smoke)
    assert.equal(smoke.phase, 'completed')
    const publishHtml = await originalReadFile(path.resolve(root, smoke.artifacts.publishHtml), 'utf8')
    assert.ok(publishHtml.includes('https://example.invalid/test-architecture.png'))
    assert.ok(publishHtml.includes('?wx_fmt=png&amp;from=app'))
    assert.ok(!publishHtml.includes('../assets/'))
    const imageLine = '![Runtime pipeline](../assets/architecture.svg)'
    const withSources = await createRevision(smoke, { scope: 'content', patches: [{ before: imageLine, after: `${imageLine}\n\n<strong>参考来源</strong>\n\n[Example](https://example.org/source)` }] }); createdRuns.push(withSources.id)
    await advance(withSources)
    assert.equal(withSources.phase, 'awaiting_draft_approval')
    const numbered = await createRevision(withSources, { scope: 'references' }); createdRuns.push(numbered.id); await advance(numbered)
    assert.equal(numbered.phase, 'awaiting_draft_approval', JSON.stringify({ qa: numbered.qa, reason: numbered.blockedReason }))
    assert.match(await originalReadFile(path.resolve(root, numbered.artifacts.writingFinal), 'utf8'), /\[1\. Example\]/)
    resetCalls(); await updateDraft(numbered, 'test-draft-id')
    assert(!execCalls.some(call => call.args[0] === 'upload_image'))
    const sanitized = String(remoteDrafts.get('test-draft-id')!.content).replace(/<\/?a\b[^>]*>/gi, '')
    assert(referencesMatchHtml(await originalReadFile(path.resolve(root, numbered.artifacts.writingFinal), 'utf8'), sanitized))
    remoteDrafts.get('test-draft-id')!.content = sanitized
    await postDraftQa(numbered)
    assert.equal(numbered.phase, 'completed')
    for (const damaged of [sanitized.replace('1. Example', 'Example'), sanitized.replace('https://example.org/source', '')]) {
      remoteDrafts.get('test-draft-id')!.content = damaged
      await assert.rejects(() => postDraftQa(numbered), /completeText/)
      assert.equal(handoffRequest(numbered).status, 'unavailable')
    }
    remoteDrafts.get('test-draft-id')!.content = sanitized
    await postDraftQa(numbered)
    const narrow = await createRevision(numbered, { scope: 'layout', imageWidthPercent: 50 }); createdRuns.push(narrow.id); await advance(narrow)
    assert.equal(narrow.phase, 'awaiting_draft_approval')
    const smaller = await createRevision(narrow, { scope: 'image', fontScale: 0.75 }); createdRuns.push(smaller.id); await advance(smaller)
    assert.equal(smaller.phase, 'awaiting_draft_approval')
    const wideMetrics = JSON.parse(await originalReadFile(path.resolve(root, numbered.artifacts.mobileMetrics), 'utf8'))
    const narrowMetrics = JSON.parse(await originalReadFile(path.resolve(root, narrow.artifacts.mobileMetrics), 'utf8'))
    const smallMetrics = JSON.parse(await originalReadFile(path.resolve(root, smaller.artifacts.mobileMetrics), 'utf8'))
    assert.equal(narrowMetrics.images[0].width * 2, wideMetrics.images[0].width)
    assert.equal(smallMetrics.images[0].width, narrowMetrics.images[0].width)
    assert.equal(smallMetrics.images[0].naturalWidth, narrowMetrics.images[0].naturalWidth)
    const probe = path.join(root, '.runtime/runs', smoke.id, 'render/orphan-probe.html')
    await fs.writeFile(probe, '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><h2 style="font:20px monospace;width:24px;word-break:break-all">ABCDE</h2><p style="margin-top:1800px">END OF REAL CAPTURE</p>')
    const measured = await originalCapture(probe, path.join(root, '.runtime/runs', smoke.id, 'render/orphan-probe'))
    assert.equal(measured.metrics.headings[0].orphan, true)
    assert(measured.metrics.height > 1800)
    assert(measured.metrics.ending.includes('END OF REAL CAPTURE'))
    assert(measured.files.length >= 4)
    await assert.rejects(() => originalExec('pnpm', ['--dir', 'vendor/doocs-md/packages/mcp-server', 'exec', 'tsx', '../../../../scripts/wechat/publish-tech-draft.mts', probe, '--draft'], { cwd: root }), /Direct renderer publishing is disabled/)
    console.log('runtime real renderer and Chrome smoke test (model/WeChat stubbed): ok')
  }
  console.log('runtime mode isolation, cover formats, screenshot input, revisions, conflict gate, draft recovery and no duplicate writes: ok')
} finally {
  runtime.exec = originalExec
  runtime.capture = originalCapture
  Thread.prototype.run = originalRun
  globalThis.fetch = originalFetch
  fs.readFile = originalReadFile
  if (originalMock === undefined) delete process.env.WECHAT_AGENT_MOCK
  else process.env.WECHAT_AGENT_MOCK = originalMock
  if (originalThread === undefined) delete process.env.CODEX_THREAD_ID
  else process.env.CODEX_THREAD_ID = originalThread
  await Promise.all(createdRuns.map(id => fs.rm(path.join(root, '.runtime/runs', id), { recursive: true, force: true })))
  assert.equal(await historicalDigest(), originalHistoricalDigest, 'historical run artifacts must remain untouched')
}
