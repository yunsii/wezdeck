# OPPO 互联 remote link (contrib plugin `oppo-remote`)

OPPO 互联 (O+ Connect) remote-control link quality for WezDeck: the
`OppoRemote·` right-status badge, the `wezterm-oppo-remote.service`
sampler, and the `oppo-remote-quality.sh` report / timeline / watch /
episodes CLI — all reconstructed from O+ Connect's own host logs.

This is an **optional contrib plugin** (`contrib/plugins/oppo-remote/` in the
WezDeck repo): not part of core, off unless a machine enables it. Layer-by-layer
triage (remote link → office side → home router / Pad Wi‑Fi → host), the
incident history and the host-memory / home-router lessons live in core:
[`docs/remote-input-stickiness.md`](../../../../docs/remote-input-stickiness.md).

## Install

```bash
scripts/dev/wezdeck-plugin.sh enable oppo-remote --sync   # registry + WezTerm badge
scripts/dev/wezdeck-plugin.sh install oppo-remote         # systemd sampler
scripts/dev/wezdeck-plugin.sh run oppo-remote oppo-remote-quality report
```

Core dependency (kept narrow so the plugin can move to a `wezdeck-plugins`
collection unchanged): `WEZDECK_REPO` (path helpers in
`scripts/runtime/windows-runtime-paths-lib.sh`, only at install time and when
the CLI resolves default paths) and the badge SDK `require 'wezdeck.badge'`.

## Baseline capture (OPPO specifics)

Alongside the generic baseline in core, record the latest sdk
`receive P2P request` peer `local` + public, `warp-cli status`, and optionally
ping the peer LAN IP and the relay (`47.112.110.179`). Company good baseline
sketch: peer `192.168.0.98`, same public IP as PC, WARP Connected, gateway
ping &lt;1 ms, relay ICMP ~8 ms, P2P `r≈10` / `c≈18–20`.

## Same-LAN vs cross-net (OPPO Pad)

Login/signaling is always cloud (`PHSRC://oppotest.xrk.host:4118` /
`:3443` → e.g. `47.112.110.179`). Media tries **P2P hole-punch** afterward.
Read peer topology from:

`%APPDATA%\O+Connect\devicespace\rc-daemon-sdk*.log`

```text
receive P2P request (public <peer-wan>:… local <peer-lan>:…), delay r:…/c:…
```

| Scenario | Peer `local` | Public IPs | Feel (typical) |
|---|---|---|---|
| Company Wi‑Fi baseline **2026-11-10 09:33** (good) | `192.168.0.98` | same as PC (`113.88.77.106`) | Same `/22` as PC `192.168.3.55/22` → snappy |
| Home / pad on IoT Wi‑Fi | `192.168.31.x` | **different** WAN than PC | Cross-NAT punch; can still be OK if host is healthy |

PC prefix `/22` covers `192.168.0.0`–`192.168.3.255` only — **`192.168.31.x`
is cross-net**.

`delay r:/c:` is **hole-punch probe RTT**, not keypress→pixels latency.
For the actual per-session link quality use the
[Link quality probe](#link-quality-probe).

## Cloudflare One Client (WARP) and OPPO

On this host the tray “One Client” **is** `CloudflareWARP` /
`warp-cli` (org `pollodev`). Observed profile: `WarpWithDnsOverHttps` +
Split Tunnel **Include** (includes full `172.31.0.0/16`, `172.16.0.0/16`,
`10.100.0.0/16`, …). DNS on the Ethernet NIC becomes `127.0.2.2` /
`127.0.2.3` while connected.

| Observation | Note |
|---|---|
| OPPO already connected, then enable WARP | Session usually **stays up** |
| WARP already on, then start OPPO | Sometimes fails to establish; **not 100%** — after reboot / same-LAN, connect-with-WARP-on succeeded (2026-11-10) |
| Include `172.31.0.0/16` vs Oppo Wintun | Community Oppo TUN conflicts often use `172.31.192.0/18`; treat as a **hypothesis** for infra split-tunnel audit, not a proven sole cause |
| `DisconnectedReason.settingsChanged` | Device profile refresh (seen around 2026-10-23/24) |

Ops tip when establishment is flaky: **connect OPPO first, then WARP**.
Do not treat WARP-on as “must be laggy” when the host was just rebooted and
topology is healthy.

Infra can verify mis-routed private traffic in Zero Trust **Gateway
Network/DNS logs** by Device ID during a failed OPPO connect window (traffic
that never enters the tunnel will not appear).

## Link quality probe

`desktop_agent.*.log` (one file per remote session, ~1 week kept) logs the
encoder's congestion controller. That is enough to reconstruct **when the
link stalled and how far behind the Pad's picture was**, after the fact:

```bash
bin/oppo-remote-quality.sh report            # one row per session, last 7d
bin/oppo-remote-quality.sh timeline          # newest session, per minute
bin/oppo-remote-quality.sh timeline 20261121-0859 --bucket 10
bin/oppo-remote-quality.sh watch --keys      # live STALL / OK lines while you work
```

Signal (field meanings inferred from behaviour, not vendor docs):

```text
[EncoderQualityCalc] limit=0(isdrop=1, 0.78), bandwidth=…(recv=1319,1485657), …, diff=34(0,113), 11027, …, drop=11, send=10
                                   ^quality            ^acked  ^in-flight bytes            ^queue delay ms
[CSingleDesktop] Too few frames sent, drop 7, send 7, fps 40
```

| Healthy | Stalled |
|---|---|
| in-flight ≈ 0, queue delay ≈ 35–200 ms | in-flight 0.5–1.7 MB, queue delay 2–11 s, acked bytes collapse to ~KB |
| `Too few frames` with `drop 0` (static screen — not a symptom) | `Too few frames` with `drop > 0`; encoder raises crf / lowers bitrate |

A *stall second* = queue delay ≥1 s, `isdrop=1`, or `Too few frames` with
`drop > 0`; runs within 5 s merge into one episode. `keys@stall` counts key
presses that landed inside an episode (the "typing lags" feel).
Topology (`same-LAN` / `same-WAN` / `cross-net`) joins the session window
against `rc-daemon-sdk*.log` (own `receive public ip` vs peer `receive P2P
request`). Verdict: `BAD` = stall ≥20 % of the session or worst lag ≥5 s;
`rough` = any episode.

Reading it: a stall with large in-flight bytes is the **network path**
(Pad Wi‑Fi / home uplink / ISP route) not draining. Host CPU/memory
stickiness shows up instead as sluggish **console** input with in-flight ≈ 0
(see WezDeck `docs/remote-input-stickiness.md#triage-first-do-not-merge-causes`).

Baseline (2026-11-14 → 11-21, 26 sessions, all **cross-net**: Pad
`192.168.31.x` at home behind a changing WAN, PC `192.168.3.55` at the
office): long smooth sessions exist (10 h / 4 h at 0 % stall), while BAD
ones cluster in short reconnect bursts (11-15 08:4x, 11-17 22:50–23:45,
11-21 08:5x) with 3–11 s worst lag and 40–60 % stall. Root cause for that
stretch: the home router — see WezDeck `docs/remote-input-stickiness.md#incident-history`.

## OppoRemote badge

Live view of the same signal on the WezTerm right status, plus a per-stall
history that says **which side** was at fault.

```bash
bin/install.sh            # systemd user unit wezterm-oppo-remote.service
bin/install.sh --check    # unit state + status.json
bin/oppo-remote-quality.sh episodes         # recorded stalls + blame
```

| Badge | Meaning |
|---|---|
| (absent) | no active O+ Connect session |
| `OppoRemote·OK` (muted) | connected, <10 % of the last 5 min stalled |
| `OppoRemote·23%` (amber) | not stalled now, but 23 % of the last 5 min was |
| `OppoRemote·4.4s` / `OppoRemote·76%` (red) | stalled now — picture ~4.4 s behind, or (no delay reading) 76 % of the last 5 min stalled |
| `OppoRemote·?` | session active but the producer went stale (>20 s) |

Producer: `oppo-remote-quality.sh daemon` tails the newest
`desktop_agent.*.log` (session = no `SLUninitialize` yet and written within
2 min), writes `state/oppo-remote/status.json` every 2 s while active / 10 s
idle, and reads the Pad model from `*_main.log` (`deviceName`). While a stall
is open it pings the office gateway and the OPPO relay (`Server [ip:4118]`
from the sdk log) every tick, plus a 30 s baseline while healthy, and on close
appends one row to `state/oppo-remote/episodes.ndjson`:

- `blame=office` — relay ping loss ≥20 % or max > 3× / +40 ms over baseline
  during the stall: own uplink/LAN is part of it.
- `blame=beyond-office` — office path flat while the stream backed up: the
  Pad side (home Wi‑Fi / home router / ISP) is the bottleneck.

The Pad-side Wi‑Fi (RSSI, band) and the home router are **not visible from
the PC** — O+ Connect logs nothing about them and the home LAN is not
reachable from the office. Check them on the Pad (router admin page, e.g.
`192.168.31.1` on a Xiaomi-style LAN) and compare `episodes` before/after a
change (router reboot, 5 GHz, moving closer).

Media path note: O+ Connect is built on the Oray SDK (`MPStream`). A session
starts on relay TCP (`switch mode to fw(tcp4)`) and moves to direct UDP once
hole-punching succeeds (`P2P_CONNECTED_0`, ~40 s on 2026-11-21); stalls seen
that day happened on the direct P2P path, not during relay↔P2P flapping.

## Log / process map

| Path / process | Use |
|---|---|
| `%APPDATA%\O+Connect\devicespace\rc-daemon-sdk*.log` | Login, P2P request / `P2PHolePunch`, `delay r/c` |
| `%APPDATA%\O+Connect\devicespace\*rc-daemon-service*.log` | `Server Address` / connect address (cloud entry; series recreated **2026-10-15 01:33**) |
| `%APPDATA%\O+Connect\devicespace\desktop_agent.*.log` | Per-session congestion controller (in-flight bytes, queue delay, drops) + key events — parsed by `oppo-remote-quality.sh` |
| `oplus_remote_service` TCP | Often `47.112.110.179:3443` (control); peer media may be UDP P2P |
| `warp-cli status` / `warp-cli settings` | One Client state + Include list |

Pre-**2026-10-15** hole-punch history lives in older
`rc-daemon-sdk.20261009-*.log` (P2P already present then). The
`rc-daemon-service` volume starts at that service restart — do not read
“no older service log” as “no older remote use”.
