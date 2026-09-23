# Guest OOM Hardening

Use this doc for guest-memory / OOM hardening on WSL: the restart loop, reclaim livelock, high-order allocation failure, `M·…` / earlyoom, and standing memory consumers.

Operator entry / other diagnostics: [`diagnostics.md`](./diagnostics.md). Host volume headroom: [`host-disk.md`](./host-disk.md).


Guest memory exhaustion does not present as "a process died" — it presents as **the whole distro vanishing and then flapping**. Reference incident (2026-07-25): `init.scope` peaked at 41.8G of the 44G `memory=` budget with 10.1G of 11G swap consumed, the OOM killer fired inside `init.scope`, and the distro then powered off and restarted every 32.4s for ~27 minutes before the VM itself rebooted.

**Judging it in 10 seconds:** if `dmesg` timestamps do **not** reset across the restart cycles (paired `systemd-shutdow` SIGTERM + `EXT4-fs … unmounting` → `mounted`), the VM kernel is alive and only the *distro* is restarting. A reset to `[0.000000]` means the VM really rebooted. The restart count is also recoverable from `/var/log/journal/<machine-id>/*.journal~` — journald renames the file on every unclean start, so fragment count ≈ restart count.

**Lookalike (not OOM):** VM reboot + `UtilAcceptVsock` spam with healthy mem/swap can also be a **Fatal machine check (MCE)**. Check `%LOCALAPPDATA%\Temp\wsl-crashes\kernel-panic-*.txt` before treating the third failure mode below as proven — triage lives in [`development-environment-troubleshooting.md`](./development-environment-troubleshooting.md#fatal-machine-check-mce--reference-2026-09-23).

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
- Env knobs: `WEZTERM_OOM_GUARD_LOG`, `WEZTERM_OOM_WATCH_INTERVAL` (10s), `WEZTERM_OOM_WATCH_HIGH_PCT` (85), `WEZTERM_OOM_WATCH_TOP_N` (8), `WEZTERM_OOM_SCOPE`, `WEZTERM_OOM_PROTECT_ADJ` (-1000), `WEZTERM_OOM_TMUX_ADJ` (-800), `WEZTERM_OOM_PROTECT_TMUX` (1), `WEZTERM_OOM_RENORMALIZE` (1), `WEZTERM_OOM_DRY_RUN` (0). Badge-side: `WEZTERM_OOM_STATUS_FILE`, `WEZTERM_OOM_PUBLISH_INTERVAL` (30s), `WEZTERM_OOM_WARN_PCT` (85), `WEZTERM_OOM_CRIT_PCT` (93), `WEZTERM_OOM_SWAP_WARN_PCT` (70), `WEZTERM_OOM_SWAP_CRIT_PCT` (90), `WEZTERM_OOM_MEMINFO` (test fixture hook). Fragmentation-axis knobs (`WEZTERM_OOM_FRAG_*`) are listed with [the third failure mode](#the-third-failure-mode-a-high-order-allocation-failure-takes-the-vm-down).
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

**Swap is the gate on this host, not memory** — for *this* failure mode. 2026-07-27 later showed a shape where swap stayed at 62% free and the VM died anyway, so read this claim as scoped to the livelock, not as the host's one true axis; see [the third failure mode](#the-third-failure-mode-a-high-order-allocation-failure-takes-the-vm-down). This box legitimately runs at 85-88% memory (12-15% available) for hours, so a memory threshold tight enough to mean anything would fire constantly. Free swap is the axis that separates "busy" from "about to die" — near 100% free in normal work, collapsing only on the way into the livelock. The AND still holds it back from deploying during normal driving. Sized against three measured points:

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

### The third failure mode: a high-order allocation failure takes the VM down

Reference incident 2026-07-27, twice in one afternoon (VM up at 14:52, dead at 18:20). Same family again — the guest is short on memory — and a **third** presentation: no process was killed, no restart loop, no livelock long enough to notice, and **swap was healthy**. The distro just stopped, and Windows restarted the whole VM.

**Judging it:** `dmesg` timestamps reset to `[0.000000]`, so per the rule above this is a VM reboot, not a distro restart. Then look for this, and nothing else is needed:

```
18:19:13 kworker/0:1: page allocation failure: order:7, mode:0xdc0(GFP_KERNEL|__GFP_ZERO)
           __alloc_pages_slowpath → vmbus_alloc_ring → vmbus_open → hvs_probe → vmbus_probe
18:19:13 Node 0 Normal: … 0*512kB 0*1024kB 1*2048kB      <- orders 7 and 8 gone
18:19:45 WSL (SessionLeader) ERROR: UtilAcceptVsock:273: accept4 failed 110    <- ETIMEDOUT
18:20:30 WSL (Relay)         ERROR: UtilAcceptVsock:246: Waiting for abnormally long accept(11)
18:20:42 <last log line of the instance>
```

Read it as a chain, not as three separate errors:

1. **A new hyperv-vsock channel needs `order:7` — 512 KiB contiguous — for its ring buffer** (`vmbus_alloc_ring`). Total free memory is not the constraint; *contiguity* is. Both incidents failed with several GB nominally free.
2. **Losing a vsock channel is fatal in a way losing a process is not.** vsock is how the Windows side and the guest talk, so the relay's `accept4` times out (`110`), `wsl.exe` concludes the distro is unreachable, and the VM is torn down. The `UtilAcceptVsock` errors are the blast surface, not the cause — do not go debugging WSL networking. The same spam also appears as a prelude to **Fatal machine check (MCE)** VM death with healthy mem/swap — rule that out via `wsl-crashes\kernel-panic-*.txt` first ([cross-host triage](./development-environment-troubleshooting.md#fatal-machine-check-mce--reference-2026-09-23)).
3. **Nothing in the guest dies, so there is nothing to find afterwards.** `oom_kill` stays 0 and no `Killed process` line is ever written. "No OOM record" rules out even less than it did after 2026-07-26.

The consumers were the standing set again, from the guard's own high-water snapshots: `next-server` at 17.0 Gi before the 14:52 death and 13.4 Gi before the 18:20 one, four `chrome-devtools` at ~2.9-4.0 Gi, `tsgo` ~2.6 Gi.

**Why all three existing layers were silent.** This is the useful part of the incident:

| Layer | Why it did nothing |
|---|---|
| kernel OOM killer | `order:7` is above `PAGE_ALLOC_COSTLY_ORDER` (3). The kernel warns and fails; it never selects a victim. Same mechanism as the 2026-07-26 `order:4`. |
| `M·` badge | Correct and already red — `crit` at 18:19:11 (mem 94%). A number on the bar is not an action, and there were 91 seconds left. |
| earlyoom | **The AND gate never armed.** At 18:20:36 memory was 95% used but swap was only 38% used — 62% free, nowhere near the 12%-free trigger. |

So the previous section's conclusion — *"swap is the gate on this host, not memory"* — is **too strong**, and the table above it dates from before this incident. Free swap predicted the 2026-07-26 livelock well and predicts this shape not at all: high-order contiguity can collapse while both percentages still read survivable. That table's `2026-07-27 14:48` row is also an after-the-fact threshold calculation, not an observation — `journalctl -b -2` contains no earlyoom lines at all, because it was still being installed that afternoon. The only *observed* verdict for earlyoom on this failure mode is the 18:20 one: silent.

#### The fragmentation axis in `wezterm-oom-record`

The guard therefore watches contiguity directly, and handles it **in the system layer** rather than by capping each consumer — one place to reason about, and no per-project memory flags to keep in sync. Two triggers:

- **Confirmed:** a new `page allocation failure: order:>=4` appears in the kernel log. No memory gate — the kernel has already refused an allocation, whatever the percentages say. This is the trigger with real lead time: the first `order:7` failure landed at 14:02 and the VM survived until 14:52.
- **Predictive:** free blocks at `order>=7` hit zero **and** memory is already past the high-water mark. The AND is load-bearing: high-order exhaustion alone is the ordinary steady state of a long-lived Linux box, and acting on it unqualified would mean compacting and eventually killing on a perfectly healthy host.

Then it escalates, stopping at the first step that produces a usable block:

1. `snapshot` — the durable record of who was big, which neither incident left behind.
2. `echo 1 > /proc/sys/vm/compact_memory`, then re-read `/proc/buddyinfo` a beat later. Lossless, and aimed at exactly what failed. If this restores a block, nothing is signalled and the log says so.
3. Only if compaction cannot produce a single block: `SIGTERM` the largest consumer, `SIGKILL` if the same PID survives to the next attempt (a process wedged in reclaim never services `SIGTERM`). Floor of 2048 MiB and earlyoom's own `--avoid` list, so the victim is a cause and never a bystander — an agent CLI at ~400 Mi is not why a 512 KiB allocation failed.

**This is the airbag earlyoom's swap gate withholds**, deliberately placed last. The cost of step 3 is one dev server; the cost of not having it is every pane in the VM. One relief attempt per `WEZTERM_OOM_FRAG_COOLDOWN` (120 s default) keeps a sustained shortage from becoming a killing spree.

```bash
scripts/runtime/wsl-oom-guard.sh status     # fragmentation + alloc-failure lines
journalctl -u wezterm-oom-record | grep frag:
```

```
fragmentation : order>=7 free blocks=4483 (acts below 1, mem gate 85%) action=compact+term
alloc failures: 0 high-order (order>=4) failure(s) in this VM's kernel log
```

A non-zero `alloc failures` count means this VM has *already* been where both reboots started, whether or not the guard was watching at the time — `watch` logs that baseline on startup for the same reason it logs a non-zero `oom_kill`.

Notes:

- **`frag_order`, `frag_free_blocks`, `frag_min_blocks` and `alloc_failures` are published in `status.json`, but the badge level is unchanged** — it still comes from the two percentage axes only, so `mem_status.lua` needs no update. The fields are there for diagnosis and for a future axis on the bar; the incident's badge was already red, so a fourth colour would have added nothing.
- **The buddy column count is derived from the line, not fixed at 11.** `MAX_ORDER` changed meaning in 6.4 and `/proc/buddyinfo`'s width follows the kernel.
- **The kernel-log count is a count, not a watermark** (same shape as `read_oom_kill`): the guard acts only when it grows and re-baselines on any change, so the wrapping `dmesg` ring buffer degrades to "missed one" instead of a stuck alarm. The predictive trigger is the backstop for exactly that.
- Env knobs: `WEZTERM_OOM_FRAG_ORDER` (7), `WEZTERM_OOM_FRAG_MIN_BLOCKS` (1), `WEZTERM_OOM_FRAG_MEM_PCT` (high-water mark), `WEZTERM_OOM_FRAG_ACTION` (`compact+term`; also `compact` to hand the kill back to earlyoom, or `off`), `WEZTERM_OOM_FRAG_COOLDOWN` (120), `WEZTERM_OOM_FRAG_MIN_RSS_MIB` (2048), `WEZTERM_OOM_FRAG_AVOID`, `WEZTERM_OOM_BUDDYINFO`, `WEZTERM_OOM_COMPACT_FILE`, `WEZTERM_OOM_KMSG_FILE` (test hook). `WEZTERM_OOM_DRY_RUN=1` reports and snapshots without compacting or signalling.
- **Compaction and signalling need root**; the recorder is a system unit, so this works there and degrades to a logged warning under an interactive `watch`.
- Regression tests: `tests/hook-units/test_wsl_oom_guard.sh` pins the escalation order, the memory gate, the RSS floor, the avoid list, the cooldown, and `SIGTERM`→`SIGKILL`, driving the real `watch` loop against fixtures (fake `/proc/buddyinfo`, fake kernel log, a FIFO standing in for `compact_memory` so "compaction helped" is deterministic rather than timing-dependent).

**After changing this script, restart the recorder** — the unit runs the file straight out of the repo, so an edit alone changes nothing in the live process:

```bash
sudo systemctl restart wezterm-oom-record
journalctl -u wezterm-oom-record -n 5 | grep 'frag axis'   # must name the new axis
```

### Standing memory consumers

The guard tells you who died; this section records what is *always* resident, so a snapshot can be read against a known baseline. Measured 2026-07-25 via `/proc/<pid>/status` `VmHWM` (per-process peak RSS) — the top-of-`ps` view understates long-lived processes that have since shrunk.

| Family | Peak sum | Processes | Note |
|---|---|---|---|
| `chrome-devtools-mcp` | 5.91 Gi | 44 | one full stack **per agent session**; see below |
| `claude` | 4.60 Gi | 11 | parallel agent sessions |
| `vscode-server` | 1.24 Gi | 10 | one server per distro, shared across windows; each extra window adds an extension host |
| `tsgo` (`--lsp --stdio`) | 4.27 Gi | 2–3 | ⚠️ corrected 2026-08-04 (`VmHWM` 4.19 Gi + 76 Mi; current RSS 3.94 Gi). The 2026-07-25 reading was **17 Mi / 1 process**, with the note "not a memory concern — it is Go, no V8 heap". That was a small-repo measurement and does not generalise: one server per workspace folder, and in a large monorepo a single one is a top-three consumer. See [tsgo and `goMemLimit`](#tsgo-and-gomemlimit) |

Two findings worth keeping:

- **No Chrome runs inside WSL.** The browser is the Windows-side headless debug instance (see [`browser-debug.md`](./browser-debug.md)); every WSL-side `chrome-devtools-mcp` process is Node.js attached over `--browser-url=http://127.0.0.1:9222`. Do not go looking for renderer processes here.
- **It was pure standby cost.** Those processes showed **0 seconds of CPU time** after 43 minutes of uptime, and peak RSS within ~10% of current — they were never exercised. The cost was paid whether or not any browser tool was ever called.

Applied 2026-07-25 — MCP config is user-global (`~/.claude.json`, managed with `claude mcp add/remove -s user`), so this is a record of the decision, not repo-owned config:

1. **Dropped the `npx` wrapper.** `npx chrome-devtools-mcp@latest` leaves npm-cli resident (~85 Mi) for the whole session just to act as a launcher, and re-resolves `@latest` on every start. `npm i -g chrome-devtools-mcp@<version>` plus a bare `command: chrome-devtools-mcp` removes that layer. Both spawners already have the fnm global bin dir on `PATH` — Claude Code's server entry sets `env.PATH` explicitly, and the OpenClaw gateway's `Environment=PATH=` is pinned in its systemd user unit — so no absolute path is needed, and the config stays copy-pasteable across machines.

   **The prerequisite that actually breaks:** `npm config get prefix` is scoped to the *current default* node version (`…/node-versions/v22.23.1/installation` here), and `aliases/default` is a symlink to it. After a `fnm default <other-version>`, the alias retargets and the binary is simply gone from `PATH` — re-run `npm i -g chrome-devtools-mcp@<version>` under the new default and re-verify with `claude mcp get chrome-devtools` / `openclaw mcp probe chrome-devtools`. An absolute path does **not** protect against this; it fails the same way with a less obvious error. Also note the path `command -v` prints right after `npm i -g` is an ephemeral `/run/user/<uid>/fnm_multishells/…` one — never put that in config.
2. **Disabled usage statistics.** `--usageStatistics=false` (or `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1`) removes a `telemetry/watchdog/main.js` child — a second full Node runtime, ~135 Mi, one per instance. Grepping `process.env.[A-Z_]+` in `build/src` does **not** surface that variable; read `chrome-devtools-mcp --help` instead.

Verified result: **4 processes / ~357 Mi per instance → 1 process / 150 Mi**, zero children, zero watchdog. Across ~12 concurrent sessions that is ~4.3 Gi → ~1.8 Gi.

**Host agents and OpenClaw are deliberately asymmetric.** Claude Code (and Codex / Grok on the host) drive Chrome through **uxc** + `chrome-devtools-mcp-skill` / `chrome-devtools-mcp-cli` — no resident `mcpServers` / `[mcp_servers.chrome-devtools]` entry (Codex used to ship `npx …@latest` here; that form is retired — see [`agent-profiles/v1/host-setup/codex.md`](../agent-profiles/v1/host-setup/codex.md)). The OpenClaw gateway keeps its own resident MCP at `~/.openclaw/openclaw.json` → `mcp.servers.chrome-devtools`, managed with `openclaw mcp add/configure/probe/reload`, and it runs **outside tmux** — so neither a host-agent config change nor a `tmux kill-server` reaches it. Gateway install stays on the global-binary + `--usageStatistics=false` form; recipe in [`openclaw/README.md`](../openclaw/README.md) "Chrome DevTools MCP" and `openclaw/workspace/skills/chrome-devtools/SKILL.md`. After editing, `openclaw mcp reload` disposes cached runtimes so the next turn rebuilds on the new config.

As of 2026-07-29 the Claude Code side is off resident MCP entirely (see below), while **OpenClaw deliberately keeps it**. The asymmetry is intentional, because the numbers and the costs differ on each side:

| | Claude Code | OpenClaw gateway |
|---|---|---|
| instances | one **per session** — 16 observed | gateway-level, but **not always exactly one** — a steady 2 concurrent on 2026-08-04 (141 Mi each). Lazy-spawn/release still holds: both observed PIDs exited within the hour and were replaced by a fresh pair, so read this as "a churning pair", not "a leak" |
| observed peak | 3.4 Gi (5 instances ≥1.7 Gi) | 138 Mi |
| lifetime | resident for the whole session | lazy-spawned, released again (observed at 0 processes with the server still configured) |
| cost of switching to `uxc` | tool schemas leave the prompt, calls go through Bash | every browser step additionally passes the `claw-run` / `exec-risk` shell gate, and code-mode `MCP.chromeDevtools.*` stops working |

So the leak that justified rebuilding the Claude Code path does not reproduce here: there is no 16× standby multiplier, the observed peak is ~25× smaller, and the runtime does get released. Paying a shell-risk gate on every "look at the page" would be a real regression in the path Dex uses daily.

**Revisit that decision if** a gateway-owned `chrome-devtools-mcp` process is seen holding more than ~1 Gi, or surviving across many turns without being released. The cheap fix at that point is not a rewrite — it is `openclaw mcp reload`, which disposes the cached runtime and lets the next turn rebuild it; that can be driven on a threshold rather than switching Dex to a CLI. Check with:

```bash
# gateway MainPID, then MCP children hanging off it
systemctl --user show openclaw-gateway.service -p MainPID --value
pgrep -f chrome-devtools-mcp   # -f is required: comm truncates to "chrome-devtools"
```

Note `openclaw mcp configure` exposes auth/timeout/TLS/tool-filter knobs but **no idle or TTL control**, so there is no config-only way to cap the growth — hence the threshold-plus-`reload` shape above. Also note `openclaw mcp probe` connects from the CLI process, not from the gateway, so it cannot be used to observe gateway runtime lifetime.

Related: a killed instance can **orphan** its `telemetry/watchdog` child (observed while testing), so it lingers holding ~135 Mi. Reap only the orphans — never a bare `pkill -f telemetry/watchdog`, which would also kill live sessions' watchdogs:

```bash
for p in $(pgrep -f "telemetry/watchdog"); do
  pp=$(tr '\0' '\n' </proc/$p/cmdline | grep -oP '(?<=--parent-pid=)\d+')
  [ -n "$pp" ] && [ ! -d "/proc/$pp" ] && kill "$p"
done
``` Other useful flags in the same `--help`: `--slim` (3 tools only, cuts tool-schema context), `--performanceCrux=false` (stops sending trace URLs to the Google CrUX API). From **1.8.0**, `--pageIdRouting` defaults to **on** (page-scoped tools require `pageId`; use `--no-page-id-routing` to restore the old optional behaviour).

#### The standby figure is a floor, not a ceiling — the heap grows without bound

The `150 Mi per instance` above is the **never-exercised** cost. An instance that actually drives a page grows monotonically and never gives the memory back. Measured 2026-07-29 across 16 concurrent sessions, the split is bimodal:

| Class | Count | Footprint |
|---|---|---|
| never called a browser tool | 11 | ~80 Mi each (RSS 1 Mi + 79 Mi swap — fully paged out) |
| actually drove a page | 5 | **1.7–3.5 Gi each** (13 h → 1.7 Gi, 23.5 h → 3.48 Gi, 37.6 h → 3.35 Gi) |

`smaps_rollup` shows `Rss ≈ Pss ≈ Anonymous ≈ Private_Dirty` (cross-process double-counting only 0.20%), i.e. pure anonymous private heap with nothing reclaimable. Those 5 held **77% of the guest's entire `AnonPages`** (14.91 of 19.32 Gi) and were the reason swap sat at 99% with only 21 MiB free while `MemFree` still showed 21 Gi — physical memory looked fine because the pressure had already been paid into swap and never came back.

**Root cause is in `build/src/PageCollector.js`**, and it is not subtle:

```js
maxNavigationSaved = 3;
storage = [[]];
listeners(value => { …; this.storage[0].push(withId); });          // no size cap
listenerMap['framenavigated'] = frame => { …; this.splitAfterNavigation(); };
splitAfterNavigation() { this.storage.unshift([]); this.storage.splice(3); }
```

Retention is "last 3 navigations", but **a single navigation bucket has no item limit**, and trimming only fires on main-frame `framenavigated`. An SPA routing via `history.pushState` never triggers it; a page left open never triggers it. So `storage[0]` grows forever. What accumulates are puppeteer `HTTPRequest` objects — each holding response/body plus back-references to frame, page, and CDP session — so a single retained entry pins a long chain. **Next.js dev server + HMR + a page left open is the worst case**, and it is exactly what the 5 bloated instances were pointed at.

Two consequences for operators:

- **`--slim` and `--no-category-network` do not help memory.** They gate tool *registration* only (`tools.js` / `ToolHandler.js`); `McpPage.js` constructs `new NetworkCollector` / `new ConsoleCollector` unconditionally in its constructor. They remain useful for cutting tool-schema context — just not for this. The only size cap anywhere in the package is `telemetry/watchdog/ClearcutSender.js`'s `MAX_BUFFER_SIZE = 1000`, which is the one component already disabled above.
- **Do not assume a pin bump fixes the growth.** Host pin is currently **1.9.0** (2026-09-08; was 1.6.0 when this section was written). Upstream [issue #1192](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1192) (`p1`, `confirmed`, closed) reported the same disease from the `--autoConnect` side — ~13 MB/min, 1.66 Gi in 10 h, swap exhaustion triggering a macOS kernel watchdog panic. The v0.20.3 fix (#1200, "release old navigation request in NetworkCollector") only addressed releasing *across* navigations, not the unbounded single bucket. Re-measure after upgrades before treating the floor as the ceiling.

A cheap habitual mitigation: **reload the page when done debugging**. That fires `framenavigated` and trims to the last 3 navigations.

#### Containment: run it through uxc instead of holding a resident connection

Applied 2026-07-29 (was previously deferred here). Drive the MCP through [`uxc`](https://github.com/holon-run/uxc) so the process is reclaimed when idle instead of living for the session's lifetime.

```bash
A=/home/yuns/.local/share/fnm/aliases/default
uxc link chrome-devtools-mcp-cli \
  "$A/bin/node $A/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js --browser-url=http://127.0.0.1:9222 --usageStatistics=false"
```

**Absolute `node` + absolute `.js` is required**, not the `chrome-devtools-mcp` shim: it is a `#!/usr/bin/env node` symlink and the daemon's child environment has no `node` on `PATH` (`env -i` reproduces the failure). Routing both through `aliases/default` avoids hard-coding the node version, though the `fnm default` caveat above still applies.

The agent-facing side is upstream's own wrapper skill, installed **unmodified** from `holon-run/uxc` → `skills/chrome-devtools-mcp-skill` (MIT) into the shared pool at `~/.agents/skills/`, symlinked into `~/.claude/skills/` like `context7-mcp-skill`. Do not fork it: its `scripts/validate.sh` requires the documentation to quote upstream's own endpoint strings verbatim, so a locally-edited copy cannot pass upstream validation.

That works despite upstream prescribing a host this machine rejects — `npx -y chrome-devtools-mcp@latest --autoConnect --no-usage-statistics`, which would reintroduce the resident npm-cli launcher and cannot work at all here (`--autoConnect` looks for a local Chrome user-data-dir, and there is no Chrome inside WSL). The Link-First flow checks `command -v chrome-devtools-mcp-cli` **before** creating anything, so the pre-seeded absolute-path link above wins and upstream's `uxc link` line never runs. Upstream's naming would call this variant `chrome-devtools-mcp-port`; locally `-cli` *is* the browserUrl form, because it is the only form that works.

⚠️ The failure mode to watch: on a machine where the link is missing, an agent will follow upstream's text and create the `npx` form — functional but with the launcher overhead back. Re-create it with the absolute-path command above instead. Running upstream's `validate.sh` needs `ripgrep`, which is not installed here.

Verified on this host:

- **All 29 operations exposed**, covering 100% of the 18 previously whitelisted ones.
- **Stateful continuity holds across separate CLI invocations.** `take_snapshot` → `uid=3_0` in one process, `click uid=3_0` in the next, `evaluate_script` reading back `CLICKED` in a third — same `child_pid` throughout, `mcp_reuse_hits` incrementing. Sessions key on `stdio:{endpoint}:{auth_fingerprint}`; `cleanup_idle` uses non-blocking `try_lock` specifically so it cannot interrupt an in-flight call.
- **Arguments must be passed `key=value`.** The skill docs' "bare JSON positional payload" form fails against MCP tools (`Invalid value at $.function`), and `--input-json` takes inline JSON only, not a file path. Use backticks inside JS to dodge shell quoting.

⚠️ **uxc's idle reaping is lazy — it needs external traffic to fire.** `MCP_IDLE_TTL_SECS` is 600, but `cleanup_idle` only runs immediately before the daemon handles a request; there is no timer. Measured: a child sat at `idle_for_secs=820`, `expires_in_secs=0`, 701 Mi resident for 750 s untouched, then died instantly when one unrelated endpoint call (`deepwiki-mcp-cli -h`) came in. Any endpoint counts, not just this one — but a quiet stretch leaves expired children resident.

`scripts/runtime/uxc-session-reaper.sh` supplies the missing trigger, on cron every 5 minutes (see `wezterm-x/local.example/crontab`). Confirmed working unattended on 2026-07-29: a session left behind by another agent had grown to ~1.4 Gi, expired, and was reclaimed by the `13:55:01` cron tick — identifiable because its `trace_id` (`20260729T135501-…`) belongs to the cron run rather than to any interactive session. It takes its verdict from uxc's own `expires_in_secs == 0` rather than guessing an RSS threshold, acts only when *every* session is expired so an in-flight workflow is never cut, and calls `uxc daemon stop` rather than signalling `child_pid` behind the daemon's back. Triage entry point:

```bash
uxc daemon sessions   # child_pid, idle_for_secs, expires_in_secs, reuse_eligible
uxc daemon status     # mcp_stdio_sessions, mcp_reuse_hits
scripts/runtime/uxc-session-reaper.sh          # dry-run
```

`UXC_DAEMON_IDLE_TTL=<secs>` overrides the TTL for a daemon (`0` disables reaping entirely — do **not** use it here, that reinstates the unbounded growth); `uxc link --daemon-idle-ttl` pins it per link.

Residual costs, unchanged from the earlier assessment: ~0.5–1 s per call (970 ms cold, 518 ms warm), and the model composes a CLI line instead of seeing tool schemas directly. The side benefit is context, not just memory — a resident MCP injects all 29 tool schemas into every session.

**Permission note:** never grant `Bash(uxc:*)`. `uxc` is a general-purpose invoker (`uxc <any endpoint> <any operation>`, plus `uxc auth` over stored credentials), so a broad prefix rule is a real privilege escalation. Keep grants bound to the linked command name, which has the endpoint baked in.

**Idle does not mean quiescent.** With pages still open, the heap keeps growing even when no tool is called: one session went 778 → 1187 Mi across 40 minutes of `idle_for_secs`, because the CDP connection is still delivering events into the collectors. The earlier 750 s observation that showed RSS *falling* (782 → 700 Mi) was measured with the test page closed, i.e. with nothing arriving — do not generalise from it. So the 600 s TTL is an upper bound on damage, not a plateau; if a session routinely accumulates hundreds of MiB before expiring, shorten it via `uxc link --daemon-idle-ttl`.

⚠️ **Reaper liveness must come from `uxc daemon status`, not a hardcoded socket.** Older uxc preferred `$XDG_RUNTIME_DIR/uxc/uxc.sock` (and with `XDG` unset fell back to `/tmp/uxc-unknown/...`); **0.22.x defaults to `~/.uxc/daemon/uxc.sock`**. Hardcoding the runtime-dir path after that upgrade made every cron tick print "daemon not running" while interactive `chrome-devtools-mcp-cli` kept a live daemon under `~/.uxc`. `scripts/runtime/uxc-session-reaper.sh` now asks `daemon status` for `data.socket` / `data.running`. When triaging a reaper that appears to do nothing, check `syslog` for the `CRON … CMD` line, then run it under `env -i HOME="$HOME" PATH=…` with cron's environment; a healthy dry-run that sees sessions prints `uxc sessions active …` or `uxc-session-reaper mode=dry-run …`.

### tsgo and `goMemLimit`

`tsgo` is the TypeScript native language server shipped by the `typescriptteam.native-preview` VS Code extension, enabled here via `typescript.experimental.useTsgo`. It replaces the Node `tsserver`, so `typescript.tsserver.maxTsServerMemory` (which becomes `--max-old-space-size`) has **no effect on it at all** — being Go, the only limit it honours is `GOMEMLIMIT`, which the extension sets from `js/ts.server.goMemLimit`.

**What it is actually serving here.** Read this table with one rule in mind, because it is the trap: **a `handled method` line does not mean the feature is on.** VS Code's clients keep issuing requests on their own schedule regardless of config, and a disabled feature answers empty in microseconds. So capability has to be judged from the config dump (authoritative) with latency as the cross-check — not from request counts. Tabulated from 13 491 `handled method` lines across the three newest logs, against the config tsgo reports receiving:

| state | methods | evidence |
|---|---|---|
| **on — real work** | `semanticTokens/full`, `/range` | the most expensive steady-state call at p50 28 ms — but see the note on latency sums below before calling it "the cost" |
| **on — parse-level, cheap** | `documentSymbol`, `foldingRange` | syntactic, sub-ms by nature |
| **on — navigation** | `definition`, `hover`, `documentHighlight` | `hover:map[maximumLength:500]`; sub-ms |
| **on — basic completion** | (not observed in logs) | `suggest:map[… enabled:true]`, but `autoImports:false`, `includeCompletionsForImportStatements:false`, `completeFunctionCalls:false` |
| **off — answers empty** | `textDocument/diagnostic` | `validate:map[… enabled:false]`; 9 631 calls (71 % of traffic) yet 97.7 % under 5 ms, p50 0.23 ms |
| **off — answers empty** | `textDocument/inlayHint` | every sub-key `false`/`none`; 70 calls, p50 0.18 ms |
| **off — answers empty** | `textDocument/codeLens` | `implementationsCodeLens.enabled:false`, `referencesCodeLens.enabled:false`; 34 calls, p50 0.70 ms |
| **off / near-empty** | `textDocument/codeAction` | `suggestionActions:map[enabled:false]`, and quick fixes derive from diagnostics which are off; p50 0.23 ms |
| infrastructure | `workspace/didChangeWatchedFiles` | 3 546 calls |

So what the tuning block actually leaves is **parse-level features plus navigation** — jump-to-definition, hover, outline, folding — plus semantic highlighting.

⚠️ **Do not rank costs by summing `handled method` durations.** Those are wall-clock latencies, and during a project load every queued request inherits the wait, so the sums point at whatever happened to be in flight at startup. Summed over four older logs they read `diagnostic` 99.6 s / 48 %, `semanticTokens/full` 46.7 s, `documentSymbol` 27.0 s — all misleading. The internal control that proves it: **`inlayHint` is disabled and still accumulated 13.3 s**, which a switched-off feature cannot spend working. Confirmed on the clean post-reload log: of 131 calls, exactly 2 exceeded 500 ms (`initialized` 0.64 s and `didOpen` 4.67 s, both inside the 5-second startup window) and everything after was sub-millisecond.

So the steady-state per-request cost of this configuration is negligible. **The real cost is the ~2.9 Gi standing heap plus the one-off project load** — and neither shrinks by disabling features, because the heap *is* the program and type graph that jump-to-definition itself depends on.

**Do not over-read that table as "only highlighting and navigation survive".** The binary implements a full language service — `strings … | grep -oE 'textDocument/[a-zA-Z]+'` lists `completion`, `references`, `rename`, `prepareRename`, `implementation`, `typeDefinition`, `declaration`, `signatureHelp`, `prepareCallHierarchy`, `prepareTypeHierarchy`, `selectionRange`, `linkedEditingRange`, `documentLink`, `inlineCompletion`, plus `workspace/symbol` — and **this configuration disables none of them**. The methods absent from the log table were simply not invoked during the sampled window; absence there is not evidence of a disabled capability.

Measured against VS Code's *defaults*, the tuning turns off exactly four feature groups: **type diagnostics** (no red squiggles — type errors must come from a separate `tsc --noEmit` run or CI, which is an implicit dependency of this configuration), **auto-import completions** (the rest of completion still works), **formatting** (delegated to prettier) and **automatic type acquisition**.

`inlayHints` and both `codeLens` kinds show as disabled in the config dump but are **not** part of this tuning — VS Code ships them off by default (`inlayHints.*` default `false`/`none`, `implementationsCodeLens.enabled` and `referencesCodeLens.enabled` default `false`). Crediting them to the tuning block overstates what it does.

#### Which keys actually do something

The authoritative check is not the settings schema and not observed behaviour — it is the `config:"…"` struct tags compiled into the `tsgo` binary, which are exactly the keys the server reads (72 of them):

```bash
strings -n 6 ~/.vscode-server/extensions/typescriptteam.native-preview-*/lib/tsgo \
  | grep -oE 'config:"[^"]+"' | sed 's/config:"//;s/"$//' | tr ',' '\n' | sort -u
```

That audit cut `~/.vscode-server/data/Machine/settings.json` from 17 keys to 12. The 12 that remain, all confirmed to be keys something actually reads:

| key | role |
|---|---|
| `js/ts.server.goMemLimit` | Go heap ceiling → `GOMEMLIMIT`. Read by the **extension**, not tsgo; verified in `/proc/<pid>/environ` |
| `typescript.experimental.useTsgo` | master switch; the only key the extension watches for live changes |
| `{typescript,javascript}.validate.enabled` | type diagnostics — latency confirms it stops the checking |
| `{typescript,javascript}.suggest.autoImports` | auto-import completions (effect not fully confirmed — see open question 7) |
| `…suggest.includeCompletionsForImportStatements` | import-statement completions |
| `{typescript,javascript}.format.enabled` | built-in formatter |
| `typescript.disableAutomaticTypeAcquisition` + `typescript.tsserver.automaticTypeAcquisition.enabled` | stop fetching `@types` — **both are required**, see below |

The 5 removed key names (6 entries counting the ts/js pairs) and why each was dead:

| removed | why it did nothing |
|---|---|
| `js/ts.trace.server` | no-op — gated behind the output channel's log level |
| `{typescript,javascript}.validate.enable` | tsgo's tags contain only `validate.enabled`; `.enable` is the built-in extension's key, and `useTsgo` retires that extension |
| `{typescript,javascript}.format.enable` | same — only `format.enabled` exists in the tags |
| `typescript.tsserver.nodePath` | tsgo is a Go binary; no node is involved |

**The deletion is self-verifying, which is the neat part.** After the reload, tsgo's config dump shows `validate:map[enable:true enabled:false]` and `format:map[enable:true enabled:false]` — the `.enable` halves reverted to their schema default `true` because nothing sets them any more, while the `.enabled` halves stayed `false`. Behaviour did not change, which is exactly the proof that those keys were inert. `trace:map[server:verbose]` reverted the same way, harmlessly.

⚠️ **Automatic type acquisition needs both keys set, or it silently stays on.** tsgo's tags contain `disableAutomaticTypeAcquisition` *and* the newer `tsserver.automaticTypeAcquisition.enabled`. With only the first one set, the dump showed them disagreeing — `disableAutomaticTypeAcquisition:true` alongside `automaticTypeAcquisition:map[enabled:true]`, the newer key sitting at its default because nothing set it — and which one wins is undocumented, so ATA may have been running the whole time. Both are now set and the dump agrees: `enabled:false`.

Also worth knowing: **`suggest.enabled` is *not* in tsgo's tag list**, so basic completion cannot be turned off from the server side by that key — only the auto-import parts of completion are configurable here.

**Setting that limit below the live heap converts a memory cost into a much worse CPU cost.** Measured 2026-08-04 with `goMemLimit: "3GiB"` against the `ai-video-collection` monorepo:

| | over-limit server | control |
|---|---|---|
| workspace | `ai-video-collection` | its `dev-web-cmdb` worktree |
| `GOMEMLIMIT` | 3GiB | 3GiB |
| RSS | 3.94 Gi (`VmHWM` 4.19 Gi) | 76 Mi |
| CPU used / uptime | **30 h 42 m / 21 h → 145 % sustained** | **19 s / 21 h** |

Both servers were started within 40 minutes of each other and had the same uptime, so the 5800× difference in CPU is not a warm-up artefact.

Same binary, same setting; the only difference is where the live heap sits relative to the limit. `GOMEMLIMIT` is a *soft* limit — when it cannot be met the runtime simply keeps running GC cycles that free nothing, forever.

**The failure is time-delayed, which is why it went unnoticed for so long.** A freshly restarted server on the same monorepo settles at **2.82–2.92 Gi (two cold measurements) — under the 3 GiB limit — and is quiet at 3 % of one core**. That is only **3–8 % headroom**, so ordinary use drifts the heap past the limit within hours, and once past it the server never recovers: the 3.94 Gi / 145 % state above was the *same* workspace after 21 h. In other words the old setting was borderline from cold start, not merely after growth. Two consequences:

- A limit that looks safe on a cold server can be badly wrong on a warm one. Size it against the *grown* heap, not the freshly-loaded one.
- **You cannot reproduce or refute this right after a reload.** Measured minutes after a restart, everything looks healthy no matter what the limit is. Compare against a server that has been up for hours, or wait.

The diagnostic signature is specific enough to recognise in one pass, and it is **not** the shape you would expect:

- CPU in periodic parallel bursts (~5.5 core-seconds every 4–6 s), not a smooth pin.
- **RSS flat** (3941 → 3936 Mi over 30 s) and **minor faults near zero** (0–63 per 2 s). There is no scavenge/refault sawtooth, because nothing is reclaimable.
- `smaps_rollup` shows ~99.6 % `Private_Dirty` anonymous (file-backed only 9.6 Mi), so the whole figure is Go-runtime-accounted and really is above the limit.
- `read_bytes` +0 over 30 s and the extension host idle at 2–8 %, which rules out project rescans and LSP request storms — the work is self-initiated.

Set the limit with real headroom above the live heap (`6GiB` here — 2.1× the 2.82 Gi cold working set, 1.5× the 3.94 Gi warm one) or leave it unset. Unset is not free either: with the Go default `GOGC=100` the heap grows toward 2× live (≈7.8 Gi), which is what the limit was originally added to prevent — so a limit with headroom beats both.

⚠️ **Changing `goMemLimit` requires `Developer: Reload Window`. Nothing cheaper works.** The env is built once, inside the extension's `start()`. Verified against `native-preview` `0.20260707.2`:

- Killing `tsgo` gets it respawned by the LanguageClient's own crash-restart, which reuses the captured `ServerOptions.env` — done twice here, both times the new process still had `GOMEMLIMIT=3GiB`.
- The extension's own **`TypeScript Native Preview: Restart`** command is no better: `tryRestart()` only falls through to `restartSession()` → `start()` when the resolved tsgo **binary path changed**; an unchanged path takes `client.restart()`, which also reuses the captured env.

Check which value a live server actually got — the env is authoritative, the settings file is not:

```bash
pgrep -f 'lib/tsgo --lsp' | while read p; do
  echo "$p $(tr '\0' '\n' < /proc/$p/environ | grep '^GOMEMLIMIT=') $(readlink /proc/$p/cwd)"
done
grep -h 'Setting GOMEMLIMIT' ~/.vscode-server/data/logs/*/exthost*/*native-preview*/*.log | tail -3
```

A reload that took effect leaves a **new** `Setting GOMEMLIMIT=` line; no new line means no re-read.

Two adjacent findings from the same pass:

- **Claude Code spawns its own `tsgo` from the same extension directory with no `GOMEMLIMIT` — and that is fine. Do not cap it.** It does not read VS Code settings, so nothing sets the env. An initial reading of this as "an uncapped multi-gigabyte heap waiting to happen" was **wrong**; measured 2026-08-04: peak RSS **3.9 Mi** across 30 minutes of sampling, instances rotate every few minutes rather than living for the session, and — decisively — the three `claude` sessions sitting in `ai-video-collection` and its worktrees had **no `tsgo` at all**, while only the session doing active work in this (non-TS) repo had one. It never performs a project-level type load, so there is nothing to cap. Note also that a cap could not break validation even if added: `GOMEMLIMIT` is soft and Go never fails an allocation over it — the risk of capping is the CPU pathology above, not failure.
- **`js/ts.trace.server: "off"` is a no-op.** `refreshTrace()` initialises trace to `Off` and only consults `trace.server` when the output channel's log level is already `Trace`. The `[info] handled method … in Xµs` spam (21 MiB across the log tree, 3.3 MiB in one day's file) is tsgo's own logging, driven by `initializationOptions.logVerbosity` = the output channel's log level and updated via `custom/setLogVerbosity`. Lower it with `Developer: Set Log Level…` on the TypeScript Native Preview channel, not with that setting.

