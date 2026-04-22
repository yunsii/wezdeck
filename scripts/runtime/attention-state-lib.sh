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
    # One tmux pane hosts at most one active attention entry, so drop any
    # other entry that shares this (tmux_socket, tmux_pane) before the
    # upsert — old sessions left behind by a killed agent or an
    # un-consumed `done` do not double-count in the counter. Falls back to
    # session_id-only dedup when the new entry has no tmux coords.
    #
    # Waiting is sticky: once a session's entry is `waiting`, a subsequent
    # `waiting` event (typically another permission_prompt in the same
    # turn) is a no-op — the original ts and reason are preserved so the
    # counter does not oscillate and the TTL clock keeps running from the
    # moment Claude first blocked for input. Only a non-waiting upsert
    # (normally `done`) transitions the entry out.
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
         '
           .entries = (
             .entries
             | to_entries
             | map(select(
                 .key == $sid
                 or $tsk == "" or $tp == ""
                 or (.value.tmux_socket // "") != $tsk
                 or (.value.tmux_pane // "") != $tp
               ))
             | from_entries
           )
           | if ($st == "waiting") and ((.entries[$sid].status // "") == "waiting")
             then .
             else .entries[$sid] = {
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
               }
             end
         ' <<<"$current"
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

# Conditional remove: drop the entry only if it is currently `waiting`.
# Used by the PostToolUse hook to acknowledge that a permission prompt
# was resolved. Leaving `done` entries alone means a Stop that fired
# between tool calls still gets rendered as done until focus-ack or
# another transition clears it.
#
# Returns 0 if an entry was actually removed, 1 on no-op. Callers use the
# return code to skip the OSC tick / log emit on no-op so PostToolUse
# (which fires on every tool call, auto-allowed or not) does not flood
# wezterm with spurious reload nudges.
attention_state_clear_if_waiting() {
  local session_id="$1"
  attention_state_init
  local path
  path="$(attention_state_path)"
  # Fast path without the lock: most PostToolUse invocations hit tools
  # that were auto-allowed, so no waiting entry exists for this session.
  # Racy with a concurrent writer, but in practice PostToolUse does not
  # race with other hooks on the same session_id.
  if [[ ! -f "$path" ]]; then
    return 1
  fi
  local current_status
  current_status="$(jq -r --arg sid "$session_id" '.entries[$sid].status // ""' "$path" 2>/dev/null || printf '')"
  if [[ "$current_status" != "waiting" ]]; then
    return 1
  fi
  local lock
  lock="$(attention_state_lock_path)"
  local removed_flag
  removed_flag="$(mktemp 2>/dev/null || printf '')"
  (
    flock -x 9
    local current next
    current="$(attention_state_read)"
    # Re-check under the lock so a concurrent transition to done is
    # respected rather than stomped on by this delayed clear.
    if [[ "$(jq -r --arg sid "$session_id" '.entries[$sid].status // ""' <<<"$current")" != "waiting" ]]; then
      exit 0
    fi
    next="$(jq --arg sid "$session_id" 'del(.entries[$sid])' <<<"$current")"
    attention_state_write "$next"
    [[ -n "$removed_flag" ]] && printf '1' > "$removed_flag"
  ) 9>"$lock"
  local rc=1
  if [[ -n "$removed_flag" && -s "$removed_flag" ]]; then
    rc=0
  fi
  [[ -n "$removed_flag" ]] && rm -f "$removed_flag" 2>/dev/null
  return "$rc"
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
