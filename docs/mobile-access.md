# Mobile Access

Use this doc when you need anything about interacting with the WSL tmux
sessions from an Android phone: the Tailscale + mosh transport, the `tm`
mirror-session helper, Termux Chinese-input setup, the window-size sharing
model, or troubleshooting a connection that stopped working or scrollback
that turned phone-width.

Built and verified 2026-07-12 on the `nut` host (vivo phone, node `v2509a`).

## Architecture

```
Android phone                      Windows host
┌──────────────────┐              ┌───────────────────────────┐
│ Termux           │  WireGuard   │  WSL2 (Ubuntu, systemd)   │
│  └ mosh/ssh ─────┼──────────────┼─→ sshd ─→ zsh ─→ tmux     │
│ Tailscale app    │  P2P first,  │   tailscaled              │
└──────────────────┘  DERP relay  │   existing tmux server    │
                      fallback    └───────────────────────────┘
```

- **Transport**: Tailscale mesh VPN. No router port-forwarding, no public
  IP, no Windows firewall rules — WSL2 stays NATed and unreachable except
  through the tailnet. Traffic goes peer-to-peer when NAT traversal
  succeeds (always on shared Wi-Fi) and falls back to Tailscale's DERP
  relays (encrypted, free, but overseas — noticeable latency) otherwise.
  Check with `tailscale status`: each peer line shows `direct` or `relay`.
- **Session layer**: mosh on top of SSH. Survives network switches, lock
  screen, and signal loss — the connection is effectively permanent until
  explicitly ended (which cuts both ways; see *Ghost clients* below).
- **tmux**: the phone attaches the same tmux server the desktop uses
  (`~/.local/bin/tmux`, default socket), via a grouped mirror session.

## Server-side pieces (WSL)

All persistent via systemd (`systemd=true` in `/etc/wsl.conf`):

| Piece | Detail |
| --- | --- |
| `sshd` | Key-only: `/etc/ssh/sshd_config.d/10-key-only.conf` sets `PasswordAuthentication no` + `KbdInteractiveAuthentication no` |
| `tailscaled` | Node `nut`, MagicDNS `nut.tailc0ce4c.ts.net` |
| `mosh` + `fzf` | apt packages; mosh UDP 60000–61000 reachable only inside the tailnet |
| `tm()` | Helper function at the end of `~/.zshrc` (machine-local, not in this repo) |

`~/.ssh/authorized_keys` holds two ed25519 keys: the phone (Termux) and the
machine's own key (localhost self-tests, desktop self-ssh).

## Phone-side pieces

- **Tailscale app**, same account, toggle must be *Connected* (VPN key icon
  in the status bar). Android battery optimization kills it — exempt it.
- **Termux** (F-Droid build, not Play Store) with `pkg install openssh mosh`.
- `~/.termux/termux.properties` needs `enforce-char-based-input = true` for
  Chinese input, then a full app restart (notification-bar **Exit**, not a
  swipe-away). The stock vivo IME works with this flag; Gboard does not —
  the flag makes Termux declare a `TYPE_NULL` input field and Gboard
  responds by locking itself to a plain latin keyboard (upstream:
  [termux-app#1539](https://github.com/termux/termux-app/issues/1539),
  [#202](https://github.com/termux/termux-app/issues/202)). Fallback for a
  broken IME: swipe the extra-keys row left to reveal Termux's plain text
  input field, where any IME works fully.

## Daily use

```bash
mosh yuns@nut          # or nut.tailc0ce4c.ts.net, or 100.108.51.25
tm                     # fzf-pick a session → grouped mirror, phone-sized
tm -g                  # glance mode: never resizes desktop windows
# leave: Ctrl+b then d (detach; mirror self-destructs, real session untouched)
```

`tm` (defined in `~/.zshrc`) opens a **grouped mirror session** named
`m-<session>`: shared windows and processes, independent current-window.
It filters `m-*` out of the picker (no mirror-of-mirror), reattaches with
`-d` to kick stale clients, and sets `destroy-unattached on` so a detach
cleans the mirror up. Zoom a pane (`Ctrl+b z`) to read a single pane on a
small screen — but the zoom flag is shared with the desktop view.

## The window-size model (read before "fixing" anything)

Empirically verified on an isolated tmux server (2026-07-12):

- Window **size is a window property**, shared across grouped sessions.
  With `window-size latest` (our value, the default), whichever client
  last interacted with a window sizes it — attaching counts.
- Desktop pressing any key reclaims full width instantly. A phone browsing
  *other* windows never affects the desktop's window.
- Lines a TUI (claude, etc.) emits while the window is phone-width are
  hard-wrapped **permanently** in scrollback. tmux reflows only its own
  soft-wraps; no terminal can un-wrap application output. Remedies:
  shrink the width gap (smaller Termux font, landscape ≈ 90–120 cols), or
  re-render the conversation at full width (`/resume` in the claude pane).
  `clear-history` nukes the narrow segment along with everything else.
- `tm -g` attaches with the `ignore-size` client flag: the phone client is
  excluded from sizing entirely (verified: window stays desktop-sized no
  matter what the phone does), at the cost of a clipped viewport on the
  phone — fine for glancing, too cramped for real interaction.
- A pane cannot be attached on its own (client → session → window → pane),
  and "one pane rendered at two widths simultaneously" does not exist in
  the pty model. Per-device full-fidelity rendering requires leaving the
  terminal (app-level multi-client UIs).

## Ghost clients

Closing Termux or losing the network does **not** detach the server-side
tmux client — mosh-server keeps it alive indefinitely, and as the "latest"
client it keeps sizing shared windows at phone width while the desktop is
idle (this is how phone-width scrollback appears without any phone
interaction). Defenses:

- Detach properly (`Ctrl+b d`) instead of just closing the app.
- `tm` reattaches with `-d`, kicking stale clients of the same mirror.
- `scripts/runtime/mobile-client-janitor.sh` runs from cron every 5
  minutes (`wezterm-x/local/crontab`) and detaches `m-*` clients idle
  longer than 15 minutes. Desktop clients are never candidates. Logs
  under the `mobile_access` category in `runtime.log`.
- Diagnose live: `tmux list-clients` — look for small `WxH` clients on
  `m-*` sessions with old `client_activity`; `tmux detach-client -t
  /dev/pts/N` removes one. The mirror self-destructs once empty.

A ghost's damage is bounded by `history-limit` too: agent TUIs reprint
their whole transcript on every resize, and the tmux default of 2000
lines let a few narrow reprints evict all full-width scrollback — the
repo `tmux.conf` now sets 10000 (new panes only).

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Cannot connect at all | Phone Tailscale app actually *Connected*; then try the IP `100.108.51.25` — carrier DNS answers the bare name `nut` with garbage when the tunnel is down |
| `mosh` connects, input laggy | `tailscale status` — `relay` means DERP fallback; usually recovers to `direct` on network change |
| Chinese input dead | `enforce-char-based-input = true` present, Termux fully restarted via Exit, IME is vivo's (not Gboard); paste-test to confirm the display path (server locale is C.UTF-8 end-to-end, verified fine) |
| Desktop scrollback phone-width | Ghost client — see above |
| Nothing reachable after Windows reboot | WSL isn't started until something launches it; open WezTerm once (keepalive scheduled task is a known-not-done option) |

## Next: app-layer agent-session sync (Happy) — planned, not started

The terminal model caps how good phone interaction can get: one pty renders
at one width, so sharing a live agent session always sacrifices one side
(see *The window-size model*). The community's answer for the agent use
case is to sync at the data layer instead — [Happy](https://happy.engineering/)
([slopus/happy](https://github.com/slopus/happy), npm package `happy`)
wraps the `claude` CLI, syncs the structured session E2E-encrypted through
a relay server, and renders it natively per device. Desktop keeps its
full-width TUI in the tmux pane (tmux never learns the phone exists — the
whole ghost-client / narrow-scrollback class disappears on this path);
the phone gets native scrolling, permission-request push, and voice input.
Control switches per keypress rather than typing simultaneously.

Adoption plan, in order:

1. **Trial on the official relay** (zero-intrusion, ~10 min): `npm
   install -g happy`, `happy --auth` (QR-pair the phone app), run `happy
   claude` manually in a scratch shell. Validates the experience and the
   official relay's reachability from CN networks before any investment.
2. **Self-host the relay inside the tailnet** (kills the third-party
   dependency; reuses the Tailscale transport already required for mosh):
   official Docker Compose (happy-server + PostgreSQL + Redis, ~512MB),
   TLS via `tailscale serve` on the `nut.tailc0ce4c.ts.net` cert, CLI
   points at it with `HAPPY_SERVER_URL` (put it in
   `~/.config/shell-env.d/happy.env`), phone app sets "Relay Server URL".
   Note: push notifications ride the official channel and may need extra
   setup or be lost when self-hosted — verify during the trial. Raises
   the priority of the Windows-boot keepalive task below (postgres/redis
   must survive reboots without opening WezTerm).
3. **Launcher integration**: wrap the claude profile as `happy claude` in
   `scripts/runtime/agent-launcher.sh` — the single launch site all
   workspace first-opens / `Alt+g` / refresh / overflow cold-spawns share
   (hard rule in `AGENTS.md`). After this, division of labor: Happy owns
   agent-session interaction from the phone; the tmux + mosh path remains
   for shell work and whole-screen glances.

## Known-not-done options

- Windows boot keepalive task (`wsl.exe -d Ubuntu --exec sleep infinity`)
  so the phone can connect before WezTerm is first opened.
- Self-hosted DERP for better relay latency from outside networks.
- Termux font: drop a CJK-capable mono ttf at `~/.termux/font.ttf`
  (Sarasa Term SC is the candidate) + `termux-reload-settings`.
