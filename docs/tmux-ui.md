# Tmux UI

Use this doc when you need visible UI behavior for tabs, panes, or status lines.

## Tab Behavior

- The native Windows title bar stays hidden.
- The tab bar uses the non-fancy style and remains visible at the bottom.
- The tab bar uses padded labels and stronger background highlighting for hover and active tabs rather than explicit separator characters.
- The left side of the tab bar shows the current workspace as a tinted badge that sits flush against the tab strip.
- Managed project tabs use stable project directory names as titles.
- If a managed tab has multiple panes, the title prefers a short summary such as `project +1`.
- Unmanaged tabs fall back to working-directory-based title inference.

## Tmux Behavior

- tmux status follows the active pane working directory.
- `default` stays the built-in WezTerm workspace at the top level, but in `hybrid-wsl` its WSL tabs start inside a lightweight tmux session.
- Managed workspace creation only requires `default_domain` in `hybrid-wsl` mode.
- Managed tmux flows do not require shell rc `OSC 7` integration; tmux status and tmux-owned shortcuts resolve cwd from tmux's own `pane_current_path`.
- In tmux-backed panes, navigation actions such as VS Code open and worktree switching resolve through tmux first, including copy-mode and scrollback.
- `Ctrl+Shift+P` opens a centered tmux popup command palette whenever the current pane is running tmux.
- tmux refresh is command-palette-owned instead of WezTerm-shortcut-owned.
- `Ctrl+k` is a tmux chord prefix for memorized low-latency actions such as `Ctrl+k v` for vertical split and `Ctrl+k h` for horizontal split.
- After `Ctrl+k`, tmux temporarily replaces one status line with a generic waiting hint.
- Copy and paste are intentionally split by layer: tmux owns pane-local text selection and copy, while WezTerm owns the smart system clipboard paste path.
- tmux explicitly uses `set-clipboard external`, so copying from tmux copy-mode writes to the system clipboard through OSC 52.
- Outside tmux copy-mode, plain left clicks are consumed by tmux only to focus the pane under the mouse.
- Outside tmux copy-mode, plain left drag does not start any selection path; use `Shift+drag` to start tmux pane-local selection from normal mode.
- Wheel scrolling may move tmux into its copy-mode-backed scrollback state, and tmux selects the pane under the mouse before entering that state.
- The `WheelUpPane` guard is `alternate_on || pane_in_mode` and intentionally omits `mouse_any_flag`. TUIs that enable mouse tracking but do not implement wheel scrolling (notably `claude-cli` and similar AI CLIs) would otherwise silently swallow the wheel. The trade-off is that `alternate_on=0` TUIs such as `fzf` or `lazygit` also yield their wheel handling to tmux scrollback inside a tmux pane.
- Releasing the mouse after a drag does not auto-copy or auto-cancel.
- `Ctrl+c` is uniform inside tmux copy-mode: when a selection is present it copies without leaving copy-mode; without a selection it cancels copy-mode.
- This config does not expose a normal WezTerm cross-pane drag-selection path by default; terminal-wide selection is still available when you hold `SUPER`.
- `Ctrl+c` first checks for a WezTerm terminal selection and copies it if one exists; otherwise it sends a normal terminal `Ctrl+c`.
- tmux emits terminal focus-in and focus-out events to applications, which helps mouse-aware TUIs recover cleanly when the WezTerm window regains focus.

## Agent Attention

### State file

- State lives in a shared JSON file at `$runtime_state_dir/state/agent-attention/attention.json` keyed by `session_id`. Each entry stores `wezterm_pane_id`, tmux `socket`/`session`/`window`/`pane`, a `status` of `waiting` or `done`, a free-text `reason`, the `git_branch` captured at hook-fire time (resolved from `$CLAUDE_PROJECT_DIR` → tmux `pane_current_path` → `$PWD`), and an epoch-ms `ts`. Writes are serialized by flock and land via atomic tmp-rename; entries older than 30 minutes are pruned on every write.

### Transitions

- `scripts/claude-hooks/emit-agent-status.sh` is the sole writer. Claude Code hooks (configured in user-level `~/.claude/settings.json`) map events to statuses: `Notification` → `waiting`, `Stop` → `done`, `UserPromptSubmit` → `cleared` (which removes the entry).
- After every write the hook emits OSC 1337 `SetUserVar=attention_tick=<ms>` (tmux DCS-wrapped when inside tmux) so the renderer reloads immediately; the `update-status` tick at `status_update_interval` acts as a fallback refresh.
- An entry can exit state.json through five paths: (1) a `UserPromptSubmit` on the same session, (2) the 30-minute TTL at the next prune, (3) the `Alt+/` clear-all sentinel, (4) a fresh `Notification`/`Stop` with the same session_id that overwrites it, or (5) an upsert from a *different* session_id that lands on the same `(tmux_socket, tmux_pane)` — a pane hosts at most one active attention entry, so restarting an agent in place evicts the prior one instead of double-counting.

### Rendering

- `wezterm-x/lua/attention.lua` is render-only; it owns no mutation path. On `user-var-changed` for `attention_tick` (and as a fallback on every `update-status`) it re-parses state.json into an in-memory cache.
- A tab gets a warm-orange `●` badge (`tab_attention_waiting_*`) when any entry's `wezterm_pane_id` matches the tab's active pane and the status is `waiting`; muted-green `○` (`tab_attention_done_*`) when the status is `done`. The right-status segment aggregates `⚠ N waiting` and `✓ N done` across every entry in the file and hides itself when both counts are zero.
- Multi-agent within one WezTerm pane is supported: each agent has its own `session_id`, so entries never collide. The right-status counter reflects real tasks, not panes.

### Keyboard

- `Alt+,` / `Alt+.` are Lua `action_callback`s (not tmux forwarders). They call `attention.pick_next` on the current state, then `attention.activate_in_gui` performs `SwitchToWorkspace` when needed, plus mux-level `tab:activate()` and `pane:activate()` so the target becomes visible even across WezTerm OS windows and workspaces. The tmux `select-window`/`select-pane` runs in the background via `scripts/runtime/attention-jump.sh --session <id>` spawned through `wsl.exe` from Lua.
- `Alt+/` opens a `InputSelector` whose rows read `<workspace>/<tab>/<branch>  <marker> <reason> — <tmux_window>:<tmux_pane>  (<age>[, no pane])`. The workspace / tab prefix is resolved live from the mux on open, so the label tracks the current WezTerm layout. A trailing `——  clear all · N entries  ——` sentinel truncates state.json and injects an `attention_tick` OSC into the current pane for immediate repaint.

### WEZTERM_PANE propagation

- The state entry's `wezterm_pane_id` comes from `$WEZTERM_PANE` in the hook's env. For the value to survive the hybrid-wsl boundary, four links must line up:
  1. `wezterm-x/lua/ui.lua` sets `WSLENV=TERM:COLORTERM:TERM_PROGRAM:TERM_PROGRAM_VERSION:WEZTERM_PANE/u` so `wsl.exe` forwards the variable into WSL.
  2. `scripts/runtime/open-project-session.sh` seeds `tmux new-session -e WEZTERM_PANE=$WEZTERM_PANE` on create and `tmux set-environment` on reuse.
  3. `scripts/runtime/open-default-shell-session.sh` does the same for the default-workspace fallback session.
  4. `tmux.conf` sets `update-environment WEZTERM_PANE` as a last-resort copy on client attach.
- Existing agent processes do **not** inherit env changes retroactively. To pick up `WEZTERM_PANE` after configuring the chain, the agent (or its hosting pane) has to restart into a shell that inherits the refreshed session env.

### Stale-entry recovery

- When an entry's `wezterm_pane_id` is empty, `attention-jump.sh` falls back to `tmux -S <socket> show-environment -t <session> WEZTERM_PANE` to recover the pane id from session env. `Alt+/` rows mark such entries with a trailing `no pane` suffix so the user sees up front which ones will go tmux-only if fallback fails.
- Ghost entries from WezTerm restarts (stale pane ids) drift out on the 30-minute TTL or can be wiped immediately via the `Alt+/` clear-all sentinel. Agents that resume with the same `session_id` self-heal their entry on the next hook fire.

## Status Lines

- The first tmux line renders repo, branch, combined git change counts, tracked-branch sync markers, and Node.js version.
- The second tmux line renders the repo family's linked worktree count plus the current worktree role, for example `linked:2 · primary`.
- The worktree line derives its repo family and current role from the active pane's live git state instead of stored tmux metadata.
- The third tmux line renders whenever the WakaTime toggle is enabled.
- Any enabled status section keeps a stable on-screen slot. If live data is unavailable, that section renders placeholder text instead of disappearing.
- A section only disappears completely when its toggle is disabled. If an entire line has no enabled sections, that line does not reserve a status row.
- Node.js version lookup includes an `nvm` fallback and the resolved version is cached.
- WakaTime refresh is cache-backed and reuses summary data for up to 60 seconds.

## Notes

- `default` is not managed by `workspaces.lua`; it remains WezTerm's built-in workspace even though `hybrid-wsl` now boots its WSL tabs through a lightweight tmux session.
- `Alt+p` uses WezTerm's built-in relative workspace switching, so it includes `default`.
- Worktree switching stays inside one repo-family tmux session and updates the active tmux window instead of spawning more top-level WezTerm tabs.
- tmux status refresh is hybrid: the draw path reads cached lines, focus and pane or window change hooks trigger debounced background refreshes, an optional shell prompt hook (see [`setup.md`](./setup.md#tmux-status-prompt-hook)) force-refreshes after each command so `git` operations reflect immediately, and a 30-second `status-interval` acts as a low-frequency fallback poll.
- WakaTime status sources `wezterm-x/local/shared.env`, and WezTerm Lua also reads that same file for shared scalar values.
