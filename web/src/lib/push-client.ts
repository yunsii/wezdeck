// Browser Web Push client for WezDeck PWA:
// Talks to `/relay/push/*` (authenticated by the paired client token) and
// manages `ServiceWorkerRegistration.pushManager` subscriptions + device prefs.
import { loadDeviceKey } from './device-key'
import { remoteLink } from './remote-link'
import { readPairedToken, relayBase, roomQuery } from './remote-pairing'
import type { PushMode, PushPrefs } from '#/relay/web-push'
import { DEFAULT_PUSH_PREFS } from '#/relay/web-push'

export type { PushMode, PushPrefs }
export { DEFAULT_PUSH_PREFS }

export type PushSupportState =
  | 'ready'
  | 'ws-only'
  | 'ios-install-required'
  | 'unsupported'
  | 'denied'
  | 'unpaired'

export type PushStatusResponse = {
  ok: boolean
  enabled: boolean
  subscribed: boolean
  mode?: PushMode | null
  prefs: PushPrefs
  devices: number
}

export function isPushServiceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return /push service error|push service not available|registration failed/i.test(
    msg,
  )
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function detectPushSupport(): PushSupportState {
  if (typeof window === 'undefined') return 'unsupported'
  if (!readPairedToken()) return 'unpaired'
  const ua = navigator.userAgent || ''
  const isIOS = /iP(hone|ad|od)/.test(ua)
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  if (isIOS && !standalone) return 'ios-install-required'
  if (!('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'ws-only'
  }
  return 'ready'
}

export function base64UrlToUint8Array(
  base64Url: string,
): Uint8Array<ArrayBuffer> {
  const padded =
    base64Url.replace(/-/g, '+').replace(/_/g, '/') +
    '==='.slice((base64Url.length + 3) % 4)
  const binary = atob(padded)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function resolvePushDeviceId(): Promise<string> {
  try {
    const key = await loadDeviceKey()
    if (key?.id) return key.id
  } catch {
    // fallback below
  }
  const storageKey = 'wezdeck-push-device-id'
  try {
    const existing = localStorage.getItem(storageKey)
    if (existing) return existing
    const fresh = `web-${crypto.randomUUID().slice(0, 12)}`
    localStorage.setItem(storageKey, fresh)
    return fresh
  } catch {
    return 'web-ephemeral'
  }
}

function pushApiUrl(path: string, extraQuery = ''): string {
  const base = relayBase().replace(/^ws/, 'http')
  const room = roomQuery()
  const query = room
    ? extraQuery
      ? `${room}&${extraQuery}`
      : room
    : extraQuery
      ? `?${extraQuery}`
      : ''
  return `${base}/relay/push/${path}${query}`
}

async function pushFetch<T>(
  path: string,
  init: RequestInit = {},
  extraQuery = '',
): Promise<T> {
  const token = readPairedToken()
  if (!token) throw new Error('Device is not paired')
  const res = await fetch(pushApiUrl(path, extraQuery), {
    ...init,
    cache: 'no-store',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    throw new Error(data.error || `Push request failed (${res.status})`)
  }
  return data
}

export async function fetchPushConfig(): Promise<{
  enabled: boolean
  vapid_public_key: string
}> {
  return pushFetch('config', { method: 'GET' })
}

export async function fetchPushStatus(): Promise<PushStatusResponse> {
  const deviceId = await resolvePushDeviceId()
  return pushFetch(
    'status',
    { method: 'GET' },
    `device_id=${encodeURIComponent(deviceId)}`,
  )
}

export async function subscribeDevicePush(
  prefs: PushPrefs = DEFAULT_PUSH_PREFS,
): Promise<{ subscribed: boolean; mode: PushMode; prefs: PushPrefs }> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted')
  }
  const config = await fetchPushConfig()
  if (!config.enabled || !config.vapid_public_key) {
    throw new Error('Push is not configured on the relay yet')
  }
  const expectedKey = base64UrlToUint8Array(config.vapid_public_key)
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  // Self-heal stale subscriptions whose VAPID key differs from the relay's key.
  if (sub?.options.applicationServerKey) {
    const existingKey = new Uint8Array(sub.options.applicationServerKey)
    if (!bytesEqual(existingKey, expectedKey)) {
      await sub.unsubscribe().catch(() => undefined)
      sub = null
    }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: expectedKey,
    })
  }
  const json = sub.toJSON()
  const deviceId = await resolvePushDeviceId()
  const result = await pushFetch<{
    subscribed: boolean
    mode: PushMode
    prefs: PushPrefs
  }>('subscribe', {
    method: 'POST',
    body: JSON.stringify({
      device_id: deviceId,
      mode: 'webpush',
      subscription: {
        endpoint: json.endpoint,
        keys: json.keys,
      },
      prefs,
    }),
  })
  remoteLink.reportFocus()
  return result
}

export async function subscribeWsFallbackPush(
  prefs: PushPrefs = DEFAULT_PUSH_PREFS,
): Promise<{ subscribed: boolean; mode: PushMode; prefs: PushPrefs }> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted')
  }
  const deviceId = await resolvePushDeviceId()
  const result = await pushFetch<{
    subscribed: boolean
    mode: PushMode
    prefs: PushPrefs
  }>('subscribe', {
    method: 'POST',
    body: JSON.stringify({
      device_id: deviceId,
      mode: 'ws',
      prefs,
    }),
  })
  remoteLink.start()
  remoteLink.reportFocus()
  return result
}

export async function unsubscribeDevicePush(): Promise<void> {
  const deviceId = await resolvePushDeviceId()
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) await sub.unsubscribe()
  } catch {
    // still clean server-side subscription
  }
  await pushFetch('unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ device_id: deviceId }),
  })
}

export async function updatePushPrefs(
  prefs: Partial<PushPrefs>,
): Promise<{ prefs: PushPrefs }> {
  const deviceId = await resolvePushDeviceId()
  return pushFetch('prefs', {
    method: 'POST',
    body: JSON.stringify({ device_id: deviceId, prefs }),
  })
}

export async function sendTestPush(): Promise<{ ok: boolean; status: number }> {
  const deviceId = await resolvePushDeviceId()
  return pushFetch('test', {
    method: 'POST',
    body: JSON.stringify({ device_id: deviceId }),
  })
}
