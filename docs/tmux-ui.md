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
- The Go popup pickers share one selected-row treatment: the focused row gets a full-width warm ANSI 255 background bar plus a leading `▶` caret so row focus is visible without overloading any per-row marker. The `Alt+x` cross-workspace session picker additionally bolds the selected session label; the `Alt+g` worktree picker, `Ctrl+Shift+P` command palette, `Alt+/` agent-attention overlay, and links picker use the same background bar. (The `Alt+,` / `Alt+.` attention jumps are direct — they cycle panes without opening a picker, so they have no selected-row surface.) Inner per-cell colors are restored with a background-preserving SGR (`\x1b[22;23;24;27;39m`) rather than a full reset so the bar stays continuous to the end of the line. The bash fallback pickers (used only when the Go binary is unavailable) keep the caret-only look.
- Copy and paste are intentionally split by layer: tmux owns pane-local text selection and copy, while WezTerm owns the smart system clipboard paste path.
- tmux explicitly uses `set-clipboard external`, so copying from tmux copy-mode writes to the system clipboard through OSC 52.
- Outside tmux copy-mode, plain left clicks are consumed by tmux only to focus the pane under the mouse.
- Outside tmux copy-mode, plain left drag does not start any selection path; use `Shift+drag` to start tmux pane-local selection from normal mode.
- Wheel scrolling may move tmux into its copy-mode-backed scrollback state, and tmux selects the pane under the mouse before entering that state.
- Copy-mode entry and exit via directional inputs follow a single symmetric rule: the first press at a boundary only switches mode without scrolling. Upward keys (`PageUp`, `Shift+Up`, wheel-up) entering from the live prompt do not jump, and downward inputs (`PageDown`, `Shift+Down`, wheel-down) at the live bottom exit copy-mode on a single press rather than auto-exiting mid-scroll.
- While a pane is in copy-mode, tmux 3.7+'s `refresh-from-pane` is run automatically every `@copy_mode_auto_refresh_interval_ms` milliseconds (default `1000`) so streaming agent output is periodically flushed into the backing grid without leaving copy-mode. The automatic loop refreshes while copy-mode is within `@copy_mode_auto_refresh_prefetch_screens` screens of the live bottom (default `3`), like a bottom-side prefetch window; farther back, it pauses so older viewport positions do not jump forward as new output pushes history past `history-limit`. It also pauses when `history_size` is within `@copy_mode_auto_refresh_history_guard_lines` lines of `history-limit` (default `200`). Because `refresh-from-pane` clears tmux's active selection, automatic refresh pauses while `selection_present=1`; manual `r` also skips refresh during an active selection. The loop also pauses while `@wezterm_popup_active=1` (boolean, set by `scripts/runtime/tmux-display-popup.sh` for the overlay lifetime): refreshing the underlying grid during a popup races tmux's client composite and garbles double-width CJK cells into the overlay. The flag is **server-global** — one reminder popup pauses auto-refresh on every pane for a few seconds (intentional, cheap). Concurrent popups are not refcounted; last closer clears. A hard-killed wrapper can leave the flag stuck (`tmux set -gu @wezterm_popup_active` clears it). Set `@copy_mode_auto_refresh` to `0` to disable the loop.
- Runtime popup opens must go through `scripts/runtime/tmux-display-popup.sh` (not bare `tmux display-popup`, except `-C` close). That is a cooperative contract enforced by `scripts/dev/check-display-popup-guard.sh`. Separate from this: command palette still uses its own `popup-open.flag` for the WezTerm second-press toggle — different reader, different lifecycle. Popup chrome uses a solid cream fill (`popup-style` / `popup-border-style` from `render-tmux-appearance.sh`) even under the frosted preset, so empty overlay cells never show the underlying pane through.
- The `WheelUpPane` guard is `alternate_on || pane_in_mode` and intentionally omits `mouse_any_flag`. TUIs that enable mouse tracking but do not implement wheel scrolling (notably `claude-cli` and similar AI CLIs) would otherwise silently swallow the wheel. The trade-off is that `alternate_on=0` TUIs such as `fzf` or `lazygit` also yield their wheel handling to tmux scrollback inside a tmux pane.
- Releasing the mouse after a drag does not auto-copy or auto-cancel.
- `Ctrl+c` is uniform inside tmux copy-mode: when a selection is present it copies without leaving copy-mode; without a selection it cancels copy-mode.
- This config does not expose a normal WezTerm cross-pane drag-selection path by default; terminal-wide selection is still available when you hold `SUPER`.
- `Ctrl+c` first checks for a WezTerm terminal selection and copies it if one exists; otherwise it sends a normal terminal `Ctrl+c`.
- tmux emits terminal focus-in and focus-out events to applications, which helps mouse-aware TUIs recover cleanly when the WezTerm window regains focus.
- Pane and status backgrounds are driven by the active appearance preset (`WEZTERM_APPEARANCE_PRESET`), not hardcoded in `tmux.conf`: `render-tmux-appearance.sh` regenerates `wezterm-x/tmux/appearance.generated.conf` (sourced via `source-file -Fq`) during sync. The `opaque` preset uses cream/dim-cream backgrounds; the `frosted` preset sets `status-style` / `window-style` / `window-active-style` all to `bg=default` so cells inherit WezTerm's window transparency + acrylic (the focused pane is then told apart by border color, not body tint). Giving any of those an explicit `bg=<hex>` paints cells opaque and hides window transparency. Full model: [`appearance-presets.md`](./appearance-presets.md).
- ANSI 256-color index 255 is remapped to `#dedcd0` via `colors.indexed` in `wezterm-x/lua/ui.lua` (sourced from `palette.indexed` in `constants.lua`). Claude Code's scrollback renderer paints user-message backgrounds with `\e[48;5;255m`, and the default xterm value (`#eeeeee`) is too close to the cream pane background to read clearly. The remap is applied to the wezterm color scheme rather than a Claude theme override because Claude Code's `userMessageBackground` token only takes effect in fullscreen rendering mode; in scrollback mode the only point of intervention is the terminal palette.
- Managed agent panes show a single dim-cyan `Loading <agent> ...` line while the agent boots, printed by `scripts/runtime/agent-launcher.sh` right before it execs the CLI. The agent's first paint clears the screen, so the cue is only visible while it's actually useful — covering the multi-second `claude --continue` / `codex resume --last` session-load window where the pane would otherwise stay blank. The shell-chain forks before the launcher (~130ms, dominated by `zsh -ilc` to inherit the interactive PATH) are intentionally kept: the post-agent fallback shell (Ctrl+D / agent crash) execs the same login shell on the same tty, so it pays the equivalent zshrc cost regardless — splitting the env across `~/.zshrc` and `~/.config/shell-env.d/` to shave that 130ms would desync interactive-shell behavior for no perceptual win. Disable the cue with `WEZTERM_NO_LOADING_BANNER=1`.

## Agent Attention

The agent-attention pipeline (state file, hook install, transitions, rendering, the `Alt+,` / `Alt+.` / `Alt+/` keyboard entry points, focus-based auto-ack, Codex integration) lives in [`agent-attention.md`](./agent-attention.md).

In tmux UI terms what shows up here is: a per-tab badge (a 1-cell `█` block in warm-orange / cool-blue / muted-green for waiting / running / done) and the right-status `🚨 N waiting  ✅ N done  🔄 N running` counter, both rendered by `wezterm-x/lua/attention.lua` from the shared state file. The tab badge stays color-only because the tab strip is dense and emoji at 2-cell width felt visually heavy; the right-status counter and the `Alt+/` picker keep emoji because their adjacent text labels need the visual anchor. The counter slot is reserved even at zero so the bar width stays stable.

## Status Lines

- The first tmux line renders repo, branch, combined git change counts, tracked-branch sync markers, and Node.js version.
- The git-changes group reads `(+S,~U,?T,<sync>)` where `S` is staged, `U` is unstaged, `T` is untracked, and `<sync>` is one of: `=0` (synced with upstream), `^N` (ahead by N), `vN` (behind by N), `*0` (no upstream — local-only branch never pushed).
- The second tmux line renders the repo family's linked worktree count plus the current worktree role, for example `linked:2 · primary`.
- The worktree line derives its repo family and current role from the active pane's live git state instead of stored tmux metadata.
- The third tmux line renders whenever the WakaTime toggle is enabled.
- Any enabled status section keeps a stable on-screen slot. If live data is unavailable, that section renders placeholder text instead of disappearing.
- A section only disappears completely when its toggle is disabled. If an entire line has no enabled sections, that line does not reserve a status row.
- Node.js version lookup falls back to `~/.local/share/fnm/aliases/default/bin` when `node` is not already on `$PATH` (this is the path `fnm` populates from its `default` alias). The resolved version is cached.
- WakaTime refresh is cache-backed and reuses summary data for up to 60 seconds.

## Notes

- `default` is not managed by `workspaces.lua`; it remains WezTerm's built-in workspace even though `hybrid-wsl` now boots its WSL tabs through a lightweight tmux session.
- `Alt+p` uses WezTerm's built-in relative workspace switching, so it includes `default`.
- Worktree switching stays inside one repo-family tmux session and updates the active tmux window instead of spawning more top-level WezTerm tabs.
- tmux status refresh is hybrid: the draw path reads cached lines, focus and pane or window change hooks trigger debounced background refreshes, a recommended shell prompt hook (see [`setup.md`](./setup.md#tmux-status-prompt-hook); when the hook is not installed, `git` state can lag up to 30s) force-refreshes after each command so `git` operations reflect immediately, and a 30-second `status-interval` acts as a low-frequency fallback poll.
- WakaTime status sources `wezterm-x/local/shared.env`, and WezTerm Lua also reads that same file for shared scalar values.
- **Grok Build light TUI background.** Stock GrokDay paints an opaque cool `#eeeeee` `bg_base`, which fights this repo's dynamic tmux pane cream (`#eae9e1` inactive / `#f1f0e9` active) and flashes on focus-in repaint. Grok has no public custom-theme API, so `scripts/dev/patch-grok-theme-wezdeck.sh` rewrites that single crossterm Color slot to **`Color::Reset`** (terminal default bg) — the main canvas then shows tmux's live `window-style` / `window-active-style`. Override with `WEZDECK_GROK_BG=f1f0e9` (solid cream) if needed. Re-run after every Grok self-update. Pin light mode with `auto_light_theme = "grokday"` in `~/.grok/config.toml`.

## Upstream Constraints

- **Copy-mode flush flicker on streaming agents.** Entering tmux copy-mode while an agent (Claude Code, Codex, etc.) is still streaming causes a visible jump + flicker on exit: tmux stops reading PTY bytes for the whole duration of copy-mode, so all output the agent produced while you were scrolled up gets buffered, then flushes into the backing grid in one frame at exit. Confirmed by tmux maintainer nicm in [tmux/tmux#1718] as a design choice, not a bug — wezterm and the agent renderer cannot mitigate it. Two upstream commands have already landed in tmux master (post-3.6a, expected in the next release):
  - [tmux/tmux#4885] `refresh-from-pane` — flushes the buffer into the backing grid from inside copy-mode while preserving scroll position (records `oy_from_top` before reclone, restores it after). This config runs it automatically while copy-mode is active, but pauses while a selection is active because tmux 3.7b clears `selection_present` during the refresh.
  - [tmux/tmux#4884] `scroll-exit-on/off/toggle` — runtime toggle for `scroll_exit` so a long selection that crosses the bottom is not kicked out of copy-mode mid-drag.

  Remaining caveat: auto-refresh reduces the exit-time burst while you stay near the live bottom, but it deliberately stops once you browse older output. Output produced after the last refresh can still flush when leaving copy-mode; this is the tradeoff that keeps older scrollback positions stable.

[tmux/tmux#1718]: https://github.com/tmux/tmux/issues/1718
[tmux/tmux#4884]: https://github.com/tmux/tmux/pull/4884
[tmux/tmux#4885]: https://github.com/tmux/tmux/pull/4885
