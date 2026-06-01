#!/usr/bin/env bash
# Per-workspace tmux-session focus statistics for the tab-visibility
# pipeline (frequency-based top-N rendering). One JSON file per workspace
# under the shared `wezterm-runtime` state dir, mirrored to the cross-FS
# routing rule documented in `docs/architecture.md` (the lua tick reads
# this file on Windows; the tmux hook writes it from WSL).
#
# Schema (per workspace):
#   {
#     "version": 1,
#     "half_life_days": 7,
#     "sessions": {
#       "<session_name>": {
#         "weight":       <float in [0,1]>,
#         "last_bump_ms": <epoch ms>,
#         "raw_count":    <int — lifetime bump count, never decayed>
#       }
#     }
#   }
#
# Weight is normalized so the max session is always 1.0 after any write.
# Decay is exponential with half-life of 7 days, applied to every session
# on every bump (so reads are trivial: just sort by `weight desc`).
#
# Sourced by:
#   scripts/runtime/tab-stats-bump.sh    (writer, called from tmux hook)
#   future readers: lua tab_visibility module via direct JSON read
#                   tab-overflow picker

set -u

__TAB_STATS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$__TAB_STATS_LIB_DIR/windows-runtime-paths-lib.sh"

# Same constants exposed both as integers (jq math) and bash vars.
TAB_STATS_HALF_LIFE_DAYS=7
TAB_STATS_MS_PER_DAY=86400000
# Skip bump if the same session was bumped within this window. Hook can
# fire several times per second when a tmux client churns; we only want
# a single weight-event per real focus burst.
TAB_STATS_THROTTLE_MS=500
# Dwell-to-weight curve for tab_stats_close_out. The entry event
# (`tab_stats_bump`) only increments raw_count — the weight delta is
# paid on LEAVE, scaled by how long the session was the active focus.
# This filters "Alt+x → glance → Esc" path-throughs (sub-second dwell
# gives weight 0) from real work bursts (≥SATURATION s gives full 1.0).
# Anything in between scales linearly so a half-minute task still
# accumulates a meaningful fraction.
TAB_STATS_DWELL_DEAD_ZONE_MS=1000
TAB_STATS_DWELL_SATURATION_MS=30000

__TAB_STATS_DIR_CACHED=""

tab_stats_dir() {
  if [[ -n "$__TAB_STATS_DIR_CACHED" ]]; then
    printf '%s' "$__TAB_STATS_DIR_CACHED"
    return 0
  fi
  if windows_runtime_detect_paths 2>/dev/null; then
    __TAB_STATS_DIR_CACHED="$WINDOWS_RUNTIME_STATE_WSL/state/tab-stats"
  else
    local state_root="${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime"
    __TAB_STATS_DIR_CACHED="$state_root/state/tab-stats"
  fi
  printf '%s' "$__TAB_STATS_DIR_CACHED"
}

# Per-client enter-state directory. Each tmux client tracks the session
# it most recently entered + the timestamp so the next bump (a switch
# to a different session) can close out the previous one with the
# correct dwell. Sibling of tab-stats/ under <state>/.
tab_stats_enter_dir() {
  printf '%s' "$(tab_stats_dir)/../tab-stats-enter"
}

# tmux exposes a client identity as `client_tty` (e.g. /dev/pts/3).
# Slug it into a safe filename: drop /dev/, rewrite any other
# non-alnum into _. Per-client (not per-session) because dwell
# semantics belong to the client doing the switching, not to the
# session being switched to.
tab_stats_client_slug() {
  local tty="${1:-}"
  if [[ -z "$tty" ]]; then
    printf '%s' '_unknown'
    return 0
  fi
  printf '%s' "$tty" \
    | LC_ALL=C sed -e 's|^/dev/||' -e 's|[^a-zA-Z0-9_-]|_|g'
}

# Sanitize workspace string into a safe filename (lowercase, alnum + dash
# + underscore). Workspace names like `default` / `work` / `config` pass
# through unchanged; any unexpected punctuation is rewritten to `_`.
tab_stats_workspace_slug() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    printf '%s' '_unknown'
    return 0
  fi
  printf '%s' "$raw" | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | LC_ALL=C sed 's/[^a-z0-9_-]/_/g'
}

tab_stats_path() {
  local workspace="${1:?missing workspace}"
  local slug
  slug="$(tab_stats_workspace_slug "$workspace")"
  printf '%s/%s.json' "$(tab_stats_dir)" "$slug"
}

tab_stats_lock_path() {
  local workspace="${1:?missing workspace}"
  printf '%s.lock' "$(tab_stats_path "$workspace")"
}

tab_stats_now_ms() {
  date +%s%3N
}

tab_stats_init() {
  local workspace="${1:?missing workspace}"
  local path dir
  path="$(tab_stats_path "$workspace")"
  dir="${path%/*}"
  mkdir -p "$dir"
  if [[ ! -f "$path" ]]; then
    printf '%s\n' \
      "{\"version\":1,\"half_life_days\":${TAB_STATS_HALF_LIFE_DAYS},\"sessions\":{}}" \
      > "$path"
  fi
}

tab_stats_read() {
  local workspace="${1:?missing workspace}"
  local path
  path="$(tab_stats_path "$workspace")"
  if [[ -f "$path" ]]; then
    cat "$path"
  else
    printf '%s' \
      "{\"version\":1,\"half_life_days\":${TAB_STATS_HALF_LIFE_DAYS},\"sessions\":{}}"
  fi
}

# Atomic write via tmp + rename. Caller MUST hold the flock.
tab_stats_write() {
  local workspace="${1:?missing workspace}"
  local payload="$2"
  local path tmp
  path="$(tab_stats_path "$workspace")"
  tmp="${path}.tmp.$$"
  printf '%s\n' "$payload" > "$tmp"
  mv "$tmp" "$path"
}

# Single jq pipeline that:
#   1. decays every session's weight by exp(-Δt_ms / half_life_ms * ln2)
#   2. updates each session's last_bump_ms = now
#   3. on the target session: weight += $weight_delta, raw_count += $raw_delta
#   4. normalizes weights so the max is exactly 1.0 (no-op if max == 0)
#
# Both tab_stats_bump (entry: weight_delta=0, raw_delta=1) and
# tab_stats_close_out (leave: weight_delta=f(dwell), raw_delta=0) flow
# through this same pipeline so reads always see a freshly-decayed,
# freshly-normalized snapshot regardless of which event source wrote it.
__TAB_STATS_WRITE_JQ='
  def half_life_ms($d): ($d * 86400000);
  def decay($w; $age_ms; $half_ms):
    if $half_ms <= 0 then $w
    elif $age_ms <= 0 then $w
    else $w * pow(2; -($age_ms / $half_ms))
    end;
  ($now | tonumber) as $now
  | ($session | tostring) as $session
  | ($weight_delta | tonumber) as $weight_delta
  | ($raw_delta | tonumber) as $raw_delta
  | (.half_life_days // 7) as $hld
  | half_life_ms($hld) as $half_ms
  | (.sessions // {}) as $existing
  | ($existing
      | to_entries
      | map(
          .key as $name
          | .value as $v
          | { key: $name,
              value: {
                weight:       decay(($v.weight // 0); ($now - ($v.last_bump_ms // $now)); $half_ms),
                last_bump_ms: $now,
                raw_count:    ($v.raw_count // 0)
              }
            }
        )
      | from_entries
    ) as $decayed
  | ($decayed[$session] // { weight: 0, last_bump_ms: $now, raw_count: 0 }) as $cur
  | $decayed
  | .[$session] = {
      weight:       (($cur.weight // 0) + $weight_delta),
      last_bump_ms: $now,
      raw_count:    (($cur.raw_count // 0) + $raw_delta)
    }
  | . as $written
  | ([$written[].weight // 0] | max) as $max
  | (if $max > 0 then
       ($written | with_entries(.value.weight = (.value.weight / $max)))
     else $written
     end) as $normed
  | { version: 1, half_life_days: $hld, sessions: $normed }
'

# Internal: apply $weight_delta + $raw_delta to <session> under the
# workspace's lock. Callers compute the deltas; this just runs the
# pipeline atomically.
__tab_stats_write_delta() {
  local workspace="$1" session_name="$2" weight_delta="$3" raw_delta="$4"
  local now current updated lock
  now="$(tab_stats_now_ms)"
  tab_stats_init "$workspace"
  lock="$(tab_stats_lock_path "$workspace")"
  (
    flock -x 9
    current="$(tab_stats_read "$workspace")"
    updated="$(printf '%s' "$current" \
      | jq --arg session "$session_name" --arg now "$now" \
           --arg weight_delta "$weight_delta" --arg raw_delta "$raw_delta" \
           "$__TAB_STATS_WRITE_JQ" 2>/dev/null)"
    if [[ -z "$updated" ]]; then
      return 0
    fi
    tab_stats_write "$workspace" "$updated"
  ) 9>>"$lock"
}

# Entry signal. Increments raw_count (the lifetime "I saw this session
# take focus" counter) but contributes NO weight on its own — the
# weight is paid on leave by tab_stats_close_out, scaled by dwell.
# Returns 0 always; throttled re-fires within TAB_STATS_THROTTLE_MS are
# silently skipped.
tab_stats_bump() {
  local workspace="${1:?missing workspace}"
  local session_name="${2:?missing session_name}"
  local now last_ms current lock
  now="$(tab_stats_now_ms)"
  tab_stats_init "$workspace"
  lock="$(tab_stats_lock_path "$workspace")"
  (
    flock -x 9
    current="$(tab_stats_read "$workspace")"
    last_ms="$(printf '%s' "$current" \
      | jq -r --arg s "$session_name" \
          '.sessions[$s].last_bump_ms // 0' 2>/dev/null || echo 0)"
    if (( last_ms > 0 )) && (( now - last_ms < TAB_STATS_THROTTLE_MS )); then
      return 0
    fi
  ) 9>>"$lock"
  __tab_stats_write_delta "$workspace" "$session_name" 0 1
}

# Map a dwell duration to a weight delta in [0, 1]:
#   dwell < DEAD_ZONE_MS       → 0      (path-through, not real use)
#   dwell ≥ SATURATION_MS      → 1.0    (full focus burst)
#   otherwise                  → linear interpolation in between
# Echoes the float on stdout.
tab_stats_dwell_to_weight() {
  local dwell_ms="${1:?missing dwell_ms}"
  if (( dwell_ms < TAB_STATS_DWELL_DEAD_ZONE_MS )); then
    printf '0'
    return 0
  fi
  if (( dwell_ms >= TAB_STATS_DWELL_SATURATION_MS )); then
    printf '1'
    return 0
  fi
  awk -v d="$dwell_ms" \
      -v dz="$TAB_STATS_DWELL_DEAD_ZONE_MS" \
      -v sat="$TAB_STATS_DWELL_SATURATION_MS" \
    'BEGIN { printf "%.6f", (d - dz) / (sat - dz) }'
}

# Leave signal. Pays the weight tab_stats_bump didn't, scaled by how
# long the session was the active focus. Skipped when dwell falls into
# the dead zone (sub-second glances stay at zero weight, exactly the
# "Alt+x peek and leave" filter we want).
tab_stats_close_out() {
  local workspace="${1:?missing workspace}"
  local session_name="${2:?missing session_name}"
  local dwell_ms="${3:?missing dwell_ms}"
  local weight_delta
  weight_delta="$(tab_stats_dwell_to_weight "$dwell_ms")"
  if [[ -z "$weight_delta" || "$weight_delta" == "0" ]]; then
    return 0
  fi
  __tab_stats_write_delta "$workspace" "$session_name" "$weight_delta" 0
}

# Print the top N session names (newline-separated, weight desc, then
# raw_count desc, then alpha asc). Empty output when state file empty.
tab_stats_top_n() {
  local workspace="${1:?missing workspace}"
  local n="${2:-5}"
  tab_stats_read "$workspace" | jq -r --argjson n "$n" '
    (.sessions // {})
    | to_entries
    | sort_by([- (.value.weight // 0), - (.value.raw_count // 0), .key])
    | .[0:$n]
    | .[].key
  '
}

# Same as top_n but emits the full record per line as TSV:
#   <session_name>\t<weight>\t<raw_count>\t<last_bump_ms>
tab_stats_top_n_tsv() {
  local workspace="${1:?missing workspace}"
  local n="${2:-5}"
  tab_stats_read "$workspace" | jq -r --argjson n "$n" '
    (.sessions // {})
    | to_entries
    | sort_by([- (.value.weight // 0), - (.value.raw_count // 0), .key])
    | .[0:$n]
    | .[]
    | [.key, (.value.weight // 0), (.value.raw_count // 0), (.value.last_bump_ms // 0)]
    | @tsv
  '
}

# Emit every session as TSV with `__refresh_<ts>_<pid>` variants
# aggregated under their base name. Mirrors the lua-side
# `_rank_sessions` aggregation so the picker (Alt+x) and the brain
# (`tab_visibility.lua`) rank from the same projection of the data.
#   <base_session_name>\t<weight_sum>\t<raw_count_sum>\t<last_bump_ms_max>
# No N cap — caller filters/sorts as needed.
tab_stats_aggregated_tsv() {
  local workspace="${1:?missing workspace}"
  tab_stats_read "$workspace" | jq -r '
    (.sessions // {})
    | to_entries
    | map({
        base: (.key | sub("__refresh_[0-9]+T[0-9]+_[0-9]+$"; "")),
        weight: (.value.weight // 0),
        raw_count: (.value.raw_count // 0),
        last_bump_ms: (.value.last_bump_ms // 0)
      })
    | group_by(.base)
    | map({
        base: .[0].base,
        weight: (map(.weight) | add),
        raw_count: (map(.raw_count) | add),
        last_bump_ms: (map(.last_bump_ms) | max)
      })
    | .[]
    | [.base, .weight, .raw_count, .last_bump_ms]
    | @tsv
  '
}
