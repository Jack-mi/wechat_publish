import fs from 'node:fs/promises'

export type WechatSource = { url: string; title: string; retrievedAt: string; summary: string }
export type WechatResearch = { sources: WechatSource[]; requests: number; skipped?: string }

const searchPath = '/story/api/gzhData/searchArticle'
const detailPath = '/story/api/gzhData/queryWork'
const limits = { searches: 1, details: 3, excerpt: 400, keyword: 30 }

export async function redfoxApiKey(envFile?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = env.REDFOX_API_KEY?.trim()
  if (configured) return configured
  if (!envFile) return ''
  try { return readEnvValue(await fs.readFile(envFile, 'utf8'), 'REDFOX_API_KEY') } catch { return '' }
}

function readEnvValue(text: string, name: string) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.startsWith(`${name}=`)) continue
    return trimmed.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return ''
}

export async function collectWechatResearch(input: {
  topic: string
  text?: string
  apiKey?: string
  fetcher?: typeof fetch
  now?: string
  baseUrl?: string
}): Promise<WechatResearch> {
  const apiKey = input.apiKey?.trim() ?? ''
  if (!apiKey) return { sources: [], requests: 0, skipped: 'REDFOX_API_KEY 未配置' }
  const fetcher = input.fetcher ?? fetch
  const baseUrl = (input.baseUrl ?? 'https://redfox.hk').replace(/\/$/, '')
  const retrievedAt = input.now ?? new Date().toISOString()
  let requests = 0
  const keyword = input.topic.replace(/\s+/g, ' ').trim().slice(0, limits.keyword)
  let hits: ArticleHit[] = []
  if (keyword) {
    requests += 1
    try {
      hits = articlesFrom(await postJson(fetcher, baseUrl + searchPath, apiKey, { keyword, offset: 0, source: '公众号写作调研-wechat-agent' }))
    } catch (error) {
      return { sources: [], requests, skipped: error instanceof Error ? error.message : '公众号搜索失败' }
    }
  }
  const namedUrls = wechatUrls(input.text ?? '')
  const named = namedUrls.filter(url => !hits.some(hit => sameArticle(hit.url, url))).map(url => ({ url, title: '', author: '', reads: '', summary: '', workUuid: '' }))
  const ordered = dedupe([...named, ...hits])
  const withBody = ordered.filter(hit => hit.workUuid)
  const preferred = withBody.filter(hit => namedUrls.some(url => sameArticle(hit.url, url)))
  const detailTargets = [...preferred, ...withBody.filter(hit => !preferred.some(item => item.url === hit.url))].slice(0, limits.details)
  const enriched = new Map<string, ArticleHit>()
  for (const hit of detailTargets) {
    requests += 1
    try {
      const details = articlesFrom(await postJson(fetcher, baseUrl + detailPath, apiKey, { workUuid: hit.workUuid, source: '公众号写作调研-wechat-agent' }))
      const detail = details.find(item => item.workUuid === hit.workUuid || sameArticle(item.url, hit.url)) ?? [...details].sort((left, right) => right.summary.length - left.summary.length)[0]
      enriched.set(hit.url, { ...hit, ...dropEmpty(detail), url: hit.url, workUuid: hit.workUuid })
    } catch { enriched.set(hit.url, hit) }
  }
  const sources = ordered.map(hit => toSource(enriched.get(hit.url) ?? hit, retrievedAt)).filter(item => item.url && item.title)
  return { sources, requests }
}

export function mergeSources(primary: WechatSource[], extra: unknown[]): WechatSource[] {
  const merged = [...primary]
  const seen = new Set(primary.map(item => item.url))
  for (const item of extra) {
    if (!item || typeof item !== 'object') continue
    const source = item as Partial<WechatSource>
    if (!source.url || !source.title || !source.retrievedAt || !source.summary || seen.has(source.url)) continue
    seen.add(source.url)
    merged.push({ url: source.url, title: source.title, retrievedAt: source.retrievedAt, summary: source.summary })
  }
  return merged
}

type ArticleHit = { url: string; title: string; author: string; reads: string; summary: string; workUuid: string }

async function postJson(fetcher: typeof fetch, url: string, apiKey: string, body: Record<string, unknown>) {
  const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json', REDFOX_API_KEY: apiKey }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`红狐接口 HTTP ${response.status}`)
  const payload = await response.json() as { code?: number; msg?: string; data?: unknown }
  if (payload.code && payload.code !== 2000 && payload.code !== 200) throw new Error(payload.msg || `红狐接口返回 ${payload.code}`)
  return payload.data ?? payload
}

function articlesFrom(data: unknown): ArticleHit[] {
  const found: ArticleHit[] = []
  walk(data, 0, found)
  return dedupe(found)
}

function walk(value: unknown, depth: number, found: ArticleHit[]) {
  if (depth > 5 || value == null) return
  if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1, found); return }
  if (typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const url = firstUrl(record)
  if (url) found.push({ url, title: text(record, ['title', 'name']) || url, author: text(record, ['userName', 'author', 'accountName', 'nickname']), reads: text(record, ['readCount', 'clicksCount', 'readNum']), summary: bodyExcerpt(record), workUuid: text(record, ['workUuid']) })
  for (const child of Object.values(record)) if (child && typeof child === 'object') walk(child, depth + 1, found)
}

function firstUrl(record: Record<string, unknown>) {
  for (const key of ['url', 'oriUrl', 'link', 'articleUrl', 'workUrl']) {
    const value = record[key]
    if (typeof value === 'string' && isHttp(value)) return value
  }
  return ''
}

function text(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function bodyExcerpt(record: Record<string, unknown>) {
  const longest = ['content', 'digest', 'desc', 'summary'].map(key => text(record, [key])).filter(Boolean).sort((left, right) => right.length - left.length)[0] ?? ''
  return excerpt(longest)
}

function excerpt(value: string) {
  const plain = value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return plain.length > limits.excerpt ? `${plain.slice(0, limits.excerpt)}…` : plain
}

function toSource(hit: ArticleHit, retrievedAt: string): WechatSource {
  const bits = [hit.author ? `作者：${hit.author}` : '', hit.reads ? `阅读：${hit.reads}` : '', hit.summary].filter(Boolean)
  return { url: hit.url, title: hit.title || '公众号文章', retrievedAt, summary: bits.join('；') || hit.title || '公众号文章' }
}

function dedupe(hits: ArticleHit[]) {
  const seen = new Set<string>()
  return hits.filter(hit => isHttp(hit.url) && !seen.has(hit.url) && seen.add(hit.url))
}

function wechatUrls(text: string) {
  return [...text.matchAll(/https?:\/\/mp\.weixin\.qq\.com\/[^\s)>"']+/g)].map(match => match[0].replace(/[.,，。]+$/, '')).filter((url, index, all) => all.indexOf(url) === index)
}

function sameArticle(left: string, right: string) {
  if (left === right) return true
  try {
    const a = new URL(left)
    const b = new URL(right)
    return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search
  } catch { return false }
}

function isHttp(value: string) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

function dropEmpty(hit?: ArticleHit) {
  if (!hit) return {}
  return Object.fromEntries(Object.entries(hit).filter(([, value]) => value))
}
