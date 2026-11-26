import { describe, expect, it } from 'vitest'

import { agentReference } from '#/features/copy-reference'
import type { AgentProfile } from '#/features/agent-profiles'

describe('agentReference', () => {
  it('copies the profile id and effective model without credential details', () => {
    const profile: AgentProfile = {
      id: 'claude_kimi',
      label: 'Claude · Kimi',
      model: 'k3.1-pro-highspeed',
      masked_key: '••••••••5678',
      base_url: 'https://api.kimi.ai/coding/',
    }
    const reference = agentReference(profile)
    expect(reference).toBe(
      '[wezdeck 智能体] Claude · Kimi\nagent_profile: claude_kimi\nmodel: k3.1-pro-highspeed',
    )
    expect(reference).not.toContain('5678')
    expect(reference).not.toContain('api.kimi.ai')
  })

  it('prefers an override and omits an unknown model', () => {
    expect(
      agentReference({
        id: 'codex',
        label: 'Codex',
        model_override: 'gpt-6.2-astra',
        default_model: 'gpt-6.2-sol',
      }),
    ).toContain('model: gpt-6.2-astra')
    expect(agentReference({ id: 'agy', label: 'Antigravity' })).toBe(
      '[wezdeck 智能体] Antigravity\nagent_profile: agy',
    )
  })
})
