import type { QueryClient } from '@tanstack/react-query'
import { hostRead } from '#/lib/runtime-client'
import { mergeReply, pollArgs } from '#/lib/session-cache'
import { traceSessionSync } from '#/lib/session-sync-trace'
import type { Detail } from './console-sessions'

export const detailKey = (id: string) => ['remote', 'session', id] as const

/** One incremental read, merged with the latest cache after the request. */
export async function readDetail(client: QueryClient, id: string) {
  const key = detailKey(id)
  const reply = (await hostRead(
    'session',
    pollArgs(id, client.getQueryData<Detail>(key)),
  )) as Detail
  const have = client.getQueryData<Detail>(key)
  traceSessionSync(have, reply, id)
  return mergeReply(have, reply)
}
