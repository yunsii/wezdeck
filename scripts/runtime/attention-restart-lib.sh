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
    local current has_live next
    current="$(attention_state_read)"
    has_live="$(jq -r --arg sid "$session_id" \
      'if (.entries[$sid] | type) == "object" and ((.entries[$sid].tmux_pane // "") != "") then "1" else "0" end' \
      <<<"$current" 2>/dev/null || echo 0)"
    if [[ "$has_live" != "1" ]]; then
      if declare -F runtime_log_info >/dev/null 2>&1; then
        runtime_log_info attention "skipped restart_pending for non-live entry" \
          "session_id=$session_id" 2>/dev/null || true
      fi
      return 0
    fi
    next="$(jq -c --arg sid "$session_id" '.entries[$sid].restart_pending = true' <<<"$current")" || return 0
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
    local current has_entry next
    current="$(attention_state_read)"
    has_entry="$(jq -r --arg sid "$session_id" 'if (.entries[$sid] | type) == "object" then "1" else "0" end' <<<"$current" 2>/dev/null || echo 0)"
    [[ "$has_entry" == "1" ]] || return 0
    next="$(jq -c --arg sid "$session_id" '
      if ((.entries[$sid].tmux_pane // "") == "") then del(.entries[$sid])
      else del(.entries[$sid].restart_pending) end
    ' <<<"$current")" || return 0
    attention_state_write "$next"
  ) 9>"$lock"
}

attention_state_prune_malformed_entries() {
  attention_state_init
  local lock; lock="$(attention_state_lock_path)"
  (
    flock -x 9
    local current pruned_ids pruned_count next
    current="$(attention_state_read)"
    pruned_ids="$(jq -r '(.entries // {}) | to_entries | map(select((.value | type) != "object" or ((.value.tmux_pane // "") == "")) | .key) | sort | join(",")' <<<"$current" 2>/dev/null || true)"
    [[ -n "$pruned_ids" ]] || return 0
    pruned_count="$(awk -F',' '{print NF}' <<<"$pruned_ids")"
    next="$(jq -c '
      .entries = ((.entries // {}) | with_entries(select((.value | type) == "object" and ((.value.tmux_pane // "") != ""))))
    ' <<<"$current")" || return 0
    attention_state_write "$next"
    if declare -F runtime_log_warn >/dev/null 2>&1; then
      runtime_log_warn attention "pruned malformed attention entries" \
        "pruned_count=$pruned_count" "pruned_ids=$pruned_ids" 2>/dev/null || true
    fi
  ) 9>"$lock"
}
