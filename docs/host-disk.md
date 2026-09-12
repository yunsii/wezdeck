# Host Disk Space

Use this doc for host disk headroom on the Windows volume that backs the WSL `ext4.vhdx`: why sparse VHD is a trap, reclaim / compact, the disk guard and `D·…` badge, and OEM preinstall inventory.

Operator entry / other diagnostics: [`diagnostics.md`](./diagnostics.md). Guest memory / OOM: [`guest-oom.md`](./guest-oom.md).


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
| Badge | `wezterm-x/lua/disk_status.lua`, right-status after `◆ SB·N` |
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

