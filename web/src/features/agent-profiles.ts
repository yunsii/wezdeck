import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { hostRead } from '#/lib/runtime-client'

export type AgentProfile = {
  id: string
  label: string
  default?: boolean
  configured?: boolean
  model?: string
  model_override?: string
  default_model?: string
  masked_key?: string
  note?: string
  disabled?: boolean
  /** Kimi / Claude Code /status parity (from kimi.env; never raw secrets). */
  base_url?: string
  effort_level?: string
  auto_compact_window?: string
  max_context_tokens?: string
  auto_mode_server?: string
  opus_model?: string
  sonnet_model?: string
  haiku_model?: string
  fable_model?: string
  subagent_model?: string
}

export function useAgentProfiles() {
  return useQuery({
    queryKey: ['remote', 'agent.profiles'],
    queryFn: async () =>
      (await hostRead('agent.profiles', {})) as {
        profiles: Array<AgentProfile>
        default: string
      },
    staleTime: 30_000,
  })
}

const PREFERENCE_KEY = 'wezdeck.agent-profile'
const PREFERENCE_EVENT = 'wezdeck:agent-profile'

export function usePreferredAgentProfile() {
  const [preferred, setPreferred] = useState(() =>
    typeof window === 'undefined'
      ? ''
      : localStorage.getItem(PREFERENCE_KEY) || '',
  )
  useEffect(() => {
    const refresh = () =>
      setPreferred(localStorage.getItem(PREFERENCE_KEY) || '')
    window.addEventListener('storage', refresh)
    window.addEventListener(PREFERENCE_EVENT, refresh)
    return () => {
      window.removeEventListener('storage', refresh)
      window.removeEventListener(PREFERENCE_EVENT, refresh)
    }
  }, [])
  const update = (id: string) => {
    if (id) localStorage.setItem(PREFERENCE_KEY, id)
    else localStorage.removeItem(PREFERENCE_KEY)
    setPreferred(id)
    window.dispatchEvent(new Event(PREFERENCE_EVENT))
  }
  return [preferred, update] as const
}
