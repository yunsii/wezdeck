# Remote access (phone / tablet → collab tickets)

Status: **MVP, read-only** (2026-11-21). A paired phone or tablet opens
`https://wezdeck.yuns.love/console/collab` from anywhere and sees the same
collab view as the host: ticket list, metrics, run detail, transcripts.
Writes (reply / close / re-run / new ticket) are the next step.

Agent coding from the phone is still OpenClaw ([`mobile-access.md`](./mobile-access.md));
this doc covers the structured ticket view.

## Shape

```mermaid
flowchart LR
  P[Phone browser] -- "HTTPS + WebSocket /relay/client" --> W[Worker wezdeck.yuns.love]
  W --> D[HostRelay Durable Object]
  H[wezdeck-wsl relay on the host] -- "outbound WebSocket /relay/host" --> W
  P -. "WebRTC DataChannel (preferred)" .-> H
  H --> T[ticket api → ~/.agent/tickets]
```

| Part | Code |
| --- | --- |
| Worker entry (`/relay/*` → DO, rest → TanStack Start SSR) | `web/src/server.ts`, `web/wrangler.jsonc` |
| HostRelay DO (forwarding, presence, auth) | `web/src/relay/host-relay.ts` |
| Browser link (WebRTC first, WebSocket fallback, latency) | `web/src/lib/remote-link.ts`, badge `web/src/features/remote-badge.tsx` |
| Collab reads choose loopback Runtime or the link | `getCollab` in `web/src/lib/runtime-client.ts` |
| Host side | `native/wezdeck-wsl/relay.go` (`wezdeck-wsl relay`) |
| Install / tokens / pairing | `scripts/dev/install-remote-relay.sh` |
| Acceptance | `web/tests/remote.cdp.test.ts` |

- The host only dials **out**; no port is opened and NAT does not matter.
- The DO only forwards frames. What can run is decided on the host by the same
  allowlist as the Runtime bridge (`collabFlags` in `collab.go`): read actions
  only, values regex-checked.
- On the host itself the page keeps using the loopback Runtime; the remote
  link starts only when loopback is unreachable (or with `?remote=1`).

## Transport order

1. The browser opens `wss://…/relay/client` (always kept: presence,
   signaling, fallback).
2. When the host is online it offers a WebRTC DataChannel (STUN
   `stun.cloudflare.com`, non-trickle: SDP carries all candidates, one
   round trip over the relay socket). pion on the host answers.
3. DataChannel open → requests and pings move to it; the relay carries
   nothing else. Not open within 15 s or ICE failed → stay on the WebSocket
   relay, retry WebRTC every 60 s.

Why direct often fails on a phone, and the mic button: mobile browsers hide
their LAN address behind mDNS (`xxxx.local`); the host cannot resolve it
(multicast replies do not reach WSL) and cannot be dialed first either — the
Hyper-V firewall blocks all inbound to WSL (`DefaultInboundAction: Block`),
and opening it on a work machine is not the trade we want. So while on the
relay after a failed attempt the badge offers **授权以局域网直连**: a
microphone grant makes the browser offer its real address (stream closed
immediately, nothing recorded — fe1's meeting-link trick), the host then dials
out and the stateful firewall lets the replies in. It only helps on the same
LAN; across networks direct needs hole punching or TURN.

`rtc_answer` log rows carry `offer_cands` / `answer_cands` (counts per
candidate type, `mdns=` for hidden host addresses) and `same_public=yes|no|unknown`
(both sides' STUN addresses equal or not; addresses are not logged). First
phone record: `host=4(mdns=4) srflx=2` → ICE failed after 30 s.

No TURN yet: when hole punching fails (common on carrier CGNAT) the
WebSocket relay is the fallback. `?transport=websocket` forces it.

## Badge

The collab header shows the link when the page is remote:

| Badge | Meaning |
| --- | --- |
| `WebRTC 直连 · 局域网 · N ms` | DataChannel, host-side address private |
| `WebRTC 直连 · 公网 · N ms` | DataChannel through NAT / public IPv6 |
| `WebSocket 中转 · N ms` | via the Durable Object |
| `主机离线` | host socket not connected (DO presence) |
| `令牌无效，请重新配对` | handshake refused (checked via `/relay/auth`) or evicted with close 4401 after a token rotation; no retry loop |

N = median of the last 5 round trips (ping every 2 s, end-to-end to the host
process). Hover shows the last WebRTC failure. Data attributes
(`data-mode`, `data-path-detail`, `data-rpc-webrtc`, `data-rpc-websocket`)
are what the acceptance test reads.

Measured 2026-11-21 (same home LAN, production):

| Client | WebRTC | WebSocket relay |
| --- | --- | --- |
| Windows Chrome → WSL host | LAN, `host↔host 192.168.3.55`, 1 ms | 85 ms |
| WSL headless Chromium | public IPv6 host candidate, 1 ms | 91 ms |

## Protocol

JSON text frames with `t`:

| Direction | Frames |
| --- | --- |
| browser → DO | `rpc {id, action, args}` · `sig {data: offer}` · `ping {id}` |
| DO → host | same plus `cid` (one per browser socket) · `bye {cid}` |
| host → DO | `res {cid, id, ok, result\|error}` · `sig {cid, data: answer}` · `pong {cid, id}` · `hello` |
| DO → browser | `host {online, since}` · host frames without `cid` |
| DataChannel | `rpc`/`res`, `ping`/`pong` without `cid` |

Host keepalive is the literal text `ping`, answered by
`setWebSocketAutoResponse` without waking the DO. Both sockets use the
hibernation API, so an idle link costs no DO duration; usage stays far
inside the Workers Free allowance.

## Auth (MVP)

Two random tokens in `~/.config/shell-env.d/wezdeck-remote.env` (0600),
mirrored as Worker secrets `RELAY_HOST_TOKEN` / `RELAY_CLIENT_TOKEN`:

- host: `Authorization: Bearer` on `/relay/host`;
- browser: subprotocols `wezdeck.v1, token.<secret>` (browsers cannot set
  WebSocket headers); stored per device in `localStorage` from a
  `#pair=<token>` link (the fragment never reaches the server).

Rotation (`rm` the env file, rerun install + `--push-secrets`) evicts open
browser sockets: each carries a SHA-256 tag of its token, checked by the DO on
every message and on every new connection (the host reconnects with the new
token right away).

Cloudflare Access in front of `/console` + `/relay/client` and pinned DTLS
fingerprints are follow-ups ([open questions](./diagnostics.md#open-questions)).

## Operate

```bash
scripts/dev/install-remote-relay.sh               # tokens (once) + build + user unit wezdeck-relay.service
scripts/dev/install-remote-relay.sh --push-secrets  # after creating / rotating tokens
scripts/dev/install-remote-relay.sh --pair        # pairing link + QR for the phone
scripts/dev/install-remote-relay.sh --check       # unit state + /relay/health presence
cd web && corepack pnpm run deploy                # vite build + wrangler deploy
```

Logs: `category=relay` rows (`connected` / `disconnected` / `rtc_state` /
`rtc_answer` / `rpc via=webrtc|websocket ms err`) in
`journalctl --user -u wezdeck-relay` and `relay.log` beside
`wsl-bridge.log`; Worker logs via Cloudflare observability.

Acceptance (local: `vite dev` with `.dev.vars` + a relay pointed at it;
production: the deployed site):

```bash
WEZDECK_REMOTE_URL=https://wezdeck.yuns.love WEZDECK_REMOTE_TOKEN=<client token> \
  corepack pnpm exec vitest run --config vitest.cdp.config.ts tests/remote.cdp.test.ts
```
