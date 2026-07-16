# Docs

Use this doc when you need the shortest possible map of the repository docs.

## Read Next

- First-time setup or machine-local config:
  Read [`setup.md`](./setup.md).
- Daily edit, sync, reload, and verification:
  Read [`daily-workflow.md`](./daily-workflow.md).
- Workspace model and config boundaries:
  Read [`workspaces.md`](./workspaces.md).
- Shortcut reference:
  Read [`keybindings.md`](./keybindings.md).
- Tabs, status lines, and selection behavior:
  Read [`tmux-ui.md`](./tmux-ui.md).
- Agent-attention pipeline (Claude / Codex hooks, state file, badges, `Alt+,` / `Alt+.` / `Alt+/`):
  Read [`agent-attention.md`](./agent-attention.md).
- Window appearance presets (`opaque` / `frosted`), transparency / frosted-glass:
  Read [`appearance-presets.md`](./appearance-presets.md).
- Headless Chrome debug instance, `Alt+b` / `Alt+Shift+b`, `chrome://inspect` workflow, `CDP·…` badge:
  Read [`browser-debug.md`](./browser-debug.md).
- Timed reminders (cron + tmux popups), `reminder.sh`, crontab install:
  Read [`reminders.md`](./reminders.md).
- Phone / Android access (Tailscale + Termux, Happy, ghost clients):
  Read [`mobile-access.md`](./mobile-access.md).
- Cutting a Windows host-helper release, updating `release-manifest.json`, side-loading the release zip:
  Read [`host-helper-release.md`](./host-helper-release.md).
- Cutting a Go picker release or install-source toggle (`WEZTERM_PICKER_INSTALL_SOURCE`):
  Read [`picker-release.md`](./picker-release.md).
- Logs, diagnostics, and smoke tests:
  Read [`diagnostics.md`](./diagnostics.md).
- Logger author surface (categories, levels, render-path discipline):
  Read [`logging-conventions.md`](./logging-conventions.md).
- Cross-host development environment failures involving Windows, WSL, DNS,
  VPN/proxy software, shells, or agent CLIs:
  Read [`development-environment-troubleshooting.md`](./development-environment-troubleshooting.md).
- Entry points, ownership, and runtime design:
  Read [`architecture.md`](./architecture.md).
- Unified WezTerm event bus (OSC vs file transport, registered events):
  Read [`event-bus.md`](./event-bus.md).
- Tab visibility / overflow ranking (`tab-stats`, Alt+t):
  Read [`tab-visibility.md`](./tab-visibility.md).
- Alt+/ popup hot path, bench harnesses, cross-FS routing rule:
  Read [`performance.md`](./performance.md).
- Why tmux 3.7+ is required, IME flicker, DEC mode 2026 investigation:
  Read [`ime-flicker-and-sync-output.md`](./ime-flicker-and-sync-output.md).

## Doc Rules

- Keep one topic in one primary file. Link to it instead of restating the same rule elsewhere.
- Prefer editing an existing topic doc over adding a new sibling file.
- Keep setup, workflow, UI behavior, diagnostics, and architecture separate.
- Put presentations, outlines, and non-reference material under [`presentations/`](./presentations/).
