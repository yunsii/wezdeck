# Mobile Access

Use this doc for **phone shell access** to this machine (Android + Tailscale +
Termux). **Agent remote work is OpenClaw (Feishu / ACP)**, not a phone-sync
wrapper around desktop TUI sessions.

Happy (phone mirror of Claude/Codex panes) was **removed from WezDeck** in
2026-07 (v6). Rationale and history:  
[`docs/presentations/ai-dev-environment-evolution.md`](./presentations/ai-dev-environment-evolution.md) ·  
OpenClaw control plane: [`openclaw/README.md`](../openclaw/README.md).

Built initially 2026-07-12/13 on the `nut` host (vivo phone); Happy path
retired 2026-07-20.

## Division of labor

| Need | Path |
| --- | --- |
| Assign / steer / accept coding work remotely | **OpenClaw** (Feishu DM → Dex; C1/C2/C3, including ACP) |
| Temporary help on a live tmux agent pane | OpenClaw **tmux skill** (capture / send-keys) — not a second full client |
| Run shell commands / inspect the machine from the phone | **Termux → ssh over Tailscale** |

OpenClaw and ssh share Tailscale when the phone is on the tailnet; they are
otherwise independent.

## Why not Happy (retired)

Earlier experiment (2026-07-13): [Happy](https://happy.engineering/) wrapped
desktop agent CLIs for native phone UI + E2E relay sync, with WezDeck
`Ctrl+k p` bare↔Happy toggle and `agent-launcher.sh --happy`.

**Removed because:**

1. **Essential remote demand is task orchestration**, not mirroring a TUI.
2. OpenClaw already covers the real modes: Main self-write, host handoff,
   **ACP**, interrupt/steer, and **temporary tmux control**.
3. Happy stayed low-use, polyglot local transports, and extra wrapper tax
   (relay, `pane_current_command` noise, codex path never fully verified).

Do **not** re-add launcher wrap / chord bindings unless product goals change.
If you still have a global `happy` npm install, it is unrelated to WezDeck
and can be uninstalled separately.

## SSH over Tailscale (phone shell)

- **Host**: Tailscale on WSL node `nut`; OpenSSH key-only
  (`/etc/ssh/sshd_config.d/10-key-only.conf`), dead-peer cleanup
  (`20-keepalive.conf`: `ClientAliveInterval 30` + `ClientAliveCountMax 4`
  → a vanished phone's tmux client detaches in ≤2 min), `tailscaled`.
  mosh was retired 2026-07-13: tmux already provides session persistence.
- **Phone**: Termux (F-Droid) + `pkg install openssh`; optional
  `~/.ssh/config` with `ServerAliveInterval 30`.
- Attaching tmux from the phone is possible but **not** the agent workflow —
  prefer OpenClaw for agent work. Historical ghost-client / narrow-scrollback
  problems are why app-layer multi-width TUI sharing was attempted (Happy)
  and then abandoned in favor of a separate control plane.

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

## The tmux window-size model (why phone TUI attach is hard)

Empirically verified on an isolated tmux server (2026-07-12); kept because
it constrains any future "share the terminal with the phone" idea:

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
  pty model. Full-fidelity multi-device agent UI needs either an app-layer
  multi-client **or** a separate control plane (OpenClaw) that does not
  resize the desktop pane.

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Phone can't reach `nut` at all | Tailscale app *Connected*; try the tailnet IP when carrier DNS is wrong |
| ssh connected but laggy | `tailscale status` — `relay` means DERP fallback; usually recovers to `direct` |
| Need agent work from phone | Use **Feishu → OpenClaw**, not tmux attach / Happy |
| Chinese input dead in Termux | `enforce-char-based-input` + full Exit restart + vivo IME (not Gboard) |
| Nothing reachable after Windows reboot | WSL isn't started until something launches it; open WezTerm once |

## Known-not-done options

- Windows boot keepalive task (`wsl.exe -d Ubuntu --exec sleep infinity`)
  so the phone can connect before WezTerm is first opened.
- Termux font: drop a CJK-capable mono ttf at `~/.termux/font.ttf`
  (Sarasa Term SC is the candidate) + `termux-reload-settings`.
