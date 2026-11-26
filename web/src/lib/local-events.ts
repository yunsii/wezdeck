import { buildId } from './pwa'
import { postLocalEvents } from './runtime-client'

type Event = {
  page: string
  seq: number
  at: number
  build: string
  kind: string
  data: Record<string, string | number | boolean>
}

const KINDS = new Set([
  'boot',
  'popstate',
  'after-back',
  'visibility',
  'link',
  'nav',
  'nav-collapse',
  'nav-frames',
  'chat-pin',
  'chat-catch-up',
  'session-seen-ack',
  'session-focus',
  'composer-clear',
  'web-write',
  'session-sync',
  'chat-render',
  'error',
  'rejection',
])
const FIELDS = new Set([
  'id',
  'op_id',
  'action',
  'stage',
  'outcome',
  'mode',
  'state',
  'status',
  'type',
  'index',
  'length',
  'count',
  'start',
  'total',
  'shown',
  'ms',
  'pinned',
  'skipped',
  'chars',
  'images',
  'busy',
])
const ROUTE_EVENTS = new Set([
  'boot',
  'popstate',
  'after-back',
  'nav',
  'nav-frames',
])
const MAX_PENDING = 120
const BATCH = 20
let page = ''
let seq = 0
let dropped = 0
let sending = false
let inFlightLast = 0
let installed = false
const pending: Array<Event> = []

export function recordLocalEvent(
  kind: string,
  data: Record<string, unknown> = {},
) {
  if (!page && typeof crypto !== 'undefined') page = crypto.randomUUID()
  if (!KINDS.has(kind) || !page) return
  const safe = Object.fromEntries(
    Object.entries(data).filter(
      ([key, value]) =>
        FIELDS.has(key) &&
        (typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'string' && /^[\w.:-]{0,80}$/.test(value))),
    ),
  ) as Event['data']
  if (ROUTE_EVENTS.has(kind)) {
    const raw = data.path ?? data.url ?? data.to
    if (typeof raw === 'string') {
      const route = raw.split(/[?#]/, 1)[0]
      if (
        /^\/(?:zh\/|en\/)?(?:console|architecture)(?:\/[\w.-]+)*\/?$/.test(
          route,
        )
      )
        safe.route = route
    }
  }
  if (pending.length >= MAX_PENDING) {
    const oldestUnsent = pending.findIndex((event) => event.seq > inFlightLast)
    pending.splice(oldestUnsent < 0 ? 0 : oldestUnsent, 1)
    dropped++
  }
  pending.push({
    page,
    seq: ++seq,
    at: Date.now(),
    build: buildId,
    kind,
    data: safe,
  })
  if (installed && pending.length >= BATCH) void flushLocalEvents()
}

export async function flushLocalEvents() {
  if (sending || (!pending.length && !dropped)) return
  sending = true
  const batch = pending.slice(0, BATCH)
  inFlightLast = batch.at(-1)?.seq ?? 0
  const lost = dropped
  try {
    if (await postLocalEvents(batch, lost)) {
      const last = batch.at(-1)?.seq ?? 0
      while (pending.length && pending[0].seq <= last) pending.shift()
      dropped -= lost
    }
  } catch {
    // The bounded queue retries when the Runtime is reachable again.
  } finally {
    sending = false
    inFlightLast = 0
  }
}

export function installLocalEvents() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.setInterval(() => void flushLocalEvents(), 3_000)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void flushLocalEvents()
  })
}
