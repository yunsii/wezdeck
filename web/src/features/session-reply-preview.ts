import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import type { Detail } from './console-sessions'
import type { SessionCard } from './session-card'
import { detailKey } from './session-detail-read'

/** Only a detail snapshot from the finished turn may supply list text. */
export function cachedAgentReply(
  row: Pick<SessionCard, 'id' | 'status' | 'ts'>,
  detail?: Pick<Detail, 'id' | 'status' | 'ts' | 'messages'>,
): string {
  if (!detail || detail.id !== row.id) return ''
  if (!['done', 'idle'].includes(row.status)) return ''
  if (!['done', 'idle'].includes(detail.status)) return ''
  if (row.ts > 0 && (detail.ts ?? 0) < row.ts) return ''
  for (let index = (detail.messages?.length ?? 0) - 1; index >= 0; index--) {
    const message = detail.messages?.[index]
    if (message?.role === 'user' && !message.text.trim().startsWith('<')) break
    if (message?.role === 'assistant' && message.kind !== 'thought') {
      const text = message.text.replace(/\s+/g, ' ').trim()
      if (text) return text
    }
  }
  return ''
}

/** Refresh list previews when background detail sync finishes. */
export function useReplyPreviews(rows: Array<SessionCard>) {
  const client = useQueryClient()
  const [, setRevision] = useState(0)
  useEffect(() => {
    const finished = new Map(
      rows
        .filter((row) => row.status === 'done' || row.status === 'idle')
        .map((row) => [row.id, row]),
    )
    const previews = new Map(
      [...finished].map(([id, row]) => [
        id,
        cachedAgentReply(row, client.getQueryData<Detail>(detailKey(id))),
      ]),
    )
    return client.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return
      const [scope, type, id] = event.query.queryKey
      if (scope !== 'remote' || type !== 'session' || typeof id !== 'string')
        return
      const row = finished.get(id)
      if (!row) return
      const next = cachedAgentReply(row, event.query.state.data as Detail)
      if (next === previews.get(id)) return
      previews.set(id, next)
      setRevision((revision) => revision + 1)
    })
  }, [client, rows])

  return rows.map((row) => ({
    ...row,
    last_reply: cachedAgentReply(
      row,
      client.getQueryData<Detail>(detailKey(row.id)),
    ),
  }))
}
