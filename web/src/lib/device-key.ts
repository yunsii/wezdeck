// This phone's write key (docs/remote-access.md "Writes"): an ECDSA P-256
// pair generated in the browser. The private key is non-extractable and kept
// in IndexedDB, so it never leaves the device; the host only ever stores the
// public half (after `install-remote-relay.sh --approve <id>`). Every write
// is signed over its exact payload text and checked on the host.
import { createStore, get, set } from 'idb-keyval'

// Own database: idb-keyval only creates a store when it creates the database,
// and 'wezdeck' already exists for the query cache.
const store = () => createStore('wezdeck-device', 'key')

type Stored = { privateKey: CryptoKey; publicRaw: string; id: string }

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

async function deviceId(raw: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', raw)
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** The stored key, or undefined when this device never enabled writing. */
export async function loadDeviceKey(): Promise<Stored | undefined> {
  try {
    return await get<Stored>('key', store())
  } catch {
    return undefined
  }
}

export async function createDeviceKey(): Promise<Stored> {
  const existing = await loadDeviceKey()
  if (existing) return existing
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
  const stored = {
    privateKey: pair.privateKey,
    publicRaw: b64url(raw),
    id: await deviceId(raw),
  }
  await set('key', stored, store())
  return stored
}

/** Signature in WebCrypto's raw r‖s form (64 bytes), base64url. */
export async function signPayload(key: Stored, payload: string) {
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    new TextEncoder().encode(payload),
  )
  return b64url(sig)
}
