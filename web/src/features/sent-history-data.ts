// Host-backed sent message outbox types and TanStack Query reader.
import { useQuery } from '@tanstack/react-query'

import { hostRead } from '#/lib/runtime-client'

export type SentRecord = {
  id: string
  client_op?: string
  kind: 'message' | 'session_new'
  session_id?: string
  repo_key?: string
  repo_label?: string
  worktree?: string
  agent?: string
  pane?: string
  text: string
  attachments?: Array<string>
  via?: string
  device?: string
  created_at: number
  status:
    'pasting' | 'pending' | 'confirmed' | 'unconfirmed' | 'failed' | 'dismissed'
  error?: string
  transcript_end_at_send: number
  confirmed_at?: number
  confirmed_msg_index?: number
}

export type SentListReply = {
  v: number
  ok: boolean
  items: Array<SentRecord>
  has_more: boolean
  unsettled_count: number
}

export type SentScope = 'session' | 'repo' | 'all'

export function sentListKey(
  scope: SentScope,
  session: string,
  onlyUnsettled: boolean,
) {
  return [
    'remote',
    'sent',
    scope,
    scope === 'all' ? '' : session,
    onlyUnsettled ? 'unsettled' : 'default',
  ] as const
}

export function useSentHistory({
  scope,
  session,
  onlyUnsettled = false,
  enabled = true,
  limit = 50,
}: {
  scope: SentScope
  session: string
  onlyUnsettled?: boolean
  enabled?: boolean
  limit?: number
}) {
  return useQuery({
    queryKey: sentListKey(scope, session, onlyUnsettled),
    enabled: enabled && typeof window !== 'undefined',
    staleTime: 3_000,
    queryFn: async () =>
      (await hostRead('sent.list', {
        scope,
        session: scope === 'all' ? undefined : session,
        status: onlyUnsettled ? 'unsettled' : 'default',
        limit,
      })) as SentListReply,
  })
}
