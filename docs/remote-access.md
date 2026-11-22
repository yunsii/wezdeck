# Remote access (phone / tablet → collab tickets)

Status: **live** (2026-11-22). A paired phone opens
`https://wezdeck.yuns.love/console/now` from anywhere: collab tickets, runs and
transcripts, every live agent session on the host (read its conversation,
send it a message, answer its confirmation dialog), and replies to tickets
waiting on you. Writes need a device key the host approved once.

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
LAN; across networks direct needs hole punching or TURN. The host's answer
carries `samePublic`, so the button is hidden when the phone is on another
network and the badge tooltip says hole punching failed.

`rtc_answer` log rows carry `offer_cands` / `answer_cands` (counts per
candidate type, `mdns=` for hidden host addresses) and `same_public=yes|no|unknown`
(both sides' STUN addresses equal or not; addresses are not logged). First
phone records: `host=4(mdns=4) srflx=2 same_public=no` → ICE failed after
30 s every time (phone and the office host on different networks; the office
side / VPN blocks UDP hole punching). Steady state there is the WebSocket
relay unless TURN is added.

No TURN yet: when hole punching fails (common on carrier CGNAT) the
WebSocket relay is the fallback. `?transport=websocket` forces it.

## Sessions

Source: the agent-attention state (`attention.json`, keyed by session id with
tmux socket / session / pane, status `running|waiting|done` and
`waiting_kind`), the only place that already knows every hooked agent
(Claude, codex, grok) and its pane. `wezdeck-wsl relay` answers:

| Action | Kind | What it does |
| --- | --- | --- |
| `sessions` | read | live entries whose pane still exists, plus archived ones (`recent[]`, status `idle`) whose pane still runs `claude`/`codex`/`grok` (newest session id per pane); newest conversation first: the session's transcript mtime (Claude `~/.claude/projects/*/<id>.jsonl`, Grok `~/.grok/sessions/*/<id>/chat_history.jsonl`, Codex `~/.codex/sessions/*/*/*/rollout-*-<id>.jsonl`; only real turns write them), status ts / tmux `window_activity` only when none is found |
| `session {id, limit}` | read | the transcript (Claude, Grok or Codex format, same locations) parsed **incrementally** (only bytes appended since the last read; cached per file) into user / assistant text and tool calls with details — edits (any tool whose input has old/new strings) as a `-`/`+` diff, whole-file writes as a preview, commands in full (judged by input shape, so the three agents' tools count alike), plus each call's result matched by `tool_use_id` (clipped); returns the last `limit` (default 60) with `total` and `start` for paging, and `usage` (model, context = last reply's full input vs the model's `max_input_tokens` from `~/.claude/cache/model-catalog`, turns, output, cache-read share; one reply spanning several lines counts once); also the last 60 screen lines (`capture-pane`) |
| `send {id,text}` | write | paste into the session's own TUI (`load-buffer` + `paste-buffer -p`, then Enter) |
| `key {id,key}` | write | one key from `1 2 3 4 Enter Escape Up Down Tab` (permission / choice dialogs) |
| `reply {id,text,continue}` | write | `ticket reply` with `TICKET_TRIGGER_SOURCE=mobile` |
| `device.register` | read-ish | records a phone's public key as pending |

Guards on every write (`remote_session.go`): one writer — a tmux-hosted
session only ever receives a paste into its own TUI, never a second process
resuming the same session id; free text anytime, also mid-turn, for every
hosted agent: Claude Code queues it and schedules it itself, Grok queues a
follow-up that runs after the turn (`[ui].follow_up_behavior`, default
`queue`; it holds while background tasks / subagents block the turn), Codex
(0.166) steers the active turn with it; background tasks
(`running_kind=background`) are listed from `bg.tasks` on the phone; never
while a confirmation is pending; nothing while someone typed at the
desk in the last 30 s (`client_activity` of the attached tmux clients); the
pane gets a 4 s `手机发来一条消息` notice.

## Writes: device keys

The phone creates an ECDSA P-256 key in the browser (non-extractable,
IndexedDB `wezdeck-device`) and registers its public half; the host approves
it once:

```bash
scripts/dev/install-remote-relay.sh --devices          # pending / approved
scripts/dev/install-remote-relay.sh --approve <id>     # id = sha256(pub)[:8] hex, shown on the phone
scripts/dev/install-remote-relay.sh --revoke <id>
```

Each write carries `{device, payload, sig}`: the host verifies the signature
over the exact payload text, then uses only the signed `action` / `args`,
rejects a clock skew over 2 min and any reused nonce. Store:
`~/.config/wezdeck/remote-devices.json` (0600). Cloudflare (or anyone holding
the pairing token) can read but cannot forge a write. Logs: `event=write` /
`event=write_denied` rows with device id.

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

Writes add device signatures (above). Cloudflare Access in front of
`/console` + `/relay/client` and pinned DTLS fingerprints remain follow-ups
([open questions](./diagnostics.md#open-questions)); Access is not enabled on
the account yet.

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

Relay rooms: `/relay/host?room=<name>` and a page opened with `?room=<name>`
(sticky per tab) share their own Durable Object, so a throwaway test host
never displaces the real one — never stop `wezdeck-relay` to test.

Acceptance (local: `vite dev` with `.dev.vars` + a relay pointed at it;
production: the deployed site, test relay in `room=test`):

```bash
WEZDECK_REMOTE_URL=https://wezdeck.yuns.love WEZDECK_REMOTE_TOKEN=<client token> \
  corepack pnpm exec vitest run --config vitest.cdp.config.ts tests/remote.cdp.test.ts
```
