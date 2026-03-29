# Workspace Rules

Use this doc when you are editing managed workspaces.

## Required Structure

- Keep workspace definitions in `wezterm-x/workspaces.lua`, not inline in `wezterm.lua`.
- Keep shared, public workspace defaults in `wezterm-x/workspaces.lua`.
- Keep private directories and machine-specific workspace overrides in `wezterm-x/local/workspaces.lua` and keep the tracked template in `wezterm-x/local.example/workspaces.lua`.
- Keep the structured workspace format in `wezterm-x/workspaces.lua`:
  - workspace-level `defaults`
  - workspace-level `items`
  - per-item `cwd`
  - optional per-item `command`

## Naming And Model

- Prefer stable, explicit workspace names.
- Do not use `default` for managed workspaces because WezTerm already has a built-in `default` workspace.
- Preserve the current workspace model unless explicitly asked to redesign it:
  - built-in `default`
  - managed `work`
  - managed `config`

## Cross-Doc Rule

- If workspace semantics change, update [`../user/workspaces.md`](../user/workspaces.md).
- If workspace shortcuts change as part of the same work, update [`../user/keybindings.md`](../user/keybindings.md).
