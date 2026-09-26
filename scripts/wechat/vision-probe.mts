import path from 'node:path'
import fs from 'node:fs/promises'
import { Codex } from '@openai/codex-sdk'

const root = path.resolve(import.meta.dirname, '../..')

const timeoutMs = Number(process.env.WECHAT_VISION_PROBE_TIMEOUT_MS ?? 180_000)
const promptFileIndex = process.argv.indexOf('--prompt-file')
const promptFile = promptFileIndex >= 0 ? process.argv[promptFileIndex + 1] : undefined
const images = process.argv.slice(2).filter((arg, index) => !arg.startsWith('--') && !(promptFileIndex >= 0 && index === promptFileIndex - 1))

if (!images.length) {
  console.error('Usage: tsx vision-probe.mts <image...>')
  process.exit(2)
}

const schema = promptFile ? {
  type: 'object',
  properties: {
    imageCount: { type: 'number' },
    answers: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['imageCount', 'answers', 'notes'],
  additionalProperties: false,
} as const : {
  type: 'object',
  properties: {
    firstVisibleLine: { type: 'string' },
    visibleItems: { type: 'array', items: { type: 'string' } },
    imageCount: { type: 'number' },
    notes: { type: 'string' },
  },
  required: ['firstVisibleLine', 'visibleItems', 'imageCount', 'notes'],
  additionalProperties: false,
} as const

const codex = new Codex({ config: { developer_instructions: 'You are a vision capability probe. Inspect the attached images directly and transcribe exactly what you see. Do not run shell commands, OCR tools, or any workaround. If you genuinely cannot see an image, say so in notes and leave tocEntries empty.', features: { memories: false } } })
const thread = codex.startThread({ workingDirectory: root, model: process.env.WECHAT_AGENT_MODEL, sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled' })

const prompt = promptFile ? await fs.readFile(promptFile, 'utf8') : `附件是一组公众号文章的 390px 手机截图（可能还有封面图）。直接看图回答：
1. 第一张截图最顶部可见的第一行文字（firstVisibleLine）。
2. 第一张截图开头那段项目介绍中能读到的项目名或关键词（visibleItems），看到什么写什么，不要编造。
3. 你实际看到的图片张数（imageCount）。
4. notes 里说明图片是否清晰可读；若你根本看不到图片内容，如实写明。
只返回严格符合 schema 的 JSON 对象。`

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), timeoutMs)
const started = Date.now()
try {
  const result = await thread.run([{ type: 'text', text: prompt }, ...images.map(image => ({ type: 'local_image' as const, path: image }))], { outputSchema: schema, signal: controller.signal })
  clearTimeout(timer)
  console.log(JSON.stringify({ ok: true, elapsedMs: Date.now() - started, model: process.env.WECHAT_AGENT_MODEL ?? 'inherited', usage: result.usage, response: JSON.parse(result.finalResponse) }, null, 2))
} catch (error) {
  clearTimeout(timer)
  console.log(JSON.stringify({ ok: false, elapsedMs: Date.now() - started, model: process.env.WECHAT_AGENT_MODEL ?? 'inherited', timedOut: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) }, null, 2))
  process.exit(1)
}
