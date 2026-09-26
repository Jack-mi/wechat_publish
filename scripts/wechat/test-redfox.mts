import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { collectWechatResearch, mergeSources, redfoxApiKey } from './redfox-research.mts'

const now = '2026-09-26T00:00:00.000Z'
const bodyText = '正文'.repeat(300)

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ code: status === 200 ? 2000 : status, msg: status === 200 ? '成功' : '失败', data }), { status, headers: { 'content-type': 'application/json' } })
}

const calls: Array<{ url: string; body: { keyword?: string; url?: string; workUuid?: string }; key: string }> = []
const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { keyword?: string; url?: string; workUuid?: string }
  calls.push({ url: String(url), body, key: new Headers(init?.headers).get('REDFOX_API_KEY') ?? '' })
  if (String(url).endsWith('/story/api/gzhData/searchArticle')) {
    return response({ list: ['a', 'b', 'c', 'd', 'e'].map(id => ({ title: `标题${id}`, workUrl: `https://mp.weixin.qq.com/s/${id}`, workUuid: `uuid-${id}`, author: `号${id}`, readCount: 1200, summary: `摘要${id}` })) })
  }
  const id = String(body.workUuid).replace('uuid-', '')
  return response({ title: `全文${id}`, workUrl: `https://mp.weixin.qq.com/s/${id}`, workUuid: body.workUuid, author: `号${id}`, summary: '短', content: `<p>${bodyText}</p>` })
}) as typeof fetch

const missing = await collectWechatResearch({ topic: '人工智能代理', apiKey: '  ', fetcher: (() => { throw new Error('不应调用红狐') }) as typeof fetch })
assert.equal(missing.requests, 0)
assert.equal(missing.sources.length, 0)
assert.equal(missing.skipped, 'REDFOX_API_KEY 未配置')

calls.length = 0
const found = await collectWechatResearch({
  topic: '人工智能'.repeat(12),
  text: '对照 https://mp.weixin.qq.com/s/e 和 https://mp.weixin.qq.com/s/outside',
  apiKey: 'test-key',
  fetcher,
  now,
})
const details = calls.filter(call => call.url.endsWith('/story/api/gzhData/queryWork'))
assert.equal(calls.filter(call => call.url.endsWith('/story/api/gzhData/searchArticle')).length, 1)
assert.equal(calls[0].body.keyword?.length, 30)
assert.equal(calls[0].key, 'test-key')
assert.equal(details.length, 3)
assert.deepEqual(details.map(call => call.body.workUuid), ['uuid-e', 'uuid-a', 'uuid-b'])
assert.equal(found.requests, 4)
const named = found.sources.find(item => item.url.endsWith('/e'))!
assert.equal(named.title, '全文e')
assert.equal(named.retrievedAt, now)
assert.match(named.summary, /^作者：号e；阅读：1200；/)
assert.ok(named.summary.endsWith('…'))
assert.ok(named.summary.includes('正文'))
assert.ok(!named.summary.includes(bodyText))
assert.equal(found.sources[0].title, '公众号文章')
assert.match(found.sources.find(item => item.url.endsWith('/d'))!.summary, /作者：号d；阅读：1200；摘要d/)
assert.equal(mergeSources(found.sources, [{ url: 'https://example.com/note', title: '补充', retrievedAt: now, summary: '网页' }, found.sources[0]]).at(-1)?.url, 'https://example.com/note')

calls.length = 0
const failed = await collectWechatResearch({
  topic: '人工智能',
  apiKey: 'test-key',
  fetcher: (async (url: string | URL | Request) => {
    calls.push({ url: String(url), body: {}, key: '' })
    if (String(url).includes('queryWork')) throw new Error('搜索失败后不应取详情')
    return response(null, 502)
  }) as typeof fetch,
})
assert.equal(failed.requests, 1)
assert.equal(failed.sources.length, 0)
assert.match(failed.skipped ?? '', /502/)
assert.equal(calls.length, 1)

const envFile = path.join(os.tmpdir(), `redfox-${Date.now()}.env`)
await fs.writeFile(envFile, '# empty\nREDFOX_API_KEY="from-file"\n')
assert.equal(await redfoxApiKey(envFile, {}), 'from-file')
assert.equal(await redfoxApiKey(envFile, { REDFOX_API_KEY: 'from-env' }), 'from-env')
await fs.rm(envFile)
console.log('redfox research limits, missing key and source shape: ok')
