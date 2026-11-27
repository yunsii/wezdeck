// Pairing token storage, URL hash adoption, forced-remote toggle, and relay
// room/base URL helpers shared by remote-link.ts.

const TOKEN_KEY = 'wezdeck.remote.token'
const INVITE_KEY = 'wezdeck.remote.invite'

export const NOT_PAIRED = 'this device is not paired'

function storage() {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** Token from a pairing link opened in this page; wins over (possibly stale or unwritable) storage. */
let pairedToken = ''
/** Single-use approval invite from `#pair=…&invite=…`; consumed by the host on first device.register. */
let pairedInvite = ''

export function readPairedToken() {
  if (pairedToken) return pairedToken
  try {
    return storage()?.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function readPairingInvite() {
  if (pairedInvite) return pairedInvite
  try {
    return storage()?.getItem(INVITE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function clearPairingInvite() {
  pairedInvite = ''
  try {
    storage()?.removeItem(INVITE_KEY)
  } catch {
    // ignore storage errors
  }
}

/**
 * Adopt a `#pair=` token (and optional `&invite=` single-use approval code);
 * true when a new pairing token was taken. Links come from anyone: replacing a
 * different token this device holds needs the person's OK, or one tapped link
 * silently swaps the pairing (unauthorized until re-paired).
 */
export function adoptPairingHash(): boolean {
  if (typeof location === 'undefined') return false
  const match = /[#&]pair=([^&]+)/.exec(location.hash)
  if (!match) return false
  const inviteMatch = /[#&]invite=([^&]+)/.exec(location.hash)
  // tokens are [A-Za-z0-9_-] (install-remote-relay.sh): anything else, or a
  // %-escape that would make decodeURIComponent throw, is not a pairing link
  const token = /^[A-Za-z0-9_-]{16,128}$/.test(match[1]) ? match[1] : ''
  const invite =
    inviteMatch && /^[A-Za-z0-9_-]{16,128}$/.test(inviteMatch[1])
      ? inviteMatch[1]
      : ''
  let current = ''
  try {
    current = storage()?.getItem(TOKEN_KEY) ?? ''
  } catch {
    current = ''
  }
  const replace =
    Boolean(token) &&
    (!current ||
      current === token ||
      window.confirm(
        document.documentElement.lang.startsWith('zh')
          ? '这个链接会替换这台设备现在的配对，确定吗？'
          : 'This link replaces the pairing on this device. Continue?',
      ))
  if (replace) {
    pairedToken = token
    try {
      storage()?.setItem(TOKEN_KEY, pairedToken)
    } catch {
      // Storage blocked (private mode / in-app browser): the token from the
      // link still applies to this page via pairedToken.
    }
    if (invite) {
      pairedInvite = invite
      try {
        storage()?.setItem(INVITE_KEY, invite)
      } catch {
        // Storage blocked: pairedInvite keeps it for this page.
      }
    } else if (token !== current) {
      clearPairingInvite()
    }
  }
  // keep the router's entry state (__TSR_index / key): null here made the
  // first entry look like it came from outside the app (useCanGoBack, the
  // tab-history rule and the transition direction all read it)
  history.replaceState(
    history.state as unknown,
    '',
    location.pathname + location.search,
  )
  return replace && token !== current
}

/**
 * `?remote=1` forces the remote link even where loopback works (acceptance on
 * the host). Remembered for the tab so in-app navigation keeps it.
 */
export function forcedRemote() {
  if (typeof location === 'undefined') return false
  try {
    if (new URLSearchParams(location.search).get('remote') === '1')
      sessionStorage.setItem('wezdeck.remote.forced', '1')
    return sessionStorage.getItem('wezdeck.remote.forced') === '1'
  } catch {
    return new URLSearchParams(location.search).get('remote') === '1'
  }
}

/** `?room=` (sticky per tab) selects a separate relay room — used by tests. */
function relayRoom() {
  if (typeof location === 'undefined') return ''
  try {
    const fromUrl = new URLSearchParams(location.search).get('room')
    if (fromUrl) sessionStorage.setItem('wezdeck.remote.room', fromUrl)
    return sessionStorage.getItem('wezdeck.remote.room') ?? ''
  } catch {
    return new URLSearchParams(location.search).get('room') ?? ''
  }
}

export const roomQuery = () =>
  relayRoom() ? `?room=${encodeURIComponent(relayRoom())}` : ''

export function relayBase() {
  const configured = import.meta.env.VITE_WEZDECK_RELAY_URL?.trim()
  if (configured) return configured.replace(/\/$/, '')
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
}

/** Check `/relay/auth` to distinguish a rejected pairing token (401) from a network outage. */
export async function checkTokenRefused(token: string) {
  try {
    const response = await fetch(
      `${relayBase().replace(/^ws/, 'http')}/relay/auth${roomQuery()}`,
      {
        headers: { authorization: `Bearer ${token}` },
        cache: 'no-store',
      },
    )
    return response.status === 401
  } catch {
    return false
  }
}
