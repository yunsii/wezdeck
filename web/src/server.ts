// Cloudflare Worker entry: /relay/* goes to the HostRelay Durable Object
// (remote access, docs/remote-access.md); everything else is the TanStack
// Start SSR handler.
import handler from '@tanstack/react-start/server-entry'

import { localeRedirect } from './locale-redirect'
import { relayFetch } from './relay/relay-fetch'
import type { RelayFetchEnv } from './relay/relay-fetch'

export default {
  fetch(request: Request, env: RelayFetchEnv) {
    if (new URL(request.url).pathname.startsWith('/relay/')) {
      return relayFetch(request, env)
    }
    // the PWA starts at /console/sessions: honour the language last chosen
    const localized = request.method === 'GET' ? localeRedirect(request) : null
    if (localized)
      return new Response(null, {
        status: 302,
        headers: { location: localized, vary: 'cookie, accept-language' },
      })
    return handler.fetch(request)
  },
}
