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
- Current WezTerm-side diagnostics categories include `workspace`, `vscode`, `chrome`, `clipboard`, `command_panel`, `host_helper`, and `hotkey`.
- Set `diagnostics.wezterm.debug_key_events = true` only for keybinding investigations.
- WezTerm-side diagnostics rotate with `diagnostics.wezterm.max_bytes` and `diagnostics.wezterm.max_files`.

## Runtime Diagnostics

- When `WEZTERM_RUNTIME_LOG_ENABLED=1`, the runtime scripts append structured lines to `WEZTERM_RUNTIME_LOG_FILE`.
- `sync-runtime.sh` prints a one-line tmux reload result to the terminal, while the full structured detail still goes to `WEZTERM_RUNTIME_LOG_FILE`.
- `sync-runtime.sh` also prints `[sync] step=...` milestones for the chosen target, helper install, bootstrap refresh, and tmux reload status. Each gated step (`helper-install`, `helper-ensure`, `lua-precheck`, `deps-check`) emits an explicit `status=skipped reason=...` line when its skip-if-current check passed; full reasons + force-bypass envs are tabulated in [`daily-workflow.md#skip-if-current-and-force-overrides`](./daily-workflow.md#skip-if-current-and-force-overrides).
- Runtime logs rotate with `WEZTERM_RUNTIME_LOG_ROTATE_BYTES` and `WEZTERM_RUNTIME_LOG_ROTATE_COUNT`.
- Leave `WEZTERM_RUNTIME_LOG_CATEGORIES` empty to capture all runtime categories, or set a comma-separated list such as `vscode,workspace,worktree`.
- Current runtime categories include `vscode`, `workspace`, `worktree`, `managed_command`, `command_panel`, `task`, `provider`, and `sync`.

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
- The counter is aggregate-only. For per-press audit (which pane, which foreground program, which WezTerm domain saw the key), look at `category="hotkey" message="bump"` lines in the WezTerm runtime log — same file as the other WezTerm categories, filtered via `diagnostics.wezterm.categories`. Use this to investigate suspicious rows such as "this hotkey rose to N but I never pressed it" — the log will tell you whether the source was a tmux TUI, a Windows IME translation, a keyboard remap, etc. tmux chord bumps do not emit this line (the shell bump path has no pane context); only WezTerm keymap bumps do.

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

Guest memory exhaustion does not present as "a process died" — it presents as **the whole distro vanishing and then flapping**. Reference incident (2026-07-25): `init.scope` peaked at 41.8G of the 44G `memory=` budget with 10.1G of 11G swap consumed, the OOM killer fired inside `init.scope`, and the distro then powered off and restarted every 32.4s for ~27 minutes before the VM itself rebooted.

**Judging it in 10 seconds:** if `dmesg` timestamps do **not** reset across the restart cycles (paired `systemd-shutdow` SIGTERM + `EXT4-fs … unmounting` → `mounted`), the VM kernel is alive and only the *distro* is restarting. A reset to `[0.000000]` means the VM really rebooted. The restart count is also recoverable from `/var/log/journal/<machine-id>/*.journal~` — journald renames the file on every unclean start, so fragment count ≈ restart count.

Two units, installed together by [`scripts/dev/install-wsl-oom-guard.sh`](../scripts/dev/install-wsl-oom-guard.sh) and both driving [`scripts/runtime/wsl-oom-guard.sh`](../scripts/runtime/wsl-oom-guard.sh):

| Unit | Type | What it does |
|---|---|---|
| `wezterm-oom-protect.service` | oneshot at boot | Writes `-1000` to `oom_score_adj` of WSL's init (comm `init-systemd(Ub…)`, normally PID 2), making it OOM-immune, and `-800` to every tmux server — then **sweeps the inherited copies back to `0`** (see below; without the sweep this unit is worse than useless). Guest OOM still kills the fattest process; it can no longer kill the process WSL uses to decide the distro still has sessions, nor the one holding every pane. `oom_score_adj` resets on every distro start, which is why this is a unit and not a one-off `echo`. |
| `wezterm-oom-record.service` | long-running | Polls `init.scope/memory.events` + `MemAvailable`; dumps a top-N RSS snapshot (with each PID's `oom_score_adj`) on an `oom_kill` increment, on crossing the high-water mark, and at startup when the counter is already non-zero. Also **re-applies the protection set every tick** and **publishes the `M·` badge JSON** — see below. Runs at `OOMScoreAdjust=-900` so the recorder outlives the pressure it records. |

**`oom_score_adj` is inherited across `fork`, and that inversion is the whole trap.** Protecting WSL init does not protect one process — it silently immunizes *every* process spawned under it, because each new WSL session descends from PID 2 and inherits its value. Under tmux the leak compounds: panes inherit the tmux server's `-800`, and so does every agent and dev server started in them. Measured right after a `tmux kill-server` on this host: **119 of `init.scope`'s processes carried a protected value when exactly 2 should have — ~6.7 Gi of the largest consumers (claude, `chrome-devtools-mcp`, node, esbuild) all off the OOM killer's candidate list.** That is strictly worse than installing nothing: the kernel still has to reclaim, but no worthwhile victim is eligible, so it kills small useless processes or fails to reclaim at all.

So `protect` finishes by resetting to `0` any process in the watched cgroup that carries a protected value and is not one of the protected PIDs — and the recorder repeats the sweep every tick, since new sessions keep inheriting (the count climbed 119 → 152 in the minutes between two checks). Two properties make the sweep safe:

- **Scoped to `init.scope`, which separates "inherited by accident" from "set on purpose" without guessing.** `systemd-udevd` (`-1000`) and `sshd` (`-1000`) are legitimate systemd `OOMScoreAdjust=` settings, as is the recorder's own `-900`; all three live in `system.slice`, outside the swept cgroup, and are never touched. Verified by reading `/proc/<pid>/cgroup`.
- **Only the two protected values are reset.** Deliberate *positive* values elsewhere (the OpenClaw gateway sits at `+200`) mean "prefer killing me" and are left alone.

`wsl-oom-guard.sh status` reports this directly:

```
inherited leak: 0 process(es) in the cgroup wrongly carry -1000/-800 (should be 0)
```

A number that stays above zero means the sweep is off or not keeping up. Note a non-root sweep only reaches processes you own — WSL's `SessionLeader` / `Relay(…)` plumbing is root-owned, so ~28 entries persist until the root-run recorder does a tick. `WEZTERM_OOM_DRY_RUN=1` counts what the sweep would change without writing.

Two more non-obvious details in the protection set:

- **tmux cannot be covered by the boot-time oneshot.** A tmux server starts when the user first opens WezTerm, long after `multi-user.target`, and arrives with `oom_score_adj=0`. That is why `wezterm-oom-record` re-applies protection on every poll tick — a new or restarted tmux server converges within `WEZTERM_OOM_WATCH_INTERVAL`. Writes are idempotent and failures are latched per PID, so a steady state logs nothing.
- **tmux servers are unfindable by `pgrep`.** `comm` is `tmux: server` (so `pgrep -x tmux` misses) while `cmdline` is still the original `tmux new-session …` (so `pgrep -f 'tmux: server'` misses too). The guard scans `/proc/*/comm`.
- **tmux gets `-800`, not `-1000`.** A tmux server holds every pane's scrollback and can genuinely grow; `-800` means it is only pickable when it is itself using >80% of memory, so the one case where tmux really is the hog stays actionable instead of becoming a blind spot.

```bash
sudo ./scripts/dev/install-wsl-oom-guard.sh      # install + enable + start
./scripts/dev/install-wsl-oom-guard.sh --check   # no root, no writes
./scripts/dev/install-wsl-oom-guard.sh --print   # dump the generated units
sudo ./scripts/dev/install-wsl-oom-guard.sh --uninstall
scripts/runtime/wsl-oom-guard.sh status          # protection state + headroom
```

- Evidence lands in `journalctl -u wezterm-oom-record` **and** `/var/log/wezterm-oom-guard.log`. The plain file exists because the journal fragments across exactly the restart loop this guard diagnoses.
- Env knobs: `WEZTERM_OOM_GUARD_LOG`, `WEZTERM_OOM_WATCH_INTERVAL` (10s), `WEZTERM_OOM_WATCH_HIGH_PCT` (85), `WEZTERM_OOM_WATCH_TOP_N` (8), `WEZTERM_OOM_SCOPE`, `WEZTERM_OOM_PROTECT_ADJ` (-1000), `WEZTERM_OOM_TMUX_ADJ` (-800), `WEZTERM_OOM_PROTECT_TMUX` (1), `WEZTERM_OOM_RENORMALIZE` (1), `WEZTERM_OOM_DRY_RUN` (0). Badge-side: `WEZTERM_OOM_STATUS_FILE`, `WEZTERM_OOM_PUBLISH_INTERVAL` (30s), `WEZTERM_OOM_WARN_PCT` (85), `WEZTERM_OOM_CRIT_PCT` (93), `WEZTERM_OOM_SWAP_WARN_PCT` (70), `WEZTERM_OOM_SWAP_CRIT_PCT` (90), `WEZTERM_OOM_MEMINFO` (test fixture hook).
- `wsl-oom-guard.sh status` prints one line per protected process with `(protected)` / `(NOT protected)`. After a distro restart that is the one-command check that the boot path still works.
- **The high-water snapshot is the load-bearing one.** A snapshot taken *after* `oom_kill` increments no longer contains the process that died; the pre-kill snapshot names it.
- **Neither unit reduces memory usage or prevents OOM.** They change *who* dies and guarantee a record. Acting on the pressure is `earlyoom`'s job (below); capping the actual consumers is a separate decision — see "Standing memory consumers".
- Prior art: `earlyoom` and `systemd-oomd` were both considered and deferred at first, on the grounds that this pair is deliberately narrower — exemption plus evidence, no policy, no apt dependency. The 2026-07-26 livelock (below) is exactly the "act before the kernel does" case that was left open, and `earlyoom` is now installed alongside. `systemd-oomd` stays rejected, for a reason specific to this host — see below.
- Kernel OOM lines are **already** captured (journald `ReadKMsg` defaults on in the default namespace; `journalctl -k` works). They are still easy to lose: `misc dxg: dxgkio_query_adapter_info` spam runs ~145 lines/s and wraps the `dmesg` ring buffer within seconds. In the reference incident no kernel OOM line survived anywhere — only the `init.scope` cgroup counter, which the VM kernel carries across distro restarts and which systemd therefore re-reported at every one of the ~50 restarts.

### The second failure mode: reclaim livelock with no OOM kill

Reference incident 2026-07-26. Same root cause family as 2026-07-25 (guest memory exhausted), **opposite presentation**: nothing was killed, there was no restart loop, and the distro simply stopped responding with all cores pinned until `taskkill /f /im wslservice.exe` from an elevated Windows prompt.

**Do not use "no OOM record" to rule out memory.** `journalctl -b -1` contained no `Out of memory: Killed process`, and the cgroup counter read `oom_kill=0` the whole time. What it did contain:

```
15:21:22 zsh: page allocation failure: order:4, mode:0x40c40(GFP_NOFS)
15:21:23 Free swap = 0kB    Total swap = 11534336kB
         free:61954 (≈248MB)  inactive_anon:33.7G  pagetables:740784kB
```

Three things to read from that:

1. **`Free swap = 0kB` with ~250 MB free is the whole diagnosis.** 44 GiB + 11 GiB swap, both gone.
2. **Timestamp spacing in the kernel log is itself evidence.** Consecutive lines of a *single* call trace drifted from sub-second to 10 s, 30 s, then three minutes (`15:24:10` → `15:27:36`). When journald cannot get scheduled to write one line for three minutes, the livelock is established without needing any other measurement.
3. **Why nothing died.** The failing allocations were `order:4` (64 KiB). Above `PAGE_ALLOC_COSTLY_ORDER` (3) the kernel does **not** invoke the OOM killer — it warns and fails. Meanwhile order-0 allocations were still nominally satisfiable through direct reclaim, except swap was full so reclaim freed nothing. Every core spun in reclaim/compaction at 100% with zero forward progress, and no victim was ever selected.

The `order:4` source is 9p: every `/mnt/*` drvfs mount here is `msize=65536`, so each RPC (`p9_fcall_init`) needs a 64 KiB contiguous `kmalloc`. Under fragmentation **`/mnt/c` access is always the first thing to fail** — in this incident a `zsh` `getdents64` and an Xwayland readahead. That is the blast surface, not the cause; do not go debugging drvfs.

The consumers were the usual standing set, from the guard's own high-water snapshot: `next-server` 11.2 Gi + 5.1 Gi, `tsgo` 5.0 Gi, two leaked `chrome-devtools-mcp` at 3.9 Gi each (against the 150 Mi/instance baseline recorded below — a 26x regression worth chasing separately), plus ~3.9 Gi across ten `claude` sessions.

**What the guard got wrong here, and what changed.** The protection set was working correctly — `renormalize` was still sweeping at `15:21:19`, so every fat process was an eligible victim at `oom_score_adj=0`. The killer just never ran. The real gap was visibility: the guard crossed its high-water mark at 09:48, again at 11:25, and then **stayed above it for four hours with no further signal**, because the high-water log line is edge-latched and lives in a file nobody reads. Two additions close that:

#### The `M·` badge

`wezterm-oom-record` now publishes `state/oom-guard/status.json` next to the disk guard's, and [`wezterm-x/lua/mem_status.lua`](../wezterm-x/lua/mem_status.lua) renders it in right-status after `D·`:

```
(absent)   both axes below warn
M·88%      memory used, at/above warn (amber)
S·95%      swap used, when swap is the worse axis
M·94%      at/above crit (red — earlyoom is close to picking a victim)
M·?        the recorder was publishing and went stale
```

Same "nothing while healthy" contract as `D·`: presence is the signal, and never having published renders nothing at all so a machine without the guard keeps a clean bar.

**It reports whichever axis is worse, and that is the point.** Through the whole 2026-07-26 run-up memory read a calm 88% while swap drained from 20% free to zero. A memory-only badge would have been accurate and useless. Thresholds: warn at 85% memory (same number as the high-water mark, so the bar and the log agree) or 70% swap; crit at 93% / 90%.

Publishing is on level change plus a 30 s heartbeat, not every 10 s tick — the status file is on the Windows side of the 9p boundary and belongs nowhere near a hot path (see [`performance.md`](./performance.md)).

**The status-file path is resolved at install time and baked into the unit** as `Environment=WEZTERM_OOM_STATUS_FILE=`. The recorder is a *system* unit running as root, where `$HOME` is `/root` (so the per-user Windows-path cache is invisible) and a systemd unit has no Windows interop — it cannot resolve the path itself at runtime. The installer resolves it as `$SUDO_USER` instead. If resolution fails the guard still protects and logs; only the badge goes missing. `install-wsl-oom-guard.sh --check` prints both the path it *would* bake and the one the installed unit actually carries, because a guard that protects but never publishes looks healthy from every other angle:

```
badge path    : /mnt/c/Users/<you>/AppData/Local/wezterm-runtime/state/oom-guard/status.json
unit carries  : <none>          <- reinstall needed
```

#### earlyoom as the airbag

```bash
sudo ./scripts/dev/install-earlyoom.sh            # install + configure + start
./scripts/dev/install-earlyoom.sh --check         # no root, no writes
./scripts/dev/install-earlyoom.sh --print         # dump the generated drop-in
sudo ./scripts/dev/install-earlyoom.sh --uninstall
journalctl -u earlyoom                            # kills and hourly reports
```

Config is `-m 15,10 -s 12,6`: SIGTERM once available memory is under 15% **and** free swap under 12%, SIGKILL at 10% / 6%.

**Swap is the gate on this host, not memory.** This box legitimately runs at 85-88% memory (12-15% available) for hours, so a memory threshold tight enough to mean anything would fire constantly. Free swap is the axis that separates "busy" from "about to die" — near 100% free in normal work, collapsing only on the way into the livelock. The AND still holds it back from deploying during normal driving. Sized against three measured points:

| Sample | mem avail | swap free | Verdict |
|---|---|---|---|
| 2026-07-26 09:48 | 11.9% | 20.0% | silent — swap healthy |
| 2026-07-26 11:25 | 11.6% | 6.6% | **fires** — early (that state ran four more hours), and the victim is the leaked 11 Gi `next-server`, which is correct |
| 2026-07-27 14:48 | 14.0% | 10.5% | **fires** — the distro died at 14:52 |

Expect it to kill a leaked dev server rather than never fire; that is the intended trade. `WEZTERM_EARLYOOM_SWAP` raises the gate if it proves too eager.

Four things make it compose with the existing guard rather than duplicate it:

- **It picks its victim by `/proc/<pid>/oom_score`, which folds in `oom_score_adj`.** The guard's `-1000` on WSL init and `-800` on tmux already steer earlyoom away from them for free — and the guard's renormalize sweep is precisely what keeps the fat processes eligible. `--avoid ^(init|systemd|sshd|tmux|wezterm|Xwayland|dbus)` is a second layer for units living *outside* `init.scope`, beyond the sweep's reach.
- **Config goes in a systemd drop-in**, `/etc/systemd/system/earlyoom.service.d/wezdeck.conf`, not the packaged `/etc/default/earlyoom` — that file is a dpkg conffile and editing it makes every upgrade prompt. The drop-in also applies the man page's `-p` equivalent (`OOMScoreAdjust=-100`, `Nice=-20`), which cannot work through the packaged unit.
- **The drop-in must override `ExecStart=`, not `EARLYOOM_ARGS`.** The packaged unit's `EnvironmentFile=-/etc/default/earlyoom` **wins over** a drop-in `Environment=`, so an args-by-variable drop-in applies silently and does nothing. Cost of learning this the hard way: earlyoom ran for a day on the package defaults (`-m 10 -s 10`) while every config file on disk said otherwise. An empty `ExecStart=` resets the list before the real one.
- **The `--avoid` regex must contain no spaces and no quotes.** systemd splits a command line without shell quote processing, so the packaged config's own `--avoid '(^|/)(init|X|sshd|firefox)$'` example would arrive as two broken arguments. `^tmux` still matches comm `tmux: server`.

**Verify against the daemon, never against the config.** earlyoom prints its parsed thresholds on startup, and that banner is the only trustworthy source — `systemctl show` reports the unit file, not the live process. `install-earlyoom.sh --check` prints installed / intended / actually-parsed side by side for exactly this reason, and the installer runs `earlyoom --dryrun` (no privilege needed) before writing, so a bad argument string fails at install time instead of during the next incident:

```
installed args: -r 3600 -m 15,10 -s 12,6 --avoid ^(init|systemd|…)
would install : -r 3600 -m 15,10 -s 12,6 --avoid ^(init|systemd|…)
daemon parsed :
  sending SIGTERM when mem <= 15.00% and swap <= 12.00%,
          SIGKILL when mem <= 10.00% and swap <=  6.00%
```

**`enable --now` is not enough on a reinstall.** It is a no-op against an already-running unit, so the old process keeps the old environment while every file on disk shows the new one. On 2026-07-27 the badge path was correctly baked into `wezterm-oom-record.service` and the running recorder never saw it — it logged an empty status path and published nothing, while `systemctl show` cheerfully reported the new value. Both installers now `systemctl restart` explicitly.

**Why not `systemd-oomd`.** Its unit of destruction is a *cgroup*, and on this host 109 processes — tmux, every agent, every dev server — live in the single `/init.scope` cgroup (which is why the OOM guard watches exactly that cgroup). oomd would either not manage `init.scope` at all or take out the whole thing, reproducing the 2026-07-25 poweroff/restart loop. It is also not installed here (`/usr/lib/systemd/systemd-oomd` absent), so there is no "already in the box" advantage, and `/proc/pressure/memory` currently reads `total=0` on this kernel while cpu and io both count — worth pressure-testing before ever relying on memory PSI in WSL. earlyoom kills one process and needs none of that.

### Standing memory consumers

The guard tells you who died; this section records what is *always* resident, so a snapshot can be read against a known baseline. Measured 2026-07-25 via `/proc/<pid>/status` `VmHWM` (per-process peak RSS) — the top-of-`ps` view understates long-lived processes that have since shrunk.

| Family | Peak sum | Processes | Note |
|---|---|---|---|
| `chrome-devtools-mcp` | 5.91 Gi | 44 | one full stack **per agent session**; see below |
| `claude` | 4.60 Gi | 11 | parallel agent sessions |
| `vscode-server` | 1.24 Gi | 10 | one server per distro, shared across windows; each extra window adds an extension host |
| `tsgo` (`--lsp --stdio`) | 17 Mi | 1 | the TypeScript native language server is **not** a memory concern — it is Go, no V8 heap |

Two findings worth keeping:

- **No Chrome runs inside WSL.** The browser is the Windows-side headless debug instance (see [`browser-debug.md`](./browser-debug.md)); every WSL-side `chrome-devtools-mcp` process is Node.js attached over `--browser-url=http://127.0.0.1:9222`. Do not go looking for renderer processes here.
- **It was pure standby cost.** Those processes showed **0 seconds of CPU time** after 43 minutes of uptime, and peak RSS within ~10% of current — they were never exercised. The cost was paid whether or not any browser tool was ever called.

Applied 2026-07-25 — MCP config is user-global (`~/.claude.json`, managed with `claude mcp add/remove -s user`), so this is a record of the decision, not repo-owned config:

1. **Dropped the `npx` wrapper.** `npx chrome-devtools-mcp@latest` leaves npm-cli resident (~85 Mi) for the whole session just to act as a launcher, and re-resolves `@latest` on every start. `npm i -g chrome-devtools-mcp@<version>` plus a bare `command: chrome-devtools-mcp` removes that layer. Both spawners already have the fnm global bin dir on `PATH` — Claude Code's server entry sets `env.PATH` explicitly, and the OpenClaw gateway's `Environment=PATH=` is pinned in its systemd user unit — so no absolute path is needed, and the config stays copy-pasteable across machines.

   **The prerequisite that actually breaks:** `npm config get prefix` is scoped to the *current default* node version (`…/node-versions/v22.23.1/installation` here), and `aliases/default` is a symlink to it. After a `fnm default <other-version>`, the alias retargets and the binary is simply gone from `PATH` — re-run `npm i -g chrome-devtools-mcp@<version>` under the new default and re-verify with `claude mcp get chrome-devtools` / `openclaw mcp probe chrome-devtools`. An absolute path does **not** protect against this; it fails the same way with a less obvious error. Also note the path `command -v` prints right after `npm i -g` is an ephemeral `/run/user/<uid>/fnm_multishells/…` one — never put that in config.
2. **Disabled usage statistics.** `--usageStatistics=false` (or `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1`) removes a `telemetry/watchdog/main.js` child — a second full Node runtime, ~135 Mi, one per instance. Grepping `process.env.[A-Z_]+` in `build/src` does **not** surface that variable; read `chrome-devtools-mcp --help` instead.

Verified result: **4 processes / ~357 Mi per instance → 1 process / 150 Mi**, zero children, zero watchdog. Across ~12 concurrent sessions that is ~4.3 Gi → ~1.8 Gi.

**There are two independent MCP configs on this host, and both needed the change.** `claude mcp … -s user` only touches Claude Code (`~/.claude.json`). The OpenClaw gateway keeps its own at `~/.openclaw/openclaw.json` → `mcp.servers.chrome-devtools`, managed with `openclaw mcp add/show/probe/reload`, and it runs **outside tmux** — so neither a Claude-side config change nor a `tmux kill-server` reaches it. Both are now on the global-binary + `--usageStatistics=false` form; the OpenClaw side is documented in [`openclaw/README.md`](../openclaw/README.md) "Chrome DevTools MCP" with the operator recipe mirrored in `openclaw/workspace/skills/chrome-devtools/SKILL.md`. After editing, `openclaw mcp reload` disposes cached runtimes so the next turn rebuilds on the new config.

Related: a killed instance can **orphan** its `telemetry/watchdog` child (observed while testing), so it lingers holding ~135 Mi. Reap only the orphans — never a bare `pkill -f telemetry/watchdog`, which would also kill live sessions' watchdogs:

```bash
for p in $(pgrep -f "telemetry/watchdog"); do
  pp=$(tr '\0' '\n' </proc/$p/cmdline | grep -oP '(?<=--parent-pid=)\d+')
  [ -n "$pp" ] && [ ! -d "/proc/$pp" ] && kill "$p"
done
``` Other useful flags in the same `--help`: `--slim` (3 tools only, cuts tool-schema context), `--performanceCrux=false` (stops sending trace URLs to the Google CrUX API), `--experimentalPageIdRouting` (page-ID routing for concurrent sessions).

Deferred option if memory pressure returns: wrap the MCP in a **skill** driven by [`uxc`](https://github.com/holon-run/uxc) instead of keeping a resident MCP connection. Measured viable — `uxc` discovers all 29 operations over stdio and its daemon reuses one live session (`idle_ttl_secs: 600`, daemon itself only 9 Mi), so `take_snapshot` → `click` `uid` continuity survives; real calls ran 970 ms cold, 518 ms warm. Costs: ~0.5–1 s per call, session state lost after the 10-minute idle expiry, and the model reaches tools by composing a CLI line instead of seeing their schemas directly. The side benefit is context, not just memory — an enabled MCP injects all 29 tool schemas into every session, while a skill loads only when triggered.

## Host Disk Space

The distro lives on a fixed-size host volume, and the failure mode is the same shape as guest OOM: nothing warns you until everything stops. Reference incident (2026-07-25): `D:` (256 GB) reached **331 MB free**. `ext4.vhdx` was 228.4 GiB while the guest filesystem inside it held only 191 GiB.

**The load-bearing fact: deleting files inside WSL does not return a single byte to the host.** WSL's `ext4.vhdx` is a dynamically expanding VHDX — it grows on demand and *never* shrinks on its own. Every cleanup you have ever run inside the distro is still occupying host blocks. Check the gap with two numbers:

```bash
df -h /                                   # what the guest actually uses
ls -l --si /mnt/d/WSL/<Distro>/ext4.vhdx  # what the host actually gives up
```

### Do not enable sparse VHD

`wsl --manage <distro> --set-sparse=true` looks like the obvious fix — it makes the vhdx an NTFS sparse file so discards punch holes and space returns automatically at `wsl --shutdown`. **Microsoft disabled it by default because it can corrupt data** ([WSL#13075](https://github.com/microsoft/WSL/issues/13075)); enabling it now requires an explicit `--allow-unsafe`, and as of mid-2026 the underlying issue is not resolved ([#12103](https://github.com/microsoft/WSL/issues/12103), [#10609](https://github.com/microsoft/WSL/issues/10609)).

Two second-order traps make it worse than it first looks:

- **Turning it on removes the manual fallback.** `Optimize-VHD` refuses to touch a sparse vhdx ("must not be sparse"), so a disk that fails to auto-shrink can no longer be compacted by hand either — [a documented dead end](https://learn.microsoft.com/en-us/answers/questions/1526083/in-wsl2-with-sparse-vhd-the-storage-usage-does-not).
- **Turning it back off is expensive.** `--set-sparse false` refills every hole, which needs the full uncompacted size free on the host; [#11664](https://github.com/microsoft/WSL/issues/11664) is someone losing 50 GB+ to a failed conversion.

Stay non-sparse and compact periodically instead. That is also where the community converged (Hanselman, Rees-Carter, et al).

### Reclaim procedure

Order matters — compacting before trimming reclaims nothing, and every step after the first requires the distro to be fully stopped.

1. **Delete inside the guest** (see inventory below).
2. **`sudo fstrim -av`** — marks freed blocks as discardable. **This is the step that determines how much compaction reclaims**, not a precaution: the host cannot read the guest's ext4, so the TRIM record is its only evidence of which blocks are dead (see the mode note in step 4). The root mount already carries `discard` so most of it happens continuously, but run it anyway — it is cheap and idempotent. It reports *all* free space on each run, not a delta, so a large number is not evidence that continuous discard was broken.
3. **`wsl --shutdown`** from Windows. This kills every tmux session, every agent pane, and the OpenClaw gateway — an agent working inside the distro cannot perform this step or anything after it.
4. **Compact**, in an elevated PowerShell:

   ```powershell
   Optimize-VHD -Path "D:\WSL\<Distro>\ext4.vhdx" -Mode Full
   ```

   **`-Mode Full` does not actually run as Full here, and that is fine.** [Per the cmdlet docs](https://learn.microsoft.com/en-us/powershell/module/hyper-v/optimize-vhd), `Full` (zero detect + block reclaim) is only permitted when the VHDX is attached read-only; after `wsl --shutdown` it is fully detached, so the call silently degrades to `Prezeroed` (block reclaim only). Nothing is lost — **zero detect is useless against ext4**, which frees blocks by updating metadata and never writes zeros, and Windows cannot enumerate free space inside a non-NTFS guest filesystem the way it can for NTFS. The docs call this case out under `Prezeroed`.

   The consequence is that **block reclaim is the whole operation, and its only input is the TRIM/discard record the guest sent down.** That is what makes step 2 load-bearing rather than optional: skip `fstrim` and compaction just repacks blocks with barely any size change. `-Mode Prezeroed` is the honest spelling of what runs; `Full` is kept above only because it is what every guide prints.

   Falls back to `diskpart` when the Hyper-V module is absent — in-place, needs no scratch space:

   ```
   diskpart
   select vdisk file="D:\WSL\<Distro>\ext4.vhdx"
   attach vdisk readonly
   compact vdisk
   detach vdisk
   exit
   ```

Backing up the vhdx first is the standard advice and is often **not achievable here** — a 228 GiB file has nowhere to go on a host whose largest free volume is 56 GB. Both compaction paths mount read-only, which is the mitigation; note it as accepted risk rather than pretending the step was done.

### What actually accumulates

Measured 2026-07-25 across `~/work` and `~/github`; 96 GiB of the 191 GiB in use was regenerable build output.

| Kind | Size | Note |
|---|---|---|
| `.next` | 52 GiB | one project's `.next/dev` alone was 26 GiB |
| `sourcemaps` | 9.4 GiB | single project, gitignored build output |
| `.next-standalone-optimized` | 8.9 GiB | |
| `.turbo` | 10 GiB | task-result cache, 194 dirs |
| rust `target` | 4 GiB | |
| `~/.npm/_cacache` + `_npx` | 5.9 GiB | |
| `~/.cache/pnpm` | 3.1 GiB | metadata cache, not the store |

Inventory without deleting — the `node_modules` prune is required, or the sweep walks into dependency-internal `.next`/`dist` directories that are part of shipped packages:

```bash
find ~/work \( -type d -name node_modules -prune \) -o \
  \( -type d \( -name '.next' -o -name '.turbo' -o -name 'sourcemaps' \) -print -prune \) \
  | tr '\n' '\0' | du -x -c -s -h --files0-from=- | tail -1
```

Three things that will mislead you while measuring:

- **`du` deduplicates hardlinks within a single invocation, not across them.** pnpm's store is hardlinked into every `node_modules`, so `du ~/.local/share/pnpm` and `du ~/work` each claim the same bytes. Deleting `node_modules` therefore frees far less than its apparent size — it is the worst ratio of disruption to reclaimed space on the list, which is why the cleanup above leaves it alone.
- **Build a delete list as absolute paths.** A list of `./relative/paths` fed to `rm` from a different cwd silently matches nothing and reports success. Verify with `grep -cv '^/expected/prefix/' list.txt` before piping it to `xargs -0 rm -rf`.
- **`sudo` cannot be driven from an agent's shell or from a `!`-prefixed session command** — no tty, no askpass. `fstrim`, `apt clean`, and journal vacuuming have to be run by hand in a real terminal.

### The guard

Because **neither side's `df` can answer "how much more can I write"**. The
guest reports the vhdx's *virtual* capacity — 1 TB by default, on a 256G
partition, which overstated real headroom 5.7× on this host. The host reports
only what the vhdx has not claimed yet, ignoring all the reusable space already
inside it. [`wsl-disk-guard.sh`](../scripts/runtime/wsl-disk-guard.sh) publishes
the number that is actually true:

```
headroom = host avail + gap - reserve
```

`avail` is room for the file to grow; `gap` is room inside the file that the
guest reuses in place, without the host number moving at all. Observed
directly: guest usage climbed 94G → 102G in an hour while `ext4.vhdx` stayed at
exactly 228.4G and host avail never budged.

`reserve` (`WEZTERM_DISK_RESERVE_GB`, default 5) is host space withheld from
WSL. Without it the badge would count the volume's last byte as WSL's to spend,
and hitting zero would mean the host volume is dry — which breaks more than the
distro. With it, headroom reaching zero means "WSL is out of its budget" while
the volume still has room to breathe, so the alert arrives while the situation
is still only a WSL problem. Set it to 0 on a volume nothing else uses.

**`gap` deliberately does not drive the badge or alerting.** When the volume is
a dedicated WSL disk — the usual arrangement, and the case here, where
everything on `D:` other than the vhdx totals 2.9G — reclaimable space is not
waste, it is the distro's own reserve. Flagging it would light a permanent hint
that never needs acting on, which is how a status bar teaches you to ignore it.
Compaction converts gap into avail; it does not create headroom. That makes it
worth doing when something *other than* WSL needs the volume, or when the file
is out of room to grow while sitting on reusable space — `status` prints the
recipe exactly then, and stays quiet otherwise.

| Piece | Where |
|---|---|
| Sampler | `scripts/runtime/wsl-disk-guard.sh sample` / `status` |
| Timer | `wezterm-disk-guard.timer` — user unit, 1 min after start then every 5 min |
| Badge | `wezterm-x/lua/disk_status.lua`, right-status after `SB·N` |
| Escalation popup | `reminder.sh`, the same wrapper cron reminders use |

```bash
./scripts/dev/install-wsl-disk-guard.sh            # install + enable + prime
./scripts/dev/install-wsl-disk-guard.sh --check    # no writes
scripts/runtime/wsl-disk-guard.sh status           # measurement + reclaim recipe
```

**The badge is absent while healthy.** Its presence in the bar *is* the
signal — there is nothing to read in the common case, and no always-on number
to learn to skip. When it does appear it is one number: headroom.

```
(absent)   headroom ≥ 10% of budget
D·22G      below 10% (amber)
D·11G      below 5%  (red — and the guard pops a reminder)
D·?        the sampler was publishing and went stale
```

Thresholds are **percentages of budget**, not absolute sizes: the same 20G is
"plenty" on a 1 TB volume and "about to stop" on a 128G one, and a percentage
does not need re-tuning per machine.

The two `?` cases are deliberately different. A sampler that *was* publishing
and went stale renders `D·?`, because a dead monitor is itself the thing that
needs attention. A machine that never published at all renders nothing, so a
clone without the guard installed shows a clean bar rather than a permanent
question mark.

To see the numbers when the badge is not showing anything, run
`wsl-disk-guard.sh status`.

Alerting fires **on escalation only**, plus a cooldown-gated repeat while still
`crit` (`WEZTERM_DISK_ALERT_COOLDOWN`, default 6h). Improvements never pop: the
badge already shows recovery, and a popup that interrupts to say things got
better is training to dismiss popups unread. Rules are pinned in
[`tests/hook-units/test_wsl_disk_guard.sh`](../tests/hook-units/test_wsl_disk_guard.sh),
including that a large gap must *not* change the level.

#### Configuration

Which volume to watch and how much to withhold are per-machine, so they live
in `wezterm-x/local/shared.env` (template in `local.example/`) rather than in
an env var you have to remember to export:

```sh
WEZTERM_DISK_VOLUME=''        # empty = follow wherever ext4.vhdx lives
WEZTERM_DISK_RESERVE_GB='5'   # host space withheld from WSL
```

Leave `WEZTERM_DISK_VOLUME` empty unless the vhdx and the volume you care
about are genuinely different things — following the vhdx means a relocated
disk does not silently leave the guard watching the wrong drive. When they
*do* differ, the gap stops counting toward headroom: free space inside a vhdx
on some other disk contributes nothing to the watched disk's budget. `status`
says so explicitly rather than quietly dropping it.

Precedence is **explicit env > shared.env > built-in default**. That ordering
needs care in the script, because `runtime_env_load_shell` is `set -a` plus
`source` and would otherwise clobber a caller's exported value — the sampler
captures the explicit env before loading the file and reapplies it after.

Remaining knobs, env-only: `WEZTERM_DISK_WARN_PCT` (10),
`WEZTERM_DISK_CRIT_PCT` (5), `WEZTERM_DISK_ALERT` (1),
`WEZTERM_DISK_ALERT_COOLDOWN` (21600), `WEZTERM_DISK_VHDX`,
`WEZTERM_DISK_STATUS_FILE`, `WEZTERM_DISK_REMINDER_BIN` (test seam).

**A systemd user unit has no Windows interop at all** — no `/mnt/c` on `PATH`,
no `WSL_INTEROP`, no `WSL_DISTRO_NAME`. Verified with `systemd-run --user`. So
the authoritative vhdx lookup (the `Lxss` registry `BasePath`) is impossible
from the timer, and the path cache next to the status file is a *requirement*,
not an optimization. Two consequences are built in:

- **The installer primes the cache from the calling shell before enabling the
  timer.** Enabling first means the timer's first tick beats the cache and
  publishes a `level:"unknown"` sample — observed exactly once during
  development, which is how this was found.
- **A cold cache falls back to globbing the drvfs mounts**, which still works
  without interop. It disambiguates by dropping Docker Desktop's disks,
  dropping candidates smaller than current guest usage (a live distro's vhdx is
  at least its own contents), then taking the most recently written. Note the
  glob must reach `…/AppData/Local/Packages/<pkg>/LocalState/ext4.vhdx` —
  WSL's own default install location is deep enough that shallow patterns miss
  a store-installed distro entirely.

### OEM preinstalls on the same volume

Worth an audit pass when the host volume is tight — on this machine `D:\Program Files\Tencent\Androws` held 22 GiB. Despite the `WeChatAppEx.exe` process it spawns, it is **not** a WeChat component: `HKLM:\SOFTWARE\Tencent\Androws` → `InstallSource` records `"display_name":"腾讯应用宝"`, `"oem_preinstall":1`, `"co_source_id":"microsoft"` — a vendor-bundled Android emulator whose preinstall target is Douyin, carrying its own `WmpfRuntime` mini-program runtime. No WeChat installation exists on this host at all. Read the `InstallSource` JSON before attributing a Tencent directory to whatever app you assume put it there.

Its `Image/` directory keeps **every** version it has ever updated through (8 × ~1.8 GiB here, oldest six months back) while only the newest is live; the stale ones are safe to delete on their own. Full removal goes through `Application\<version>\Uninstall.exe`, then check for `D:\AndrowsData`, the `AndrowsSvr` service, and the `HKLM`/`HKCU` `SOFTWARE\Tencent\Androws` keys.

## Troubleshooting Notes

- If the host volume is full or nearly full, do **not** start by hunting for files on the Windows side — compare `df -h /` against the size of `ext4.vhdx` first. A large gap means the space is trapped in the vhdx and no host-side deletion will touch it; see "Host disk space" above for the trim-then-compact procedure and why `--set-sparse` is the wrong fix.
- If the whole distro disappears — tmux, every agent pane, all at once — and especially if it then keeps coming back and dying on a fixed interval, suspect guest OOM before suspecting WezTerm or tmux. Start from "Guest OOM hardening" above: check `dmesg` timestamp continuity to tell a distro restart from a VM reboot, then read the previous instance's shutdown log for `init.scope: Failed with result 'oom-kill'` and the `memory peak` / `memory swap peak` line (`journalctl --file /var/log/journal/<machine-id>/system@<seq>.journal~ -n 60 --no-pager`).
- For agent-attention "stuck running / done not clearing / right-status not refreshing" reports, **first verify the hook→render latency in the logs before suspecting render or cache layers**. Producer side: `grep "hook emitted agent status" ~/.local/state/wezterm-runtime/logs/runtime.log` — `elapsed_ms` should be ~100–300 ms with `osc_emitted=1`. Renderer side: in the WezTerm log under `%LOCALAPPDATA%\wezterm-runtime\logs\wezterm.log`, the `category="attention"` lines (`render_status` / `focus ack scheduled` / `jump dispatched`) for the same `session_id` should land in the same frame as the producer's `tick_ms`. If both are normal, the UI is not at fault — pivot upstream: read `attention.json.entries[<id>]` plus `recent[]` and look for whether the producer ever emitted a transition (long stretches of `hook resolved no-op` between a `running` and the next `done` mean the agent really was running, not stuck — Claude Code's protocol only updates status on UserPromptSubmit/Stop, all PreToolUse/PostToolUse runs resolve to no-op).
- If the tmux status line still reflects stale branch or change counts after a local `git` command and only catches up on the next 30s poll, the recommended prompt hook is probably not installed. From an affected tmux pane run `typeset -f __tmux_status_prompt_refresh >/dev/null && echo ok || echo missing`; when it prints `missing`, add the source line documented in [`setup.md`](./setup.md#tmux-status-prompt-hook) to your shell rc and re-source it — existing shells will not pick up the hook until you do.
- If text paste is fast but image-path paste stops working in `hybrid-wsl`, sync the runtime, let WezTerm auto-reload, and inspect the shared `trace_id` across the WezTerm and helper logs.
- In `hybrid-wsl`, WezTerm prewarms the host helper during GUI startup, then still falls back to on-demand ensure when the helper later goes stale or bootstrap state is missing.
- To reproduce the release fallback on a machine that already has Windows `dotnet`, run sync with `WEZTERM_WINDOWS_HELPER_INSTALL_SOURCE=release` and inspect `helper-install-state.json` plus the `[helper-install]` terminal lines for `installed_source`, `release_version`, and the installed binary paths.
- If GitHub downloads are too slow, place the zip at `%LOCALAPPDATA%\wezterm-runtime\artifacts\host-helper\<version>\<assetName>` or set `WEZTERM_WINDOWS_HELPER_RELEASE_ARCHIVE`, then rerun sync and confirm `release_archive_source=preload_versioned|preload_flat|explicit_archive`.
