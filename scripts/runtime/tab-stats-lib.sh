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
#   3. on the bumped session: weight += 1, raw_count += 1
#   4. normalizes weights so the max is exactly 1.0 (no-op if max == 0)
#
# Pure jq function so the bump path is one fork per call.
__TAB_STATS_BUMP_JQ='
  def half_life_ms($d): ($d * 86400000);
  def decay($w; $age_ms; $half_ms):
    if $half_ms <= 0 then $w
    elif $age_ms <= 0 then $w
    else $w * pow(2; -($age_ms / $half_ms))
    end;
  ($now | tonumber) as $now
  | ($session | tostring) as $session
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
      weight:       (($cur.weight // 0) + 1),
      last_bump_ms: $now,
      raw_count:    (($cur.raw_count // 0) + 1)
    }
  | . as $bumped
  | ([$bumped[].weight // 0] | max) as $max
  | (if $max > 0 then
       ($bumped | with_entries(.value.weight = (.value.weight / $max)))
     else $bumped
     end) as $normed
  | { version: 1, half_life_days: $hld, sessions: $normed }
'

# Returns 0 (skipped due to throttle) or 0 (bumped). Caller does not need
# to distinguish — the throttle is silent.
tab_stats_bump() {
  local workspace="${1:?missing workspace}"
  local session_name="${2:?missing session_name}"
  local now last_ms current updated lock
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
    updated="$(printf '%s' "$current" \
      | jq --arg session "$session_name" --arg now "$now" \
           "$__TAB_STATS_BUMP_JQ" 2>/dev/null)"
    if [[ -z "$updated" ]]; then
      return 0
    fi
    tab_stats_write "$workspace" "$updated"
  ) 9>>"$lock"
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
