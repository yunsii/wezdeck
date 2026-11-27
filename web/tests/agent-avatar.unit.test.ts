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
    expect(agy).toMatch(
      /src="([^"]*agy[^"]*\.png|data:image\/png;base64,[^"]+)"/,
    )
    expect(agy).toContain('decoding="sync"')
    expect(agy).not.toContain('agent-avatar-fallback')
    expect(unknown).toContain('data-testid="agent-avatar-fallback"')
    expect(unknown).not.toContain('agent.png')
  })

  it('puts status top-left and backend badge bottom-right', () => {
    const html = renderToStaticMarkup(
      createElement(AgentAvatar, {
        profile: 'claude_kimi',
        tone: 'running',
      }),
    )
    expect(html).toContain('data-testid="chat-status-dot"')
    expect(html).toContain('data-tone="running"')
    expect(html).toContain('-top-0.5 -left-0.5')
    expect(html).toContain('data-testid="agent-avatar-badge"')
    expect(html).toContain('-right-0.5 -bottom-0.5')
    const done = renderToStaticMarkup(
      createElement(AgentAvatar, { profile: 'claude', tone: 'done' }),
    )
    expect(done).toContain('data-tone="done"')
    const idle = renderToStaticMarkup(
      createElement(AgentAvatar, { profile: 'claude_kimi', tone: 'idle' }),
    )
    expect(idle).not.toContain('chat-status-dot')
    expect(idle).toContain('agent-avatar-badge')
  })

  it('scales corner badges down cleanly for compact form selectors', () => {
    const compact = renderToStaticMarkup(
      createElement(AgentAvatar, { profile: 'claude_kimi', size: 24 }),
    )
    const list = renderToStaticMarkup(
      createElement(AgentAvatar, { profile: 'claude_kimi', size: 40 }),
    )
    expect(compact).toContain('width:10px;height:10px')
    expect(compact).toContain('ring-1')
    expect(list).toContain('width:16px;height:16px')
    expect(list).toContain('ring-2')
  })
})
