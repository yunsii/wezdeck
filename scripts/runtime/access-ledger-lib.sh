#!/usr/bin/env bash
# Durable user-access ledger for navigation surfaces (Alt+g / Alt+x) and
# worktree focus restore after WezTerm / tmux restart.
#
# Signal is "user visited / selected", never pane output. Live tmux
# mirrors (@wezterm_user_interact_ts) remain the hot-path sort key when
# present; this file fills gaps after tmux death and feeds Alt+x.
#
# Schema (single JSON, atomic tmp+rename under flock):
# {
#   "version": 1,
#   "sessions": {
#     "<tmux_session>": {
#       "last_access_ms": 0,
#       "last_path": "/abs/worktree",
#       "recent_paths": [ {"path":"...", "ms":0}, ... ]  # capped MRU
#     }
#   },
#   "worktrees": {
#     "/abs/worktree": { "last_access_ms": 0, "session": "<tmux_session>" }
#   }
# }
#
# Fail-open: every helper returns 0 / empty on error so hooks never
# break the tmux server or picker open path.

# shellcheck disable=SC2034

ACCESS_LEDGER_RECENT_CAP="${ACCESS_LEDGER_RECENT_CAP:-8}"
ACCESS_LEDGER_VERSION=1

access_ledger_path() {
  local lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck disable=SC1091
  . "$lib_dir/wsl-runtime-paths-lib.sh"
  printf '%s' "$WSL_ACCESS_LEDGER_FILE"
}

access_ledger_now_ms() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    printf '%s\n' "$(( ${EPOCHREALTIME//./} / 1000 ))"
    return 0
  fi
  date +%s%3N 2>/dev/null || date +%s000
}

# Sanitize session / path for jq --arg use (already literal; no-op).
# Touch session + worktree. Optional ms defaults to now.
# Usage: access_ledger_touch <session> <worktree_path> [ms]
access_ledger_touch() {
  local session_name="${1:-}"
  local worktree_path="${2:-}"
  local ms="${3:-}"
  local ledger_path=""
  local lock_path=""
  local tmp=""
  local cap="$ACCESS_LEDGER_RECENT_CAP"

  [[ -n "$session_name" && -n "$worktree_path" ]] || return 0
  if [[ ! "$ms" =~ ^[0-9]+$ ]]; then
    ms="$(access_ledger_now_ms)"
  fi
  [[ "$ms" =~ ^[0-9]+$ ]] || return 0

  ledger_path="$(access_ledger_path)"
  [[ -n "$ledger_path" ]] || return 0
  mkdir -p "${ledger_path%/*}" 2>/dev/null || return 0
  lock_path="${ledger_path}.lock"
  tmp="${ledger_path}.tmp.$$"

  (
    flock -x 9 || exit 0
    if [[ ! -s "$ledger_path" ]]; then
      printf '{"version":%s,"sessions":{},"worktrees":{}}\n' \
        "$ACCESS_LEDGER_VERSION" >"$ledger_path" 2>/dev/null || exit 0
    fi
    if ! command -v jq >/dev/null 2>&1; then
      exit 0
    fi
    jq -c \
      --arg sess "$session_name" \
      --arg path "$worktree_path" \
      --argjson ms "$ms" \
      --argjson cap "$cap" '
      .version = (.version // 1)
      | .sessions = (.sessions // {})
      | .worktrees = (.worktrees // {})
      | .sessions[$sess] = (
          (.sessions[$sess] // {})
          | .last_access_ms = $ms
          | .last_path = $path
          | .recent_paths = (
              (
                [ {path: $path, ms: $ms} ]
                + (
                    ((.recent_paths // []) | map(select(.path != $path)))
                  )
              ) | .[0:$cap]
            )
        )
      | .worktrees[$path] = {
          last_access_ms: $ms,
          session: $sess
        }
      ' "$ledger_path" >"$tmp" 2>/dev/null || exit 0
    mv -f "$tmp" "$ledger_path" 2>/dev/null || rm -f "$tmp"
  ) 9>"$lock_path" 2>/dev/null || true

  return 0
}

# Print last_access_ms for a session (or empty).
access_ledger_session_ms() {
  local session_name="${1:-}"
  local ledger_path=""
  [[ -n "$session_name" ]] || return 0
  ledger_path="$(access_ledger_path)"
  [[ -s "$ledger_path" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -r --arg s "$session_name" \
    '(.sessions[$s].last_access_ms // empty)|tostring' \
    "$ledger_path" 2>/dev/null || true
}

# Print last_path for a session (or empty).
access_ledger_session_last_path() {
  local session_name="${1:-}"
  local ledger_path=""
  [[ -n "$session_name" ]] || return 0
  ledger_path="$(access_ledger_path)"
  [[ -s "$ledger_path" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -r --arg s "$session_name" \
    '.sessions[$s].last_path // empty' \
    "$ledger_path" 2>/dev/null || true
}

# Print last_access_ms for a worktree path (or empty).
access_ledger_worktree_ms() {
  local worktree_path="${1:-}"
  local ledger_path=""
  [[ -n "$worktree_path" ]] || return 0
  ledger_path="$(access_ledger_path)"
  [[ -s "$ledger_path" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -r --arg p "$worktree_path" \
    '(.worktrees[$p].last_access_ms // empty)|tostring' \
    "$ledger_path" 2>/dev/null || true
}

# Print recent worktree paths for a session, most recent first (one per line).
# Usage: access_ledger_session_recent_paths <session> [limit]
access_ledger_session_recent_paths() {
  local session_name="${1:-}"
  local limit="${2:-$ACCESS_LEDGER_RECENT_CAP}"
  local ledger_path=""
  [[ -n "$session_name" ]] || return 0
  [[ "$limit" =~ ^[0-9]+$ ]] || limit="$ACCESS_LEDGER_RECENT_CAP"
  ledger_path="$(access_ledger_path)"
  [[ -s "$ledger_path" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -r --arg s "$session_name" --argjson n "$limit" '
    ((.sessions[$s].recent_paths // [])[:$n][] | .path // empty)
  ' "$ledger_path" 2>/dev/null || true
}

# Emit TSV: session_name \t last_access_ms for every known session.
access_ledger_all_session_ms_tsv() {
  local ledger_path=""
  ledger_path="$(access_ledger_path)"
  [[ -s "$ledger_path" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -r '
    (.sessions // {})
    | to_entries[]
    | select((.value.last_access_ms // 0) > 0)
    | [.key, (.value.last_access_ms|tostring)] | @tsv
  ' "$ledger_path" 2>/dev/null || true
}

# Emit TSV: path \t last_access_ms for every known worktree.
access_ledger_all_worktree_ms_tsv() {
  local ledger_path=""
  ledger_path="$(access_ledger_path)"
  [[ -s "$ledger_path" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -r '
    (.worktrees // {})
    | to_entries[]
    | select((.value.last_access_ms // 0) > 0)
    | [.key, (.value.last_access_ms|tostring)] | @tsv
  ' "$ledger_path" 2>/dev/null || true
}
