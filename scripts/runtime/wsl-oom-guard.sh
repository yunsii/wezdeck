#!/usr/bin/env bash
# Guest-OOM hardening for this WSL distro. One subcommand per systemd unit.
#
#   protect  Bias the kernel OOM killer away from the two processes whose death
#            escalates "a dev server ate the RAM" into "the whole distro is
#            gone": WSL's init (comm `init-systemd(Ub…)`, normally PID 2) at
#            -1000 = fully exempt, and every tmux server at -800 = only pickable
#            if it is itself using >80% of memory. Guest OOM still fires and
#            still kills the fattest process; it just can no longer take out the
#            process WSL uses to decide "this distro still has sessions", nor the
#            one holding every pane.
#
#            Then immediately sweeps the *inherited* copies back to 0.
#            oom_score_adj is inherited across fork, so protecting WSL init
#            silently immunizes every process spawned under it — measured at 119
#            immune processes / ~6.7 Gi on this host. Without that sweep this
#            guard is worse than useless: the kernel still has to reclaim but no
#            large consumer is an eligible victim. The sweep is scoped to the
#            watched cgroup so systemd units' deliberate OOMScoreAdjust
#            (`systemd-udevd`, `sshd`, this guard's own recorder) is never hit.
#
#   watch    Poll init.scope's cgroup memory.events + guest memory headroom and
#            dump a process snapshot when an OOM kill lands or usage crosses the
#            high-water mark. The kernel's own OOM line is easy to lose: the WSL
#            dmesg ring buffer wraps within seconds under `misc dxg` spam
#            (~145 lines/s observed), and the 2026-07-25 incident left no kernel
#            OOM record anywhere — only a stale cgroup counter. The high-water
#            snapshot is the durable record of who was big *before* the kill.
#            Also re-applies `protect` every tick — a boot-time oneshot cannot
#            cover tmux, which starts when the user first opens WezTerm.
#
#   sample   Take one measurement and publish the JSON the WezTerm M· badge
#            reads. No root needed. `watch` does this on its own schedule; this
#            subcommand exists for manual checks and for the test suite.
#
#   status   Print current protection state, counters, and headroom. No writes,
#            no root needed.
#
# Usage:
#   scripts/runtime/wsl-oom-guard.sh protect      # needs root
#   scripts/runtime/wsl-oom-guard.sh watch        # long-running; systemd owns it
#   scripts/runtime/wsl-oom-guard.sh sample
#   scripts/runtime/wsl-oom-guard.sh status
#
# Env knobs (see docs/diagnostics.md "Guest OOM hardening"):
#   WEZTERM_OOM_GUARD_LOG        append target. Default /var/log/wezterm-oom-guard.log
#   WEZTERM_OOM_WATCH_INTERVAL   poll seconds. Default 10
#   WEZTERM_OOM_WATCH_HIGH_PCT   high-water mark, percent of MemTotal. Default 85
#   WEZTERM_OOM_WATCH_TOP_N      processes per snapshot. Default 8
#   WEZTERM_OOM_SCOPE            cgroup dir to watch. Default /sys/fs/cgroup/init.scope
#   WEZTERM_OOM_PROTECT_ADJ      WSL init oom_score_adj. Default -1000 (exempt)
#   WEZTERM_OOM_TMUX_ADJ         tmux server oom_score_adj. Default -800
#   WEZTERM_OOM_PROTECT_TMUX     1 to protect tmux servers, 0 to skip. Default 1
#   WEZTERM_OOM_RENORMALIZE      1 to sweep inherited values back to 0. Default 1
#   WEZTERM_OOM_DRY_RUN          1 to count the sweep without writing. Default 0
#   WEZTERM_OOM_STATUS_FILE      badge JSON path. Default: Windows runtime state.
#                                The record unit bakes this in at install time —
#                                see scripts/dev/install-wsl-oom-guard.sh.
#   WEZTERM_OOM_PUBLISH_INTERVAL seconds between badge writes while the level is
#                                unchanged. Default 30
#   WEZTERM_OOM_WARN_PCT         memory used% at or above this is `warn`. Default
#                                85, matching the high-water mark
#   WEZTERM_OOM_CRIT_PCT         memory used% at or above this is `crit`. Default 93
#   WEZTERM_OOM_SWAP_WARN_PCT    swap used% at or above this is `warn`. Default 70
#   WEZTERM_OOM_SWAP_CRIT_PCT    swap used% at or above this is `crit`. Default 90
#   WEZTERM_OOM_MEMINFO          meminfo source. Default /proc/meminfo; the test
#                                suite points it at a fixture to pin thresholds
#
# Install as systemd units: scripts/dev/install-wsl-oom-guard.sh
set -uo pipefail

GUARD_LOG="${WEZTERM_OOM_GUARD_LOG:-/var/log/wezterm-oom-guard.log}"
WATCH_INTERVAL="${WEZTERM_OOM_WATCH_INTERVAL:-10}"
WATCH_HIGH_PCT="${WEZTERM_OOM_WATCH_HIGH_PCT:-85}"
WATCH_TOP_N="${WEZTERM_OOM_WATCH_TOP_N:-8}"
OOM_SCOPE="${WEZTERM_OOM_SCOPE:-/sys/fs/cgroup/init.scope}"
PROTECT_ADJ="${WEZTERM_OOM_PROTECT_ADJ:--1000}"
# Deliberately not -1000: a tmux server holds every pane's scrollback and can
# genuinely grow, so leave it pickable in the one case where it IS the hog.
TMUX_ADJ="${WEZTERM_OOM_TMUX_ADJ:--800}"
PROTECT_TMUX="${WEZTERM_OOM_PROTECT_TMUX:-1}"
# Sweep descendants that inherited a protected oom_score_adj back to 0. Without
# this the protection propagates by fork and immunizes everything (see
# renormalize_inherited).
RENORMALIZE="${WEZTERM_OOM_RENORMALIZE:-1}"
DRY_RUN="${WEZTERM_OOM_DRY_RUN:-0}"
PUBLISH_INTERVAL="${WEZTERM_OOM_PUBLISH_INTERVAL:-30}"
# Badge thresholds. warn defaults to the high-water mark so the bar lights up at
# the same moment the log starts caring, rather than inventing a second number.
WARN_PCT="${WEZTERM_OOM_WARN_PCT:-$WATCH_HIGH_PCT}"
CRIT_PCT="${WEZTERM_OOM_CRIT_PCT:-93}"
# Swap gets its own pair because it is the axis that actually predicts the
# livelock: on 2026-07-26 memory sat at 88% for four hours while swap drained to
# zero, and it was the exhausted swap — not the 88% — that ended the distro.
SWAP_WARN_PCT="${WEZTERM_OOM_SWAP_WARN_PCT:-70}"
SWAP_CRIT_PCT="${WEZTERM_OOM_SWAP_CRIT_PCT:-90}"
MEMINFO="${WEZTERM_OOM_MEMINFO:-/proc/meminfo}"

# Print the whole header block (line 2 through the line before `set -`) so the
# help text cannot drift out of sync when the header grows.
usage() {
  sed -n '2,/^set -/p' "$0" | sed '$d; s/^# \{0,1\}//'
}

# Log to stdout (systemd journal) and, best-effort, to a plain append-only file.
# The file matters because the journal itself fragments across the distro
# restarts this guard exists to diagnose.
log() {
  local line
  line="$(date '+%Y-%m-%dT%H:%M:%S%z') wsl-oom-guard: $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$GUARD_LOG" 2>/dev/null || true
}

# WSL's init execs as `init-systemd(Ub…)` when systemd=true, plain `init`
# otherwise. Both sit at PID 2 in practice, but resolve by name so a future WSL
# layout change fails loudly instead of poisoning an unrelated PID.
resolve_wsl_init_pid() {
  local pid comm
  for pid in 2 $(pgrep -P 1 2>/dev/null || true); do
    [[ "$pid" == 1 ]] && continue
    [[ -r "/proc/$pid/comm" ]] || continue
    comm="$(cat "/proc/$pid/comm" 2>/dev/null || true)"
    case "$comm" in
      init-systemd*|init) printf '%s\n' "$pid"; return 0 ;;
    esac
  done
  return 1
}

# tmux servers are unfindable by pgrep: comm is `tmux: server` (so `pgrep -x
# tmux` misses) while cmdline is still the original `tmux new-session …` (so
# `pgrep -f 'tmux: server'` misses too). Scan /proc/*/comm instead.
resolve_tmux_server_pids() {
  grep -l '^tmux: server$' /proc/[0-9]*/comm 2>/dev/null \
    | sed 's#^/proc/##; s#/comm$##' || true
}

# Failures are latched per PID: the watch loop retries every tick, and an
# un-latched failure would write one line every WATCH_INTERVAL into the very file
# an operator reads during an incident.
declare -A PROTECT_FAILED=()

# Idempotent: writes only when the value differs, so the watch loop can call
# this every tick without spamming the log.
protect_pid() {
  local pid="$1" adj="$2" label="$3" before
  [[ -r "/proc/$pid/oom_score_adj" ]] || return 0
  before="$(cat "/proc/$pid/oom_score_adj" 2>/dev/null || printf '?')"
  [[ "$before" == "$adj" ]] && return 0
  # Subshell so the redirection failure itself (a shell-level error, not the
  # printf's) is swallowed and only the log line below surfaces.
  if ! ( printf '%s\n' "$adj" >"/proc/$pid/oom_score_adj" ) 2>/dev/null; then
    if [[ -z "${PROTECT_FAILED[$pid]:-}" ]]; then
      PROTECT_FAILED[$pid]=1
      log "protect: FAILED — cannot write /proc/$pid/oom_score_adj for $label (need root); not repeating for this pid"
    fi
    return 1
  fi
  unset "PROTECT_FAILED[$pid]"
  log "protect: $label pid=$pid oom_score_adj $before -> $adj"
}

# Pids that are *supposed* to carry a protected value. Populated by protect_all
# and consumed by renormalize_inherited.
PROTECTED_PIDS=""

# Read-only: fill PROTECTED_PIDS without touching anything. `status` needs the
# same set as `protect` so its leak count does not report the legitimately
# protected pids as leaks — otherwise "should be 0" could never read 0.
collect_protected_pids() {
  local pid
  PROTECTED_PIDS=""
  pid="$(resolve_wsl_init_pid)" && PROTECTED_PIDS="$PROTECTED_PIDS $pid"
  if [[ "$PROTECT_TMUX" == 1 ]]; then
    while read -r pid; do
      [[ -n "${pid:-}" ]] || continue
      PROTECTED_PIDS="$PROTECTED_PIDS $pid"
    done < <(resolve_tmux_server_pids)
  fi
}

# Re-apply the full protection set. Called at boot by `protect` and on every
# `watch` tick, because tmux servers start long after boot (and oom_score_adj is
# per-process, so a new server arrives unprotected).
protect_all() {
  local rc=0 pid
  collect_protected_pids
  if pid="$(resolve_wsl_init_pid)"; then
    protect_pid "$pid" "$PROTECT_ADJ" "wsl-init" || rc=1
  else
    log "protect: FAILED — no WSL init found (expected comm init-systemd* near PID 2)"
    rc=1
  fi
  if [[ "$PROTECT_TMUX" == 1 ]]; then
    while read -r pid; do
      [[ -n "${pid:-}" ]] || continue
      protect_pid "$pid" "$TMUX_ADJ" "tmux-server" || rc=1
    done < <(resolve_tmux_server_pids)
  fi
  return "$rc"
}

# Strip *inherited* protection. oom_score_adj is inherited across fork, so with
# WSL init at -1000 every new WSL session — and under tmux every pane shell and
# every agent it spawns — arrives already immune. Measured on this host right
# after a `tmux kill-server`: 119 of init.scope's processes carried a protected
# value when only 2 should have, leaving ~6.7 Gi of the largest consumers off the
# OOM killer's candidate list. That is strictly worse than no guard at all: the
# kernel still must reclaim, but nothing worth killing is eligible.
#
# Scoped to the watched cgroup on purpose. A systemd unit's deliberate
# OOMScoreAdjust must never be touched — `systemd-udevd` and `sshd` legitimately
# sit at -1000 in system.slice, and this guard's own recorder at -900. Those live
# outside init.scope, so restricting the sweep to init.scope separates
# "inherited by accident" from "set on purpose" without guessing.
renormalize_inherited() {
  [[ "$RENORMALIZE" == 1 ]] || return 0
  local pid adj fixed=0
  while read -r pid; do
    [[ -n "${pid:-}" ]] || continue
    [[ " $PROTECTED_PIDS " == *" $pid "* ]] && continue
    adj="$(cat "/proc/$pid/oom_score_adj" 2>/dev/null)" || continue
    [[ "$adj" == "$PROTECT_ADJ" || "$adj" == "$TMUX_ADJ" ]] || continue
    if [[ "$DRY_RUN" == 1 ]]; then
      fixed=$((fixed + 1))
      continue
    fi
    if ( printf '0\n' >"/proc/$pid/oom_score_adj" ) 2>/dev/null; then
      fixed=$((fixed + 1))
    fi
  done < "$OOM_SCOPE/cgroup.procs" 2>/dev/null
  if (( fixed > 0 )); then
    log "renormalize: reset $fixed inherited oom_score_adj to 0$([[ "$DRY_RUN" == 1 ]] && printf ' (dry-run, nothing written)')"
  fi
  return 0
}

# Count init.scope processes wrongly carrying a protected value. Operator signal:
# a number that stays above zero means the sweep is not keeping up (or is off).
count_inherited() {
  local pid adj n=0
  while read -r pid; do
    [[ -n "${pid:-}" ]] || continue
    [[ " $PROTECTED_PIDS " == *" $pid "* ]] && continue
    adj="$(cat "/proc/$pid/oom_score_adj" 2>/dev/null)" || continue
    case "$adj" in "$PROTECT_ADJ"|"$TMUX_ADJ") n=$((n + 1)) ;; esac
  done < "$OOM_SCOPE/cgroup.procs" 2>/dev/null
  printf '%s\n' "$n"
}

read_oom_kill() {
  awk '$1=="oom_kill"{print $2; found=1} END{if (!found) print 0}' \
    "$OOM_SCOPE/memory.events" 2>/dev/null || printf '0\n'
}

# MemTotal / MemAvailable in MiB, plus used percent, as one "total avail pct" line.
read_mem() {
  awk '
    /^MemTotal:/     { total = $2 }
    /^MemAvailable:/ { avail = $2 }
    END {
      if (total <= 0) { print "0 0 0"; exit }
      printf "%d %d %d\n", total / 1024, avail / 1024, (total - avail) * 100 / total
    }
  ' "$MEMINFO" 2>/dev/null || printf '0 0 0\n'
}

# SwapTotal / SwapUsed in MiB plus used percent. A swapless distro reports
# "0 0 0" rather than dividing by zero, and classify treats that as no signal.
read_swap() {
  awk '
    /^SwapTotal:/ { total = $2 }
    /^SwapFree:/  { free = $2 }
    END {
      if (total <= 0) { print "0 0 0"; exit }
      printf "%d %d %d\n", total / 1024, (total - free) / 1024, (total - free) * 100 / total
    }
  ' "$MEMINFO" 2>/dev/null || printf '0 0 0\n'
}

# --- badge state ---------------------------------------------------------
# ok < warn < crit, on whichever of the two axes is worse. Memory used% alone
# would have shown a calm 88% through the whole 2026-07-26 incident; swap
# used% alone misses a swapless machine filling RAM. The badge reports the
# dominant one so a single number is always the thing to act on.
classify_pressure() {
  local mem_pct="$1" swap_pct="$2"
  if (( mem_pct >= CRIT_PCT )) || (( swap_pct >= SWAP_CRIT_PCT )); then
    printf 'crit\n'
  elif (( mem_pct >= WARN_PCT )) || (( swap_pct >= SWAP_WARN_PCT )); then
    printf 'warn\n'
  else
    printf 'ok\n'
  fi
}

now_ms() {
  printf '%s\n' "$(($(date +%s%N) / 1000000))"
}

# --- state file location -----------------------------------------------
# Same rule as the disk guard: prefer the Windows-readable runtime state dir so
# WezTerm Lua never crosses \\wsl$ on its 250 ms tick.
#
# Detection cannot be relied on here the way it can in the disk guard. That one
# runs as a *user* timer, so `windows_runtime_detect_paths` finds the warm
# per-user cache; this one runs as root from a system unit, where $HOME is
# /root (no cache) and there is no Windows interop to fall back on. The
# installer therefore resolves the path from the invoking user's shell and
# bakes it into the unit as WEZTERM_OOM_STATUS_FILE. Detection is still
# attempted so an interactive `sample` / `status` works with no setup at all.
status_file_path() {
  if [[ -n "${WEZTERM_OOM_STATUS_FILE:-}" ]]; then
    printf '%s\n' "$WEZTERM_OOM_STATUS_FILE"
    return 0
  fi
  if [[ -z "${WINDOWS_RUNTIME_STATE_WSL:-}" ]]; then
    local paths_lib
    paths_lib="$(dirname "${BASH_SOURCE[0]}")/windows-runtime-paths-lib.sh"
    if [[ -f "$paths_lib" ]]; then
      # shellcheck disable=SC1091
      source "$paths_lib" 2>/dev/null || true
      windows_runtime_detect_paths 2>/dev/null || true
    fi
  fi
  if [[ -n "${WINDOWS_RUNTIME_STATE_WSL:-}" ]]; then
    printf '%s\n' "${WINDOWS_RUNTIME_STATE_WSL}/state/oom-guard/status.json"
    return 0
  fi
  printf '%s\n' "${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/state/oom-guard/status.json"
}

# Largest RSS process as "rss_mib comm". Only called when the level is not ok:
# it costs a `ps` over every process, and in the common case nobody reads it.
#
# Size first, name last, because comm routinely contains spaces — Next.js's
# worker reports `next-server (v1…`, and a name-first layout made `read -r`
# split the number off into the name field.
top_consumer() {
  ps -eo rss,comm --sort=-rss --no-headers 2>/dev/null \
    | awk 'NR==1 { rss = $1; $1 = ""; sub(/^ +/, ""); printf "%d %s\n", rss / 1024, $0; exit }'
}

# Publishes the badge JSON. Hand-rolled rather than jq-piped for the same reason
# as the disk guard: this runs from a systemd unit where a missing jq must not
# cost the badge its heartbeat.
publish_status() {
  local level="$1" mem_total="$2" mem_avail="$3" mem_pct="$4"
  local swap_total="$5" swap_used="$6" swap_pct="$7"
  local path tmp top_comm="" top_rss=""

  if [[ "$level" != "ok" ]]; then
    read -r top_rss top_comm <<<"$(top_consumer)"
    # comm is attacker-adjacent only in the sense that any process can pick it;
    # strip the two characters that would produce invalid JSON rather than
    # trusting it, since a malformed file costs the badge its heartbeat.
    top_comm="${top_comm//\\/}"
    top_comm="${top_comm//\"/}"
    [[ "$top_rss" =~ ^[0-9]+$ ]] || top_rss=""
  fi

  path="$(status_file_path)"
  mkdir -p "$(dirname "$path")" 2>/dev/null || true
  tmp="${path}.tmp.$$"
  cat >"$tmp" 2>/dev/null <<EOF
{
  "version": 1,
  "level": "$level",
  "mem_total_mib": $mem_total,
  "mem_avail_mib": $mem_avail,
  "mem_used_pct": $mem_pct,
  "swap_total_mib": $swap_total,
  "swap_used_mib": $swap_used,
  "swap_used_pct": $swap_pct,
  "top_comm": $( [[ -n "$top_comm" ]] && printf '"%s"' "${top_comm//\"/}" || printf 'null' ),
  "top_rss_mib": ${top_rss:-null},
  "warn_pct": $WARN_PCT,
  "crit_pct": $CRIT_PCT,
  "swap_warn_pct": $SWAP_WARN_PCT,
  "swap_crit_pct": $SWAP_CRIT_PCT,
  "oom_kill": $(read_oom_kill),
  "heartbeat_at_ms": $(now_ms),
  "updated_at": "$(date --iso-8601=seconds)"
}
EOF
  mv -f "$tmp" "$path" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
}

snapshot() {
  local reason="$1" total avail pct swap_used pid rss comm adj rows=0
  read -r total avail pct <<<"$(read_mem)"
  swap_used="$(awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2} END{printf "%d", (t - f) / 1024}' "$MEMINFO" 2>/dev/null || printf '0')"
  log "snapshot[$reason] mem_total=${total}Mi mem_avail=${avail}Mi used=${pct}% swap_used=${swap_used}Mi oom_kill=$(read_oom_kill)"
  # oom_score_adj is not a ps format specifier (procps rejects it), so read the
  # per-PID value from /proc. Trailing `comm` absorbs names containing spaces.
  while read -r pid rss comm; do
    [[ -n "${pid:-}" ]] || continue
    adj="$(cat "/proc/$pid/oom_score_adj" 2>/dev/null || printf '?')"
    log "snapshot[$reason]   pid=$pid rss=$((rss / 1024))Mi oom_score_adj=$adj comm=$comm"
    rows=$((rows + 1))
  done < <(ps -eo pid,rss,comm --sort=-rss --no-headers 2>/dev/null | head -n "$WATCH_TOP_N")
  # A snapshot with no process rows is worthless — say so instead of logging a
  # header that reads like a successful capture.
  (( rows > 0 )) || log "snapshot[$reason]   WARNING: no process rows captured (ps failed?)"
}

cmd_protect() {
  # At boot only WSL init exists; tmux servers appear later and are picked up by
  # the watch loop. Finding no tmux server here is normal, not a failure.
  local rc=0
  protect_all || rc=$?
  renormalize_inherited
  return "$rc"
}

cmd_watch() {
  local last_kill cur_kill total avail pct high_latched=0 low_pct
  local swap_total swap_used swap_pct level last_level="" last_publish=0 now
  low_pct=$((WATCH_HIGH_PCT - 10))
  last_kill="$(read_oom_kill)"
  log "watch: start interval=${WATCH_INTERVAL}s high=${WATCH_HIGH_PCT}% top_n=$WATCH_TOP_N renormalize=$RENORMALIZE scope=$OOM_SCOPE oom_kill=$last_kill"
  log "watch: badge levels warn>=${WARN_PCT}%/swap${SWAP_WARN_PCT}% crit>=${CRIT_PCT}%/swap${SWAP_CRIT_PCT}% -> $(status_file_path)"
  # Publish once before the first sleep so a freshly started distro has a
  # heartbeat immediately; otherwise the badge reads "stale" for a full tick.
  cmd_sample >/dev/null 2>&1 || true
  # A non-zero counter at startup is itself evidence: the VM kernel outlives a
  # distro restart, so the cgroup counter can carry over from a dead instance.
  # That is exactly what the 2026-07-25 restart loop kept re-reporting.
  if (( last_kill > 0 )); then
    log "watch: non-zero oom_kill at startup — a kill landed in this or an earlier distro instance"
    snapshot "startup-oom-kill=$last_kill"
  fi
  while :; do
    sleep "$WATCH_INTERVAL"
    # Re-apply protection every tick: tmux servers start after boot, and a
    # restarted one arrives with oom_score_adj=0. Silent unless something changed.
    protect_all || true
    renormalize_inherited
    cur_kill="$(read_oom_kill)"
    if [[ "$cur_kill" != "$last_kill" ]]; then
      log "watch: oom_kill $last_kill -> $cur_kill"
      snapshot "oom-kill"
      last_kill="$cur_kill"
    fi
    read -r total avail pct <<<"$(read_mem)"
    read -r swap_total swap_used swap_pct <<<"$(read_swap)"

    # The badge is the part of this guard that a human actually sees, so it
    # republishes on every level change and otherwise on a slow heartbeat.
    # Not every tick: the status file lives on the Windows side of the 9p
    # boundary, and a 10 s write cadence would put it in the hot path this
    # repo deliberately keeps state files out of (docs/performance.md).
    level="$(classify_pressure "$pct" "$swap_pct")"
    now="$(date +%s)"
    if [[ "$level" != "$last_level" ]] || (( now - last_publish >= PUBLISH_INTERVAL )); then
      publish_status "$level" "$total" "$avail" "$pct" "$swap_total" "$swap_used" "$swap_pct"
      [[ "$level" != "$last_level" && -n "$last_level" ]] \
        && log "watch: badge level $last_level -> $level (mem ${pct}%, swap ${swap_pct}%)"
      last_level="$level"
      last_publish="$now"
    fi

    if (( pct >= WATCH_HIGH_PCT )) && (( high_latched == 0 )); then
      high_latched=1
      log "watch: crossed high-water mark (${pct}% >= ${WATCH_HIGH_PCT}%)"
      snapshot "high-water"
    elif (( pct < low_pct )) && (( high_latched == 1 )); then
      high_latched=0
      log "watch: pressure released (${pct}% < ${low_pct}%)"
    fi
  done
}

cmd_sample() {
  local total avail pct swap_total swap_used swap_pct level
  read -r total avail pct <<<"$(read_mem)"
  read -r swap_total swap_used swap_pct <<<"$(read_swap)"
  level="$(classify_pressure "$pct" "$swap_pct")"
  publish_status "$level" "$total" "$avail" "$pct" "$swap_total" "$swap_used" "$swap_pct"
  printf '%s mem=%s%% swap=%s%% -> %s\n' "$level" "$pct" "$swap_pct" "$(status_file_path)"
}

cmd_status() {
  local pid adj total avail pct
  collect_protected_pids
  if pid="$(resolve_wsl_init_pid)"; then
    adj="$(cat "/proc/$pid/oom_score_adj" 2>/dev/null || printf '?')"
    printf 'wsl init      : pid=%s comm=%s oom_score_adj=%s%s\n' \
      "$pid" "$(cat "/proc/$pid/comm" 2>/dev/null)" "$adj" \
      "$([[ "$adj" == "$PROTECT_ADJ" ]] && printf ' (protected)' || printf ' (NOT protected)')"
  else
    printf 'wsl init      : NOT FOUND\n'
  fi
  local tmux_pids found=0
  tmux_pids="$(resolve_tmux_server_pids)"
  while read -r pid; do
    [[ -n "${pid:-}" ]] || continue
    found=1
    adj="$(cat "/proc/$pid/oom_score_adj" 2>/dev/null || printf '?')"
    printf 'tmux server   : pid=%s oom_score_adj=%s%s\n' "$pid" "$adj" \
      "$([[ "$adj" == "$TMUX_ADJ" ]] && printf ' (protected)' || printf ' (NOT protected)')"
  done <<<"$tmux_pids"
  (( found == 1 )) || printf 'tmux server   : none running%s\n' \
    "$([[ "$PROTECT_TMUX" == 1 ]] || printf ' (protection disabled)')"
  read -r total avail pct <<<"$(read_mem)"
  printf 'memory        : total=%sMi avail=%sMi used=%s%% (high-water %s%%)\n' \
    "$total" "$avail" "$pct" "$WATCH_HIGH_PCT"
  local swap_total swap_used swap_pct level
  read -r swap_total swap_used swap_pct <<<"$(read_swap)"
  printf 'swap          : total=%sMi used=%sMi (%s%%)\n' "$swap_total" "$swap_used" "$swap_pct"
  level="$(classify_pressure "$pct" "$swap_pct")"
  printf 'badge level   : %s (warn mem>=%s%% swap>=%s%%, crit mem>=%s%% swap>=%s%%)\n' \
    "$level" "$WARN_PCT" "$SWAP_WARN_PCT" "$CRIT_PCT" "$SWAP_CRIT_PCT"
  printf 'badge file    : %s%s\n' "$(status_file_path)" \
    "$([[ -f "$(status_file_path)" ]] && printf '' || printf ' (not published yet)')"
  if [[ "$level" != "ok" ]]; then
    local top_comm top_rss
    read -r top_rss top_comm <<<"$(top_consumer)"
    [[ -n "${top_comm:-}" ]] && printf 'largest       : %s (%sMi)\n' "$top_comm" "$top_rss"
  fi
  printf 'cgroup        : %s oom_kill=%s\n' "$OOM_SCOPE" "$(read_oom_kill)"
  printf 'inherited leak: %s process(es) in the cgroup wrongly carry %s/%s (should be 0)\n' \
    "$(count_inherited)" "$PROTECT_ADJ" "$TMUX_ADJ"
  printf 'guard log     : %s\n' "$GUARD_LOG"
  if command -v systemctl >/dev/null 2>&1; then
    # is-active exits non-zero for anything but "active", so take its stdout and
    # only fall back when it printed nothing at all.
    local protect_state record_state
    protect_state="$(systemctl is-active wezterm-oom-protect.service 2>/dev/null)"
    record_state="$(systemctl is-active wezterm-oom-record.service 2>/dev/null)"
    printf 'units         : wezterm-oom-protect=%s wezterm-oom-record=%s\n' \
      "${protect_state:-unknown}" "${record_state:-unknown}"
  fi
}

case "${1:-}" in
  protect) cmd_protect ;;
  watch)   cmd_watch ;;
  sample)  cmd_sample ;;
  status)  cmd_status ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
