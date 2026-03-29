# Routing

Read this file to decide which doc to load next. Do not keep reading every doc once you have the one you need.

## Task Routing

- Workspace definitions or workspace behavior:
  Read [`workspace-rules.md`](./workspace-rules.md).
- Debugging, diagnostics, or logging:
  Read [`validation.md`](./validation.md) first, then [`repo-structure.md`](./repo-structure.md) for the owning files.
- WezTerm entry config, Lua modules, or ownership boundaries:
  Read [`repo-structure.md`](./repo-structure.md).
- tmux layout, status rendering, tab title invariants, or managed Codex behavior:
  Read [`runtime-invariants.md`](./runtime-invariants.md).
- Sync, reload, validation, or release workflow:
  Read [`validation.md`](./validation.md).
- Preparing a commit message or deciding commit split:
  Read [`commit-guidelines.md`](./commit-guidelines.md).

## User Doc Routing

Only open a user doc when the change affects user-visible behavior.

- Workspace semantics:
  Read [`../user/workspaces.md`](../user/workspaces.md).
- Keybindings:
  Read [`../user/keybindings.md`](../user/keybindings.md).
- Tmux, titles, or status behavior:
  Read [`../user/tmux-and-status.md`](../user/tmux-and-status.md).
- Setup or maintenance workflow:
  Read [`../user/overview.md`](../user/overview.md) or [`../user/maintenance.md`](../user/maintenance.md).
