import assert from 'node:assert/strict'
import { schemas } from './wechat-agent.mts'

// OpenAI 严格结构化输出要求：每个对象都必须 additionalProperties:false 且 required 覆盖全部 properties。
// 这里的模型走 Friday 路由；不满足时 Agent 调用会直接报 invalid_json_schema。
type Problem = { path: string; kind: string; detail: string }
const problems: Problem[] = []

function walk(node: unknown, path: string) {
  if (Array.isArray(node) || !node || typeof node !== 'object') return
  const obj = node as Record<string, any>
  if (obj.properties && typeof obj.properties === 'object') {
    const keys = Object.keys(obj.properties)
    if (obj.additionalProperties !== false) problems.push({ path, kind: 'additionalProperties', detail: String(obj.additionalProperties) })
    if (!Array.isArray(obj.required)) problems.push({ path, kind: 'missing-required', detail: `properties=[${keys}]` })
    else {
      const missing = keys.filter((key: string) => !obj.required.includes(key))
      if (missing.length) problems.push({ path, kind: 'required-incomplete', detail: `missing=[${missing}]` })
      const extra = obj.required.filter((key: string) => !keys.includes(key))
      if (extra.length) problems.push({ path, kind: 'required-extra', detail: `extra=[${extra}]` })
    }
    for (const [key, value] of Object.entries(obj.properties)) walk(value, `${path}.${key}`)
  }
  if (obj.items) walk(obj.items, `${path}[]`)
}

for (const name of ['orchestrator', 'writer', 'visual', 'qa']) {
  assert.ok((schemas as Record<string, unknown>)[name], `missing agent schema: ${name}`)
}
for (const [name, schema] of Object.entries(schemas)) walk(schema, name)
assert.deepEqual(problems, [])

console.log('wechat-agent schema strictness: ok')
