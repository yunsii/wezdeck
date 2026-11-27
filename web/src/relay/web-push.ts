// Pure WebCrypto Web Push implementation (RFC 8292 VAPID ES256 + RFC 8291
// aes128gcm payload encryption) with zero external dependencies so it runs
// identically in Cloudflare Workers Durable Objects and Node/Vitest.

export type PushEventKind =
  | 'session_waiting'
  | 'session_done'
  | 'ticket_proposal'
  | 'ticket_waiting'
  | 'ticket_error'
  | 'ticket_verify'
  | 'badge'
  | 'test'

export type PushPrefs = {
  session_waiting: boolean
  session_done: boolean
  session_done_min_s: number
  ticket_proposal: boolean
  ticket_waiting: boolean
  ticket_error: boolean
  ticket_verify: boolean
  quiet_when_desk_active: boolean
}

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  session_waiting: true,
  session_done: false,
  session_done_min_s: 60,
  ticket_proposal: true,
  ticket_waiting: true,
  ticket_error: true,
  ticket_verify: true,
  quiet_when_desk_active: true,
}

export type StoredPushSub = {
  device_id: string
  endpoint: string
  keys: {
    p256dh: string
    auth: string
  }
  prefs: PushPrefs
  updated_at: number
  ua?: string
}

export type PushEmitEvent = {
  event_id: string
  kind: PushEventKind
  tag: string
  url: string
  title: string
  body: string
  badge?: number
  silent?: boolean
  desk_active?: boolean
  turn_elapsed_s?: number
  target_path?: string
}

export type VapidConfig = {
  publicKey: string
  privateKey: string
  subject: string
}

export function normalizePushPrefs(raw: unknown): PushPrefs {
  const obj =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const minS =
    typeof obj.session_done_min_s === 'number' &&
    Number.isFinite(obj.session_done_min_s)
      ? Math.max(15, Math.min(3600, Math.round(obj.session_done_min_s)))
      : DEFAULT_PUSH_PREFS.session_done_min_s
  return {
    session_waiting:
      typeof obj.session_waiting === 'boolean'
        ? obj.session_waiting
        : DEFAULT_PUSH_PREFS.session_waiting,
    session_done:
      typeof obj.session_done === 'boolean'
        ? obj.session_done
        : DEFAULT_PUSH_PREFS.session_done,
    session_done_min_s: minS,
    ticket_proposal:
      typeof obj.ticket_proposal === 'boolean'
        ? obj.ticket_proposal
        : DEFAULT_PUSH_PREFS.ticket_proposal,
    ticket_waiting:
      typeof obj.ticket_waiting === 'boolean'
        ? obj.ticket_waiting
        : DEFAULT_PUSH_PREFS.ticket_waiting,
    ticket_error:
      typeof obj.ticket_error === 'boolean'
        ? obj.ticket_error
        : DEFAULT_PUSH_PREFS.ticket_error,
    ticket_verify:
      typeof obj.ticket_verify === 'boolean'
        ? obj.ticket_verify
        : DEFAULT_PUSH_PREFS.ticket_verify,
    quiet_when_desk_active:
      typeof obj.quiet_when_desk_active === 'boolean'
        ? obj.quiet_when_desk_active
        : DEFAULT_PUSH_PREFS.quiet_when_desk_active,
  }
}

export function evaluatePushDelivery(
  sub: StoredPushSub,
  event: PushEmitEvent,
  focusedPaths: ReadonlySet<string>,
): { deliver: boolean; silent: boolean; reason?: string } {
  if (event.kind === 'test') {
    return { deliver: true, silent: false }
  }
  if (event.kind === 'badge' || event.silent) {
    return { deliver: true, silent: true }
  }
  const prefs = sub.prefs
  const enabled = (() => {
    switch (event.kind) {
      case 'session_waiting':
        return prefs.session_waiting
      case 'session_done':
        return (
          prefs.session_done &&
          (event.turn_elapsed_s ?? 0) >= prefs.session_done_min_s
        )
      case 'ticket_proposal':
        return prefs.ticket_proposal
      case 'ticket_waiting':
        return prefs.ticket_waiting
      case 'ticket_error':
        return prefs.ticket_error
      case 'ticket_verify':
        return prefs.ticket_verify
      default:
        return false
    }
  })()
  if (!enabled) {
    return { deliver: false, silent: true, reason: 'pref_disabled' }
  }
  if (event.target_path && focusedPaths.has(event.target_path)) {
    return { deliver: false, silent: true, reason: 'foreground_same_page' }
  }
  if (event.desk_active && prefs.quiet_when_desk_active) {
    if (typeof event.badge === 'number') {
      return { deliver: true, silent: true, reason: 'desk_active_badge_only' }
    }
    return { deliver: false, silent: true, reason: 'desk_active' }
  }
  return { deliver: true, silent: false }
}

const enc = new TextEncoder()

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(input: string): Uint8Array {
  const padded =
    input.replace(/-/g, '+').replace(/_/g, '/') +
    '==='.slice((input.length + 3) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

function concatBytes(...chunks: Array<Uint8Array>): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const chunk of chunks) {
    out.set(chunk, off)
    off += chunk.length
  }
  return out
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function hkdfExtract(
  salt: Uint8Array,
  ikm: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const prk = await crypto.subtle.sign('HMAC', key, toArrayBuffer(ikm))
  return new Uint8Array(prk)
}

async function hkdfExpand(
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(prk),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const input = concatBytes(info, new Uint8Array([1]))
  const out = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, toArrayBuffer(input)),
  )
  return out.slice(0, length)
}

/**
 * Signs an RFC 8292 VAPID JWT using P-256 ES256.
 * `vapid.publicKey`: base64url 65-byte uncompressed EC point (`04 || x || y`).
 * `vapid.privateKey`: base64url 32-byte EC private scalar (`d`).
 */
export async function signVapidJwt(
  audience: string,
  vapid: VapidConfig,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<string> {
  const pubBytes = base64UrlDecode(vapid.publicKey)
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
    throw new Error('invalid VAPID public key')
  }
  const x = base64UrlEncode(pubBytes.slice(1, 33))
  const y = base64UrlEncode(pubBytes.slice(33, 65))
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d: vapid.privateKey },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const header = base64UrlEncode(
    enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })),
  )
  const payload = base64UrlEncode(
    enc.encode(
      JSON.stringify({
        aud: audience,
        exp: nowSec + 12 * 3600,
        sub: vapid.subject,
      }),
    ),
  )
  const signingInput = `${header}.${payload}`
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      toArrayBuffer(enc.encode(signingInput)),
    ),
  )
  return `${signingInput}.${base64UrlEncode(sig)}`
}

/**
 * Encrypts a UTF-8 JSON payload per RFC 8291 (`aes128gcm` content encoding).
 */
export async function encryptWebPushPayload(
  plaintext: Uint8Array,
  subscriberPublicKeyB64: string,
  subscriberAuthB64: string,
): Promise<Uint8Array> {
  const uaPubBytes = base64UrlDecode(subscriberPublicKeyB64)
  const authSecret = base64UrlDecode(subscriberAuthB64)
  if (uaPubBytes.length !== 65 || uaPubBytes[0] !== 0x04) {
    throw new Error('invalid subscriber p256dh key')
  }
  if (authSecret.length !== 16) {
    throw new Error('invalid subscriber auth secret')
  }

  const uaPubKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(uaPubBytes),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const asKeyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair
  const asPubBytes = new Uint8Array(
    (await crypto.subtle.exportKey('raw', asKeyPair.publicKey)) as ArrayBuffer,
  )
  const deriveAlgo = {
    name: 'ECDH',
    public: uaPubKey,
  } as unknown as Parameters<SubtleCrypto['deriveBits']>[0]
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(deriveAlgo, asKeyPair.privateKey, 256),
  )

  const salt = crypto.getRandomValues(new Uint8Array(16))

  const prkKey = await hkdfExtract(authSecret, sharedSecret)
  const keyInfo = concatBytes(
    enc.encode('WebPush: info\0'),
    uaPubBytes,
    asPubBytes,
  )
  const ikm = await hkdfExpand(prkKey, keyInfo, 32)

  const prk = await hkdfExtract(salt, ikm)
  const cek = await hkdfExpand(
    prk,
    enc.encode('Content-Encoding: aes128gcm\0'),
    16,
  )
  const nonce = await hkdfExpand(
    prk,
    enc.encode('Content-Encoding: nonce\0'),
    12,
  )

  const aesKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(cek),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  )
  // Delimiter 0x02 marks the final record (RFC 8188 §2)
  const record = concatBytes(plaintext, new Uint8Array([0x02]))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce), tagLength: 128 },
      aesKey,
      toArrayBuffer(record),
    ),
  )

  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, 4096, false)
  const header = concatBytes(
    salt,
    rs,
    new Uint8Array([asPubBytes.length]),
    asPubBytes,
  )
  return concatBytes(header, ciphertext)
}

export async function sendWebPush(
  sub: StoredPushSub,
  payload: Record<string, unknown>,
  vapid: VapidConfig,
  options: { urgency?: 'high' | 'normal'; ttl?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; gone: boolean; error?: string }> {
  let origin: string
  try {
    origin = new URL(sub.endpoint).origin
  } catch {
    return { ok: false, status: 400, gone: true, error: 'invalid endpoint URL' }
  }
  const jwt = await signVapidJwt(origin, vapid)
  const body = await encryptWebPushPayload(
    enc.encode(JSON.stringify(payload)),
    sub.keys.p256dh,
    sub.keys.auth,
  )
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(options.ttl ?? 3600),
      urgency: options.urgency ?? 'normal',
    },
    body: toArrayBuffer(body),
  })
  const gone = res.status === 404 || res.status === 410
  return {
    ok: res.ok,
    status: res.status,
    gone,
    error: res.ok ? undefined : `push ${res.status}`,
  }
}
