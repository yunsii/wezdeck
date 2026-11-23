// Ticket list sync, change-driven. The list is ~45 KB; health is ~380 B and
// moves whenever the list would: its events head (seq_head), the counts by
// status and the runs in flight. So health is the poll — every 3 s while a
// run is in flight, 15 s otherwise — and the list is fetched when health
// changes, with a slow backstop (10 s while running, for run progress in the
// rows; 5 min idle). It used to be the list itself every 2 s while running
// (~22 KB/s), with each page that showed it polling on its own timer.
//
// One driver: the console shell (useTicketSync) — every console page sits in
// it. Pages read the same cache entries without timers of their own
// (useTicketList / useTicketHealth), and a fresh-enough list is not refetched
// just because a page mounted.
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { collabKey, useCollab } from './collab-query'

export const LIST_PARAMS = { limit: 200 }
const FOREVER = Number.POSITIVE_INFINITY

export function useTicketSync() {
  const client = useQueryClient()
  const peek = client.getQueryData<{ running?: number }>(collabKey('health'))
  const busy = (peek?.running ?? 0) > 0
  const health = useCollab(
    'health',
    {},
    { refetchInterval: busy ? 3_000 : 15_000 },
  )
  const running = (health.data?.running ?? 0) > 0
  useCollab('list', LIST_PARAMS, {
    refetchInterval: running ? 10_000 : 300_000,
    staleTime: FOREVER,
  })
  const data = health.data
  const signature = data?.ok
    ? [
        data.seq_head,
        data.tickets,
        data.running,
        data.waiting_human,
        JSON.stringify(data.by_status),
      ].join('|')
    : ''
  const seen = useRef('')
  useEffect(() => {
    if (!signature) return
    if (seen.current && seen.current !== signature)
      void client.invalidateQueries({
        queryKey: collabKey('list', LIST_PARAMS),
      })
    seen.current = signature
  }, [signature, client])
  return health
}

/** the ticket list as the shell keeps it; no timer of its own */
export const useTicketList = () =>
  useCollab('list', LIST_PARAMS, { staleTime: FOREVER })

/** collab health as the shell keeps it; no timer of its own */
export const useTicketHealth = () =>
  useCollab('health', {}, { staleTime: FOREVER })
