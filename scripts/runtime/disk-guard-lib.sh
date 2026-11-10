#!/usr/bin/env bash
# Shared helpers for wsl-disk-guard.sh: history ring paths, append/trim, and
# ASCII sparkline review. Sourced by the guard; not a standalone entry point.
#
# History files live next to status.json:
#   history.ndjson         WSL / watched vhdx volume (role=wsl)
#   history-system.ndjson  Windows system volume (role=system)
#
# Each line is one compact sample. Trim is per-file so a dual-volume host
# keeps a full window on each disk. See docs/host-disk.md.

disk_guard_history_path() {
  local status_path="$1"
  local role="${2:-wsl}"
  local dir
  dir="$(dirname "$status_path")"
  case "$role" in
    system) printf '%s\n' "$dir/history-system.ndjson" ;;
    *) printf '%s\n' "$dir/history.ndjson" ;;
  esac
}

# Append one JSON object line and keep the last $max lines. max=0 disables.
disk_guard_append_history() {
  local path="$1"
  local max="$2"
  local line="$3"
  [[ "$max" =~ ^[0-9]+$ ]] || return 0
  ((max > 0)) || return 0
  [[ -n "$line" ]] || return 0
  local tmp dir
  dir="$(dirname "$path")"
  mkdir -p "$dir" 2>/dev/null || true
  tmp="${path}.tmp.$$"
  {
    [[ -f "$path" ]] && cat "$path" 2>/dev/null
    printf '%s\n' "$line"
  } 2>/dev/null | tail -n "$max" >"$tmp" 2>/dev/null || true
  mv -f "$tmp" "$path" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
}

# Classify absolute avail only (system volume has no vhdx gap). Prints level.
disk_guard_classify_avail() {
  local avail_bytes="${1:-}"
  local warn_gb="${2:-10}"
  local crit_gb="${3:-5}"
  if [[ ! "$avail_bytes" =~ ^[0-9]+$ ]]; then
    printf 'unknown\n'
    return 0
  fi
  local avail_gib
  avail_gib="$(awk -v b="$avail_bytes" 'BEGIN { printf "%.6f", b / 1073741824 }')"
  if [[ "$crit_gb" =~ ^[0-9]+(\.[0-9]+)?$ ]] \
    && awk -v a="$avail_gib" -v t="$crit_gb" 'BEGIN { exit !(t > 0 && a <= t) }'; then
    printf 'crit\n'
  elif [[ "$warn_gb" =~ ^[0-9]+(\.[0-9]+)?$ ]] \
    && awk -v a="$avail_gib" -v t="$warn_gb" 'BEGIN { exit !(t > 0 && a < t) }'; then
    printf 'warn\n'
  else
    printf 'ok\n'
  fi
}

disk_guard_level_rank() {
  case "${1:-}" in
    crit) printf '3\n' ;;
    warn) printf '2\n' ;;
    *) printf '0\n' ;;
  esac
}

# Read a numeric JSON field from an NDJSON line without requiring jq.
disk_guard_json_num() {
  local line="$1" key="$2"
  printf '%s' "$line" \
    | grep -o "\"${key}\"[[:space:]]*:[[:space:]]*-*[0-9.]*" \
    | head -1 \
    | grep -o -- '-*[0-9.]*$' || true
}

# Sparkline from whitespace-separated numbers on stdin. Empty → "-".
disk_guard_sparkline() {
  local chars='▁▂▃▄▅▆▇█'
  local -a nums=()
  local n min="" max="" i idx ch
  while read -r n; do
    [[ "$n" =~ ^[0-9]+(\.[0-9]+)?$ ]] || continue
    nums+=("$n")
    if [[ -z "$min" ]] || awk -v a="$n" -v m="$min" 'BEGIN { exit !(a < m) }'; then
      min="$n"
    fi
    if [[ -z "$max" ]] || awk -v a="$n" -v m="$max" 'BEGIN { exit !(a > m) }'; then
      max="$n"
    fi
  done
  ((${#nums[@]} > 0)) || { printf '-\n'; return 0; }
  if [[ "$min" == "$max" ]]; then
    for ((i = 0; i < ${#nums[@]}; i++)); do
      printf '%s' "${chars:4:1}"
    done
    printf '\n'
    return 0
  fi
  for n in "${nums[@]}"; do
    idx="$(awk -v v="$n" -v lo="$min" -v hi="$max" \
      'BEGIN { printf "%d", int((v - lo) / (hi - lo) * 7 + 0.5) }')"
    ((idx < 0)) && idx=0
    ((idx > 7)) && idx=7
    ch="${chars:$idx:1}"
    printf '%s' "$ch"
  done
  printf '\n'
}

# Downsample a list of numbers to at most $width points (evenly spaced).
disk_guard_downsample() {
  local width="${1:-48}"
  local -a nums=()
  local n i step
  while read -r n; do
    [[ "$n" =~ ^[0-9]+(\.[0-9]+)?$ ]] || continue
    nums+=("$n")
  done
  local count=${#nums[@]}
  ((count > 0)) || return 0
  if ((count <= width)); then
    printf '%s\n' "${nums[@]}"
    return 0
  fi
  for ((i = 0; i < width; i++)); do
    idx="$(awk -v i="$i" -v c="$count" -v w="$width" \
      'BEGIN { printf "%d", int(i * (c - 1) / (w - 1)) }')"
    printf '%s\n' "${nums[$idx]}"
  done
}

disk_guard_gib() {
  local bytes="${1:-}"
  [[ "$bytes" =~ ^[0-9]+$ ]] || { printf '?\n'; return 0; }
  awk -v b="$bytes" 'BEGIN { printf "%.1f", b / 1073741824 }'
}

# Print a one-volume history review. field is the JSON numeric key to plot.
disk_guard_print_curve() {
  local path="$1"
  local field="$2"
  local label="$3"
  local width="${4:-48}"
  local since_epoch="${5:-0}"

  if [[ ! -f "$path" ]]; then
    printf '%s  (no history yet: %s)\n' "$label" "$path"
    return 0
  fi

  local -a values=()
  local line val ts ts_epoch first_ts="" last_ts="" first_val="" last_val=""
  local min_val="" max_val=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    ts=""
    ts="$(printf '%s' "$line" | grep -o '"ts"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | head -1 | sed 's/.*"\([^"]*\)"/\1/')"
    if ((since_epoch > 0)) && [[ -n "$ts" ]]; then
      ts_epoch="$(date -d "$ts" +%s 2>/dev/null || printf '0')"
      ((ts_epoch > 0 && ts_epoch < since_epoch)) && continue
    fi
    val="$(disk_guard_json_num "$line" "$field")"
    [[ "$val" =~ ^[0-9]+(\.[0-9]+)?$ ]] || continue
    values+=("$val")
    [[ -z "$first_val" ]] && first_val="$val"
    last_val="$val"
    if [[ -z "$min_val" ]] || awk -v a="$val" -v m="$min_val" 'BEGIN { exit !(a < m) }'; then
      min_val="$val"
    fi
    if [[ -z "$max_val" ]] || awk -v a="$val" -v m="$max_val" 'BEGIN { exit !(a > m) }'; then
      max_val="$val"
    fi
    if [[ -n "$ts" ]]; then
      [[ -z "$first_ts" ]] && first_ts="$ts"
      last_ts="$ts"
    fi
  done <"$path"

  local count=${#values[@]}
  if ((count == 0)); then
    printf '%s  (no numeric samples for %s)\n' "$label" "$field"
    return 0
  fi

  local spark
  spark="$(printf '%s\n' "${values[@]}" | disk_guard_downsample "$width" | disk_guard_sparkline)"
  local first_g last_g min_g max_g
  first_g="$(disk_guard_gib "${first_val%.*}")"
  last_g="$(disk_guard_gib "${last_val%.*}")"
  min_g="$(disk_guard_gib "${min_val%.*}")"
  max_g="$(disk_guard_gib "${max_val%.*}")"
  # When the field was already fractional GiB-ish float stored as bytes, gib()
  # on the integer truncation is fine (bytes are integers in our writers).

  printf '%s  %s\n' "$label" "$spark"
  printf '    n=%s  first=%sG  last=%sG  min=%sG  max=%sG' \
    "$count" "$first_g" "$last_g" "$min_g" "$max_g"
  if [[ -n "$first_ts" && -n "$last_ts" ]]; then
    printf '  (%s → %s)' "$first_ts" "$last_ts"
  fi
  printf '\n'
}

# --- system volume + history command (used by wsl-disk-guard.sh) ----------

# Absolute-avail sample for the Windows system volume (typically /mnt/c).
# Sets SYS_* globals. Skipped when unset, missing, or same as HOST_MOUNT.
disk_guard_measure_system() {
  local system_volume="${1:-}"
  local host_mount="${2:-}"
  local warn_gb="${3:-10}"
  local crit_gb="${4:-5}"

  SYS_MOUNT=""
  SYS_AVAIL=""
  SYS_SIZE=""
  SYS_LEVEL=""
  SYS_REASON=""
  SYS_BADGE=""
  SYS_AVAIL_PCT=""

  [[ -n "$system_volume" ]] || return 0
  [[ -d "$system_volume" ]] || return 0
  if [[ -n "$host_mount" && "$system_volume" == "$host_mount" ]]; then
    return 0
  fi

  SYS_MOUNT="$system_volume"
  SYS_AVAIL="$(df --output=avail -B1 "$SYS_MOUNT" 2>/dev/null | tail -1 | tr -d ' ')"
  SYS_SIZE="$(df --output=size -B1 "$SYS_MOUNT" 2>/dev/null | tail -1 | tr -d ' ')"
  [[ "$SYS_AVAIL" =~ ^[0-9]+$ ]] || SYS_AVAIL=""
  [[ "$SYS_SIZE" =~ ^[0-9]+$ ]] || SYS_SIZE=""

  if [[ "${WEZTERM_DISK_TEST_SYS_AVAIL_BYTES:-}" =~ ^[0-9]+$ ]]; then
    SYS_AVAIL="$WEZTERM_DISK_TEST_SYS_AVAIL_BYTES"
  fi
  if [[ "${WEZTERM_DISK_TEST_SYS_SIZE_BYTES:-}" =~ ^[0-9]+$ ]]; then
    SYS_SIZE="$WEZTERM_DISK_TEST_SYS_SIZE_BYTES"
  fi

  if [[ -n "$SYS_AVAIL" && -n "$SYS_SIZE" && "$SYS_SIZE" -gt 0 ]]; then
    SYS_AVAIL_PCT="$(awk -v a="$SYS_AVAIL" -v s="$SYS_SIZE" \
      'BEGIN { printf "%.1f", a * 100 / s }')"
  fi

  SYS_LEVEL="$(disk_guard_classify_avail "$SYS_AVAIL" "$warn_gb" "$crit_gb")"
  case "$SYS_LEVEL" in
    ok) SYS_REASON="ok" ;;
    unknown) SYS_REASON="unknown" ;;
    *) SYS_REASON="host_avail" ;;
  esac
  SYS_BADGE="$SYS_AVAIL"
}

disk_guard_should_alert_system() {
  local enabled="${1:-1}"
  local cooldown="${2:-21600}"
  local now_ms="${3:-0}"
  [[ -n "${SYS_MOUNT:-}" ]] || return 1
  [[ "$enabled" == "1" ]] || return 1
  local rank prev_rank
  rank="$(disk_guard_level_rank "${SYS_LEVEL:-}")"
  prev_rank="$(disk_guard_level_rank "${SYS_PREV_LEVEL:-}")"
  ((rank >= 2)) || return 1
  ((rank > prev_rank)) && return 0
  [[ "${SYS_LEVEL:-}" == "crit" ]] || return 1
  [[ "${SYS_LAST_ALERT_AT_MS:-}" =~ ^[0-9]+$ ]] || return 0
  local elapsed_ms=$((now_ms - SYS_LAST_ALERT_AT_MS))
  ((elapsed_ms >= cooldown * 1000))
}

disk_guard_fire_alert_system() {
  local reminder_bin="$1"
  local now_ms="$2"
  local gib_fn="${3:-disk_guard_gib}"
  [[ -x "$reminder_bin" ]] || return 0
  local title message avail_gib label
  avail_gib="$($gib_fn "$SYS_AVAIL")G"
  label="$(printf '%s' "${SYS_MOUNT#/mnt/}" | tr 'a-z' 'A-Z')"
  if [[ "$label" =~ ^[A-Z]$ ]]; then
    label="${label}:"
  else
    label="$SYS_MOUNT"
  fi
  if [[ "${SYS_LEVEL:-}" == "crit" ]]; then
    title=" 系统盘告急 "
  else
    title=" 系统盘偏低 "
  fi
  message="${label} 可用仅 ${avail_gib}"
  if [[ -n "${SYS_AVAIL_PCT:-}" ]]; then
    message="${message}（${SYS_AVAIL_PCT}% free）"
  fi
  "$reminder_bin" "$title" "$message" 62 7 >/dev/null 2>&1 || true
  SYS_LAST_ALERT_LEVEL="${SYS_LEVEL:-}"
  SYS_LAST_ALERT_AT_MS="$now_ms"
}

# Emit the nested `system` object for status.json. $1 is a json_field helper
# name (prints number or null). Without SYS_MOUNT prints null.
disk_guard_system_json() {
  local json_field_fn="${1:-disk_guard_json_field}"
  if [[ -z "${SYS_MOUNT:-}" ]]; then
    printf 'null'
    return 0
  fi
  cat <<SYSJSON
{
    "host_mount": "$SYS_MOUNT",
    "level": "${SYS_LEVEL:-unknown}",
    "level_reason": "${SYS_REASON:-unknown}",
    "host_avail_bytes": $($json_field_fn "$SYS_AVAIL"),
    "host_size_bytes": $($json_field_fn "$SYS_SIZE"),
    "avail_pct": ${SYS_AVAIL_PCT:-null},
    "badge_bytes": $($json_field_fn "$SYS_BADGE"),
    "last_alert_level": "${SYS_LAST_ALERT_LEVEL:-}",
    "last_alert_at_ms": $($json_field_fn "${SYS_LAST_ALERT_AT_MS:-}")
  }
SYSJSON
}

disk_guard_json_field() {
  local value="${1:-}"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s' "$value"
  else
    printf 'null'
  fi
}

disk_guard_cmd_history() {
  local wsl_history="$1"
  local sys_history="$2"
  shift 2
  local days=7 width=48
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --days) days="${2:-7}"; shift ;;
      --days=*) days="${1#--days=}" ;;
      --width) width="${2:-48}"; shift ;;
      --width=*) width="${1#--width=}" ;;
      -h|--help)
        printf 'Usage: wsl-disk-guard.sh history [--days N] [--width N]\n'
        return 0
        ;;
      *) printf 'unknown history option: %s\n' "$1" >&2; return 64 ;;
    esac
    shift
  done
  [[ "$days" =~ ^[0-9]+$ ]] || days=7
  [[ "$width" =~ ^[0-9]+$ ]] || width=48
  ((width < 8)) && width=8
  ((width > 120)) && width=120
  local since=0
  if ((days > 0)); then
    since=$(($(date +%s) - days * 86400))
  fi
  printf 'Disk history curves (last %sd, width %s).\n' "$days" "$width"
  printf 'Run `status` for live numbers; badge presence is the warn/crit signal.\n\n'
  disk_guard_print_curve "$wsl_history" host_avail_bytes "WSL   avail" "$width" "$since"
  disk_guard_print_curve "$wsl_history" headroom_bytes "WSL   headroom" "$width" "$since"
  disk_guard_print_curve "$sys_history" host_avail_bytes "SYS   avail" "$width" "$since"
}

disk_guard_print_system_status() {
  local system_volume="${1:-}"
  local host_mount="${2:-}"
  local gib_fn="${3:-disk_guard_gib}"
  printf '\n=== System volume ===\n'
  if [[ -z "$system_volume" ]]; then
    printf 'system       (disabled)\n'
  elif [[ -z "${SYS_MOUNT:-}" ]]; then
    printf 'system       configured %s but not sampled' "$system_volume"
    if [[ -n "$host_mount" && "$system_volume" == "$host_mount" ]]; then
      printf ' (same as WSL volume)'
    fi
    printf '\n'
  else
    printf 'level        %s  (reason=%s)\n' "${SYS_LEVEL:-?}" "${SYS_REASON:-?}"
    printf 'host avail   %sG  of %sG (%s%% free)\n' \
      "$($gib_fn "$SYS_AVAIL")" "$($gib_fn "$SYS_SIZE")" "${SYS_AVAIL_PCT:-?}"
    printf 'badge        %sG\n' "$($gib_fn "$SYS_BADGE")"
    printf 'host mount   %s\n' "$SYS_MOUNT"
  fi
}
