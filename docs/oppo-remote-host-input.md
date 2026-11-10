# OPPO Remote + Host Input Stickiness

Operator notes from the **2026-10 → 2026-11-10** investigation on host
`nut`: OPPO 互联 (O+ Connect) Pad remote-control, Cloudflare One Client
(WARP), long Windows uptime, and “CPU looks fine but typing/mouse feel
sticky”.

Related: [`guest-oom.md#guest-vs-host-memory-meters`](./guest-oom.md#guest-vs-host-memory-meters)
(`VmmemWSL` / `wsl-host-mem.sh`),
[`diagnostics.md`](./diagnostics.md) (WezTerm `latency` proxies — not HID
latency), open-questions §21 (RDP lid-close vs Oppo confounder).

## Triage first (do not merge causes)

| Feel | Primary suspect |
|---|---|
| Sticky **only** inside the Pad remote view; console keyboard/mouse fine | Remote path (same-LAN vs cross-net, Wi‑Fi RTT, encode/refresh) |
| Sticky **at the PC console** (Notepad / desktop) as well | Host state (long uptime, `VmmemWSL`, soft faults, long-lived WezTerm) |
| Whole desktop “new login / PIN” mid-work | RDP auto-reconnect — [`diagnostics.md#open-questions`](./diagnostics.md#open-questions) §21 |

Reference close: console + remote felt bad after ~**26 d** Windows uptime
(boot **2026-10-15**); after reboot **2026-11-10**, host free RAM ~16 GiB →
~41 GiB, `VmmemWSL` Private ~42 GiB → ~9 GiB; later the same day **cross-net**
remote felt smooth. Operator conclusion: **long uptime / host memory
stickiness was the larger input-delay factor** for that incident.

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
Local OPPO logs do **not** record end-to-end input delay; `desktop_agent`
session files are often **0 bytes**.

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

## What to capture for a “good” baseline

When remote feels good, record at least:

1. Subjective note + whether **console** input is also fine.
2. PC IPv4 / prefix; latest sdk `receive P2P request` peer `local` + public.
3. `warp-cli status`.
4. `scripts/dev/wsl-host-mem.sh` (`VmmemWSL` Private / host free).
5. Windows uptime (`LastBootUpTime`).
6. Optional: ping peer LAN IP and `47.112.110.179`.

Company good baseline sketch: peer `192.168.0.98`, same public IP as PC,
WARP Connected, gateway ping &lt;1 ms, relay ICMP ~8 ms, P2P `r≈10` /
`c≈18–20`.

## Log / process map

| Path / process | Use |
|---|---|
| `%APPDATA%\O+Connect\devicespace\rc-daemon-sdk*.log` | Login, P2P request / `P2PHolePunch`, `delay r/c` |
| `%APPDATA%\O+Connect\devicespace\*rc-daemon-service*.log` | `Server Address` / connect address (cloud entry; series recreated **2026-10-15 01:33**) |
| `E:\Program Files\Oppo Connect\daemon\log\desktop_agent.*.log` | Encode fps/bitrate when non-empty |
| `oplus_remote_service` TCP | Often `47.112.110.179:3443` (control); peer media may be UDP P2P |
| `warp-cli status` / `warp-cli settings` | One Client state + Include list |

Pre-**2026-10-15** hole-punch history lives in older
`rc-daemon-sdk.20261009-*.log` (P2P already present then). The
`rc-daemon-service` volume starts at that service restart — do not read
“no older service log” as “no older remote use”.
