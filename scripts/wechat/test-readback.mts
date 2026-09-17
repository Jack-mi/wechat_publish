import assert from 'node:assert/strict'
import { draftNewsItem } from './wechat-agent.mts'

// 微信 draft/get 实际把 news_item 放在顶层；旧代码只认 item[0].content.news_item，
// 导致回读校验把真实草稿误判为失败。这里锁定两种形态都能解析。
const actual = {
  news_item: [{ title: '标题A', content: '<section class="wx-article"><h2 class="h2">1. 小节</h2>文章目录</section>' }],
  create_time: 1,
  update_time: 2,
}
const nested = { item: [{ content: { news_item: [{ title: '标题B', content: '<h2>验证</h2>' }] } }] }
const flatItem = { item: [{ news_item: [{ title: '标题C', content: '<h2>验证</h2>' }] }] }

assert.equal(draftNewsItem(actual as Record<string, unknown>).title, '标题A')
assert.equal(draftNewsItem(nested as Record<string, unknown>).title, '标题B')
assert.equal(draftNewsItem(flatItem as Record<string, unknown>).title, '标题C')
assert.deepEqual(draftNewsItem({} as Record<string, unknown>), {})

console.log('wechat-agent draft readback parsing: ok')
