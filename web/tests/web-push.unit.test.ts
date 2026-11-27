// covers: web/src/relay/web-push.ts web/src/lib/push-client.ts
import { describe, expect, it } from 'vitest'

import { isPushServiceError } from '#/lib/push-client'
import {
  DEFAULT_PUSH_PREFS,
  base64UrlEncode,
  encryptWebPushPayload,
  evaluatePushDelivery,
  normalizePushPrefs,
  sendWebPush,
  signVapidJwt,
} from '#/relay/web-push'
import type { PushEmitEvent, StoredPushSub } from '#/relay/web-push'

async function generateTestVapidAndSub() {
  const vapidPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const vapidPubRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', vapidPair.publicKey),
  )
  const vapidPrivJwk = await crypto.subtle.exportKey(
    'jwk',
    vapidPair.privateKey,
  )

  const uaPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )
  const uaPubRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', uaPair.publicKey),
  )
  const auth = crypto.getRandomValues(new Uint8Array(16))

  const sub: StoredPushSub = {
    device_id: 'dev-phone-1',
    endpoint: 'https://push.example.com/sub/abc',
    keys: {
      p256dh: base64UrlEncode(uaPubRaw),
      auth: base64UrlEncode(auth),
    },
    prefs: { ...DEFAULT_PUSH_PREFS },
    updated_at: Date.now(),
  }

  return {
    vapid: {
      publicKey: base64UrlEncode(vapidPubRaw),
      privateKey: vapidPrivJwk.d!,
      subject: 'mailto:ops@wezdeck.yuns.love',
    },
    sub,
  }
}

describe('web-push (RFC 8291/8292 + noise suppression)', () => {
  it('signs VAPID ES256 JWT and encrypts aes128gcm payload with valid header', async () => {
    const { vapid, sub } = await generateTestVapidAndSub()
    const jwt = await signVapidJwt(
      'https://push.example.com',
      vapid,
      1_700_000_000,
    )
    const parts = jwt.split('.')
    expect(parts).toHaveLength(3)

    const encrypted = await encryptWebPushPayload(
      new TextEncoder().encode(
        JSON.stringify({ title: 'Test', body: 'Hello' }),
      ),
      sub.keys.p256dh,
      sub.keys.auth,
    )
    // Header = 16 salt + 4 rs + 1 keylen(65) + 65 pubkey = 86 bytes + ciphertext + 16 GCM tag
    expect(encrypted.byteLength).toBeGreaterThan(86 + 16)
    expect(encrypted[20]).toBe(65)
    expect(encrypted[21]).toBe(0x04)
  })

  it('sends signed encrypted HTTP POST and detects 410 Gone for pruning', async () => {
    const { vapid, sub } = await generateTestVapidAndSub()
    let seenHeaders: Record<string, string> = {}
    const okRes = await sendWebPush(
      sub,
      { title: 'Need approval', url: '/console/sessions/s1' },
      vapid,
      { urgency: 'high' },
      async (_input, init) => {
        seenHeaders = Object.fromEntries(new Headers(init?.headers).entries())
        return new Response(null, { status: 201 })
      },
    )
    expect(okRes.ok).toBe(true)
    expect(okRes.gone).toBe(false)
    expect(seenHeaders['content-encoding']).toBe('aes128gcm')
    expect(seenHeaders['authorization']).toMatch(/^vapid t=[^,]+, k=/)

    const goneRes = await sendWebPush(
      sub,
      { title: 'Stale' },
      vapid,
      {},
      async () => new Response(null, { status: 410 }),
    )
    expect(goneRes.ok).toBe(false)
    expect(goneRes.gone).toBe(true)
  })

  it('applies per-kind prefs, long-turn threshold, desk-active quiet, and foreground suppression', () => {
    const sub: StoredPushSub = {
      device_id: 'd1',
      endpoint: 'https://push.example.com/1',
      keys: { p256dh: 'x', auth: 'y' },
      prefs: normalizePushPrefs({ session_done: true, session_done_min_s: 60 }),
      updated_at: 0,
    }
    const waitingEvent: PushEmitEvent = {
      event_id: 'e1',
      kind: 'session_waiting',
      tag: 'session:s1',
      url: '/console/sessions/s1',
      target_path: '/console/sessions/s1',
      title: '需要确认 · Demo',
      body: '权限审批',
      badge: 2,
    }

    // Normal delivery
    expect(evaluatePushDelivery(sub, waitingEvent, new Set())).toEqual({
      deliver: true,
      silent: false,
    })

    // Foreground same page suppresses popup
    expect(
      evaluatePushDelivery(
        sub,
        waitingEvent,
        new Set(['/console/sessions/s1']),
      ),
    ).toEqual({
      deliver: false,
      silent: true,
      reason: 'foreground_same_page',
    })

    // Desk active downgrades to silent badge update
    expect(
      evaluatePushDelivery(
        sub,
        { ...waitingEvent, desk_active: true },
        new Set(),
      ),
    ).toEqual({
      deliver: true,
      silent: true,
      reason: 'desk_active_badge_only',
    })

    // Short session_done below 60s threshold is suppressed
    expect(
      evaluatePushDelivery(
        sub,
        {
          ...waitingEvent,
          kind: 'session_done',
          turn_elapsed_s: 25,
        },
        new Set(),
      ).deliver,
    ).toBe(false)
    expect(
      evaluatePushDelivery(
        sub,
        {
          ...waitingEvent,
          kind: 'session_done',
          turn_elapsed_s: 95,
        },
        new Set(),
      ).deliver,
    ).toBe(true)

    // Another device in the foreground suppresses popups across all devices
    expect(evaluatePushDelivery(sub, waitingEvent, new Set(), true)).toEqual({
      deliver: true,
      silent: true,
      reason: 'other_device_foreground_badge_only',
    })

    // Push service error classifier
    expect(
      isPushServiceError(new Error('Registration failed - push service error')),
    ).toBe(true)
    expect(
      isPushServiceError(new Error('Notification permission denied')),
    ).toBe(false)
  })
})
