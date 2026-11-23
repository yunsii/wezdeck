# Remote access (phone / tablet → collab tickets)

Status: **live** (2026-11-22). A paired phone opens
`https://wezdeck.yuns.love/console/sessions` from anywhere: collab tickets, runs and
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
| `sessions` | read | live entries whose pane still exists, plus archived ones (`recent[]`, status `idle`) whose pane still runs an agent (`claude`/`codex`/`grok`/`grok.real`, or `python3` when the session is Grok under `grok-focus-filter.py` — otherwise archived Grok vanishes from 会话 until the next message); newest session id per pane; newest conversation first: the newest turn's own timestamp in the transcript (Claude `~/.claude/projects/*/<id>.jsonl` user / assistant lines, Codex `~/.codex/sessions/*/*/*/rollout-*-<id>.jsonl` any line; read from the file tail, cached by size — `remote_activity.go`), the file mtime only for Grok (`~/.grok/sessions/*/<id>/chat_history.jsonl` lines carry no timestamp); not the mtime for Claude, which touches idle transcripts (mtime only, same size) long after the last turn and kept floating idle sessions such as fe1 to the top; status ts / tmux `window_activity` only when no transcript is found. Each card also carries tree fields for the phone list: `repo` / `repo_root` / `worktree` (git family + this checkout; soft-fail without git) and optional tmux mount `tmux_session` / `tmux_pane` / `pane_index` / `pane_role` (`primary` when index≤1, else `secondary`) so the UI groups by path and ticket agents can join the same tree later; `visited` is when you last visited that worktree at the desk (ms, from `access-ledger.json` — the `Alt+g` / `Alt+x` visit clock, `WEZDECK_ACCESS_LEDGER` overrides; `session_visits.go`): the phone orders its list by it, not by the card order; `title` is the agent display name when known (Claude last `ai-title` / Grok `summary.json` `generated_title`, including after TUI `/rename`). A message sent while Claude is mid-turn is stored as an `attachment` (`queued_command`, `origin.kind=human`) and shown as a user line; task notifications and auto-continuations are not. A subagent's hand-back (since Claude Code's hand-back protocol the Agent `tool_result` is only a pointer) shows as that Agent call's result: `toolUseResult.handbackReport.text` for a foreground agent, the `peer` queued_command body (matched by `origin.from` = the call's `agentId`) for a background one (`agent_claude.go`). Tool calls carry `pending` until their result arrives. The `session` reply also carries `reference` (`remote_reference.go`): a block for another agent — `[wezdeck 会话] <title>（<agent>）`, `session_id`, `transcript` path, `cwd` (+ branch), `tmux: -S <socket> -t <pane>（会话 …）` — which the phone's 复制引用 copies so an agent can read the conversation or drive the pane |
| `session {id, limit}` | read | the transcript (Claude, Grok or Codex format, same locations) parsed **incrementally** (only bytes appended since the last read; cached per file) into user / assistant text and tool calls with details — edits (any tool whose input has old/new strings) as a `-`/`+` diff, whole-file writes as a preview, commands in full (judged by input shape, so the three agents' tools count alike), plus each call's result matched by `tool_use_id` (clipped); returns the last `limit` (default 60) with `total` and `start` for paging; Claude context compaction (`type:system`, `subtype:compact_boundary`) becomes a `role:system`, `kind:compact` marker (`text` = `auto`/`manual`, `body` = the summary the agent continues from — the `isCompactSummary` user line is never shown as something the human typed), and for Claude the reply also carries `subagents` (`agent_subagents.go`: each Agent-tool / forked-skill subagent from `<session>/subagents/agent-<id>.meta.json` + `.jsonl` — name or description, type, background, `running` / `done` / `stale` after 30 min of silence, tool-call count, latest tool, start and last-activity time; running first, finished kept 2 h, at most 8), which the session page shows above the composer (`session-subagents.tsx`); the reply adds `compacted_at` (index of the latest marker) and `compactions`: the phone draws a divider, pages 加载更早 back to the marker and goes further only on 查看压缩前的记录 (pre-compaction history stays in the file but is no longer the agent's context); 会话信息 shows 本页已加载 N / M and the compaction count; and `usage` (model, context = last reply's full input vs the model's `max_input_tokens` from `~/.claude/cache/model-catalog`, turns, output, cache-read share; one reply spanning several lines counts once); also the last 60 screen lines (`capture-pane`). For Grok, when `updates.jsonl` has an unanswered `ask_user_question`, also `elicitation.questions[]` (label/description) so the phone can render tappable options instead of guessing 1/2/3; optional `plan.excerpt` from sibling `plan.md`, and `plan.awaiting_approval` when `exit_plan_mode` is open so the phone can send TUI keys `a`/`s`/`q` |
| `send {id,text,attachments}` | write | paste into the session's own TUI (`load-buffer` + `paste-buffer -p`, then Enter); `attachments` are uploaded file names, appended as a `[手机附件]` block of host paths |
| `upload {upload,seq,total,mime,data}` | write | one base64 chunk (≤ 64 KB decoded) of a phone attachment; the last chunk stores the file and answers its `name` |
| `key {id,key}` | write | one key from `1 2 3 4 Enter Escape Up Down Tab C-c a s q y` (permission / Ask digits, Ctrl+C interrupt, and Grok plan-review `a`/`s`/`q`/`y`) |
| `reply {id,text,continue}` | write | `ticket reply` with `TICKET_TRIGGER_SOURCE=mobile` |
| `attach {id}` | write | `ticket attach --id` (skills/agent-collab/lib/attach.py): the ticket's agent conversation opens in a new window of the target repo's tmux session through `agent-launcher.sh` with `WEZDECK_RESUME_SESSION_ID`, and an open ticket is session-claimed so headless runs stop writing to it — the phone's 接管到 tmux |
| `todos {session? \| all}` | read | the repo to-dos of the session's repo, or every open one (`scripts/runtime/todo.py list --json`) |
| `todo {op, session, text?, id?}` | write | `add` (to the session's repo, source `phone`) / `done` / `reopen` / `delete` a repo to-do |
| `repos` | read | repositories a phone may create a session in: main checkouts of visited worktrees (access ledger) and of running sessions, newest visit first (`session_new.go`) |
| `session.new {repo, type, subject, prompt}` | write | 新会话 — Ctrl+k g d/t/h: `open-task-window --no-attach --type dev\|task\|hotfix -- <subject>` in `repo` (must be one of `repos`; subject one line ≤ 60, message 1–8000), then the message is pasted into the new agent once its pane runs a non-shell and the screen holds still 1.5 s. Answers `{job}` at once — git fetch + agent start outlast an RPC. The message is required: a session is listed only from its first prompt's attention entry. `WEZDECK_SESSION_NEW_CMD` replaces open-task-window (test stack stand-in) |
| `session.new.job {job}` | read | that job: `stage` creating → starting → sending → done, or failed with `error`; `worktree`, `branch` (kept an hour) |
| `ticket.targets` | read | the ticket config's targets `[{key, path}]` (`$TICKETS_ROOT/config.yml`, the subset the CLI parses) |
| `ticket.new {from, to, title, observed, assumed, run}` | write | 新工单: `ticket create` between two configured targets (title one line ≤ 120; the assumption gate's observed / assumed 1–8000). `run` starts `ticket run --phase auto` in its own transient unit (`systemd-run --user --unit wezdeck-ticket-<id>`), so a relay restart does not kill it; `WEZDECK_TICKET_RUN_CMD` replaces that launch (`ticket_new.go`) |
| `clear {id}` | write | mark a session read — Ctrl+X in `Alt+/`: `attention-jump.sh --forget <id> --only-if-ts <ts>` archives the live entry into `recent[]` and nudges the counters; only a listed session, and only while its entry still has the ts just read (a fresh question is never swallowed). A relay with `WEZDECK_ATTENTION_FILE` clears there (`WEZDECK_ATTENTION_STATE_PATH`), never in the live state (`remote_clear.go`). The phone: swipe a running / waiting / done row left → 标为已读, or the button in 会话信息 |
| `device.register` | read-ish | records a phone's public key as pending |

Guards on every write (`remote_session.go`): one writer — a tmux-hosted
session only ever receives a paste into its own TUI, never a second process
resuming the same session id; free text anytime, also mid-turn, for every
hosted agent: Claude Code queues it and schedules it itself, Grok queues a
follow-up that runs after the turn (`[ui].follow_up_behavior`, default
`queue`; it holds while background tasks / subagents block the turn), Codex
(0.166) steers the active turn with it; background tasks
(`running_kind=background`) are listed from `bg.tasks` on the phone; never
while a confirmation is pending; nothing while there was input at the
desk in the last 10 s (`client_activity` of the attached tmux clients: keys,
mouse, focus; it was 30 s, which blocked the phone for half a minute after
merely answering a prompt at the desk) — the error says `retry in Ns` and the
phone counts down and resends by itself (up to 3 rounds); the
pane gets a 4 s `手机发来一条消息` notice.

### Local reads

A browser on the host itself reads sessions without pairing, the way it
already reads tickets: the loopback Runtime answers
`GET /api/v1/remote/<action>?args=<json object>` (health capability
`remote.read`; `RuntimeWebServer.Remote.cs`, fixed allowlist, args ≤ 4 KB)
through the WSL bridge `remote.<action>`, which runs the relay's own read set
(`readRPC` in `relay.go`): `sessions`, `session`, `upload.get`, `todos`,
`repos`, `ticket.targets`, `session.new.job`, `session.image`. The web's
`hostRead` tries this first and falls back to the remote link (`?remote=1`
forces the link). Writes and `device.register` never go this way — they need
an approved device's signature, so an unpaired host browser can read but not
write (「我的 › 连接」 says so).

### Attachments

Reporting a problem from the phone (the toolbar above the composer,
`session-composer.tsx`): add up to 5 images with 图片
(thumbnails sit in the same row; the toolbar shows only on an approved phone). Images are shrunk on the
phone (long edge ≤ 1600 px, JPEG 0.82, `lib/upload.ts`); every file goes up
as signed `upload` chunks of 36 KB (small enough for one DataChannel
message), then `send` names the stored files and the host appends

```
[手机附件]
- 图片: ~/.local/state/wezdeck/remote-uploads/img-<ts>-<id>.jpg
```

so the agent can open them. Host side (`remote_upload.go`): types limited to
JPEG / PNG / WebP / GIF / JSON and checked by magic bytes (JSON must parse),
8 MB per file, 6 attachments per message, `send` only resolves bare names
inside the uploads dir (`WEZDECK_REMOTE_UPLOADS` overrides it), half-done
uploads expire after 10 min, files older than 30 days are pruned on every
finished upload; one `event=upload` relay log row per stored file.

Viewing them (`features/image-viewer.tsx`): a composer thumbnail opens the
local pick full screen; in the conversation a `[手机附件]` image renders as a
thumbnail and opens the original. Both come back through the read action
`upload.get {name, thumb}` (`remote_upload_get.go`, bare `img-*` names inside
the uploads dir only): `thumb:true` answers one frame with a ≤360 px JPEG
(stdlib decode + box filter), otherwise `{mime, size, offset, data}` chunks
of 48 KB that the phone reassembles into a blob (`lib/upload-image.ts`,
cached per page). The viewer fits the screen, a tap toggles actual size
(scroll to pan), Esc / × / backdrop close, ← / → step through a message's
images; the blurred thumbnail stands in until the original arrives. A
thumbnail that fails while the link is still coming up retries with backoff;
Only the host's "no longer on the host" shows 已过期, other failures show 重试
(tap reloads). Images embedded base64 in a Claude transcript — pasted at the
desk (`[Image #1]` + image block) or returned by a tool (Read of a .png,
browser screenshots) — become refs on the message (`images`:
`<line byte offset>.<nth image in that line>`, `agent_claude.go`) and are
read with `session.image {id, ref, thumb, offset}` (`remote_image.go`),
which re-reads that one line and answers like `upload.get`; tool images load
only once the call is opened.

### Repo to-dos

A big change gets a follow-up note that belongs to the **repository**, not to
the conversation: a later session there (or another agent) picks it up after
the original one is gone. Stored in SQLite (`~/.local/state/wezdeck/wezdeck.db`,
table `todos`, `WEZDECK_TODO_DB` overrides) by `scripts/runtime/todo.py`,
keyed by the git common dir so every worktree of a repo shares one list.
Agents call it from the repo: `todo.py add [--session ID] -- TEXT`,
`todo.py list [--open|--all] [--json]`, `todo.py done|reopen|delete ID`. On the
phone, the session toolbar's 待办 panel lists the session repo's to-dos — add,
mark done, or put one into the composer to hand it to this agent — and the
会话 list shows every open one under 待跟进 at the bottom. The relay only maps a session to its
directory (`remote_todo.go`).

### Diagnostics on demand

No 诊断 button: the host pulls what it needs. `wezdeck-wsl diag [--wait 15]
[--reason TEXT] [--steps JSON | --steps-file F]` asks the running relay over
its control socket (`~/.local/state/wezdeck/relay.sock`, 0600;
`WEZDECK_RELAY_CONTROL` overrides) to push `{t:"diag.request"}` to every
phone seen in the last 3 min (DataChannel when open, else the DO by cid;
`relay_diag.go`). With `--steps` the phone first drives its own UI
(`lib/host-diag.ts`: `navigate` in-app paths, `back`, `click` by `text` or
`selector`, `scroll`, `wait`; never a control inside a form or under
`[data-write]` — send, reply, take over, keys, options, rename), recording
each step's frames (count, fps, longest gap, gaps > 50 ms). It answers with
the snapshot as `diag.submit` chunks — accepted only for a live request id —
stored as `diagnostics-<ts>-<id>-<phone>.json` in the uploads dir; the CLI
prints the paths. The phone shows a toast that the host read diagnostics;
relay log rows `diag_request` / `diag_received` / `diag_done`.

The snapshot (`lib/client-trace.ts`) holds build id, page path (no hash: it
can carry the pairing token), user agent, standalone mode, screen / viewport
/ `visualViewport` / safe-area sizes, the scroller, link mode / path / RTT,
history index / length, View Transitions support, the session page's state,
the host's step results, and the last 300 page events (viewport, focus,
`chat-pin`, visibility, link changes, errors, `nav` / `nav-collapse`,
`nav-frames` for every page change, `longtask` ≥ 80 ms where supported). No
tokens, no message text.

### Account limits

The session header shows the Claude account's 5-hour and 7-day limits the
way Claude Code's own status line does — from the same source, no
credentials or API calls: Claude Code pipes a JSON snapshot (with
`rate_limits.five_hour` / `seven_day`: `used_percentage`, `resets_at`, and
`context_window`) to its statusLine command on every refresh. The statusLine
script hands it on, in the background:

```bash
printf '%s' "$input" | bash "${WEZDECK_REPO:-$HOME/github/wezterm-config}/scripts/runtime/claude-statusline-tap.sh" >/dev/null 2>&1 &
```

`claude-statusline-tap.sh` writes `{session_id, ts, model, context_window,
rate_limits}` to `~/.local/state/wezdeck/claude-status/<session_id>.json`
(atomic, ids validated, 30-day prune; `WEZDECK_CLAUDE_STATUS_DIR`
overrides). `remote_limits.go`: limits are account-wide, so the newest
snapshot from any session answers (`account` in the `session` reply, Claude
sessions only, hidden when older than 7 days); a session's own
`context_window_size` replaces the model-catalog context limit (it knows
the 1M variants). Codex reports `rate_limits` in its `token_count` events
too, but through the gateway used here they are all null, so Codex shows
context only; Grok's transcript has no token counts.

### Agent adapters and the session contract

Everything that differs between agent CLIs stays on the host, behind one
interface (`native/wezdeck-wsl/agent_adapter.go`); the relay, the transport
and the web page only see the shared contract. Each agent is one file —
`agent_claude.go`, `agent_grok.go`, `agent_codex.go` — implementing:

| Method | Does |
|---|---|
| `Name()` | agent id the phone sees (`claude` / `grok` / `codex`) |
| `Locate(home, id)` | the session's transcript path, or `""` |
| `Feed(t, line)` | one transcript line → shared messages / usage |
| `Title(path)` | agent-generated or `/rename`'d title |
| `ToolKind(name, input)` | the shared kind of a tool call (below) |
| `Capabilities()` | which agent-specific features the phone may offer |

A new agent is one more file plus an entry in `agentAdapters`.

**Contract** (the `session` reply; `v: 1`). Messages: `role` (`user` /
`assistant` / `tool`), `text`, `ts`; tool calls add `tool` (the agent's own
name, for display), **`kind`**, `body`, `result`, `file` / `added` /
`removed` (counted from the input's shape) and `pending`. Session: `usage`
(context, limit, output, cache), `account` (Claude limits), `elicitation`
(Ask questions) and the plan-review flag, `reference`, and
**`capabilities`**, and `meta` (`remote_meta.go`: everything the host
knows, grouped `session` / `location` / `transcript` / `state` as
`{name, rows: [{key, value}]}`, empty values left out — the phone's
会话信息 sheet):

| Field | Meaning | claude / grok / codex |
|---|---|---|
| `ask_options` | structured questions with tappable options | – / ✓ / – |
| `plan_review` | a plan waiting for approve / revise / exit | – / ✓ / – |
| `usage` | where context / spend comes from | `transcript` / `none` / `token_count` |
| `account_limits` | 5 h / 7 d limits from the status line | ✓ / – / – |
| `mid_turn_input` | what a message sent mid-turn does | `queue` / `queue` / `steer` |
| `title` | the agent names sessions, honours `/rename` | ✓ / ✓ / – |

Tool `kind`: `command`, `read`, `edit`, `write`, `search`, `task`, `todo`,
`web`, `ask`, `other` — from each adapter's name table, falling back to the
input's shape (edit pairs → edit, whole content → write, a command →
command, a file path → read), so an unknown tool still lands sensibly. The
phone's run digest (files changed, commands run, files read) counts kinds,
not names — Grok's `run_terminal_command` / `search_replace` / `read_file`
used to fall through a Claude-name filter and showed only a call count.

Versioning: changes are additive (new fields, new kind or capability
values); pages ignore what they do not know and fall back when a field is
missing (the digest maps Claude names when `kind` is absent). A change of
meaning bumps `v`. Writes are still per-agent keys today; the next step is
intents (`answer`, `approve`, `interrupt`) that each adapter turns into its
agent's keys, so the page never encodes an agent's key sequence.

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

Hardening (2026-11-23 review): the device store is read-modify-written by
both the relay (register) and `install-remote-relay.sh` (approve / revoke)
under one `flock` on `remote-devices.json.lock`, and the relay writes it
atomically (tmp + rename), so a revoke cannot be undone by a racing register;
device names drop control characters (stored and printed) so `--devices`
cannot be spoofed with escape sequences. A pairing-token rotation also sends
the host `bye` for every evicted cid, closing that client's WebRTC peer, not
only its DO socket. `diag.submit` accepts chunks only from the cids the
request was pushed to, once each. A `#pair=` link must look like a token
(`[A-Za-z0-9_-]{16,128}`) and needs a confirmation before it replaces a
different token on the device. Each paste uses its own tmux buffer, a resent
upload chunk counts toward the 8 MB limit, relay log `action=` values are
quoted, `session.image` serves only listed sessions, and `ticket attach`
rejects a recorded session id that is not `[A-Za-z0-9_-]{1,128}`.

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

## Cost and free tier

Everything runs on the Cloudflare **Workers Free** plan; nothing here can
produce a bill — over a limit, that kind of call fails until 00:00 UTC
(08:00 Beijing) and then works again. Checked against the official
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
in 2026-11:

| Resource | What uses it | Free limit / day |
|---|---|---|
| Worker requests | SSR pages, the relay handshake, `/relay/auth`, `/relay/health`, `/relay/usage` (static assets are free) | 100,000 |
| Durable Object requests | the `HostRelay` object: each WebSocket **upgrade** is 1, **incoming** WebSocket messages count **20:1**; outgoing messages and protocol pings are free | 100,000 |
| Durable Object duration | 128 MB × wall time while the object is active and cannot hibernate | 13,000 GB-s |

Why WebSocket stays cheap here: `HostRelay` uses the hibernation API
(`ctx.acceptWebSocket`), so between messages it is hibernation-eligible and
bills no duration even with phone and host connected all day; the host's
keepalive `ping` is answered by `setWebSocketAutoResponse` (no wake, no
time). What is billed is the incoming messages: every RPC is two (phone →
relay, host → relay) and the phone's RTT ping every 2 s is two more. The
busiest hour in the relay log (2026-11-22) had 810 WebSocket RPCs: ≈ 1,620
+ 3,600 ping messages ≈ 5,400 incoming / h ≈ 270 requests / h — a full day
at that rate is ≈ 6,500 of the 100,000 Durable Object requests. A direct
WebRTC DataChannel bypasses the relay and costs nothing. Free plan requires
SQLite-backed Durable Objects (`new_sqlite_classes` in `wrangler.jsonc`).

**Usage card** (我的 › 用量, `console-usage.tsx` → `/relay/usage`,
`relay/usage.ts`, adapted from forge's admin usage page): today's Worker
requests, Durable Object requests / duration and WebSocket messages in /
out against those limits, from the Cloudflare GraphQL Analytics API,
cached 5 minutes. Analytics count every message while billing counts
incoming ones 20:1, so the card computes the billable number itself:
`durableObjectsInvocationsAdaptiveGroups` grouped by `type` —
`hibernation` is one incoming WebSocket message delivered to the
hibernating relay (the periodic dataset's `inboundWebsocketMsgCount` stays
0 under hibernation), `http` is upgrades and presence fetches — billable =
http + ⌈hibernation ÷ 20⌉. `durableObjectsPeriodicGroups` (`activeTime` in
µs, `outboundWebsocketMsgCount`) cannot filter by script, so it is summed
over the `namespaceId`s the invocations reported; `workersInvocationsAdaptive`
filters by `scriptName`. Measured 2026-11-22 (UTC day, ≈ 13 h in): Worker
949 requests; relay 245 http + 30,505 messages ≈ 1,771 billable of 100,000;
active 16.5 s ≈ 2 GB-s of 13,000. The token lives in the account that owns
the Worker (`Yuns.xie@qq.com's Account`, where `wrangler whoami` points),
named `wezdeck usage (analytics read)`. It needs two Worker secrets — an
API token with only **Account › Account Analytics › Read** and the account
id:

```bash
cd web
npx wrangler secret put CF_ANALYTICS_TOKEN   # paste the read-only token
npx wrangler secret put CF_ACCOUNT_ID        # the account id (dashboard / wrangler whoami)
```

Without them the card says so and shows dashes; `/relay/usage` requires the
phone's client token (401 otherwise) and never wakes the relay object.

## Testing locally

`scripts/dev/remote-test-stack.sh start [--home DIR]` builds the web app,
serves the production build with the Worker + `HostRelay` on `:3018`
(`vite preview`) and starts a throwaway host relay whose attention file,
device approvals, uploads, Claude status snapshots and a private copy of the
ticket store (new tickets / replies write only the copy; a ticket run and a
new session's open-task-window are stand-ins) all live in a temp dir
(`--home` also points it at fixture transcripts); it prints the `export`
lines the cdp tests need (`WEZDECK_TEST_ATTENTION`, `WEZDECK_TEST_DEVICES`,
`WEZDECK_TEST_UPLOADS`). `stop` ends it; the systemd relay is never touched.
Hand-typed stacks twice forgot `WEZDECK_REMOTE_UPLOADS` and wrote test
uploads into the real uploads dir — use the script.

Versions are source fingerprints (`scripts/dev/source-fingerprint.sh DIR`:
the last commit touching it, `-dirty-<hash>` with uncommitted edits; web
tests excluded): the stack builds the web with it as the build id, and
`build.sh` stamps it into the relay, which logs `event=connected
version=…`. Before any cdp test, `web/tests/version.setup.ts` compares the
served `/build.json` and the test relay's version with the working tree and
stops with "restart the stack" on a mismatch — a stale stack once passed for
a real bug (`WEZDECK_SKIP_VERSION_CHECK=1` to probe an old build on purpose).

## Operate

```bash
scripts/dev/install-remote-relay.sh               # tokens (once) + build + user unit wezdeck-relay.service
scripts/dev/install-remote-relay.sh --push-secrets  # after creating / rotating tokens
scripts/dev/install-remote-relay.sh --pair        # pairing link + QR for the phone
scripts/dev/install-remote-relay.sh --check       # unit state + /relay/health presence
scripts/dev/wezdeck-release.sh                    # ship a committed round (below)
```

`wezdeck-release.sh` runs push, relay and web **in parallel** (logs under
`~/.local/state/wezdeck/release/<stamp>/`, one summary row per run in
`release.log`). A part whose running version already equals its fingerprint
is skipped — a web-only round does not restart the relay and drop phone
links; `--only push|relay|web`, `--force`. It refuses uncommitted tracked
changes. `--commit MSGFILE` commits the staged changes first and fixes what
the pre-commit gate would only report — prettier on the staged web files,
`lingui extract` for the catalogs — so one command goes from staged to
live; lint / type errors still stop it before anything ships. A deploy that succeeds is done; the version check belongs before
the tests, not after the deploy.

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
