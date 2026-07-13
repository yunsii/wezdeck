# Mobile Access

Use this doc when you need anything about interacting with this machine
from an Android phone: the Happy client for agent sessions, the
Tailscale + ssh path for shell work, Termux Chinese-input setup, or the
tmux window-size sharing model that shaped this design.

Built 2026-07-12/13 on the `nut` host (vivo phone, node `v2509a`).

## Division of labor

| Need | Path |
| --- | --- |
| Interact with Claude Code sessions from the phone | **Happy** (app-layer sync, native mobile rendering) |
| Run commands / inspect the machine from the phone | **Termux → ssh over Tailscale** |

The two paths share the Tailscale transport but are otherwise independent
fallbacks for each other.

## Happy (agent sessions)

[Happy](https://happy.engineering/) ([slopus/happy](https://github.com/slopus/happy),
npm package `happy`, MIT, free including the official relay and voice) is a
third-party wrapper around the `claude` CLI — not a client of Anthropic's
first-party Remote Control. It captures the structured session via the
Agent SDK, syncs it E2E-encrypted (X25519 + AES-256-GCM) through a relay,
and renders it natively per device. The desktop keeps its full-width TUI
in the tmux pane; tmux never learns the phone exists, so the whole
ghost-client / narrow-scrollback class of problems does not exist on this
path. Control switches per keypress rather than typing simultaneously.

Status: trialed 2026-07-13 on the official relay — experience and CN
reachability acceptable. Decisions:

- **Official relay, no self-hosting** for lightweight use. E2E means
  privacy gains nothing from self-hosting; worst failure mode is the
  phone losing sync while the desktop session and the ssh path stay
  intact. Revisit (Docker Compose happy-server + PostgreSQL + Redis, TLS
  via `tailscale serve` on the `nut.tailc0ce4c.ts.net` cert,
  `HAPPY_SERVER_URL` in `~/.config/shell-env.d/happy.env`, app-side
  "Relay Server URL") only if the relay proves unreliable from CN or the
  phone becomes a daily critical path.
- **Decision 2026-07-13: manual opt-in, not the default launch path.**
  `agent-launcher.sh` keeps spawning bare `claude`. Wrap a session with
  Happy only when phone access is actually wanted: `cd <project> &&
  happy --continue` resumes the directory's latest conversation with
  phone sync (exit the pane's own claude first so two processes don't
  resume the same conversation), or plain `happy` for a fresh session.
  `~/.local/bin/happy` symlinks the fnm-global install so the command
  resolves outside fnm-initialized shells.

### Workflow

- **Capability is per-session.** Each running `happy` process registers
  one session in the phone app; sessions launched as bare `claude` are
  invisible to the phone. When the wrapper process exits, the session
  drops off the app. Manual opt-in therefore means: you grant phone
  access conversation by conversation.
- **Input is single-writer with explicit handoff; viewing is always
  live on both ends.** Sending a message from the phone flips the
  session into *remote mode*: the desktop TUI keeps rendering everything
  in real time but its keyboard yields. To take control back on the
  desktop, press **Ctrl+T** (or double-tap space) — deliberate rather
  than any-key, so brushing the keyboard can't hijack an in-flight
  phone interaction. The phone regains control simply by sending again.
- **Phone-spawned sessions are headless.** A session started from the
  app is launched by `happy daemon` as a standalone process — it never
  appears in any desktop pane, and it coexists with whatever session a
  desktop pane is showing (a pane sitting in *remote mode* is just the
  old session with its keyboard yielded; Ctrl+T reclaims it, nothing to
  clean up). To move a phone-spawned conversation to the desktop, end
  it on the phone first, then resume it in the directory (see
  *Resuming a specific conversation*).
- **Auth is per-machine, not per-client.** MCP OAuth tokens
  (`~/.claude.json` credential store) and claude.ai connector grants are
  shared by every session on this machine, Happy-wrapped or not. But
  first-time OAuth flows need a browser callback and cannot be initiated
  from a phone session (non-interactive) — authorize once in a desktop
  interactive session via `/mcp`, then phone sessions just use it.
- **Permission modes**: don't touch the phone's mode picker on
  desktop-started sessions (it would drop the session out of `auto`,
  which mobile pickers can't set back — Shift+Tab on the desktop
  restores it); phone-spawned sessions should use `default` or `plan`.
  `defaultMode` in `~/.claude/settings.json` is machine-global and
  applies to daemon-spawned sessions too, unless the app's new-session
  flow sets an explicit mode.
- Diagnostics: `happy doctor`. A relay outage only breaks phone sync —
  the desktop TUI keeps working as a plain claude session.
- Findings from the integration spike (launcher diff verified end-to-end,
  then reverted — kept here so a future default-on switch is cheap):
  `happy --continue` passes args through to claude and lands in a usable
  session either way; `auto` permission mode works under the wrapper;
  happy runs claude in an inner pty, so `pane_current_command` reads
  `sh`, not `claude` — a default-on integration must stamp
  `@wezterm_pane_role agent-cli:<profile>` from the launcher (role is
  currently unset on managed panes, so `@agent_pane_match` / the
  Ctrl+n / Ctrl+P bindings lean on the command-name fallback) and must
  prepend the fnm default-alias bin to PATH (happy and its `env node`
  shebang live there; tmux-spawned shells lack it — same trick as the
  crontab). `happy codex` passthrough of `codex resume --last` was never
  tested.

Permission modes from the phone: the picker mirrors Claude Code's
session-level modes (default / plan / acceptEdits / bypassPermissions).
`auto` (the desktop default here, `defaultMode` in `~/.claude/settings.json`)
is not offered on mobile pickers — don't touch the selector on
desktop-started sessions or the session drops out of auto (Shift+Tab on
the desktop to restore); pick `default` or `plan` for phone-spawned ones.

### Resuming a specific conversation

- `happy --continue` — resume the directory's latest conversation (see
  the opt-in decision above).
- `happy --resume` (no arg) — passes through to claude's interactive
  session picker for the current directory; the pick gets phone sync.
- `happy resume <happy-session-id>` — exact resume by the ID shown in
  the phone app's session details; works across directories.
- All three: make sure no other process is still attached to the same
  conversation before resuming it.

### Known upstream issues (as of 2026-07)

- **App misses new responses until the session is re-entered**
  ([slopus/happy#1308](https://github.com/slopus/happy/issues/1308), fix
  in progress via PR #1310; Android-flavored variant
  [#1208](https://github.com/slopus/happy/issues/1208)). Mechanism: the
  relay does not push ordinary messages — delivery rides the app's
  websocket, which Android suspends when the app is backgrounded — and
  on returning to foreground the app does not re-sync the visible
  session. Re-entering the session forces a full fetch, which is why
  that "fixes" it. Mitigations until the fix ships: exempt the Happy app
  from vivo battery optimization / allow background running (same
  treatment as Tailscale), keep the app foregrounded during long tasks,
  and treat leave-and-re-enter as the manual sync gesture.

## Termux + ssh (shell work)

```bash
ssh yuns@nut           # or nut.tailc0ce4c.ts.net, or 100.108.51.25
```

- **Transport**: Tailscale mesh VPN. No port-forwarding, no public IP —
  WSL2 stays NATed; peer-to-peer when NAT traversal succeeds (always on
  shared Wi-Fi), overseas DERP relay fallback otherwise (`tailscale
  status` shows `direct` vs `relay` per peer). Phone must show
  *Connected*; exempt the app from battery optimization.
- **Server side** (all persistent via systemd): key-only sshd
  (`/etc/ssh/sshd_config.d/10-key-only.conf`), dead-peer cleanup
  (`20-keepalive.conf`: `ClientAliveInterval 30` + `ClientAliveCountMax 4`
  → a vanished phone's tmux client detaches in ≤2 min), `tailscaled`
  (node `nut`). mosh was retired 2026-07-13: tmux already provides session
  persistence, so mosh's never-dying server bought nothing and was the
  root cause of ghost clients pinning windows at phone width.
- **Phone side**: Termux (F-Droid build) + `pkg install openssh`; an
  `~/.ssh/config` alias with `ServerAliveInterval 30` is convenient.
  `~/.ssh/authorized_keys` on the server holds the phone key and the
  machine's own key (localhost self-tests).
- Attaching tmux from the phone is possible (`tmux attach`) but no longer
  part of the workflow — the `tm` mirror-session helper and the
  `mobile-client-janitor.sh` cron task were removed 2026-07-13 once Happy
  took over agent interaction (see git history for both).

## Termux Chinese input

`~/.termux/termux.properties` needs `enforce-char-based-input = true`,
then a full app restart (notification-bar **Exit**, not a swipe-away).
The stock vivo IME works with this flag; Gboard does not — the flag makes
Termux declare a `TYPE_NULL` input field and Gboard responds by locking
itself to a plain latin keyboard (upstream:
[termux-app#1539](https://github.com/termux/termux-app/issues/1539),
[#202](https://github.com/termux/termux-app/issues/202)). Fallback for a
broken IME: swipe the extra-keys row left to reveal Termux's plain text
input field, where any IME works fully. Server locale is C.UTF-8
end-to-end (verified) — display is never the problem.

## The tmux window-size model (why Happy, in one section)

Empirically verified on an isolated tmux server (2026-07-12); kept here
because it constrains any future "share the terminal with the phone"
idea:

- Window size is a window property shared across grouped sessions; with
  `window-size latest`, whichever client last interacted sizes it
  (attaching counts). Per-client sizes are an upstream architectural
  wontfix ([tmux#1877](https://github.com/tmux/tmux/issues/1877)).
- Lines a TUI emits while a window is phone-width are hard-wrapped
  permanently in scrollback; tmux reflows only its own soft-wraps. Worse,
  agent TUIs reprint their whole transcript on every resize, so a few
  narrow reprints can evict all full-width history — that is why the repo
  `tmux.conf` sets `history-limit 10000` (default 2000; new panes only).
  The conversation source of truth lives in the agent's own session log
  (`/resume` re-renders at any width); scrollback is just a render cache.
- "One pane rendered at two widths simultaneously" does not exist in the
  pty model. Per-device full-fidelity rendering requires an app-layer
  multi-client — which is exactly what Happy is.

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Phone can't reach `nut` at all | Tailscale app actually *Connected*; then try the IP `100.108.51.25` — carrier DNS answers the bare name with garbage when the tunnel is down |
| ssh connected but laggy | `tailscale status` — `relay` means DERP fallback; usually recovers to `direct` on network change |
| Happy phone client out of sync | Desktop session unaffected; check relay reachability, `happy doctor` |
| Happy app shows stale conversation; new responses only appear after re-entering the session | Known upstream bug, not a local fault — see *Known upstream issues* above (#1308/#1208); battery-exempt the app, re-enter to force a full sync |
| Chinese input dead in Termux | `enforce-char-based-input` present + full Exit restart + vivo IME (not Gboard) |
| Nothing reachable after Windows reboot | WSL isn't started until something launches it; open WezTerm once (keepalive scheduled task is a known-not-done option) |

## Known-not-done options

- Windows boot keepalive task (`wsl.exe -d Ubuntu --exec sleep infinity`)
  so the phone can connect before WezTerm is first opened.
- Default-on Happy launcher integration (spike verified and documented
  above; flip only if manual opt-in proves too much friction).
- Termux font: drop a CJK-capable mono ttf at `~/.termux/font.ttf`
  (Sarasa Term SC is the candidate) + `termux-reload-settings`.
