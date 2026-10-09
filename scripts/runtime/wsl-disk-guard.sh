#!/usr/bin/env bash
# Host-disk guard for this WSL distro. One subcommand per entry point.
#
#   sample   Take one measurement, publish the JSON the WezTerm badge reads,
#            and pop a tmux reminder when the level escalates. systemd owns
#            this one (see scripts/dev/install-wsl-disk-guard.sh).
#
#   status   Print the same measurement human-readably. No writes.
#
# Why this exists: neither side of the boundary can answer "how much more can
# I write". The guest's `df` reports the vhdx's *virtual* capacity — 1 TB by
# default, on a 256G partition — so it overstated real headroom 5.7x on this
# host. The host's `df` sees only what the vhdx has not claimed yet, ignoring
# the space already inside it. On 2026-07-25 the guest cheerfully reported
# 766G free while the host volume was down to 331 MB.
#
# The number that is actually true is the sum:
#
#   avail     free space on the host volume holding ext4.vhdx — room for the
#             file to grow
#   gap       vhdx size minus guest bytes in use — space the vhdx already
#             owns and the guest reuses in place, without touching `avail`
#   reserve   host space deliberately withheld from WSL, so the volume never
#             goes fully dry even if the distro consumes its whole budget
#   headroom  avail + gap - reserve — what the distro can still write while
#             leaving the reserve intact. One of two alert inputs.
#
# Alerting is a dual gate (take the worse of the two):
#
#   1. headroom as a % of budget (warn <10%, crit <5%) — WSL write budget
#   2. host avail as absolute GiB (warn <10G, crit ≤5G) — volume about to dry
#
# Gate 2 exists because a large gap can keep headroom looking healthy while
# the host volume has only megabytes left — the 2026-07-25 and 2026-10-09
# incidents both failed that way. `gap` still does not drive a level on its
# own (on a dedicated WSL disk it is reserve, not waste); compaction converts
# gap into avail. See docs/host-disk.md.
#
# Usage:
#   scripts/runtime/wsl-disk-guard.sh sample
#   scripts/runtime/wsl-disk-guard.sh status
#
# Env knobs (see docs/host-disk.md):
#   WEZTERM_DISK_VHDX            vhdx path, WSL-side. Default: autodetected
#   WEZTERM_DISK_STATUS_FILE     JSON output path. Default: Windows runtime state
#   WEZTERM_DISK_VOLUME          WSL-side mount point of the volume to watch,
#                                e.g. /mnt/d. Default: wherever the vhdx lives
#   WEZTERM_DISK_RESERVE_GB      host space withheld from WSL. Default 5
#   WEZTERM_DISK_WARN_PCT        headroom below this % of budget is `warn`.
#                                Default 10
#   WEZTERM_DISK_CRIT_PCT        headroom below this % of budget is `crit`.
#                                Default 5
#   WEZTERM_DISK_AVAIL_WARN_GB   host avail below this GiB is at least `warn`.
#                                Default 10. Set 0 to disable this gate.
#   WEZTERM_DISK_AVAIL_CRIT_GB   host avail at or below this GiB is `crit`.
#                                Default 5. Set 0 to disable this gate.
#   WEZTERM_DISK_HISTORY_MAX     NDJSON samples kept next to status.json.
#                                Default 288 (~24h at 5 min). 0 disables.
#
# WEZTERM_DISK_VOLUME and WEZTERM_DISK_RESERVE_GB also read from
# wezterm-x/local/shared.env, which is the place to set them per machine.
# An explicit environment variable still wins over the file.
#   WEZTERM_DISK_ALERT           1 to pop reminders, 0 to stay silent. Default 1
#   WEZTERM_DISK_ALERT_COOLDOWN  re-alert interval while still crit, seconds.
#                                Default 21600 (6h)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Capture explicit env before loading the machine config, because
# runtime_env_load_shell is `set -a` + source and would otherwise clobber it.
# Precedence: explicit env > shared.env > built-in default.
_env_volume="${WEZTERM_DISK_VOLUME:-}"
_env_reserve="${WEZTERM_DISK_RESERVE_GB:-}"

if [[ -f "$SCRIPT_DIR/runtime-env-lib.sh" ]]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/runtime-env-lib.sh" 2>/dev/null || true
  runtime_env_load_shell "$REPO_ROOT/wezterm-x/local/shared.env" 2>/dev/null || true
fi

VOLUME="${_env_volume:-${WEZTERM_DISK_VOLUME:-}}"
RESERVE_GB="${_env_reserve:-${WEZTERM_DISK_RESERVE_GB:-5}}"
WARN_PCT="${WEZTERM_DISK_WARN_PCT:-10}"
CRIT_PCT="${WEZTERM_DISK_CRIT_PCT:-5}"
AVAIL_WARN_GB="${WEZTERM_DISK_AVAIL_WARN_GB:-10}"
AVAIL_CRIT_GB="${WEZTERM_DISK_AVAIL_CRIT_GB:-5}"
HISTORY_MAX="${WEZTERM_DISK_HISTORY_MAX:-288}"
ALERT_ENABLED="${WEZTERM_DISK_ALERT:-1}"
ALERT_COOLDOWN="${WEZTERM_DISK_ALERT_COOLDOWN:-21600}"

usage() {
  sed -n '2,55p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

now_ms() {
  printf '%s\n' "$(($(date +%s%N) / 1000000))"
}

# --- state file location -----------------------------------------------
# Same rule as the session-bridge badge: prefer the Windows-readable runtime
# state dir so WezTerm Lua never crosses \\wsl$ on its 250 ms tick.
status_file_path() {
  if [[ -n "${WEZTERM_DISK_STATUS_FILE:-}" ]]; then
    printf '%s\n' "$WEZTERM_DISK_STATUS_FILE"
    return 0
  fi
  if [[ -z "${WINDOWS_RUNTIME_STATE_WSL:-}" ]]; then
    local paths_lib="$SCRIPT_DIR/windows-runtime-paths-lib.sh"
    if [[ -f "$paths_lib" ]]; then
      # shellcheck disable=SC1091
      source "$paths_lib" 2>/dev/null || true
      windows_runtime_detect_paths 2>/dev/null || true
    fi
  fi
  if [[ -n "${WINDOWS_RUNTIME_STATE_WSL:-}" ]]; then
    printf '%s\n' "${WINDOWS_RUNTIME_STATE_WSL}/state/disk-guard/status.json"
    return 0
  fi
  printf '%s\n' "${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/state/disk-guard/status.json"
}

# --- vhdx discovery ------------------------------------------------------
# The registry is the only authoritative source for where WSL put the disk,
# and querying it costs a PowerShell round-trip (~1s), so the answer is
# cached next to the status file and only re-resolved when the cached path
# has gone missing.
vhdx_cache_path() {
  printf '%s\n' "$(dirname "$(status_file_path)")/vhdx-path.txt"
}

resolve_vhdx_from_registry() {
  local shell_lib="$SCRIPT_DIR/windows-shell-lib.sh"
  [[ -f "$shell_lib" ]] || return 1
  # shellcheck disable=SC1091
  source "$shell_lib" 2>/dev/null || return 1

  # Match on WSL_DISTRO_NAME when the caller has it (interactive shells do);
  # fall back to the registry's own DefaultDistribution, which is what a
  # systemd unit with a stripped environment will hit.
  local want="${WSL_DISTRO_NAME:-}"
  local base
  base="$(windows_run_powershell_command_utf8 "
    \$root = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Lxss'
    \$want = '$want'
    \$hit = \$null
    if (\$want -ne '') {
      \$hit = Get-ChildItem \$root -ErrorAction SilentlyContinue | ForEach-Object {
        \$p = Get-ItemProperty \$_.PSPath -ErrorAction SilentlyContinue
        if (\$p.DistributionName -eq \$want) { \$p.BasePath }
      } | Select-Object -First 1
    }
    if (-not \$hit) {
      \$def = (Get-ItemProperty \$root -ErrorAction SilentlyContinue).DefaultDistribution
      if (\$def) {
        \$hit = (Get-ItemProperty \"\$root\\\$def\" -ErrorAction SilentlyContinue).BasePath
      }
    }
    if (\$hit) { \$hit }
  " 2>/dev/null | tr -d '\r' | head -1)"

  [[ -n "$base" ]] || return 1
  # BasePath arrives as \\?\D:\WSL\Ubuntu-24.04 — strip the extended-length
  # prefix before handing it to wslpath.
  base="${base#\\\\?\\}"
  local wsl_base
  wsl_base="$(wslpath -u "$base" 2>/dev/null)" || return 1
  [[ -n "$wsl_base" ]] || return 1
  local candidate="$wsl_base/ext4.vhdx"
  [[ -f "$candidate" ]] || return 1
  printf '%s\n' "$candidate"
}

# Interop-free fallback. The drvfs mounts stay up in contexts where the
# Windows interop is gone (a systemd user unit has no /mnt/c on PATH and no
# WSL_INTEROP at all), so globbing is the only discovery path a timer can
# actually use when the cache is cold.
#
# Disambiguation, in order: drop Docker Desktop's own disks, drop anything
# smaller than what the guest currently has in use (a live distro's vhdx is
# necessarily at least its own contents), then take the most recently written
# — a running distro writes continuously, an idle one does not.
resolve_vhdx_by_glob() {
  local guest_used="${1:-0}"
  local best="" best_mtime=0 candidate size mtime
  # Third pattern is WSL's own default install location, which is deep enough
  # that the shallow patterns miss it entirely — a store-installed distro that
  # was never relocated lives there, not in a tidy X:\WSL\<name>.
  for candidate in \
    /mnt/*/WSL/*/ext4.vhdx \
    /mnt/*/*/ext4.vhdx \
    /mnt/*/Users/*/AppData/Local/Packages/*/LocalState/ext4.vhdx; do
    [[ -f "$candidate" ]] || continue
    case "$candidate" in
      *[Dd]ocker*) continue ;;
    esac
    size="$(stat -c %s "$candidate" 2>/dev/null)" || continue
    [[ "$size" =~ ^[0-9]+$ ]] || continue
    [[ "$guest_used" =~ ^[0-9]+$ ]] && ((size < guest_used)) && continue
    mtime="$(stat -c %Y "$candidate" 2>/dev/null)" || continue
    if ((mtime > best_mtime)); then
      best_mtime="$mtime"
      best="$candidate"
    fi
  done
  [[ -n "$best" ]] && printf '%s\n' "$best"
}

resolve_vhdx() {
  if [[ -n "${WEZTERM_DISK_VHDX:-}" ]]; then
    [[ -f "$WEZTERM_DISK_VHDX" ]] && printf '%s\n' "$WEZTERM_DISK_VHDX"
    return 0
  fi

  local cache
  cache="$(vhdx_cache_path)"
  if [[ -f "$cache" ]]; then
    local cached
    cached="$(head -1 "$cache" 2>/dev/null)"
    if [[ -n "$cached" && -f "$cached" ]]; then
      printf '%s\n' "$cached"
      return 0
    fi
  fi

  # Registry first when interop is reachable — it is the only authoritative
  # answer. Falls through to the glob in a stripped environment.
  local found
  found="$(resolve_vhdx_from_registry)" || found=""
  if [[ -z "$found" ]]; then
    found="$(resolve_vhdx_by_glob "${1:-0}")" || found=""
  fi
  if [[ -n "$found" ]]; then
    mkdir -p "$(dirname "$cache")" 2>/dev/null || true
    printf '%s\n' "$found" >"$cache" 2>/dev/null || true
    printf '%s\n' "$found"
  fi
}

# --- measurement ---------------------------------------------------------
# Fills the globals the emitters read. Every field degrades independently:
# a vhdx we cannot find still leaves host avail usable, and the badge simply
# drops the reclaimable hint.
measure() {
  VHDX_BYTES=""
  GAP_BYTES=""
  HOST_MOUNT=""
  HOST_AVAIL=""
  HOST_SIZE=""

  # Resolved first: the glob fallback uses it to reject vhdx candidates too
  # small to be this distro's own disk.
  GUEST_USED="$(df --output=used -B1 / 2>/dev/null | tail -1 | tr -d ' ')"
  [[ "$GUEST_USED" =~ ^[0-9]+$ ]] || GUEST_USED=""

  VHDX_PATH="$(resolve_vhdx "${GUEST_USED:-0}")"

  if [[ -n "$VHDX_PATH" && -f "$VHDX_PATH" ]]; then
    VHDX_BYTES="$(stat -c %s "$VHDX_PATH" 2>/dev/null)"
    [[ "$VHDX_BYTES" =~ ^[0-9]+$ ]] || VHDX_BYTES=""
    VHDX_MOUNT="$(df --output=target "$VHDX_PATH" 2>/dev/null | tail -1)"
  fi

  # Watch the configured volume when one is set, otherwise follow the vhdx —
  # the disk moves with whatever volume WSL was pointed at, so a hardcoded
  # drive letter would silently watch the wrong thing after a relocate.
  HOST_MOUNT="${VOLUME:-$VHDX_MOUNT}"
  if [[ -n "$HOST_MOUNT" && -d "$HOST_MOUNT" ]]; then
    HOST_AVAIL="$(df --output=avail -B1 "$HOST_MOUNT" 2>/dev/null | tail -1 | tr -d ' ')"
    HOST_SIZE="$(df --output=size -B1 "$HOST_MOUNT" 2>/dev/null | tail -1 | tr -d ' ')"
  fi
  [[ "$HOST_AVAIL" =~ ^[0-9]+$ ]] || HOST_AVAIL=""
  [[ "$HOST_SIZE" =~ ^[0-9]+$ ]] || HOST_SIZE=""

  if [[ -n "$VHDX_BYTES" && -n "$GUEST_USED" ]]; then
    GAP_BYTES=$((VHDX_BYTES - GUEST_USED))
    ((GAP_BYTES < 0)) && GAP_BYTES=0
  fi

  # The gap only counts toward headroom when it sits on the volume being
  # watched. Point WEZTERM_DISK_VOLUME at some other disk and the vhdx's
  # internal free space is irrelevant to that disk's budget.
  GAP_ON_VOLUME=0
  if [[ -n "$GAP_BYTES" && -n "$VHDX_MOUNT" && "$VHDX_MOUNT" == "$HOST_MOUNT" ]]; then
    GAP_ON_VOLUME="$GAP_BYTES"
  fi

  # What the distro can still write: room for the file to grow, plus room
  # already inside it, minus what the host keeps for itself. Either of the
  # first two alone understates the answer; skipping the third would let WSL
  # consume the volume down to zero and take the host with it.
  RESERVE_BYTES=$((RESERVE_GB * 1024 * 1024 * 1024))
  HEADROOM_BYTES=""
  BUDGET_BYTES=""
  HEADROOM_PCT=""
  if [[ -n "$HOST_AVAIL" ]]; then
    HEADROOM_BYTES=$((HOST_AVAIL + GAP_ON_VOLUME - RESERVE_BYTES))
    ((HEADROOM_BYTES < 0)) && HEADROOM_BYTES=0
  fi
  if [[ -n "$HOST_SIZE" ]]; then
    BUDGET_BYTES=$((HOST_SIZE - RESERVE_BYTES))
    ((BUDGET_BYTES < 1)) && BUDGET_BYTES=1
  fi
  if [[ -n "$HEADROOM_BYTES" && -n "$BUDGET_BYTES" ]]; then
    HEADROOM_PCT="$(awk -v h="$HEADROOM_BYTES" -v b="$BUDGET_BYTES" \
      'BEGIN { printf "%.1f", h * 100 / b }')"
  fi

  # Test seams: let the unit suite inject host/guest sizes without mocking df.
  # Unset in production.
  if [[ "${WEZTERM_DISK_TEST_HOST_AVAIL_BYTES:-}" =~ ^[0-9]+$ ]]; then
    HOST_AVAIL="$WEZTERM_DISK_TEST_HOST_AVAIL_BYTES"
  fi
  if [[ "${WEZTERM_DISK_TEST_HOST_SIZE_BYTES:-}" =~ ^[0-9]+$ ]]; then
    HOST_SIZE="$WEZTERM_DISK_TEST_HOST_SIZE_BYTES"
    BUDGET_BYTES=$((HOST_SIZE - RESERVE_BYTES))
    ((BUDGET_BYTES < 1)) && BUDGET_BYTES=1
  fi
  if [[ "${WEZTERM_DISK_TEST_GUEST_USED_BYTES:-}" =~ ^[0-9]+$ ]]; then
    GUEST_USED="$WEZTERM_DISK_TEST_GUEST_USED_BYTES"
    if [[ -n "$VHDX_BYTES" ]]; then
      GAP_BYTES=$((VHDX_BYTES - GUEST_USED))
      ((GAP_BYTES < 0)) && GAP_BYTES=0
      GAP_ON_VOLUME=0
      if [[ -n "$VHDX_MOUNT" && "$VHDX_MOUNT" == "$HOST_MOUNT" ]]; then
        GAP_ON_VOLUME="$GAP_BYTES"
      fi
    fi
  fi
  # Recompute headroom after test-seam overrides so classify sees consistent
  # numbers (avail/gap/reserve must move together).
  if [[ -n "$HOST_AVAIL" ]]; then
    HEADROOM_BYTES=$((HOST_AVAIL + GAP_ON_VOLUME - RESERVE_BYTES))
    ((HEADROOM_BYTES < 0)) && HEADROOM_BYTES=0
  fi
  if [[ -n "$HEADROOM_BYTES" && -n "$BUDGET_BYTES" ]]; then
    HEADROOM_PCT="$(awk -v h="$HEADROOM_BYTES" -v b="$BUDGET_BYTES" \
      'BEGIN { printf "%.1f", h * 100 / b }')"
  fi

  classify
}

# Dual gate: worse of (headroom %, host avail GiB). Sets LEVEL, LEVEL_REASON,
# and BADGE_BYTES (the number the status-bar segment should show).
#
# Headroom stays percentage-of-budget so the same knobs work across volume
# sizes. Host avail is absolute because "the NTFS volume is about to dry" is
# a host-side failure mode that a large gap must not mask — reference
# incidents 2026-07-25 (331 MB free) and 2026-10-09 (~dozen MB free).
#
# Gap alone never escalates: on a dedicated WSL volume it is the distro's own
# reserve. AVAIL_*_GB=0 disables that gate (tests / unusual layouts).
classify() {
  LEVEL="unknown"
  LEVEL_REASON="unknown"
  BADGE_BYTES=""

  local headroom_level="unknown"
  if [[ -n "$HEADROOM_PCT" ]]; then
    if awk -v p="$HEADROOM_PCT" -v t="$CRIT_PCT" 'BEGIN { exit !(p < t) }'; then
      headroom_level="crit"
    elif awk -v p="$HEADROOM_PCT" -v t="$WARN_PCT" 'BEGIN { exit !(p < t) }'; then
      headroom_level="warn"
    else
      headroom_level="ok"
    fi
  fi

  local avail_level="ok"
  if [[ -n "$HOST_AVAIL" ]]; then
    local avail_gib
    avail_gib="$(awk -v b="$HOST_AVAIL" 'BEGIN { printf "%.6f", b / 1073741824 }')"
    if [[ "$AVAIL_CRIT_GB" =~ ^[0-9]+(\.[0-9]+)?$ ]] \
      && awk -v a="$avail_gib" -v t="$AVAIL_CRIT_GB" 'BEGIN { exit !(t > 0 && a <= t) }'; then
      avail_level="crit"
    elif [[ "$AVAIL_WARN_GB" =~ ^[0-9]+(\.[0-9]+)?$ ]] \
      && awk -v a="$avail_gib" -v t="$AVAIL_WARN_GB" 'BEGIN { exit !(t > 0 && a < t) }'; then
      avail_level="warn"
    fi
  else
    avail_level="unknown"
  fi

  local headroom_rank avail_rank
  headroom_rank="$(level_rank "$headroom_level")"
  avail_rank="$(level_rank "$avail_level")"

  if ((headroom_rank >= avail_rank)); then
    LEVEL="$headroom_level"
  else
    LEVEL="$avail_level"
  fi
  # Prefer a known headroom/avail signal over "unknown" when one side failed
  # to measure: an unresolved headroom with a live avail still alerts.
  if [[ "$LEVEL" == "unknown" ]]; then
    if [[ "$avail_level" != "unknown" ]]; then
      LEVEL="$avail_level"
    elif [[ "$headroom_level" != "unknown" ]]; then
      LEVEL="$headroom_level"
    fi
  fi

  local hr_hot=0 av_hot=0
  ((headroom_rank >= 2)) && hr_hot=1
  ((avail_rank >= 2)) && av_hot=1
  if ((hr_hot && av_hot)); then
    LEVEL_REASON="both"
  elif ((av_hot)); then
    LEVEL_REASON="host_avail"
  elif ((hr_hot)); then
    LEVEL_REASON="headroom"
  elif [[ "$LEVEL" == "ok" ]]; then
    LEVEL_REASON="ok"
  else
    LEVEL_REASON="unknown"
  fi

  # Badge number: when the host volume is the binding constraint, show avail
  # (a large headroom would lie about how dry the volume is). Otherwise show
  # headroom — the distro write budget.
  if [[ "$LEVEL_REASON" == "host_avail" || "$LEVEL_REASON" == "both" ]]; then
    BADGE_BYTES="$HOST_AVAIL"
  else
    BADGE_BYTES="$HEADROOM_BYTES"
  fi
}

level_rank() {
  case "${1:-}" in
    crit) printf '3\n' ;;
    warn) printf '2\n' ;;
    *) printf '0\n' ;;
  esac
}

gib() {
  local bytes="${1:-}"
  [[ "$bytes" =~ ^[0-9]+$ ]] || { printf '?\n'; return 0; }
  awk -v b="$bytes" 'BEGIN { printf "%.1f", b / 1073741824 }'
}

# --- publish -------------------------------------------------------------
json_field() {
  local value="${1:-}"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s' "$value"
  else
    printf 'null'
  fi
}

history_file_path() {
  printf '%s\n' "$(dirname "$(status_file_path)")/history.ndjson"
}

# Append one compact sample line and trim to HISTORY_MAX. Survives a crash that
# overwrites status.json, so the next boot can still reconstruct the approach
# to a disk-full event. Disabled when HISTORY_MAX=0.
append_history() {
  [[ "$HISTORY_MAX" =~ ^[0-9]+$ ]] || return 0
  ((HISTORY_MAX > 0)) || return 0
  local path tmp dir
  path="$(history_file_path)"
  dir="$(dirname "$path")"
  mkdir -p "$dir" 2>/dev/null || true
  tmp="${path}.tmp.$$"
  {
    [[ -f "$path" ]] && cat "$path" 2>/dev/null
    printf '{"ts":"%s","level":"%s","reason":"%s","host_avail_bytes":%s,"gap_bytes":%s,"headroom_bytes":%s,"headroom_pct":%s,"vhdx_bytes":%s,"guest_used_bytes":%s}\n' \
      "$(date --iso-8601=seconds)" \
      "$LEVEL" \
      "$LEVEL_REASON" \
      "$(json_field "$HOST_AVAIL")" \
      "$(json_field "$GAP_BYTES")" \
      "$(json_field "$HEADROOM_BYTES")" \
      "${HEADROOM_PCT:-null}" \
      "$(json_field "$VHDX_BYTES")" \
      "$(json_field "$GUEST_USED")"
  } 2>/dev/null | tail -n "$HISTORY_MAX" >"$tmp" 2>/dev/null || true
  mv -f "$tmp" "$path" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
}

publish() {
  local path tmp
  path="$(status_file_path)"
  mkdir -p "$(dirname "$path")" 2>/dev/null || true
  tmp="${path}.tmp.$$"

  # Hand-rolled rather than jq-piped: this runs from a systemd timer where a
  # missing jq must not cost the badge its heartbeat.
  cat >"$tmp" 2>/dev/null <<EOF
{
  "version": 2,
  "level": "$LEVEL",
  "level_reason": "$LEVEL_REASON",
  "host_mount": $( [[ -n "$HOST_MOUNT" ]] && printf '"%s"' "$HOST_MOUNT" || printf 'null' ),
  "host_avail_bytes": $(json_field "$HOST_AVAIL"),
  "host_size_bytes": $(json_field "$HOST_SIZE"),
  "vhdx_path": $( [[ -n "$VHDX_PATH" ]] && printf '"%s"' "$VHDX_PATH" || printf 'null' ),
  "vhdx_bytes": $(json_field "$VHDX_BYTES"),
  "guest_used_bytes": $(json_field "$GUEST_USED"),
  "gap_bytes": $(json_field "$GAP_BYTES"),
  "headroom_bytes": $(json_field "$HEADROOM_BYTES"),
  "headroom_pct": ${HEADROOM_PCT:-null},
  "badge_bytes": $(json_field "$BADGE_BYTES"),
  "budget_bytes": $(json_field "$BUDGET_BYTES"),
  "reserve_bytes": $(json_field "$RESERVE_BYTES"),
  "reserve_gb": $RESERVE_GB,
  "warn_pct": $WARN_PCT,
  "crit_pct": $CRIT_PCT,
  "avail_warn_gb": $AVAIL_WARN_GB,
  "avail_crit_gb": $AVAIL_CRIT_GB,
  "last_alert_level": "$LAST_ALERT_LEVEL",
  "last_alert_at_ms": $(json_field "$LAST_ALERT_AT_MS"),
  "heartbeat_at_ms": $(now_ms),
  "updated_at": "$(date --iso-8601=seconds)"
}
EOF
  mv -f "$tmp" "$path" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  append_history
}

# Read back the previous run's alert bookkeeping. Kept as plain grep so a
# malformed file degrades to "never alerted" instead of aborting the sample.
load_previous() {
  PREV_LEVEL=""
  LAST_ALERT_LEVEL=""
  LAST_ALERT_AT_MS=""
  local path
  path="$(status_file_path)"
  [[ -f "$path" ]] || return 0
  PREV_LEVEL="$(grep -o '"level"[[:space:]]*:[[:space:]]*"[a-z]*"' "$path" 2>/dev/null | head -1 | grep -o '[a-z]*"$' | tr -d '"')"
  LAST_ALERT_LEVEL="$(grep -o '"last_alert_level"[[:space:]]*:[[:space:]]*"[a-z]*"' "$path" 2>/dev/null | head -1 | grep -o '[a-z]*"$' | tr -d '"')"
  LAST_ALERT_AT_MS="$(grep -o '"last_alert_at_ms"[[:space:]]*:[[:space:]]*[0-9]*' "$path" 2>/dev/null | head -1 | grep -o '[0-9]*$')"
}

# --- alerting ------------------------------------------------------------
# Fires on escalation only, plus a cooldown-gated repeat while still crit.
# A level that improves never pops anything: the badge already shows it, and
# a popup that interrupts to say "things got better" trains you to dismiss
# popups without reading them.
should_alert() {
  [[ "$ALERT_ENABLED" == "1" ]] || return 1
  local rank prev_rank
  rank="$(level_rank "$LEVEL")"
  prev_rank="$(level_rank "$PREV_LEVEL")"
  ((rank >= 2)) || return 1
  ((rank > prev_rank)) && return 0

  # Same level as last time — only repeat for crit, and only after cooldown.
  [[ "$LEVEL" == "crit" ]] || return 1
  [[ "$LAST_ALERT_AT_MS" =~ ^[0-9]+$ ]] || return 0
  local elapsed_ms=$(($(now_ms) - LAST_ALERT_AT_MS))
  ((elapsed_ms >= ALERT_COOLDOWN * 1000))
}

fire_alert() {
  # Injectable so the test suite can assert on the alert without a popup.
  local reminder="${WEZTERM_DISK_REMINDER_BIN:-$SCRIPT_DIR/reminder.sh}"
  [[ -x "$reminder" ]] || return 0

  local title message headroom_gib avail_gib gap_hint=""
  headroom_gib="$(gib "$HEADROOM_BYTES")G（${HEADROOM_PCT}%）"
  avail_gib="$(gib "$HOST_AVAIL")G"
  # Only worth mentioning when compaction is the actionable move — i.e. the
  # file cannot grow much further but is holding reusable space.
  if [[ -n "$GAP_BYTES" && -n "$HOST_AVAIL" ]] \
    && ((GAP_BYTES > HOST_AVAIL)) && ((GAP_BYTES > 10737418240)); then
    gap_hint="，其中 $(gib "$GAP_BYTES")G 需压缩后才归还宿主"
  fi

  if [[ "$LEVEL" == "crit" ]]; then
    title=" WSL 磁盘告急 "
  else
    title=" WSL 磁盘偏低 "
  fi
  case "$LEVEL_REASON" in
    host_avail)
      message="宿主可用仅 ${avail_gib}（WSL 预算仍 ${headroom_gib}）${gap_hint}"
      ;;
    both)
      message="宿主可用 ${avail_gib}，WSL 预算 ${headroom_gib}${gap_hint}"
      ;;
    *)
      message="可写余量 ${headroom_gib}${gap_hint}"
      ;;
  esac

  # tmux run-shell -b, not a bare background job: a popup spawned from a
  # dying timer process would be reaped with it. See docs/reminders.md.
  "$reminder" "$title" "$message" 62 7 >/dev/null 2>&1 || true

  LAST_ALERT_LEVEL="$LEVEL"
  LAST_ALERT_AT_MS="$(now_ms)"
}

# --- subcommands ---------------------------------------------------------
cmd_sample() {
  load_previous
  measure
  if should_alert; then
    fire_alert
  fi
  publish
}

cmd_status() {
  load_previous
  measure

  printf 'level        %s  (reason=%s)\n' "$LEVEL" "$LEVEL_REASON"
  printf 'headroom     %sG  (%s%% of budget)   <- WSL budget left\n' \
    "$(gib "$HEADROOM_BYTES")" "${HEADROOM_PCT:-?}"
  printf '  host avail %sG   (room for the vhdx to grow, of %sG volume)\n' \
    "$(gib "$HOST_AVAIL")" "$(gib "$HOST_SIZE")"
  if [[ "$GAP_ON_VOLUME" == "0" && -n "$GAP_BYTES" ]] && ((GAP_BYTES > 0)); then
    printf '  gap        %sG   (NOT counted: vhdx is on %s, not %s)\n' \
      "$(gib "$GAP_BYTES")" "${VHDX_MOUNT:-?}" "$HOST_MOUNT"
  else
    printf '  gap        %sG   (inside the vhdx, reused in place)\n' "$(gib "$GAP_BYTES")"
  fi
  printf '  reserve   -%sG   (withheld from WSL so %s never goes dry)\n' \
    "$(gib "$RESERVE_BYTES")" "${HOST_MOUNT:-the volume}"
  printf 'budget       %sG   (volume minus reserve)\n' "$(gib "$BUDGET_BYTES")"
  printf 'badge        %sG   (number shown when level != ok)\n' "$(gib "$BADGE_BYTES")"
  printf 'host mount   %s%s\n' "${HOST_MOUNT:-<unresolved>}" \
    "$([[ -n "$VOLUME" ]] && printf ' (configured)' || printf ' (from vhdx)')"
  printf 'vhdx         %s\n' "${VHDX_PATH:-<unresolved>}"
  printf 'vhdx size    %sG\n' "$(gib "$VHDX_BYTES")"
  printf 'guest used   %sG\n' "$(gib "$GUEST_USED")"
  printf 'thresholds   headroom warn<%s%% crit<%s%%; avail warn<%sG crit<=%sG (reserve %sG)\n' \
    "$WARN_PCT" "$CRIT_PCT" "$AVAIL_WARN_GB" "$AVAIL_CRIT_GB" "$RESERVE_GB"
  printf 'status file  %s\n' "$(status_file_path)"
  printf 'history file %s  (max %s samples)\n' "$(history_file_path)" "$HISTORY_MAX"
  if [[ -n "$LAST_ALERT_LEVEL" ]]; then
    printf 'last alert   %s\n' "$LAST_ALERT_LEVEL"
  fi

  # Compaction moves gap into avail. It does not create headroom, so it is
  # only worth doing when the file is out of room to grow while sitting on
  # reusable space — or when something other than WSL needs the volume.
  if [[ -n "$GAP_BYTES" && -n "$HOST_AVAIL" ]] && ((GAP_BYTES > HOST_AVAIL)); then
    local distro="${WSL_DISTRO_NAME:-Ubuntu-24.04}"
    printf '\nCompaction would move %sG from gap back to host avail.\n' "$(gib "$GAP_BYTES")"
    printf '  sudo fstrim -av\n'
    printf '  # then from Windows (preferred on WSL 3.0.1+):\n'
    printf '  wsl --manage %s --compact\n' "$distro"
    printf '  # or elevated PowerShell:\n'
    printf '  wsl --shutdown\n'
    printf '  Optimize-VHD -Path "%s" -Mode Full\n' "$(wslpath -w "${VHDX_PATH:-}" 2>/dev/null || printf '<vhdx>')"
    printf 'See docs/host-disk.md.\n'
  fi
}

main() {
  case "${1:-}" in
    sample) cmd_sample ;;
    status) cmd_status ;;
    -h | --help | help) usage ;;
    *)
      usage >&2
      exit 64
      ;;
  esac
}

main "$@"
