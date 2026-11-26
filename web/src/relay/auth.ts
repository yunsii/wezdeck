// Token checks for the relay (host-relay.ts, usage.ts).

/** constant-time compare; never equal when either side is empty */
export function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Extract `<token>` from `Authorization: Bearer <token>`, else empty string. */
export function bearerToken(header: string | null | undefined) {
  if (!header) return ''
  const prefix = 'Bearer '
  return header.startsWith(prefix) ? header.slice(prefix.length) : ''
}

/**
 * The host's `Authorization: Bearer <token>`. An unset secret refuses
 * everyone: comparing with `Bearer ${token}` let "Bearer undefined" in as
 * the host on a deploy without RELAY_HOST_TOKEN.
 */
export function hostAuthorized(header: string, token: string | undefined) {
  if (!token) return false
  return safeEqual(bearerToken(header), token)
}

/** Short digest of a token, kept on each client socket so a rotated secret can evict it. */
export async function tokenTag(token: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  )
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** What a refused token was, without logging it: digest + length (stale vs truncated). */
export async function tokenFacts(token: string) {
  return { tag: token ? await tokenTag(token) : '', len: token.length }
}

export function logRelayEvent(
  event: string,
  fields: Record<string, unknown> = {},
) {
  console.log(JSON.stringify({ category: 'relay', event, ...fields }))
}
