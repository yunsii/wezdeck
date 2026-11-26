import { describe, expect, it } from 'vitest'

import { agentFamily, agentProfileBadge } from '#/features/agent-avatar'

describe('agentFamily', () => {
  it('uses the live agent when known', () => {
    expect(agentFamily('claude', 'claude_kimi')).toBe('claude')
    expect(agentFamily('codex', '')).toBe('codex')
    expect(agentFamily('grok.real', '')).toBe('grok')
  })
  it('falls back to the profile prefix', () => {
    expect(agentFamily('agent', 'claude_kimi')).toBe('claude')
    expect(agentFamily('', 'grok')).toBe('grok')
  })
})

describe('agentProfileBadge', () => {
  it('badges only non-default variants', () => {
    expect(agentProfileBadge('claude', 'claude')).toBe('')
    expect(agentProfileBadge('claude_kimi', 'claude')).toBe('kimi')
    expect(agentProfileBadge('claude_sub2api', 'claude')).toBe('gateway')
    expect(agentProfileBadge('', 'claude')).toBe('')
  })
})
