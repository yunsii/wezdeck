import { useQuery } from '@tanstack/react-query'
import { hostRead } from '#/lib/runtime-client'

export type Repository = {
  root: string
  label: string
  visited?: number
  agent_profile?: string
  workspace_agent_profile?: string
  agent_source?: 'workspace' | 'override'
}

export function useRepositories() {
  return useQuery({
    queryKey: ['remote', 'repos'],
    queryFn: async () =>
      (await hostRead('repos', {})) as {
        repos: Array<Repository>
        settings_error?: boolean
      },
    staleTime: 0,
  })
}
