# Docs

Use this doc when you need the shortest possible map of the repository docs.

## Read Next

- First-time setup or machine-local config:
  Read [`setup.md`](./setup.md).
- Daily edit, sync, reload, and verification:
  Read [`daily-workflow.md`](./daily-workflow.md).
- Repository-owned interface changes, migration warnings, and compatibility
  policy:
  Read [`compatibility-policy.md`](./compatibility-policy.md).
- Skill source ownership, user-level links, and `WEZDECK_REPO` path resolution:
  Read [`skill-sources.md`](./skill-sources.md).
- Workspace model and config boundaries:
  Read [`workspaces.md`](./workspaces.md).
- Shortcut reference:
  Read [`keybindings.md`](./keybindings.md).
- Tabs, status lines, and selection behavior:
  Read [`tmux-ui.md`](./tmux-ui.md).
- Agent-attention pipeline (Claude / Codex hooks, state file, badges, `Alt+j` / `Alt+k` / `Alt+l` / `Alt+/`):
  Read [`agent-attention.md`](./agent-attention.md).
- Window appearance presets (`opaque` / `frosted`), transparency / frosted-glass:
  Read [`appearance-presets.md`](./appearance-presets.md).
- Headless Chrome debug instance, `Alt+b` / `Alt+Shift+b`, `chrome://inspect` workflow, `CDP·…` badge:
  Read [`browser-debug.md`](./browser-debug.md).
- Timed reminders (cron + tmux popups), `reminder.sh`, crontab install:
  Read [`reminders.md`](./reminders.md).
- Phone / Android remote work (OpenClaw; Happy + Tailscale phone shell retired):
  Read [`mobile-access.md`](./mobile-access.md).
- Cutting a Windows host-helper release, updating `release-manifest.json`, side-loading the release zip:
  Read [`host-helper-release.md`](./host-helper-release.md).
- Cutting a Go picker release or install-source toggle (`WEZTERM_PICKER_INSTALL_SOURCE`):
  Read [`picker-release.md`](./picker-release.md).
- Logs, diagnostics, smoke tests, latency / hotkey counters:
  Read [`diagnostics.md`](./diagnostics.md).
- Day-loop reconstruction (`workflow-timeline.sh`) or personal habit /
  intensity metrics (`habit-report.sh` / skill `habit-weekly`):
  Read [`diagnostics.md#workflow-timeline`](./diagnostics.md#workflow-timeline)
  and [`diagnostics.md#habit-report`](./diagnostics.md#habit-report).
- Guest OOM hardening (restart loop, reclaim livelock, high-order allocation,
  `M·…` / earlyoom, standing memory consumers):
  Read [`guest-oom.md`](./guest-oom.md).
- Host disk space (`ext4.vhdx`, sparse-VHD trap, compaction, `D·…` badge):
  Read [`host-disk.md`](./host-disk.md).
- Logger author surface (categories, levels, render-path discipline):
  Read [`logging-conventions.md`](./logging-conventions.md).
- Cross-host development environment failures involving Windows, WSL, DNS,
  VPN/proxy software, shells, or agent CLIs:
  Read [`development-environment-troubleshooting.md`](./development-environment-troubleshooting.md).
- Entry points, ownership, and runtime design:
  Read [`architecture.md`](./architecture.md).
- Agent 执行通道调度（人工 TUI / 跨仓工单 / OpenClaw ACP·Main / 审查 headless；
  统一 vs 刻意不合；票仓协议 vs 多目录挂载）:
  Read [`agent-scheduling.md`](./agent-scheduling.md)
  ([`#ticket-vs-multi-dir-mount`](./agent-scheduling.md#ticket-vs-multi-dir-mount)).
- Big-picture map of session management (workspace/tab/tmux/worktree/agent/attention) and interop (host TUI ↔ session-bridge ↔ Feishu), with a built / convention / not-built status table:
  Read [`architecture.md#session--interop-overview`](./architecture.md#session--interop-overview).
- Unified WezTerm event bus (OSC vs file transport, registered events):
  Read [`event-bus.md`](./event-bus.md).
- Tab visibility / overflow ranking (`tab-stats`, Alt+t):
  Read [`tab-visibility.md`](./tab-visibility.md).
- Alt+/ popup hot path, bench harnesses, cross-FS routing rule:
  Read [`performance.md`](./performance.md).
- tmux install (cross-OS: use system if ≥ 3.7; user-prefix only as fallback):
  Read [`tmux-install.md`](./tmux-install.md).
- Why tmux 3.7+ is required, IME flicker, DEC mode 2026 investigation:
  Read [`ime-flicker-and-sync-output.md`](./ime-flicker-and-sync-output.md).
- Host↔Claw session interop (Session Adapter Kit / `session-bridge`: host tmux ↔ claw sessions, gated poke/host-send-keys, panic, identities):
  Read [`../openclaw/docs/session-bridge.md`](../openclaw/docs/session-bridge.md).
- Personal OpenClaw control plane (Feishu remote, operational; not WezTerm hot path):
  Read [`../openclaw/README.md`](../openclaw/README.md).

## Doc Rules

- Keep one topic in one primary file. Link to it instead of restating the same rule elsewhere.
- Prefer editing an existing topic doc over adding a new sibling file.
- When a topic is already over the soft line budget in [`skills/repo-hygiene/budgets.conf`](../skills/repo-hygiene/budgets.conf) (docs topics soft 400 / hard 600), split by **decision domain** rather than appending another section — see user-level `documentation-29`.
- Keep setup, workflow, UI behavior, diagnostics, and architecture separate.
- Put presentations, outlines, and non-reference material under [`presentations/`](./presentations/).
- After changing markdown links or mermaid blocks, rely on `skills/repo-hygiene/` (pre-commit + `run.sh audit`) rather than eyeballing. Operator notes: [`daily-workflow.md#repo-hygiene`](./daily-workflow.md#repo-hygiene).
