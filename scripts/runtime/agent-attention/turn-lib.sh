#!/usr/bin/env bash
# Turn start, context compaction and /clear in attention.json
# (docs/remote-sessions.md "Turn progress"): the phone shows "运行中… 4m 39s" and "正在压缩上下文… 36s"
# from these fields instead of reading the TUI's screen. Sourced by
# attention-state-lib.sh (the jq defs) and emit.sh (the shell functions);
# kept out of those two, which are over their line budget.
#
# Fields on an entry:
#   turn_started    ms, while running / waiting: when this turn began
#   running_kind    "compacting" while a compaction runs (or "background")
#   compact_started ms, while compacting
#   compact_from    status before the compaction (where `compacted` returns)

# jq, appended to the upsert's entry object:
#   + turn_fields($prev; $st; $rk; $ts)
# A compaction keeps when it started and where it came from while it lasts.
# turn_started is kept through running / waiting of the same turn (queued
# prompts, permission prompts); a turn after done, after a background-only
# stretch or with no entry starts now; done drops it.
# turn_on_running($ts): the waiting / done → running flip
# (transition_to_running): a waiting turn goes on, a done one starts again.
# shellcheck disable=SC2034 # read by attention-state-lib.sh
__ATTENTION_TURN_DEF='
def turn_fields($prev; $st; $rk; $ts):
  (if ($st == "running") and ($rk == "compacting")
   then (if ($prev.running_kind // "") == "compacting"
         then {running_kind: "compacting",
               compact_started: $prev.compact_started,
               compact_from: ($prev.compact_from // "")}
         else {running_kind: "compacting",
               compact_started: $ts,
               compact_from: ($prev.status // "")}
         end)
   else {} end)
  + (if ($st == "running" or $st == "waiting") and ($rk != "background")
     then {turn_started:
            (if (($prev.status // "") == "running" or ($prev.status // "") == "waiting")
                and (($prev.running_kind // "") != "background")
                and ($prev.turn_started != null)
             then $prev.turn_started else $ts end)}
     else {} end);
def turn_on_running($ts):
  .turn_started = (if .status == "waiting" then (.turn_started // $ts) else $ts end);
'

# emit.sh: Claude PreCompact → `compacting`, SessionStart source=compact →
# `compacted`. compacting = running with running_kind=compacting (the upsert
# records compact_started / compact_from). compacted goes back by
# compact_from: an auto compaction mid-turn stays running (the turn goes
# on), a manual /compact after a finished turn returns to done, one with no
# entry before clears again; without a matching compacting it is a no-op.
# Reads / sets emit.sh's globals: status, session_id, entry_ts_ms.
attention_compaction_translate() {
  [[ "$status" == "compacting" || "$status" == "compacted" ]] || return 0
  local rk="" from=""
  if [[ -f "$(attention_state_path)" ]]; then
    IFS=$'\x1f' read -r rk from < <(jq -r --arg sid "$session_id" \
      '.entries[$sid] // {} | [.running_kind, .compact_from] | map(. // "" | tostring) | join("\u001f")' \
      "$(attention_state_path)" 2>/dev/null || true) || true
  fi
  if [[ "$status" == "compacting" ]]; then
    status="running"
    export AGENT_ATTENTION_RUNNING_KIND=compacting
  else
    [[ "$rk" == "compacting" ]] || exit 0
    unset AGENT_ATTENTION_RUNNING_KIND || true
    case "$from" in
      running|waiting) status="running" ;;
      done) status="done" ;;
      *) status="cleared" ;;
    esac
  fi
  runtime_log_info attention "compaction ${status}" \
    "session_id=${session_id:-}" "from=${from:-}" \
    "running_kind=${AGENT_ATTENTION_RUNNING_KIND:-}" \
    "entry_ts_ms=${entry_ts_ms:-}" 2>/dev/null || true
}

# emit.sh resolved (a tool call) while running_kind is background or
# compacting: background → turn-running is a new turn (it starts now); after
# an auto compaction the compaction is over and the turn goes on
# (SessionStart compact may come later). Returns 0 when it promoted.
attention_promote_to_turn() {
  local session_id="$1" rk="$2" raw_event="${3:-}"
  [[ "$rk" == "background" || "$rk" == "compacting" ]] || return 1
  local ts cur next
  ts="$(attention_state_now_ms)"
  (
    flock -x 9
    cur="$(attention_state_read)"
    next="$(jq -c --arg sid "$session_id" --argjson ts "$ts" '
      if (.entries[$sid] // null) == null then .
      else
        (if (.entries[$sid].running_kind // "") == "background"
         then .entries[$sid].turn_started = $ts else . end)
        | .entries[$sid].status = "running"
        | .entries[$sid].ts = $ts
        | .entries[$sid].reason = "running…"
        | del(.entries[$sid].running_kind, .entries[$sid].bg,
              .entries[$sid].compact_started, .entries[$sid].compact_from)
      end
    ' <<<"$cur")"
    attention_audit_prepare "upsert" "running" "running" "bg_promote" 0
    attention_state_write "$next"
  ) 9>"$(attention_state_lock_path)"
  if [[ "$rk" == "background" ]]; then
    runtime_log_info attention "bg-running promoted to turn-running" \
      "session_id=$session_id" "raw_event=$raw_event" \
      "entry_ts_ms=${entry_ts_ms:-}" 2>/dev/null || true
  else
    runtime_log_info attention "compaction ended by a tool call" \
      "session_id=$session_id" "raw_event=$raw_event" \
      "entry_ts_ms=${entry_ts_ms:-}" 2>/dev/null || true
  fi
  return 0
}

# emit.sh pane-evict (SessionStart: /clear, /new, /resume): the prior
# tenant of this pane was just archived into recent[]; mark it cleared_to
# the current id so the relay lists that session before its first prompt
# makes an entry, and answers the previous id with replaced_by. A pane pin
# alone cannot say this: it is also set at launch and goes stale after
# /resume.
#
# Resume/load must overwrite an earlier cleared_to (e.g. A→B from /new,
# then /resume A): keep pointing every other row on the pane at the
# current id, drop cleared_to on the current id itself, and leave a
# stub for any phantom id that only existed as someone's cleared_to so
# a web page still on that URL gets replaced_by.
attention_mark_cleared() {
  local socket="$1" pane="$2" new_sid="$3"
  [[ -n "$pane" && -n "$new_sid" ]] || return 0
  (
    flock -x 9
    local cur next now
    cur="$(attention_state_read)"
    now="$(attention_state_now_ms)"
    next="$(jq -c --arg tsk "$socket" --arg tp "$pane" --arg sid "$new_sid" --argjson now "$now" '
      (.recent // []) as $recent
      | ($recent
          | map(select(
              (.tmux_pane // "") == $tp and (.tmux_socket // "") == $tsk
              and (.cleared_to // "") != "" and (.cleared_to // "") != $sid
            ) | .cleared_to)
          | unique) as $phantoms
      | ($recent | map(.session_id // "") | unique) as $known
      | .recent = (
          ($recent | map(
            if (.tmux_pane // "") != $tp or (.tmux_socket // "") != $tsk then .
            elif (.session_id // "") == $sid then del(.cleared_to)
            else . + {cleared_to: $sid}
            end
          ))
          + ($phantoms
              | map(select(. as $p | ($known | index($p) | not)))
              | map({
                  session_id: .,
                  tmux_socket: $tsk,
                  tmux_pane: $tp,
                  last_status: "idle",
                  archived_ts: $now,
                  cleared_to: $sid
                }))
        )
    ' <<<"$cur")" || return 0
    attention_state_write "$next"
  ) 9>"$(attention_state_lock_path)"
}
