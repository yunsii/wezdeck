#!/usr/bin/env bash
# tab-overflow-prefetch-build.sh — continuous maintenance for Alt+x.
#
# Builds a base TSV under tab-stats so the press path does not scan
# items.json / stats / git. Same design rule as attention live-panes:
# keep the cache warm on a tick; the keypress only re-stamps is_current,
# warm/cold from live tmux sessions, and sorts.
#
# Output: <tab-stats>/overflow-base.tsv
# Columns (tab-separated):
#   workspace label cwd has_tab session snap_idx rank_tier rank_score
#   event_count rank_recent_ms
#
# Also backfills .session into each *-items.json when missing so future
# builders and readers share one cache (snapshot version bumped to 2).
#
# Usage:
#   tab-overflow-prefetch-build.sh
#   WEZTERM_OVERFLOW_PREFETCH_FORCE=1 tab-overflow-prefetch-build.sh
#
# Safe under flock — concurrent builders serialize on the lock.

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$script_dir/tab-stats-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/wsl-runtime-paths-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/tmux-worktree-lib.sh" 2>/dev/null || {
  tmux_worktree_session_name_for_path() { :; }
}

# Inputs (items/stats) stay on the Windows tab-stats dir so Lua can
# co-read them. Output cache is WSL-ext4 for the press-time menu.
stats_dir="$(tab_stats_dir)"
mkdir -p "$stats_dir" "$WSL_RUNTIME_STATE_DIR" 2>/dev/null || true
out="$WSL_OVERFLOW_BASE_TSV"
lock="$WSL_OVERFLOW_BASE_TSV.lock"
tmp="$out.tmp.$$"

# Skip if cache is fresh (< 3s) unless forced — update-status may fire
# this more often than needed when multiple windows tick.
if [[ -z "${WEZTERM_OVERFLOW_PREFETCH_FORCE:-}" && -f "$out" ]]; then
  now="$(date +%s 2>/dev/null || printf '0')"
  mtime="$(stat -c '%Y' "$out" 2>/dev/null || printf '0')"
  if [[ "$now" =~ ^[0-9]+$ && "$mtime" =~ ^[0-9]+$ ]]; then
    age=$((now - mtime))
    if (( age >= 0 && age < 3 )); then
      exit 0
    fi
  fi
fi

exec 9>>"$lock"
if ! flock -n 9; then
  # Another builder holds the lock — leave its result.
  exit 0
fi

shopt -s nullglob
snapshots=( "$stats_dir"/*-items.json )
shopt -u nullglob

if (( ${#snapshots[@]} == 0 )); then
  : > "$tmp"
  mv -f "$tmp" "$out"
  exit 0
fi

# Map workspace name → snapshot path (prefer .workspace field).
declare -A snap_for_ws=()
declare -a workspaces=()
for snapshot in "${snapshots[@]}"; do
  ws="$(jq -r '.workspace // empty' "$snapshot" 2>/dev/null || true)"
  if [[ -z "$ws" ]]; then
    base="${snapshot##*/}"
    ws="${base%-items.json}"
  fi
  [[ -n "$ws" ]] || continue
  snap_for_ws["$ws"]="$snapshot"
  workspaces+=("$ws")
done

if (( ${#workspaces[@]} > 0 )); then
  IFS=$'\n' read -r -d '' -a workspaces < <(
    printf '%s\n' "${workspaces[@]}" | LC_ALL=C sort -u
    printf '\0'
  ) || true
fi

declare -A score_for_sess=()
declare -A tier_for_sess=()
declare -A event_count_for_sess=()
declare -A recent_for_sess=()

populate_weights() {
  local target_ws="$1"
  local base rank_tier rank_score total_dwell_ms event_count rank_recent
  while IFS=$'\t' read -r base rank_tier rank_score total_dwell_ms event_count rank_recent; do
    [[ -n "$base" ]] || continue
    : "$total_dwell_ms"
    tier_for_sess["$base"]="$rank_tier"
    score_for_sess["$base"]="$rank_score"
    event_count_for_sess["$base"]="$event_count"
    recent_for_sess["$base"]="$rank_recent"
  done < <(tab_stats_aggregated_tsv "$target_ws" 2>/dev/null)
}

for ws in "${workspaces[@]}"; do
  populate_weights "$ws"
done

bulk_script="$script_dir/tmux-worktree/print-session-names.sh"
: > "$tmp"

for ws in "${workspaces[@]}"; do
  snapshot="${snap_for_ws[$ws]:-}"
  [[ -n "$snapshot" && -f "$snapshot" ]] || continue

  missing=()
  declare -A sess_for_cwd=()
  declare -a rows=()

  while IFS=$'\t' read -r cwd label has_tab sess; do
    [[ -n "$cwd" ]] || continue
    if [[ -n "$sess" ]]; then
      sess_for_cwd["$cwd"]="$sess"
    else
      missing+=("$cwd")
    fi
    rows+=("$cwd"$'\t'"$label"$'\t'"$has_tab"$'\t'"$sess")
  done < <(jq -r '.items[] | [.cwd, .label, (.has_tab // false | tostring), (.session // "")] | @tsv' "$snapshot" 2>/dev/null)

  if (( ${#missing[@]} > 0 )) && [[ -f "$bulk_script" ]]; then
    while IFS=$'\t' read -r cwd sess; do
      [[ -n "$cwd" && -n "$sess" ]] || continue
      sess_for_cwd["$cwd"]="$sess"
    done < <(bash "$bulk_script" "$ws" "${missing[@]}" 2>/dev/null || true)

    # Persist session names into items.json so the next builder / press
    # path never pays git again for these cwds.
    if (( ${#sess_for_cwd[@]} > 0 )); then
      map_json='{}'
      for cwd in "${!sess_for_cwd[@]}"; do
        map_json="$(jq -c --arg k "$cwd" --arg v "${sess_for_cwd[$cwd]}" '.[$k]=$v' <<<"$map_json" 2>/dev/null || printf '%s' "$map_json")"
      done
      patched="$(jq -c --argjson m "$map_json" '
        .version = 2
        | .items = [(.items // [])[] | .session = (if (.session // "") == "" then ($m[.cwd] // .session // "") else .session end)]
      ' "$snapshot" 2>/dev/null || true)"
      if [[ -n "$patched" ]]; then
        printf '%s\n' "$patched" > "${snapshot}.tmp.$$"
        mv -f "${snapshot}.tmp.$$" "$snapshot"
      fi
    fi
  fi

  snap_idx=0
  for line in "${rows[@]}"; do
    IFS=$'\t' read -r cwd label has_tab sess <<< "$line"
    snap_idx=$((snap_idx + 1))
    [[ -n "$sess" ]] || sess="${sess_for_cwd[$cwd]:-}"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$ws" "$label" "$cwd" "$has_tab" "$sess" "$snap_idx" \
      "${tier_for_sess[$sess]:-0}" \
      "${score_for_sess[$sess]:-0}" \
      "${event_count_for_sess[$sess]:-0}" \
      "${recent_for_sess[$sess]:-0}" \
      >> "$tmp"
  done
  unset sess_for_cwd
done

mv -f "$tmp" "$out"
exit 0
