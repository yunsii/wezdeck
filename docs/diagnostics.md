# Diagnostics

Use this doc when you need logs, smoke tests, or troubleshooting paths.

## Logging Defaults

- WezTerm-side diagnostics are configured in `wezterm-x/local/constants.lua` under `diagnostics.wezterm`.
- Runtime shell diagnostics are configured separately in `wezterm-x/local/runtime-logging.sh`, starting from `wezterm-x/local.example/runtime-logging.sh`.
- Both logging systems are enabled by default at the `info` level for control-plane events.

## Conventions for Emitting Logs

Author-facing rules — file placement, render-path discipline, category schema, levels, required fields, and the field-name dictionary — live in [`logging-conventions.md`](./logging-conventions.md). Read that doc before adding a new logger callsite, a new category, or a new log file.

## WezTerm Diagnostics

- When `diagnostics.wezterm.enabled = true`, WezTerm writes structured lines to the configured file and also shows them in the Debug Overlay.
- Current WezTerm-side diagnostics categories include `workspace`, `vscode`, `chrome`, `clipboard`, `command_panel`, `host_helper`, `hotkey`, `latency`, `agent_cli`, `attention`, `tab_visibility`, `event_bus`, `keybindings`, `layout`, and `link`. When `diagnostics.wezterm.categories` is a non-empty allowlist, every category you care to grep later must be listed as `true` — otherwise those rows are filtered at emit time (this is how Ctrl+n / keybinding / layout warnings went missing before).
- Set `diagnostics.wezterm.debug_key_events = true` only for keybinding investigations.
- WezTerm-side diagnostics rotate with `diagnostics.wezterm.max_bytes` and `diagnostics.wezterm.max_files`.

## Key / status latency

Occasional typing stutter or slow shortcuts usually means the WezTerm UI thread was busy. Ordinary character keys never enter Lua, so this surface measures two proxies and writes them to `%LOCALAPPDATA%\wezterm-runtime\logs\wezterm.log`:

| Signal | Meaning | Default gate |
|---|---|---|
| `category="latency" message="slow key handler"` | A WezTerm-layer manifest hotkey's `perform_action` (including usage bump) took too long | `duration_ms >= 50` |
| `category="latency" message="slow status tick"` | One `update-status` callback (250 ms cadence) took too long — the closest proxy for "typing felt sticky" | `duration_ms >= 40` |

Shared fields: `duration_ms`, `threshold_ms`, `kind="hotkey|status"`, plus `hotkey_id` / `workspace` / `pane_id` / `domain` / `foreground` when available.

Slow **status** rows also attach a phase breakdown (ms) so a sticky tick can be attributed without turning on `emit_all`:

| Field | Block in `titles.lua` `update-status` |
|---|---|
| `phase_left_ms` | focus marker + left-status workspace label |
| `phase_tabvis_ms` | `tab_visibility.tick` + sample / overflow-collision / hot-reorder |
| `phase_prefetch_ms` | `refresh_all_items_snapshots` + background overflow-base rebuild |
| `phase_attention_ms` | per-tick cache reset, TTL prune, focus-ack |
| `phase_live_snap_ms` | `attention.maybe_refresh_live_snapshot` (1 s throttle) |
| `phase_event_bus_ms` | `event_bus.poll_files` |
| `phase_right_ms` | right-status segments + render log |

These fields are investigation instrumentation; drop them once the sticky-tick owner is fixed and verified.

**2026-08-27 sticky Alt+c/w:** slow ticks were ~every 5s with `phase_prefetch_ms` p50≈810ms — `refresh_all_items_snapshots` matching tabs via repeated `pane:get_current_working_dir()` (O(tabs×items) on hybrid-wsl). Fix: title-first match + at most one cwd resolve per tab, and skip the NTFS rewrite when the snapshot body is unchanged. Re-check with `grep phase_prefetch_ms= …/wezterm.log | tail`.

**Slow rows also attach a guest-pressure snapshot** (only when `duration_ms` crosses the gate — never on the quiet path or on `latency.perf` under-threshold samples):

| Field | Source |
|---|---|
| `mem_level` / `mem_used_pct` / `mem_avail_mib` / `swap_used_pct` | `state/oom-guard/status.json` (same file as the `M·` badge) |
| `loadavg_1` / `loadavg_5` / `loadavg_15` | guest `/proc/loadavg`, published by `wsl-oom-guard.sh` |
| `proc_runnable` / `proc_total` | runnable/total from the same loadavg line |
| `top_comm` / `top_rss_mib` | only when the badge level is not `ok` |

Reads are cached ~2 s (`diagnostics.wezterm.latency.pressure_cache_ms`) so a storm of slow ticks shares one NTFS open. Disable with `pressure_enrich = false`. Freshness follows the oom-record publish cadence (~30 s) — enough to tell "was the guest hot?" after a sticky-typing report, not a profiler.

Config (tracked defaults in `wezterm-x/lua/constants.lua`, override in `wezterm-x/local/constants.lua`):

```lua
diagnostics = {
  wezterm = {
    latency = {
      hotkey_slow_ms = 50,
      status_slow_ms = 40,
      emit_all = false,  -- true → also write every sample under latency.perf
      -- pressure_enrich = false,       -- opt out of mem/loadavg on slow rows
      -- pressure_cache_ms = 2000,
    },
    -- If you use a categories allowlist, keep latency = true or slow
    -- rows are filtered out by the logger.
    categories = { latency = true, --[[ … ]] },
  },
}
```

Operator commands:

```bash
# Daily slow-event counts + p50/p95 from wezterm.log
scripts/dev/latency-report.sh

# Only workspace switches / only status ticks
scripts/dev/latency-report.sh --hotkey-id workspace.switch
scripts/dev/latency-report.sh --kind status

# Live tail while reproducing a stutter (shows mem/loadavg when present)
scripts/dev/latency-report.sh --watch

# One day's slow rows with pressure columns
scripts/dev/latency-report.sh --raw today
```

Limits: this does not measure GPU frame time, WSL/tmux internal lag, or OS IME candidate-window delay. A quiet log during a felt stutter means the blockage is outside these Lua callbacks — use that as a negative signal, not as "nothing happened". Pressure fields are guest-side (WSL); they will not explain a Windows-host-only CPU spike.

## Runtime Diagnostics

- When `WEZTERM_RUNTIME_LOG_ENABLED=1`, the runtime scripts append structured lines to `WEZTERM_RUNTIME_LOG_FILE`.
- `sync-runtime.sh` prints a one-line tmux reload result to the terminal, while the full structured detail still goes to `WEZTERM_RUNTIME_LOG_FILE`.
- `sync-runtime.sh` also prints `[sync] step=...` milestones for the chosen target, helper install, bootstrap refresh, and tmux reload status. Each gated step (`helper-install`, `helper-ensure`, `lua-precheck`, `deps-check`) emits an explicit `status=skipped reason=...` line when its skip-if-current check passed; full reasons + force-bypass envs are tabulated in [`daily-workflow.md#skip-if-current-and-force-overrides`](./daily-workflow.md#skip-if-current-and-force-overrides).
- Runtime logs rotate with `WEZTERM_RUNTIME_LOG_ROTATE_BYTES` and `WEZTERM_RUNTIME_LOG_ROTATE_COUNT`.
- Leave `WEZTERM_RUNTIME_LOG_CATEGORIES` empty to capture all runtime categories, or set a comma-separated list such as `vscode,workspace,worktree`.
- Current runtime categories include `vscode`, `workspace` (includes F5 `refresh-current-window` invoked/completed/failed), `worktree`, `managed_command`, `command_panel`, `task`, `provider`, `sync`, `agent_cli` (Ctrl+n `/new` vs `clear` + pane role tag set/clear), `attention` (jump toast / empty / completed), `layout`, and `session_bridge` (`Ctrl+k w` claw take).

### Ctrl+n / agent `/new` did nothing

`Ctrl+n` is decided on the **tmux** side (`scripts/runtime/agent-ctrl-n.sh`), not in WezTerm Lua. Lua only logs that it forwarded `\x0e`; the match / `/new` / `clear` outcome is in WSL `runtime.log`.

| Where | What to grep |
|---|---|
| `%LOCALAPPDATA%\wezterm-runtime\logs\wezterm.log` | `category="agent_cli"` — `forwarding Ctrl+n to tmux-backed pane` (key reached Lua) |
| `~/.local/state/wezterm-runtime/logs/runtime.log` | `category="agent_cli"` — decision |

Decision messages in `runtime.log`:

| level | message | Meaning |
|---|---|---|
| `info` | `Ctrl+n matched agent pane; staging /new` | `@agent_pane_match=1` → injected `/new` |
| `info` | `Ctrl+n non-agent pane; injecting clear` | normal non-agent pane → injected `clear`+Enter |
| `warn` | `Ctrl+n pass-through on suspected agent pane (missing @wezterm_pane_role?)` | leaf is `sh`/`node`, window has managed `primary_command`, but pane role tag empty — keep raw `Ctrl+n` (do not clear into a likely agent composer); the Alt+g tagging-gap class of bug |
| `info` | `Ctrl+n completed` | terminal row; `outcome=new\|clear\|pass_through_suspected\|aborted` + `duration_ms` (no toast — keystrokes are the UX) |

Useful fields on those rows: `pane_id`, `session_name`, `window_id`, `cwd`, `pane_current_command`, `pane_role`, `agent_pane_match`, `primary_command`, `outcome`, `duration_ms`.

```bash
# After reproducing a dead Ctrl+n:
grep 'category="agent_cli"' ~/.local/state/wezterm-runtime/logs/runtime.log | tail

# Live pane probe (no keypress needed):
tmux display-message -p \
  'cmd=#{pane_current_command} role=#{@wezterm_pane_role} match=#{E:#{@agent_pane_match}}'
```

Heal a suspected miss without refresh:  
`tmux set-option -p -t <pane_id> @wezterm_pane_role agent-cli:<claude|codex|grok>`  
Or re-select the worktree via `Alt+g` (retag on select) / run session refresh.

Tag lifecycle (same `agent_cli` category): `set primary pane agent role tag` / `cleared primary pane agent role tag` from `ensure_primary_pane_role_tag`.

### Attention jump / Claw take toast-only gaps

| Symptom | Grep |
|---|---|
| Alt+j/k/l or User1/User2 “did nothing” | `category="attention"` in `runtime.log` — `attention jump toast` / `attention jump empty` / `attention jump completed` |
| `Ctrl+k w` claw take failed | `category="session_bridge"` — `session-bridge take failed` (toast alone used to evaporate) |

Lua-side Alt+j/k/l also writes `attention` rows to `wezterm.log` when allowlisted.

### F5 / refresh current window

`F5` is decided on the **tmux** side (`scripts/runtime/session-refresh-current-window.sh` via `User3`). WezTerm only logs that it forwarded `\e[20102~`; the heal + respawn outcome is in WSL `runtime.log`. Toast alone evaporates — always grep the terminal row.

| Where | What to grep |
|---|---|
| `%LOCALAPPDATA%\wezterm-runtime\logs\wezterm.log` | `hotkey_id="session.refresh-current-window"` / `forwarding F5` (key reached Lua) |
| `~/.local/state/wezterm-runtime/logs/runtime.log` | `F5 refresh-current-window` |

| level | message | Meaning |
|---|---|---|
| `info` | `F5 refresh-current-window invoked` | User3 script started |
| `info` | `F5 refresh-current-window completed` | heal + respawn finished; fields include `duration_ms`, `outcome=respawned`, `toast=` |
| `warn` | `F5 refresh-current-window failed` | reset non-zero; `duration_ms`, `exit_code`, `toast=` — wrapper still exits 0 so tmux does not append `returned N` |

If the pane lands in status `COPY` with an empty grid after F5, that was historically **view-mode** opened because `run-shell` received stdout (`reset_window_in_place`). The wrapper now discards reset stdout; a leftover mode is cancelled on the success path. Confirm with `tmux display-message -p -t <pane> '#{pane_in_mode} #{pane_mode}'` (`view-mode` / `copy-mode` vs empty).

```bash
grep 'F5 refresh-current-window' ~/.local/state/wezterm-runtime/logs/runtime.log | tail
```

### Destructive hotkeys (pane close / palette refresh-*)

| Symptom | Grep |
|---|---|
| `Ctrl+k x` close pane unclear | `category="workspace"` — `pane close-current invoked` / `completed` / `failed` (`outcome=killed`, `closes_window=0\|1`, `toast=`) |
| Palette Refresh session / workspace / all “did nothing” | `category="workspace"` — `session refresh invoked` / `completed` / `failed` (`action=refresh-current-session\|…`, `outcome=refreshed_*`) plus `command_panel` item completed/failed |

```bash
grep -E 'pane close-current|session refresh ' ~/.local/state/wezterm-runtime/logs/runtime.log | tail
```

### Sync-side state files

Three small artifacts under `$WEZTERM_RUNTIME_STATE_DIR` (i.e. `%LOCALAPPDATA%\wezterm-runtime\` in hybrid-wsl) drive sync's skip-if-current decisions; deleting any of them forces the next sync to run the corresponding gate from scratch:

- `bin/helper-install-state.json` — written by the PowerShell installer at the end of every successful install. Its **mtime** is sync-runtime's "last successful helper install" marker; `find -newer` on `native/host-helper/windows/src/**` and the `release-manifest.json` against this file decides whether `dotnet publish` runs again.
- `state/helper/state.env` — written by the running helper-manager every ~250ms. `ready=1` + filesystem mtime within ~10s of now is sync-runtime's "helper alive" signal that lets `helper-ensure` skip the PowerShell round-trip. CRLF line endings (PowerShell-written) — readers must strip `\r` before string-comparing values.
- `lua-precheck.ok` — empty sentinel touched by `sync-runtime.sh` after each successful Lua precheck. `find -newer` on `~/.wezterm-x/lua/`, `~/.wezterm-x/repo-worktree-task.env`, and the precheck script itself against this file decides whether to re-run the precheck.

`logs/deps-check.log` is a separate artifact: it's both the deps-check output (since the check now runs detached, see daily-workflow.md) AND the daily-rate-limit gate (its mtime date is compared against today's date).

## Traceability

- Runtime and WezTerm log lines include a shared `trace_id` so related subprocesses can be correlated while debugging.
- In `hybrid-wsl`, `%LOCALAPPDATA%\wezterm-runtime\logs\wezterm.log` and `%LOCALAPPDATA%\wezterm-runtime\logs\helper.log` are the main diagnostics files.
- Host-helper reuse diagnostics emit explicit decision fields such as `decision_path`, `registry_hit`, `matched_process_count`, `matched_process_ids`, and `matched_window_found`.
- The helper installer prints and records its chosen source as `install_source=local|release`, and writes the last installed release metadata to `%LOCALAPPDATA%\wezterm-runtime\bin\helper-install-state.json`.
- Release installs also report `release_archive_source`, `release_archive_path`, and `release_download_url` so you can distinguish cache hits, manually preloaded archives, URL overrides, and direct manifest downloads.

## Hotkey Usage Counter

Aggregate press counts — no event log — for every WezTerm keymap entry and the tmux command-chord actions. The counter is meant for "do I press this often enough to deserve a better key" decisions, not forensics.

- Storage: `~/.local/state/wezterm-runtime/state/hotkey-usage.json` (WSL ext4 via `WSL_HOTKEY_USAGE_FILE` in `wsl-runtime-paths-lib.sh`). Pure WSL bash writer + reader — not under `%LOCALAPPDATA%`. Single JSON file, no rotation.
- File layout (versioned):

```json
{
  "schema_version": 1,
  "updated_at": "<ISO8601 UTC>",
  "hotkeys": {
    "<manifest.id>": {
      "count": <int>,
      "first_seen": "<ISO8601 UTC>",
      "last_seen":  "<ISO8601 UTC>"
    }
  }
}
```

- Writers (both take the same `<hotkey_id>` argument and share a file lock):
  - WezTerm side: [`wezterm-x/lua/usage.lua`](../wezterm-x/lua/usage.lua) spawns [`scripts/runtime/hotkey-usage-bump.sh`](../scripts/runtime/hotkey-usage-bump.sh) via `background_child_process` (fire-and-forget; no blocking on the keypress path).
  - tmux chord side: each `command-chord` binding in `tmux.conf` prefixes the action with `run-shell -b "bash .../hotkey-usage-bump.sh <id>"`.
- Ids are the manifest entry ids from [`wezterm-x/commands/manifest.json`](../wezterm-x/commands/manifest.json). Every hotkey should be registered there (enforced by the rule in [`AGENTS.md`](../AGENTS.md)); ad-hoc ids that ever slip through render with label `(unregistered)` in the report, which is the signal to add the missing manifest entry.
- Run [`scripts/dev/hotkey-usage-report.sh`](../scripts/dev/hotkey-usage-report.sh) for a sorted table (count, keys, id, label, first-seen, last-seen ages). `--json` dumps the raw counter, `--path` prints the resolved file path.
- Deleting the counter file is safe and resets all counts; the bump script recreates it on the next press.
- The counter is aggregate-only. For **per-press audit** of WezTerm-layer bindings, look at `category="hotkey"` rows in `%LOCALAPPDATA%\wezterm-runtime\logs\wezterm.log` (filtered via `diagnostics.wezterm.categories` — keep `hotkey = true` when using an allowlist):

  | message | Meaning |
  |---|---|
  | `pressed` | Keymap wrap entered — the binding fired (or at least reached Lua after any UI-thread queue) |
  | `dispatched` | `perform_action` returned — `ok="1"` means no Lua error; `duration_ms` is wrap wall time |

  Shared fields: `hotkey_id`, `workspace`, `pane_id`, `domain`. Nested action logs (for example `category="workspace" message="workspace open completed"`) carry the same `hotkey_id` when the open was driven by a hotkey wrap, so one grep correlates press → business logic:

  ```bash
  grep 'hotkey_id="workspace.switch-work"' \
    /mnt/c/Users/*/AppData/Local/wezterm-runtime/logs/wezterm.log | tail
  ```

  How to read a "key did nothing" report:
  1. **No `pressed`** — binding never reached Lua (IME swallow, wrong layer, focus elsewhere, or UI thread still blocked so the wrap has not run yet).
  2. **`pressed` but no `dispatched`** — handler still running / crashed before return (`ok="0"` on a later dispatched row).
  3. **`dispatched ok=1` but no matching action log** — wrap finished but the action was a no-op or lives outside logged code (built-in WezTerm action with no Lua side effect).
  4. **Both hotkey rows + action log** — logic ran; if the UI still felt stuck, look at preceding `slow status tick` / `phase_*` rows.

  tmux chord bumps do **not** emit these lines (the shell bump path has no pane context); only WezTerm keymap wraps do.

## Workflow timeline

Derived **day loop** projection over WezDeck / helper / OpenClaw logs — for
reconstructing how you moved through workspaces / worktrees / attention /
host verify / OS foreground / recycle / interop.

- Entry: [`scripts/dev/workflow-timeline.sh`](../scripts/dev/workflow-timeline.sh)
  (Python projector: `scripts/dev/workflow-timeline.py`).
- Sources (resolved via runtime path libs):
  - `%LOCALAPPDATA%\wezterm-runtime\logs\wezterm.log` — `workspace.enter`,
    mapped hotkey `dispatched` (j/k/l, overlay, overflow, tab, worktree create
    hotkeys, vscode/chrome), Alt+v forward.
  - `~/.local/state/wezterm-runtime/logs/runtime.log` — worktree
    select/create/switch, `session.focus_restore`, `agent.resume_boot` /
    `agent.resume_fallback_fresh`, tmux-chord `hotkey` presses, attention
    **status edges** (`running`/`waiting`/`done` only; `resolved` skipped),
    recycle/reclaim, vscode IPC, human-run propose.
  - `%LOCALAPPDATA%\wezterm-runtime\logs\helper.log` — `host.foreground`
    (`category=foreground message="foreground changed"`; process names only).
  - `~/.openclaw/logs/session-bridge-audit.jsonl` when present — `interop.*`
    (**`preview` stripped**; `text_hash` kept).
- Optional write: `--write` →
  `~/.local/state/wezterm-runtime/state/workflow/day-YYYY-MM-DD.jsonl`
  (`WSL_WORKFLOW_DIR`; recomputable, safe to delete).
- Examples:

```bash
scripts/dev/workflow-timeline.sh                  # today, table (no status edges)
scripts/dev/workflow-timeline.sh --summary
scripts/dev/workflow-timeline.sh --include-transitions   # add running/waiting/done edges
scripts/dev/workflow-timeline.sh --kind host.foreground
scripts/dev/workflow-timeline.sh --write --paths
```

- Default output omits `attention.transition` (pass `--include-transitions`
  for status forensics).
- Privacy: no agent chat / `last_user_prompt`; no audit preview; no window titles.

### Foreground sampling (device profile)

Host helper samples the OS foreground process name on each heartbeat and logs
**only on process-name change**. This gate applies **only** to OS foreground
rows in `helper.log` — WezDeck-internal collection (hotkeys, worktree,
attention, resume, vscode/chrome opens, …) stays on regardless.

Configure in machine-local `wezterm-x/local/constants.lua` (template:
[`wezterm-x/local.example/constants.lua`](../wezterm-x/local.example/constants.lua)):

```lua
workflow = {
  -- personal (default): allowlist WezTerm + VS Code + Chrome
  -- work: every foreground process-name change
  device_profile = 'personal',
  -- foreground_sampling = 'off',  -- mute OS foreground logs only
  -- foreground_allowlist = { 'wezterm-gui', 'Code', 'chrome' },
}
```

Written into `manager-config.json` as `foregroundSampling.{mode,allowlist}` when
the helper is ensured. Reload WezTerm (or re-run ensure) after changing local
constants so the helper picks up a new `configHash`.

## Smoke Tests

- For a repeatable live smoke test of the Windows runtime host, run [`scripts/dev/check-windows-runtime-host.sh`](../scripts/dev/check-windows-runtime-host.sh) from WSL.
- The Windows host smoke test validates both text and image clipboard IPC, including the tracked [`assets/copy-test.png`](../assets/copy-test.png) path.
- For the repo-local agent clipboard wrapper, run [`scripts/dev/check-agent-clipboard.sh`](../scripts/dev/check-agent-clipboard.sh) from WSL. It writes text through `scripts/runtime/agent-clipboard.sh`, reads it back through `resolve_for_paste`, then repeats the flow for the tracked image asset.
- For dependency drift (wezterm / tmux / go) against upstream latest and the repo's declared floors (tmux 3.7 in `scripts/runtime/tmux-version-lib.sh`, go 1.21 in `native/picker/go.mod`; wezterm has no floor), run [`scripts/dev/check-deps-updates.sh`](../scripts/dev/check-deps-updates.sh) from WSL. Read-only; skips `go` when no `go` binary is on PATH; degrades to `offline?` when GitHub or `go.dev` are unreachable. Exits non-zero on floor violation or "update available". Also runs automatically as the last `sync-runtime.sh` step in advisory mode (`--advisory --no-color --timeout 4 --prefix '[sync] '`); set `WEZTERM_SYNC_SKIP_DEPS_CHECK=1` to skip it during sync.
- For tmux reset regressions, prefer the isolated repo test suite:

```bash
bash tests/tmux-reset/run.sh
```

- For the agent-attention pipeline, run [`scripts/dev/test-agent-attention.sh`](../scripts/dev/test-agent-attention.sh) from inside a WezTerm pane. The default subcommand drives the real hook, asserts the shared state file reflects each transition, and polls `wezterm.log` for a `category="attention" message="tick received"` line per emission. State keys on `pane:<WEZTERM_PANE>` so the entry is scoped to the current WezTerm pane and the run ends with it removed.
- Subcommands: `cycle-visual` for a slower human-in-the-loop demo with 3-second pauses; `running` / `waiting` / `done` / `cleared` / `resolved` to exercise a single state transition (caller cleans up); `show` to dump the current state file via `jq`; `clear-all` to truncate the state file and nudge WezTerm to redraw — useful after manual experimentation leaves stale entries. `resolved` mirrors the `PostToolUse` hook and is a conditional transition: `waiting` or `done` flips to `running` in place (preserving the entry so the counter reflects mid-turn work — including a Monitor subscription that woke the agent after a prior `Stop`), a missing entry is upserted as `running`, and `running` is a no-op that skips the OSC tick so diagnostics stay quiet on auto-allowed tool calls.

## Hybrid WSL Startup Measurement

- Use [`scripts/dev/install-hybrid-wsl-agent-startup-desktop-script.sh`](../scripts/dev/install-hybrid-wsl-agent-startup-desktop-script.sh) from WSL when you want a Windows-side PowerShell test script for the currently configured managed agent CLI across the full hybrid `WSL + login shell + agent CLI` launch path.
- The generated PowerShell wrapper invokes [`scripts/dev/measure-hybrid-wsl-agent-startup.ps1`](../scripts/dev/measure-hybrid-wsl-agent-startup.ps1) with the resolved agent command baked in.
- Run the generator from the target repo root or pass `--cwd /path/to/repo` to resolve a different project context.

Example:

```bash
scripts/dev/install-hybrid-wsl-agent-startup-desktop-script.sh
```

After the wrapper is placed on the Desktop, run it from Windows PowerShell with execution policy bypass:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\your-user\Desktop\measure-hybrid-wsl-agent-startup-your-repo.ps1 -Pause
```

## Guest OOM Hardening

Guest-memory failure modes (distro restart loop, reclaim livelock, high-order allocation / VM reboot), the `M·…` badge, earlyoom, and standing memory consumers live in [`guest-oom.md`](./guest-oom.md). Read that doc when the whole WSL distro vanishes on an interval, cores pin with no OOM record, or vsock dies while swap still looks healthy.

## Host Disk Space

Host volume headroom (`ext4.vhdx` growth, sparse-VHD trap, `fstrim` → shutdown → Optimize-VHD / compact, disk-guard `D·…` badge, OEM preinstalls) lives in [`host-disk.md`](./host-disk.md).

## Troubleshooting Notes

- If the host volume is full or nearly full, do **not** start by hunting for files on the Windows side — compare `df -h /` against the size of `ext4.vhdx` first. A large gap means the space is trapped in the vhdx and no host-side deletion will touch it; see [`host-disk.md`](./host-disk.md) for the trim-then-compact procedure and why `--set-sparse` is the wrong fix.
- If the whole distro disappears — tmux, every agent pane, all at once — and especially if it then keeps coming back and dying on a fixed interval, suspect guest OOM before suspecting WezTerm or tmux. Start from [`guest-oom.md`](./guest-oom.md): check `dmesg` timestamp continuity to tell a distro restart from a VM reboot, then read the previous instance's shutdown log for `init.scope: Failed with result 'oom-kill'` and the `memory peak` / `memory swap peak` line (`journalctl --file /var/log/journal/<machine-id>/system@<seq>.journal~ -n 60 --no-pager`).
- **Sticky title says repo A, `Alt+l` lands on `…`, overflow shows browse.** Grep `level="warn".*inconsistent:` in `wezterm.log`. Messages: `sticky title/session mismatch`, `jump projected to overflow despite sticky-visible tab`, `overflow collision on ghost-visible session` (fields: `session` / `tab_title` / `titled_host_session` / `fought_recent_project`). Pair with `live-panes.json` (`tab_title` vs `tmux_session`) and `pane-session/<id>.txt`.
- For agent-attention "stuck running / done not clearing / right-status not refreshing" reports, **first verify the hook→render latency in the logs before suspecting render or cache layers**. Producer side: `grep "hook emitted agent status" ~/.local/state/wezterm-runtime/logs/runtime.log` — `elapsed_ms` should be ~100–300 ms with `osc_emitted=1`. Renderer side: in the WezTerm log under `%LOCALAPPDATA%\wezterm-runtime\logs\wezterm.log`, the `category="attention"` lines (`render_status` / `focus ack scheduled` / `jump dispatched`) for the same `session_id` should land in the same frame as the producer's `tick_ms`. If both are normal, the UI is not at fault — pivot upstream: read `attention.json.entries[<id>]` plus `recent[]` and look for whether the producer ever emitted a transition (long stretches of `hook resolved no-op` between a `running` and the next `done` mean the agent really was running, not stuck — Claude Code's protocol only updates status on UserPromptSubmit/Stop, all PreToolUse/PostToolUse runs resolve to no-op).
- **Hook / wrapper self-check (no need to paste CLI "hook failed, ignored").** Agent CLI hooks and the Grok focus-filter wrapper write warn/error into `~/.local/state/wezterm-runtime/logs/runtime.log` (`attention` / `primary_pane`). When a hook aborts under `set -u` or ensure/theme heal fails, look here first:

  ```bash
  LOG="${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/logs/runtime.log"
  grep -E 'level="(error|warn)"' "$LOG" | tail -40
  grep -E 'hook aborted|adapter payload degraded|grok theme|focus-filter unhealthy|agent launcher failed' "$LOG" | tail -40
  ```

  Messages: `hook aborted` (emit non-zero exit), `adapter payload degraded` (JSON with no usable fields), `grok theme patch failed` / `grok theme patched`, `grok focus-filter unhealthy`, `agent launcher failed`. Intentional attention skips stay `info`.
- If the tmux status line still reflects stale branch or change counts after a local `git` command and only catches up on the next 30s poll, the recommended prompt hook is probably not installed. From an affected tmux pane run `typeset -f __tmux_status_prompt_refresh >/dev/null && echo ok || echo missing`; when it prints `missing`, add the source line documented in [`setup.md`](./setup.md#tmux-status-prompt-hook) to your shell rc and re-source it — existing shells will not pick up the hook until you do.
- If a managed tab’s layout looks wrong (uneven panes, content not filling the WezTerm window, status “too tall”) and `list-panes` already looks ~equal: **compare PTY `TIOCGWINSZ` to `tmux list-clients` size before trusting pane ratios.** WezTerm can grow the pts while `tmux attach` keeps a stale client size; `refresh-client -S` alone often does not converge. Full symptom table, triage commands, and fix-layout steps: [`tmux-ui.md#layout-heal-fix-layout`](./tmux-ui.md#layout-heal-fix-layout).
- If text paste is fast but image-path paste stops working in `hybrid-wsl`, sync the runtime, let WezTerm auto-reload, and inspect the shared `trace_id` across the WezTerm and helper logs.
- In `hybrid-wsl`, WezTerm prewarms the host helper during GUI startup, then still falls back to on-demand ensure when the helper later goes stale or bootstrap state is missing.
- To reproduce the release fallback on a machine that already has Windows `dotnet`, run sync with `WEZTERM_WINDOWS_HELPER_INSTALL_SOURCE=release` and inspect `helper-install-state.json` plus the `[helper-install]` terminal lines for `installed_source`, `release_version`, and the installed binary paths.
- If GitHub downloads are too slow, place the zip at `%LOCALAPPDATA%\wezterm-runtime\artifacts\host-helper\<version>\<assetName>` or set `WEZTERM_WINDOWS_HELPER_RELEASE_ARCHIVE`, then rerun sync and confirm `release_archive_source=preload_versioned|preload_flat|explicit_archive`.

## Open questions

Things left unverified or deliberately deferred, with how to close them. Dated so staleness is visible — a claim here older than the code it describes should be re-checked, not trusted.

1. **`agent-cleanup.sh --kill` on a stopped process group is unverified end to end** (2026-07-29). The `SIGCONT`-then-verify path was added after observing the same pgid "terminated" every 30 minutes for 38 hours, but the fix itself was never run against a live stopped group — the local auto-mode classifier blocks `kill`, and the one real specimen was cleaned up manually before the fix landed. Closes when a `lingering=` field or a `signalled … but it is still alive` line shows up in `runtime.log`, or by deliberately `kill -STOP`-ing a throwaway process group and running `--kill --min-age 0` against it. Until then, treat `killed=` in that script's logs as "signalled and confirmed gone" only for non-stopped groups.
2. **`uxc-session-reaper.sh` reports `reclaimed` slightly before it is true** (2026-07-29). `uxc daemon stop` returns once the daemon is down, but the stdio children exit asynchronously — a check immediately afterwards can still see `child_pid` alive, and a check a moment later finds it gone with no orphans. The outcome is correct, only the wording leads. Left alone deliberately: adding a poll loop would trade real complexity for a cosmetic fix. Revisit only if an orphan is ever actually observed.
3. **Next.js dev servers reach ~6 Gi of swap on their own** (2026-07-29). Independent of the MCP work: one `next dev` process was found holding 5.95 Gi of swap with `VmHWM` 6.8 Gi, was cleaned up, and a freshly started one reached 6.1 Gi again within hours. Nothing in this repo manages those processes; restarting them periodically is currently the only mitigation. Worth a decision on whether that belongs in `agent-cleanup.sh`'s scope or stays manual.
4. **Concurrent sessions share one MCP process, so they also share its page-selection state** (2026-07-29). Be precise about what changed, because concurrent interference is **not** new — every MCP instance, resident or uxc-managed, drives the same Chrome on 9222, so anything living in the browser (pages, DOM, login state) was always shared. What moved is the state that lives in the *MCP process*: the selected page and the snapshot `uid` map. The daemon keys sessions on `stdio:{endpoint}:{auth_fingerprint}` with no caller identity, so all agents land on one child and now share those too.

   | scenario | resident MCP | via uxc |
   |---|---|---|
   | two sessions driving the **same** page | already unsafe (browser-level) | unchanged |
   | two sessions driving **different** pages | safe | **can cross wires** |

   So the delta is exactly one case: work on separate pages, previously safe, can now silently mis-target — A selects page 2, B selects page 5, A's next `take_snapshot` returns page 5 without erroring. Wrong data, no failure signal. Do not read this as "uxc introduced concurrency problems"; the browser-level ones predate it and reverting to resident MCP would not fix them.

   The mitigation is `--experimentalPageIdRouting`, which removes the implicit selected-page: measured, it turns `take_snapshot` into `required: ['pageId']`, `click` into `required: ['pageId', 'uid']`, and leaves `list_pages` as the only page-scoped tool needing no id. Its cost is that it **breaks every example in upstream's skill** (`click uid=3_0` starts failing on a missing `pageId`), and upstream documents no such mode. A second option — a distinct endpoint string yields a distinct `session_key` and hence a separate process — isolates fully but gives back the single-instance win.

   `pageId` is safe to hold onto: it is a stable allocated id, not a list position. Verified by opening two scratch pages (6, 7), closing 6, and confirming 7 stayed 7 rather than sliding down — consistent with v1.6.0's `keep page ids unique across browser reconnects` (#2345). Ids do differ between *separate* MCP process instances, which is why two `list_pages` runs against different children can order the same tabs differently; within one child they are stable. So routing is a sound fix, not a partial one.

   Neither is applied yet: the collision needs two agents driving the browser inside the same 10-minute window, plausible here but not routine. Escalate to `--experimentalPageIdRouting` the first time a snapshot is observed returning the wrong page — do not wait for a second occurrence, since the failure is silent.
5. ~~**`goMemLimit: "6GiB"` is applied; the CPU benefit is still unproven**~~ → **closed 2026-08-04 19:31.** The fix is verified, and the diagnosis survived its falsification test. Reloaded at 17:03; 2 h 28 m later the `ai-video-collection` server sat at **RSS 3.55 Gi — past the old 3 GiB cliff — on 14 m 41 s of CPU (10.2 % average, and 4 of 6 instantaneous 10 s samples at 0 %)**. Under the old limit that same RSS meant a permanent 145 %, so this is the decisive comparison: **CPU −93 % at equal-or-higher memory**. `VmHWM` reached 5.21 Gi and RSS then fell back to 3.55 Gi, which the old configuration could never do — it could not get below 3.94 Gi. Swap 0.

   Two notes for whoever reads this later. **The tripwire is live heap, not peak RSS.** The 5.21 Gi peak is GC slack (`GOGC=100` grows the heap toward 2× live before collecting), and a soft limit only turns pathological when *live* heap exceeds it — live is ~2.9–3.6 Gi here, so the 6 GiB ceiling still has ~2× headroom despite the peak looking close. **And per-project cost is not a fixed number**: at the same moment, the `dev-web-cmdb` worktree of the *same* monorepo held 58 Mi on 2 s of CPU, 63× less, purely because no TS file had been opened in that window. tsgo's cost tracks which `tsconfig` projects get loaded by the files you actually open, not repository size — so "one resident cost per project" badly overestimates.
6. **Where the heap goes — and why it grows 2.82 → 3.94 Gi over a day — is unmeasured** (2026-08-04). Raising the limit stops the CPU burn but does not make the heap smaller. Two separate questions: whether ~2.8 Gi is a reasonable cold cost for this monorepo's type information, and whether the +1.1 Gi drift across 21 h of editing is legitimate working set or a leak. The second matters more, because a leak would eventually cross any limit and reinstate the burn. The extension exposes `js/ts.server.pprofDir` plus `dev.saveHeapProfile` / `dev.saveAllocProfile` commands, so a real heap profile is available — it needs a Go toolchain for `go tool pprof`, which is not installed here. Until someone looks, "3.9 Gi is just what this project costs" is an assumption, not a finding.
7. **`validate.enabled: false` looks honoured; the rest of the tuning block is still unverified** (2026-08-04, revised same day). The earlier reading here — "delivered but seemingly ignored, because `textDocument/diagnostic` keeps being handled" — was **too strong**. Latency settles it: 97.7 % of 9 631 diagnostic calls return under 5 ms (p50 0.23 ms), which cannot be real type checking, so the key stops the *checking* while VS Code's pull-diagnostics client keeps issuing *requests* on its own schedule. Part (a) of this is now **closed**: the slow tail was requests blocking behind project load, not checking — proved by the disabled `inlayHint` accumulating 13.3 s it cannot have spent working, and confirmed on a clean post-reload log where only 2 of 131 calls exceeded 500 ms, both inside the 5-second startup window. What remains open: `suggest.autoImports: false` is delivered yet `Built autoimport registry` still appears in the logs, and no latency argument has been made for it. Closes per key by dumping the `config:"…"` struct tags from the `tsgo` binary and matching them against observed behaviour, not against the settings schema.
8. **The tmux status poll fires at ~44s, not the configured 30s** (2026-08-05). Traced while fixing the concurrent-refresh drop described in [`tmux-ui.md`](./tmux-ui.md): two independent draw-path invocations decided to poll at `age=44` and `age=45` against `@tmux_status_poll_interval 30`. The poll is lazy — it only evaluates when tmux re-runs the `status-format[0]` `#()` job, so the real cadence is `status-interval` **plus** whatever the job scheduler adds under load, not the option value. It stopped being load-bearing now that a forced refresh waits for the lock instead of being dropped, but any future reasoning that treats 30s as the worst-case staleness bound is wrong by ~50%. Closes by timestamping consecutive `reason=poll` decisions for one session over a quiet hour and comparing against `status-interval`, or by moving the fallback poll off the draw path entirely.
9. **One option write repaints every attached client, so a single refresh forks ~3×N job processes** (2026-08-05). Same trace: each `tmux set-option -t <session> @tmux_status_line_*` made all 11 attached clients redraw their status, and each redraw ran all three `status-format` `#()` scripts — 33 short-lived bash processes per refresh, for a change that concerns exactly one session. With 11 sessions each polling on its own timer this is a standing background cost, and it is the most likely reason the poll cadence above degrades under load. Not fixed here: the change would be structural (collapse the three lines into one job, or stop having the draw path read options tmux itself just wrote). Closes by measuring `fork`s per refresh (`perf stat -e` or a wrapper counter) before and after collapsing the three `status-format` jobs into one.
10. **Reconnect cost is unmeasured, and it is the real argument against a short TTL** (2026-07-29). A freshly spawned session reached 1411 Mi within 6 minutes of being created against three open tabs (one of them a Grafana explore view) — the collectors appear to absorb the current pages' history on attach, not just events arriving afterwards. Against the old resident numbers (3.3 Gi over 37 h) that is a far steeper curve, so shortening the TTL trades accumulation for repeated re-absorption. Nothing here is wrong — the peak is reclaimed rather than kept — but if the TTL is ever tuned, measure how much a reconnect costs before assuming shorter is better.
11. **The VS Code Z-order LRU fix ships only to `install_source=local` installs** (2026-08-08). It was verified by hand-dropping a locally built `helper-manager.dll` into `%LOCALAPPDATA%\wezterm-runtime\bin\`, previous binary kept beside it as `helper-manager.dll.bak-preZorderLru`. Two loose ends, and they point in opposite directions. **This machine is fine**: `helper-install-state.json` says `source: local`, so `install-windows-runtime-helper-manager.ps1` rebuilds from the working tree and a reinstall carries the fix — but the bytes currently running came from a manual `cp`, not from that script, so `bin/` is not in a state the installer produced and the `.bak-` file is litter until someone reinstalls. **`install_source=release` installs are not fine**: `native/host-helper/windows/release-manifest.json` still pins the pre-fix build, so they keep the old behaviour — the reused window locks onto whichever one the helper recorded first — with no visible signal that the two disagree. Closes by cutting a host-helper release per [`host-helper-release.md`](./host-helper-release.md), updating the manifest, and deleting the `.bak-preZorderLru` file. Until then, `decision_path="max_windows_reuse_zorder_lru_window"` in this machine's `helper.log` says nothing about what a release install does.

    Same commit also added the title-based already-open check (`max_windows_focus_window_showing_folder`) after the Z-order change alone produced a worse failure: it displaced a window for a folder VS Code then de-duped elsewhere, and wrote a registry key pointing at a window that never received the folder — `Alt+v` on that folder afterwards opened an unrelated project, permanently, since every later request hit the same bad key. Two known-fragile spots in the new check, neither yet observed failing: a custom `window.title` template stops the match (degrades to displacing, not to anything worse), and two folders with the same leaf name under the same distro would match each other. Closes by either accepting the heuristic or giving the helper a real folder→window source; revisit if `decision_path="max_windows_focus_window_showing_folder"` ever focuses a visibly wrong project.
12. ~~**Repo hygiene debt queue — diagnostics split**~~ → **partially closed 2026-09-12.** `diagnostics.md` Guest OOM / Host Disk bodies moved to [`guest-oom.md`](./guest-oom.md) / [`host-disk.md`](./host-disk.md); hygiene L0/L1 gate is live. Remaining OVER-HARD allowlisted debt: `tab-visibility.md`, `attention.lua`, `openclaw/README.md`, etc. Closes fully by working that Top-N the same way. Not an adversarial-review item.
13. **What actually empties the overflow pane's in-memory session edge is inferred, not observed** (2026-08-19). The recycled-pane-id fix (see [`tab-visibility.md`](./tab-visibility.md), *Recycled pane ids*) is grounded in measured state: pane 6 (`…`, work) and pane 4 (`coco-forge`) both resolved to `wezterm_work_coco-forge_060820bd21` in `live-panes.json` while `tmux list-clients` had the placeholder on `wezterm_work_overflow`, and `pane-session/6.txt` was two weeks older than the pane. What is *not* observed is why the in-memory tier — seeded with the browse session by `spawn_overflow_tab` at 08-17 19:10 — was empty by the time the file was read; a config reload dropping the Lua state's `_G` is the plausible candidate, a spawn-time `set_pane_session` failure the other. It does not change the fix (the file tier is wrong for that pane either way), but it does decide whether the placeholder's post-reload badge amnesia is a real, frequent trade-off or a non-event. Closes by logging one line in `spawn_overflow_tab` after the seed and one in `window-config-reloaded` reporting `_G.__WEZTERM_PANE_TMUX_SESSION` size, then reading the ordering after the next sync-driven reload.
14. **Grok FocusGained full-clear flash — waiting on upstream gate narrow** (2026-08-20; macOS timing + WSL size A/B closed same day; **ops regression note 2026-09-04**). Primary cause and local fix: [`tmux-ui.md#grok-build-in-tmux`](./tmux-ui.md#grok-build-in-tmux). Stable **1.0.5** / alpha **1.0.7** still emit `\e[2J` on CSI FocusIn under any detected multiplexer; `/feedback` filed 2026-08-20 (GH Issues disabled). **Local mitigation verified** after `grok-with-focus-filter.sh --install` (`~/.grok/bin/grok` → wrapper, ELF at `grok.real`) with resume tree `python3 → grok.real` and no interactive flash. **Why macOS can look fine:** same heal fires; dingbo’s native WezTerm+tmux client redraw burst is typically **1–6 ms** (inside one 60 Hz / ~16.7 ms frame), so the cleared intermediate is not painted as its own frame — not an OS exemption. **WSL size A/B closed:** unfiltered `grok.real` in isolated WezTerm + `groknofilter`, Grok pane ~**31×15** in a ~**60×18** client, still whole-content flashes on `Alt+o` — shrinking is not an escape hatch on this hybrid stack (tmux/Grok in WSL, WezTerm on Windows); leading suspect remains **WSL interop fragmenting/delaying** the client burst. **Recurring local footgun (2026-09-04):** `grok update` left `~/.grok/bin/grok → downloads/grok-1.0.13-…` (bare ELF) while `~/.local/bin/grok` still pointed at the wrapper; login PATH hits `.grok/bin` first, so **direct shell `grok` flashed** even when some `agent-launcher` panes (now absolute-path wrapper) looked fine. Triage is `--check` → `--install` → exit/`--resume`, not a new WezTerm/focus-events theory. Close the upstream item when stock Grok stops clearing on FocusGained under plain tmux (`repro-grok-focus-flash.sh inject-real` → `no-clear`), then remove the wrapper. Until then keep `--install` after every `grok update`; cream `bg_base` patching is secondary only.
