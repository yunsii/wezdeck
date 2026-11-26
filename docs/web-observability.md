# Local Web observability

The host browser batches selected `client-trace` events to the loopback Runtime
(`POST /api/v1/web-events`, capability `web.events`). Only the production
console's allowed write origin can submit them; a remote-mode browser sends
none. The Runtime accepts at most 20 events / 64 KiB per batch, keeps only
allowlisted scalar fields (route pathname only; no message text, token,
query or hash), and rotates
`%LOCALAPPDATA%\wezterm-runtime\logs\web-client.log` at 1 MiB with three
older files. The browser queues at most 120 events while the Runtime is down;
`browser queue overflow` records the number lost after it reconnects.
Delivery is best effort: a page closed before its next flush can lose its tail,
and a retry after a partial disk write can duplicate a `page` + `seq` pair.

```bash
scripts/dev/web-events.sh                 # newest 200 local Web events
scripts/dev/web-events.sh '<session-id>'  # search current + rotated files
scripts/dev/web-events.sh '<op-id>'       # browser + relay write stages
```

`web-write` records requested / host-accepted / failed; `relay.log` records
the same `op_id` on the host write. `session-sync` marks a changed total,
status or replacement in the host snapshot; `chat-render` marks the reveal
cursor after the page painted. `session-follow` records an auto-navigation
from a replaced / redirected session id (`action` = from, `id` = to; with
`skipped=cycle` when the page refuses a hop that would bounce back).
`host-diag` / `host-reload` carry the host's `--reason` (why a snapshot,
reproduce steps, or page reload was requested). An accepted `send` means
tmux got the paste and Enter, not that the agent recorded it in the
transcript. Compare these stages with `wezdeck-wsl diag` when a message is
missing. The local diagnostics page also reads the current `web-client.log`
alongside the Windows and WSL logs.
