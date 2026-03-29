# Workspaces

Use this doc when you need to understand or edit managed workspaces.

## Workspace Model

WezTerm workspaces are the top-level session unit.

- `default`: WezTerm built-in workspace
- `work`: managed business workspace
- `config`: managed config workspace

## Managed Workspace Behavior

- If the target workspace already exists, the shortcut switches to it.
- If it does not exist, WezTerm creates it and opens the configured project tabs.
- Each managed project tab boots through `tmux`.
- The left pane runs the configured primary command.
- The right pane stays as a shell in the same directory.
- `work` and `config` currently default to launching `codex` through `scripts/runtime/run-managed-command.sh`.
- Managed `codex` startup forces `tui.theme=github` because terminal background detection is unreliable inside `tmux`.
- Running `codex` directly in a normal shell is unchanged.

## Public Vs Local Config

- `wezterm-x/workspaces.lua` is the tracked public baseline.
- `wezterm-x/local/workspaces.lua` is the gitignored private override file for your real project directories.
- `wezterm-x/local.example/workspaces.lua` is the tracked template you should copy before editing local values.
- `config` is defined in the tracked baseline and points at the synced repo root.
- `work` is intentionally empty in the tracked baseline until you define your private directories in `wezterm-x/local/workspaces.lua`.

## Update Workspaces

Edit `wezterm-x/workspaces.lua` when you need to change:

- shared workspace semantics
- the default command for that workspace
- tracked workspace names such as `config`

Edit `wezterm-x/local/workspaces.lua` when you need to change:

- your private project directories
- machine-specific workspace overrides
- per-project command overrides that should not be committed

Example local override:

```lua
local wezterm = require 'wezterm'
local runtime_dir = wezterm.config_dir .. '/.wezterm-x'
local constants = dofile(runtime_dir .. '/lua/constants.lua')

local managed_command = nil
if constants.repo_root then
  managed_command = {
    constants.repo_root .. '/scripts/runtime/run-managed-command.sh',
    'codex-github-theme',
  }
end

return {
  work = {
    defaults = {
      command = managed_command,
    },
    items = {
      { cwd = '/home/your-user/work/project-a' },
      { cwd = '/home/your-user/work/project-b' },
      { cwd = '/home/your-user/work/project-c', command = { 'bash' } },
    },
  },
}
```

If you change the local file shape, update `wezterm-x/local.example/workspaces.lua` in the same edit.

After editing, follow [`maintenance.md`](./maintenance.md).
