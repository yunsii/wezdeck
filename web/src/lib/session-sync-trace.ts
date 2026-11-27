import { trace } from './client-trace'

type Snapshot = {
  total?: number
  status: string
  read_only?: boolean
  replaced_by?: string
  start?: number
  messages?: Array<unknown>
}

/** Return whether the host snapshot changed in a way worth logging. */
export function sessionSyncChanged(
  before: Snapshot | undefined,
  after: Snapshot,
) {
  return (
    !before ||
    before.total !== after.total ||
    before.status !== after.status ||
    Boolean(before.read_only) !== Boolean(after.read_only) ||
    before.replaced_by !== after.replaced_by
  )
}

export function traceSessionSync(
  before: Snapshot | undefined,
  after: Snapshot,
  id: string,
) {
  if (!sessionSyncChanged(before, after)) return
  trace('session-sync', {
    id,
    total: after.total ?? 0,
    status: after.status,
    readOnly: after.read_only === true,
    start: after.start ?? 0,
    shown: after.messages?.length ?? 0,
  })
}
