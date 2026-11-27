// Standalone Cloudflare Worker hosting the HostRelay Durable Object.
// Kept separate from the main `wezdeck` frontend Worker so routine web deploys
// never recycle HostRelay or drop live host/browser WebSocket connections.
// Exported as `HostRelayDO` so `wezdeck`'s v2 `deleted_classes: ["HostRelay"]`
// migration does not collide with the cross-script `HOST_RELAY` binding
// (Cloudflare API error 10061 validates deleted_classes against class_name).
export { HostRelay as HostRelayDO } from './host-relay'

export default {
  fetch() {
    return new Response('wezdeck-relay-do', { status: 200 })
  },
}
