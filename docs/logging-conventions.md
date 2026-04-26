# Logging Conventions

Hard rules for code that emits log lines.

For the **operator** surface — env knobs, where files live, how to read them, smoke tests, troubleshooting — read [`diagnostics.md`](./diagnostics.md). This doc is for **authors** adding or modifying logger callsites.

## Where logs go

Three log files, segmented by **which process writes**. The file lives on the writer's native filesystem so the writer never pays the cross-FS penalty; cross-FS readers (rare) absorb the cost in their own paths.

| File | Writer | Why this side |
|---|---|---|
| `~/.local/state/wezterm-runtime/logs/runtime.log` (WSL ext4) | every bash script in `scripts/runtime/`, every `picker` invocation, the Claude/Codex agent hooks | WSL-native; ~150× faster than `/mnt/c` per the cross-FS routing rule in [`performance.md`](./performance.md) |
| `%LOCALAPPDATA%\wezterm-runtime\logs\wezterm.log` (Windows NTFS) | WezTerm Lua via `wezterm.log_*` + `append_file` in `wezterm-x/lua/logger.lua` | wezterm.exe is a Windows process |
| `%LOCALAPPDATA%\wezterm-runtime\logs\helper.log` (Windows NTFS) | `windows-helper-manager.exe` (.NET) | helper is a Windows process |

Never hard-code paths. Bash sources `scripts/runtime/wsl-runtime-paths-lib.sh` for `WSL_RUNTIME_LOG_FILE`; Lua reads `diagnostics.wezterm.file` from `wezterm-x/local/constants.lua`; the Go picker honors `WEZTERM_RUNTIME_LOG_FILE` else derives the same XDG default.

When adding a new log writer, ask: **does this writer ever run on the other side of the WSL boundary?** Yes → file belongs on the writer's native FS, not the reader's. The cross-FS penalty is asymmetric and the writer is always the hot side.

## Render-path discipline

Code that paints a UI frame **must not call the logger inline**. Surfaces in scope:

- popup picker render functions (Go `cmd_*.go` `render()`, bash `render_picker()`)
- WezTerm `format-tab-title`, `update-status`, `user-var-changed` callbacks
- tmux right-status renderers (`scripts/runtime/tmux-status-*.sh`)

Reasons:

- A render path that fires once per keystroke produces rows nobody reads. The historical "log every paint" pattern in the pickers wrote one row per Up/Down keypress, but every consumer (`perf-trend.sh`, `bench-attention-popup.sh`) explicitly filters to `paint_kind="first"`.
- Even category-gated logging adds env lookups + string formatting to a loop where the p50 budget is single-digit ms.
- The frame painter is the wrong layer to judge "is this transition interesting enough to log?" — that is a state-transition concern.

Acceptable patterns:

1. **State-transition gate.** Log only when a tracked signature changes. `wezterm-x/lua/titles.lua` does this with `badge_last_status[tab_id] ~= current` and `last_rendered_status ~= signature` — copy that template.
2. **Once-per-popup perf event.** Emit one row at first paint, *after the first frame's bytes hit stdout*, from the **calling site** (the loop that drives `render()`), never from inside `render()` itself. Subsequent repaints emit nothing.
3. **Out-of-band timing flush.** When a render path needs to record latency, accumulate it into a struct field and flush from a non-render entry point (popup teardown, dispatch, exit).

If you genuinely need ad-hoc render-path debugging, gate it behind an explicit env var (`WEZTERM_DEBUG_RENDER=1`) and remove the call before commit.

## Categories

Add a new category only when an existing one would dilute its meaning. Currently registered:

- **bash** (`scripts/runtime/`): `attention`, `clipboard`, `command_panel`, `managed_command`, `primary_pane`, `provider`, `sync`, `task`, `vscode`, `workspace`, `worktree`
- **Lua** (`wezterm-x/lua/`): `attention`, `chrome`, `clipboard`, `command_panel`, `host_helper`, `hotkey`, `ime`, `vscode`, `workspace`
- **C# helper** (`windows-helper-manager`): owned outside this repo, treat as read-only

Rules:

1. **Lower-snake_case.** No spaces, no PascalCase, no dots inside the base name.
2. **`<base>.perf` is reserved for perf events** that follow the schema in [`performance.md`](./performance.md) "Perf-only logging". One `.perf` subcategory per UI surface (`attention.perf`, `command.perf`, `worktree.perf`, `links.perf`). Never reuse `<base>.perf` for non-perf events.
3. **Lifecycle / dispatch events live in the base category**, not in `.perf`. Base categories default-on; `.perf` is opt-in via `WEZTERM_RUNTIME_LOG_CATEGORIES`.
4. **One category per subsystem, not per file.** `attention-jump.sh`, `attention-state-lib.sh`, and `tmux-attention-picker.sh` all log under `attention`.
5. **Cross-language alignment.** When bash and Lua cooperate on one flow, use the same base name on both sides (`attention` on both, not `attention` vs `att`).

## Levels

| Level | Use for |
|---|---|
| `error` | unrecoverable failure for this invocation; the user-visible action did not happen |
| `warn` | recovered or fell back, but the user might want to know (manifest entry skipped, alternate path taken) |
| `info` | control-plane events: started X, finished X with `duration_ms`, decision Y reached |
| `debug` | verbose state dumps for active investigation; default-off at `WEZTERM_RUNTIME_LOG_LEVEL=info` |

Default level is `info`. Do not log at info level inside any loop that runs more than once per user action.

## Required fields

Every line gets `ts`, `level`, `source`, `category`, `message`, `trace_id` from the lib — do not add them manually.

Beyond those, the schema below is enforced by convention (no lint yet — break it deliberately or not at all):

- **Lifecycle "X started":** identifying fields the operation works on (`session_name`, `cwd`, `worktree_root`, …).
- **Lifecycle "X completed":** the same identifiers plus `duration_ms` — use `runtime_log_duration_ms "$start_ms"` in bash; the Lua side computes it inline.
- **`*.perf` rows:** `paint_kind="first"`, `picker_kind="go|bash"`, `panel="<name>"`, `total_ms`, `lua_ms`, `menu_ms`, `picker_ms`, `item_count`, `selected_index`. Do NOT emit `paint_kind="repaint"` — no consumer reads it and the noise hides real signal.

## Field names

Pick the name from the dictionary when one exists; coin a new field only when no existing one captures the meaning.

| Concept | Field |
|---|---|
| tmux session | `session_name` (not `session`, not `tmux_session`) |
| tmux window | `current_window_id` for the user's window, `window_id` for any other |
| pane id (tmux) | `pane_id` |
| pane id (WezTerm) | `wezterm_pane` |
| filesystem path | `cwd`, `worktree_root`, `repo_root`, `manifest_path` — full word, no abbreviations |
| count | `<noun>_count` (`item_count`, `pane_count`, `matched_process_count`) |
| duration | `duration_ms` — always ms, always integer |
| timestamp captured by writer | explicit unit suffix (`tick_ms`, `heartbeat_at_ms`) |
| picker variant | `picker_kind="go"` or `"bash"` |
| boolean | spell out: `osc_emitted="1"` not `emit="true"` — every value is a lib-quoted string |

The dictionary is small on purpose. Before inventing a field, grep existing log lines for an analogous one.
