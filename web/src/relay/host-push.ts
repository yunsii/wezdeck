// Durable Object storage & delivery helpers for Web Push subscriptions.
// Kept separate from host-relay.ts so HostRelay stays compact and focused.
import { logRelayEvent } from './auth'
import {
  DEFAULT_PUSH_PREFS,
  evaluatePushDelivery,
  normalizePushPrefs,
  sendWebPush,
} from './web-push'
import type { PushEmitEvent, StoredPushSub, VapidConfig } from './web-push'

const PUSH_PREFIX = 'push_sub:'
const DEVICE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

export type PushEnv = {
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

export type DeviceFrameSender = (
  deviceId: string,
  frame: Record<string, unknown>,
) => boolean

function readVapid(env: PushEnv): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? ''
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? ''
  if (!publicKey || !privateKey) return null
  return {
    publicKey,
    privateKey,
    subject: env.VAPID_SUBJECT?.trim() || 'mailto:ops@wezdeck.yuns.love',
  }
}

export async function handlePushHttp(
  request: Request,
  storage: DurableObjectStorage,
  env: PushEnv,
  sendToDevice?: DeviceFrameSender,
): Promise<Response> {
  const url = new URL(request.url)
  const action = url.pathname.slice('/push/'.length)
  const vapid = readVapid(env)

  if (action === 'status' && request.method === 'GET') {
    const deviceId = url.searchParams.get('device_id')?.trim() ?? ''
    const entries = await storage.list<StoredPushSub>({ prefix: PUSH_PREFIX })
    const mine = deviceId ? entries.get(`${PUSH_PREFIX}${deviceId}`) : undefined
    return Response.json({
      ok: true,
      enabled: Boolean(vapid),
      subscribed: Boolean(mine),
      mode: mine ? (mine.mode ?? 'webpush') : null,
      prefs: mine?.prefs ?? DEFAULT_PUSH_PREFS,
      devices: entries.size,
    })
  }

  let body: Record<string, unknown> = {}
  try {
    body = await request.json<Record<string, unknown>>()
  } catch {
    return Response.json({ ok: false, error: 'invalid json' }, { status: 400 })
  }

  const deviceId =
    typeof body.device_id === 'string' ? body.device_id.trim() : ''
  if (!DEVICE_ID_RE.test(deviceId)) {
    return Response.json(
      { ok: false, error: 'invalid device_id' },
      { status: 400 },
    )
  }
  const key = `${PUSH_PREFIX}${deviceId}`

  if (action === 'subscribe' && request.method === 'POST') {
    const mode = body.mode === 'ws' ? 'ws' : 'webpush'
    const existing = await storage.get<StoredPushSub>(key)
    const prefs = body.prefs
      ? normalizePushPrefs(body.prefs)
      : (existing?.prefs ?? DEFAULT_PUSH_PREFS)
    let endpoint = ''
    let p256dh = ''
    let auth = ''
    if (mode === 'webpush') {
      const sub = body.subscription as
        | { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
        | undefined
      endpoint = typeof sub?.endpoint === 'string' ? sub.endpoint.trim() : ''
      p256dh =
        typeof sub?.keys?.p256dh === 'string' ? sub.keys.p256dh.trim() : ''
      auth = typeof sub?.keys?.auth === 'string' ? sub.keys.auth.trim() : ''
      if (!endpoint.startsWith('https://') || !p256dh || !auth) {
        return Response.json(
          { ok: false, error: 'invalid push subscription' },
          { status: 400 },
        )
      }
    }
    const record: StoredPushSub = {
      device_id: deviceId,
      mode,
      endpoint,
      keys: { p256dh, auth },
      prefs,
      updated_at: Date.now(),
      ua: (request.headers.get('user-agent') ?? '').slice(0, 120),
    }
    await storage.put(key, record)
    logRelayEvent('push_subscribed', { device_id: deviceId, mode })
    return Response.json({ ok: true, subscribed: true, mode, prefs })
  }

  if (action === 'unsubscribe' && request.method === 'POST') {
    await storage.delete(key)
    logRelayEvent('push_unsubscribed', { device_id: deviceId })
    return Response.json({ ok: true, subscribed: false })
  }

  if (action === 'prefs' && request.method === 'POST') {
    const existing = await storage.get<StoredPushSub>(key)
    if (!existing) {
      return Response.json(
        { ok: false, error: 'device not subscribed' },
        { status: 404 },
      )
    }
    const prefs = normalizePushPrefs({
      ...existing.prefs,
      ...(body.prefs as object),
    })
    await storage.put(key, { ...existing, prefs, updated_at: Date.now() })
    return Response.json({ ok: true, prefs })
  }

  if (action === 'test' && request.method === 'POST') {
    const sub = await storage.get<StoredPushSub>(key)
    if (!sub) {
      return Response.json(
        { ok: false, error: 'device not subscribed' },
        { status: 404 },
      )
    }
    if (sub.mode === 'ws') {
      const delivered =
        sendToDevice?.(deviceId, {
          t: 'push.notify',
          force: true,
          kind: 'test',
          title: 'WezDeck 测试通知',
          body: '后台保活通道正常：切到后台时，会话待确认与工单关键节点将自动弹窗。',
          tag: 'wezdeck:test',
          url: '/console/me/notifications',
        }) ?? false
      logRelayEvent('push_test', {
        device_id: deviceId,
        mode: 'ws',
        ok: delivered,
      })
      if (!delivered) {
        return Response.json(
          {
            ok: false,
            error:
              'No active relay socket for this device — refresh the page and retry',
          },
          { status: 409 },
        )
      }
      return Response.json({ ok: true, status: 200 })
    }
    if (!vapid) {
      return Response.json(
        { ok: false, error: 'VAPID keys not configured on relay' },
        { status: 503 },
      )
    }
    const result = await sendWebPush(
      sub,
      {
        title: 'WezDeck 测试通知',
        body: '推送通道正常：会话待确认与工单关键节点将实时触达此设备。',
        tag: 'wezdeck:test',
        url: '/console/me/notifications',
      },
      vapid,
      { urgency: 'high', ttl: 300 },
    )
    if (result.gone) {
      await storage.delete(key)
      logRelayEvent('push_pruned', {
        device_id: deviceId,
        status: result.status,
      })
    }
    logRelayEvent('push_test', {
      device_id: deviceId,
      ok: result.ok,
      status: result.status,
    })
    return Response.json(
      { ok: result.ok, status: result.status, error: result.error },
      { status: result.ok ? 200 : 502 },
    )
  }

  return Response.json({ ok: false, error: 'not found' }, { status: 404 })
}

export async function dispatchPushEmit(
  frame: Record<string, unknown>,
  storage: DurableObjectStorage,
  env: PushEnv,
  focusedByDevice: Map<string, Set<string>>,
  sendToDevice?: DeviceFrameSender,
): Promise<void> {
  const vapid = readVapid(env)
  const kind = String(frame.kind ?? '') as PushEmitEvent['kind']
  const event: PushEmitEvent = {
    event_id: String(frame.event_id ?? ''),
    kind,
    tag: String(frame.tag ?? 'wezdeck'),
    url: String(frame.url ?? '/console/sessions'),
    title: String(frame.title ?? 'WezDeck'),
    body: String(frame.body ?? ''),
    badge: typeof frame.badge === 'number' ? frame.badge : undefined,
    silent: frame.silent === true,
    desk_active: frame.desk_active === true,
    turn_elapsed_s:
      typeof frame.turn_elapsed_s === 'number'
        ? frame.turn_elapsed_s
        : undefined,
    target_path:
      typeof frame.target_path === 'string' ? frame.target_path : undefined,
  }

  const entries = await storage.list<StoredPushSub>({ prefix: PUSH_PREFIX })
  if (entries.size === 0) return

  const anyDeviceForeground = focusedByDevice.size > 0
  let sent = 0
  let suppressed = 0
  let pruned = 0

  await Promise.all(
    [...entries.entries()].map(async ([storageKey, sub]) => {
      const focused = focusedByDevice.get(sub.device_id) ?? new Set<string>()
      const decision = evaluatePushDelivery(
        sub,
        event,
        focused,
        anyDeviceForeground,
      )
      if (!decision.deliver) {
        suppressed++
        return
      }
      if (sub.mode === 'ws') {
        const delivered =
          sendToDevice?.(sub.device_id, {
            t: 'push.notify',
            event_id: event.event_id,
            kind: event.kind,
            title: event.title,
            body: event.body,
            tag: event.tag,
            url: event.url,
            badge: event.badge,
            silent: decision.silent,
          }) ?? false
        if (delivered) sent++
        else suppressed++
        return
      }
      if (!vapid) {
        suppressed++
        return
      }
      const urgency =
        decision.silent || event.kind === 'session_done' ? 'normal' : 'high'
      try {
        const res = await sendWebPush(
          sub,
          {
            title: event.title,
            body: event.body,
            tag: event.tag,
            url: event.url,
            badge: event.badge,
            silent: decision.silent,
          },
          vapid,
          { urgency, ttl: 3600 },
        )
        if (res.ok) {
          sent++
        } else if (res.gone) {
          pruned++
          await storage.delete(storageKey)
          logRelayEvent('push_pruned', {
            device_id: sub.device_id,
            status: res.status,
          })
        } else {
          logRelayEvent('push_error', {
            device_id: sub.device_id,
            status: res.status,
            kind: event.kind,
          })
        }
      } catch (err) {
        logRelayEvent('push_error', {
          device_id: sub.device_id,
          kind: event.kind,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }),
  )

  logRelayEvent('push_sent', {
    event_id: event.event_id,
    kind: event.kind,
    sent,
    suppressed,
    pruned,
  })
}
