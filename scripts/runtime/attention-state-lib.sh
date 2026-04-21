#!/usr/bin/env bash
# Shared state helpers for the agent-attention feature.
#
# State file layout (JSON):
#   {
#     "version": 1,
#     "entries": {
#       "<session_id>": {
#         "session_id":     "<string>",
#         "wezterm_pane_id":"<string>",
#         "tmux_socket":    "<string>",
#         "tmux_session":   "<string>",
#         "tmux_window":    "<string>",   -- e.g. "@5"
#         "tmux_pane":      "<string>",   -- e.g. "%12"
#         "status":         "waiting" | "done",
#         "reason":         "<short text>",
#         "ts":             <epoch ms>
#       }
#     }
#   }
#
# Sourced by:
#   scripts/claude-hooks/emit-agent-status.sh  (writer)
#   scripts/runtime/attention-jump.sh          (reader / consumer)

set -u

attention_state_path() {
  if command -v wezterm-runtime-detect-paths >/dev/null 2>&1; then
    : # placeholder
  fi
  local lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck disable=SC1091
  . "$lib_dir/windows-runtime-paths-lib.sh"
  if windows_runtime_detect_paths 2>/dev/null; then
    printf '%s/state/agent-attention/attention.json' "$WINDOWS_RUNTIME_STATE_WSL"
    return 0
  fi
  local state_root="${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime"
  printf '%s/state/agent-attention/attention.json' "$state_root"
}

attention_state_lock_path() {
  local path
  path="$(attention_state_path)"
  printf '%s.lock' "$path"
}

attention_state_init() {
  local path dir
  path="$(attention_state_path)"
  dir="${path%/*}"
  mkdir -p "$dir"
  if [[ ! -f "$path" ]]; then
    printf '%s\n' '{"version":1,"entries":{}}' > "$path"
  fi
}

attention_state_now_ms() {
  date +%s%3N
}

attention_state_read() {
  local path
  path="$(attention_state_path)"
  if [[ -f "$path" ]]; then
    cat "$path"
  else
    printf '%s' '{"version":1,"entries":{}}'
  fi
}

# atomic write via tmp + rename. Caller holds flock.
attention_state_write() {
  local payload="$1" path tmp
  path="$(attention_state_path)"
  tmp="${path}.tmp.$$"
  printf '%s\n' "$payload" > "$tmp"
  mv "$tmp" "$path"
}

attention_state_upsert() {
  local session_id="$1" wezterm_pane="$2" tmux_socket="$3" tmux_session="$4"
  local tmux_window="$5" tmux_pane="$6" status="$7" reason="$8" git_branch="${9:-}"
  local ts; ts="$(attention_state_now_ms)"
  attention_state_init
  local lock
  lock="$(attention_state_lock_path)"
  (
    flock -x 9
    local current next
    current="$(attention_state_read)"
    next="$(
      jq --arg sid "$session_id" \
         --arg wp "$wezterm_pane" \
         --arg tsk "$tmux_socket" \
         --arg tses "$tmux_session" \
         --arg tw "$tmux_window" \
         --arg tp "$tmux_pane" \
         --arg st "$status" \
         --arg rs "$reason" \
         --arg gb "$git_branch" \
         --argjson ts "$ts" \
         '.entries[$sid] = {
            session_id: $sid,
            wezterm_pane_id: $wp,
            tmux_socket: $tsk,
            tmux_session: $tses,
            tmux_window: $tw,
            tmux_pane: $tp,
            status: $st,
            reason: $rs,
            git_branch: $gb,
            ts: $ts
          }' <<<"$current"
    )"
    attention_state_write "$next"
  ) 9>"$lock"
}

attention_state_remove() {
  local session_id="$1"
  attention_state_init
  local lock
  lock="$(attention_state_lock_path)"
  (
    flock -x 9
    local current next
    current="$(attention_state_read)"
    next="$(jq --arg sid "$session_id" 'del(.entries[$sid])' <<<"$current")"
    attention_state_write "$next"
  ) 9>"$lock"
}

attention_state_truncate() {
  attention_state_init
  local lock
  lock="$(attention_state_lock_path)"
  (
    flock -x 9
    attention_state_write '{"version":1,"entries":{}}'
  ) 9>"$lock"
}

# Drop entries older than TTL (ms). Default 30 minutes.
attention_state_prune() {
  local ttl_ms="${1:-1800000}"
  local now; now="$(attention_state_now_ms)"
  local cutoff=$((now - ttl_ms))
  attention_state_init
  local lock
  lock="$(attention_state_lock_path)"
  (
    flock -x 9
    local current next
    current="$(attention_state_read)"
    next="$(jq --argjson cutoff "$cutoff" \
      '.entries = (.entries | with_entries(select(.value.ts >= $cutoff)))' <<<"$current")"
    attention_state_write "$next"
  ) 9>"$lock"
}
