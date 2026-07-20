# Mobile Access

**Agent remote work is OpenClaw (Feishu / ACP).** There is no phone-sync
wrapper around desktop TUI sessions, and **no maintained phone-shell VPN path**
on this host after 2026-07-20.

| Need | Path |
| --- | --- |
| Assign / steer / accept coding work remotely | **OpenClaw** (Feishu DM → Dex; C1/C2/C3, including ACP) |
| Temporary help on a live tmux agent pane | OpenClaw **tmux skill** (capture / send-keys) — not a second full client |
| Phone shell / attach desktop tmux from Android | **Retired** (was Tailscale + Termux ssh; host package to be purged) |

History: evolution **v6** · OpenClaw control plane:
[`openclaw/README.md`](../openclaw/README.md).

Built initially 2026-07-12/13 on the `nut` host (vivo phone). Happy path
retired 2026-07-20; Tailscale phone path retired the same day (host package purge is ops, not WezDeck code).

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

Code side (2026-07-20): deleted `agent-happy-toggle.sh`, launcher `--happy`,
manifest `agent.toggle-happy`. Host side: remove `~/.happy`, broken
`~/.local/bin/happy` symlink, and any leftover global npm `happy` package.

Do **not** re-add launcher wrap / chord bindings unless product goals change.

## Why not Tailscale (retired)

Phone **shell** used to be Termux → ssh over Tailscale to WSL node `nut`
(key-only OpenSSH, keepalives for dead-peer detach). That path was low-use
once OpenClaw covered remote agent work; keeping `tailscaled` + tailnet
surface without a product need was pure cost.

If you ever reintroduce a personal VPN/ssh path, document it here and keep it
independent of OpenClaw (control plane ≠ shell tunnel).

## Termux Chinese input (historical notes)

Still useful if Termux is used for anything else:

`~/.termux/termux.properties` needs `enforce-char-based-input = true`,
then a full app restart (notification-bar **Exit**, not a swipe-away).
The stock vivo IME works with this flag; Gboard does not — the flag makes
Termux declare a `TYPE_NULL` input field and Gboard responds by locking
itself to a plain latin keyboard (upstream:
[termux-app#1539](https://github.com/termux/termux-app/issues/1539),
[#202](https://github.com/termux/termux-app/issues/202)). Fallback for a
broken IME: swipe the extra-keys row left to reveal Termux's plain text
input field, where any IME works fully.

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
| Need agent work from phone | Use **Feishu → OpenClaw** (not tmux attach / Happy / Tailscale) |
| Chinese input dead in Termux | `enforce-char-based-input` + full Exit restart + vivo IME (not Gboard) |
| Expect ssh via tailnet IP | Path retired — do not reinstall Tailscale for agent work; use OpenClaw |
