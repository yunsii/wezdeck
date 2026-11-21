// Cloudflare Worker entry: /relay/* goes to the HostRelay Durable Object
// (remote access, docs/remote-access.md); everything else is the TanStack
// Start SSR handler.
import handler from '@tanstack/react-start/server-entry'

import { relayFetch } from './relay/host-relay'
import type { RelayEnv } from './relay/host-relay'

export { HostRelay } from './relay/host-relay'

export default {
  fetch(request: Request, env: RelayEnv) {
    if (new URL(request.url).pathname.startsWith('/relay/')) {
      return relayFetch(request, env)
    }
    return handler.fetch(request)
  },
}
