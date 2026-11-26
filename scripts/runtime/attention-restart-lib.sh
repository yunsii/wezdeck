#!/usr/bin/env bash
# Restart transition marker for attention readers. Sourced after
# attention-state-lib.sh, which provides the state path and locking helpers.

attention_state_mark_restart_pending() {
  local session_id="$1"
  [[ -n "$session_id" ]] || return 0
  attention_state_init
  local lock; lock="$(attention_state_lock_path)"
  (
    flock -x 9
    local current next
    current="$(attention_state_read)"
    next="$(jq --arg sid "$session_id" '.entries[$sid].restart_pending = true' <<<"$current")" || return 0
    attention_state_write "$next"
  ) 9>"$lock"
}

attention_state_clear_restart_pending() {
  local session_id="$1"
  [[ -n "$session_id" ]] || return 0
  attention_state_init
  local lock; lock="$(attention_state_lock_path)"
  (
    flock -x 9
    local current next
    current="$(attention_state_read)"
    next="$(jq --arg sid "$session_id" 'if .entries[$sid] then del(.entries[$sid].restart_pending) else . end' <<<"$current")" || return 0
    attention_state_write "$next"
  ) 9>"$lock"
}
