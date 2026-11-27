// Standalone Cloudflare Worker hosting the HostRelay Durable Object.
// Kept separate from the main `wezdeck` frontend Worker so routine web deploys
// never recycle HostRelay or drop live host/browser WebSocket connections.
export { HostRelay } from './host-relay'

export default {
  fetch() {
    return new Response('wezdeck-relay-do', { status: 200 })
  },
}
