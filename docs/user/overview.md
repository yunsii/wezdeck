# Overview

Use this doc when you need the minimum setup and navigation context.

## Prerequisites

- Windows uses the WezTerm nightly build.
- Managed project tabs run inside the WSL domain configured in `wezterm-x/local/constants.lua`.
- `tmux` must be available in WSL for managed project tabs.

## Local Setup

1. Copy `wezterm-x/local.example/` to `wezterm-x/local/`.
2. Edit `wezterm-x/local/constants.lua` for your real WSL domain and optional Chrome debug profile path.
3. Edit `wezterm-x/local/workspaces.lua` for your private project directories.

 ## Repo Entry Points

- `wezterm.lua`: main WezTerm config
- `wezterm-x/workspaces.lua`: shared public workspace baseline and per-project startup defaults
- `wezterm-x/local.example/`: tracked templates for private machine-local overrides
- `wezterm-x/local/`: gitignored machine-local overrides that are still copied by the sync skill
- `wezterm-x/lua/`: WezTerm Lua modules synced under `%USERPROFILE%\.wezterm-x`
- `skills/wezterm-runtime-sync/`: Codex skill and scripts that own runtime sync and prompt regression checks
- `tmux.conf`: tmux layout and status line rendering
- `scripts/runtime/open-project-session.sh`: tmux session bootstrap for managed project tabs
- `scripts/runtime/run-managed-command.sh`: launcher for managed workspace startup commands
- `wezterm-x/scripts/`: Windows launcher scripts that are synced to `%USERPROFILE%\.wezterm-x\scripts`
- `scripts/dev/`: repo-local maintenance helpers
- `skills/wezterm-runtime-sync/scripts/sync-runtime.sh`: skill-owned sync implementation; the public workflow is to use the `wezterm-runtime-sync` skill

## Read Next

- For workspace behavior or editing workspace items, read [`workspaces.md`](./workspaces.md).
- For shortcuts, read [`keybindings.md`](./keybindings.md).
- For tmux or tab behavior, read [`tmux-and-status.md`](./tmux-and-status.md).
- For syncing and verification, read [`maintenance.md`](./maintenance.md).
