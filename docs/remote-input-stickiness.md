# Remote Control + Host Input Stickiness

Operator notes from the **2026-10 → 2026-11-21** investigation on host
`nut`: driving this Windows PC from a Pad / phone remote-control client, long
Windows uptime, the home router, and “CPU looks fine but typing/mouse feel
sticky”. The same symptom (“typing over the remote lags, then is fine
again”) has had **different causes at different times** — triage by layer,
do not carry the last incident's conclusion forward.

Remote-control clients are **not** part of WezDeck core. Each one is an
external plugin that contributes a remote-link badge and a report CLI; the
one in use on this host is **`wezdeck-plugin-oppo-remote`** (OPPO 互联 /
O+ Connect — `OppoRemote·` badge, sampler, signal meanings, OPPO / WARP
topology notes in its own `docs/oppo.md`). Install / enable:
[`plugin-architecture.md#operating`](./plugin-architecture.md#operating).

Related: [`guest-oom.md#guest-vs-host-memory-meters`](./guest-oom.md#guest-vs-host-memory-meters)
(`VmmemWSL` / `wsl-host-mem.sh`),
[`diagnostics.md`](./diagnostics.md) (WezTerm `latency` proxies — not HID
latency), open-questions §21 (RDP lid-close vs remote-client confounder).

## Triage first (do not merge causes)

Read the layers in this order; each has its own glanceable signal.

| # | Check | Signal | If bad → |
|---|---|---|---|
| 1 | Is the remote **link** stalling? | the remote plugin's badge red (e.g. `OppoRemote·4.4s` / `·76%`) or its `report` CLI | go to 2 |
| 2 | Does the **office side** move with the stall? | plugin `episodes` blame `office` (relay / gateway ping degrades with it) | PC uplink / office LAN / VPN (WARP) |
| 3 | Office flat, link stalling | blame `beyond-office` | **client side**: home router → client Wi‑Fi → home ISP ([Home router](#home-router-long-uptime)) |
| 4 | Remote badge healthy but typing still sticky | console (Notepad on the PC) also sticky? `Memory·` / `LoadAvg·` | **host** stickiness ([Long uptime](#long-uptime--host-memory-local-input)) |
| — | Whole desktop “new login / PIN” mid-work | — | RDP auto-reconnect — [`diagnostics.md#open-questions`](./diagnostics.md#open-questions) §21 |

A remote-link badge only proves the stream backed up; it cannot see inside
the PC (input injection, compositor). `Memory·` / `LoadAvg·` cannot see the
network. Use both before concluding.

### Incident history

| When | Cause (confirmed by) | Signal that would have shown it | Fix |
|---|---|---|---|
| 2026-10-15 → 11-10 | **Host**: ~26 d Windows uptime, `VmmemWSL` Private ~42 GiB, console also sticky (reboot → RAM 16 → 41 GiB free, smooth same day) | `Memory·`, console test | Windows reboot |
| 2026-11-14 → 11-21 | **Home router** long uptime: stalls on the direct P2P path, office gateway 0.3 ms / relay 12.6 ms flat (`beyond-office`), PC rebooted 8 h earlier (host ruled out); router reboot 09:5x → 44 min @ 78 % stalled before, 0 % after | `OppoRemote·` red + `episodes` blame `beyond-office` | Home router reboot |

Both were cross-net (Pad at home, PC at the office); cross-net alone is
**not** the cause — multi-hour 0 % sessions exist on the same topology.

## Long uptime / host memory (local input)

Not Windows-only: soft faults / reclaim pressure exist on Linux and macOS
too. This host’s loud shape is **Windows + WSL2 balloon + long GUI**:

- `autoMemoryReclaim=gradual` — guest `free` calm while Task Manager still
  shows a large `VmmemWSL` Private (see guest-oom meters).
- Transition Faults/sec high (often 5k–20k+) with modest average CPU —
  micro-stalls feel like input lag.
- Multi-week `wezterm-gui` (observed ~17 d, Priv ~1 GiB, continuous redraw)
  keeps the compositor busy.

**Mitigation order (least → most invasive):**

1. Restart WezTerm.
2. `wsl --shutdown` (returns host RAM; kills panes/agents).
3. Close fat Windows apps (Chrome / Feishu / O+ Connect windows).
4. Reboot Windows when uptime is many days and (1)–(3) are not enough.

Reboot is effective, not the only lever.

## Home router (long uptime)

Closed **2026-11-21**: the 11-14 → 11-21 stalls were the home router
(Xiaomi-style LAN `192.168.31.0/24`). Evidence chain:

1. Stall shape = stream backlog on the **direct P2P** path (in-flight up to
   2 MB, acked bytes ~KB), not relay↔P2P flapping.
2. Office path flat during the stall (`blame=beyond-office`), PC rebooted the
   same night → PC, office LAN and WARP ruled out.
3. Only the router changed (Pad got a new DHCP lease `.106` → `.99`, home WAN
   IP unchanged), and the next session went from 78 % to 0 % stalled.

Which router subsystem degraded is **not** known — a reboot clears all of
them at once: Wi‑Fi channel chosen at boot now crowded by neighbours,
conntrack / buffer build-up (bufferbloat — fits the “backlog then drains”
shape best), or a degraded wireless driver. To separate them next time:
when the remote-link badge turns red with `beyond-office`, first **switch the Wi‑Fi channel
only**; reboot only if that does not help. Note the router uptime at each
recurrence; if it degrades on a stable period, enable the router's scheduled
reboot.

The router is not reachable from the PC (office LAN; `miwifi.com` resolves to
Xiaomi's public site from outside). Use the Pad browser (`192.168.31.1`) or
the Mi WiFi / Mi Home app.

## What to capture for a “good” baseline

When remote feels good, record at least:

1. Subjective note + whether **console** input is also fine; the remote
   plugin's report for the day (OPPO:
   `wezdeck-plugin.sh run oppo-remote oppo-remote-quality report --days 1`).
2. PC IPv4 / prefix and the client's peer address as the remote plugin
   reports it (same LAN vs cross-net).
3. VPN state (`warp-cli status` on this host).
4. `scripts/dev/wsl-host-mem.sh` (`VmmemWSL` Private / host free).
5. Windows uptime (`LastBootUpTime`).
