import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  AgentAvatar,
  agentFamily,
  agentProfileBadge,
} from '#/features/agent-avatar'

describe('agentFamily', () => {
  it('uses the live agent when known', () => {
    expect(agentFamily('claude', 'claude_kimi')).toBe('claude')
    expect(agentFamily('codex', '')).toBe('codex')
    expect(agentFamily('grok.real', '')).toBe('grok')
    expect(agentFamily('agy', '')).toBe('agy')
  })
  it('falls back to the profile prefix', () => {
    expect(agentFamily('agent', 'claude_kimi')).toBe('claude')
    expect(agentFamily('', 'grok')).toBe('grok')
    expect(agentFamily('', 'agy')).toBe('agy')
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

describe('AgentAvatar', () => {
  it('uses the official Agy mark and a generic icon for unknown agents', () => {
    const agy = renderToStaticMarkup(
      createElement(AgentAvatar, { profile: 'agy' }),
    )
    const unknown = renderToStaticMarkup(
      createElement(AgentAvatar, { profile: 'unknown' }),
    )
    expect(agy).toContain('/icons/agents/agy.png')
    expect(agy).not.toContain('agent-avatar-fallback')
    expect(unknown).toContain('data-testid="agent-avatar-fallback"')
    expect(unknown).not.toContain('/icons/agents/agent.png')
  })
})
