import assert from 'node:assert/strict'
import { unresolvedConflicts } from './wechat-agent.mts'

const conflict = {
  id: 'fact-1', draftClaim: '原稿主张', location: { artifact: 'input/source.md', line: 1 },
  evidence: [{ url: 'https://example.com', retrievedAt: '2026-09-16T00:00:00.000Z', excerpt: '证据' }],
  severity: 'major' as const, impact: 'core_conclusion' as const, status: 'open' as const,
}
assert.equal(unresolvedConflicts([conflict]).length, 1)
assert.equal(unresolvedConflicts([{ ...conflict, status: 'resolved' as const }]).length, 0)
assert.equal(unresolvedConflicts([{ ...conflict, severity: 'minor' as const }]).length, 0)
console.log('wechat-agent conflict hook: ok')
