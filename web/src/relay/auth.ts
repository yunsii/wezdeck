// Token checks for the relay (host-relay.ts, usage.ts).

/** constant-time compare; never equal when either side is empty */
export function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * The host's `Authorization: Bearer <token>`. An unset secret refuses
 * everyone: comparing with `Bearer ${token}` let "Bearer undefined" in as
 * the host on a deploy without RELAY_HOST_TOKEN.
 */
export function hostAuthorized(header: string, token: string | undefined) {
  if (!token) return false
  const prefix = 'Bearer '
  return (
    header.startsWith(prefix) && safeEqual(header.slice(prefix.length), token)
  )
}
