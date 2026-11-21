#!/usr/bin/env bash
# Mode 3 step feedback: progress snapshot + watch ticks.
# Sourced by run.sh after lifecycle.sh (cmd_watch calls cmd_run).
# shellcheck shell=bash

# Print one progress snapshot JSON; updates events_cursor via stdout field.
_ticket_watch_tick_json() {
  local id=$1 after=$2 round=$3 kind=$4
  env TICKETS_ROOT="$(ticket_store_root)" \
    ID="$id" AFTER="$after" ROUND="$round" KIND="$kind" \
    python3 "$(ticket_tool_root)/lib/ticket_fs.py" progress-read "$id" --after "$after" --events-limit -1 \
    | python3 -c '
import json, os, sys
data = json.load(sys.stdin)
kind = os.environ.get("KIND") or "waiting"
data["round"] = int(os.environ.get("ROUND") or 0)
if kind == "done":
    data["done"] = True
elif kind == "blocked":
    data["blocked"] = True
    data["hint"] = data.get("hint") or "reply --decision … [--continue]"
elif kind == "session_blocked":
    data["blocked"] = True
    data["owner"] = "human"
    data["hint"] = "session claim — target TUI implements; do not run/worktree"
else:
    data["waiting"] = True
prog = data.get("progress") or {}
step = prog.get("step") or data.get("phase") or "?"
msg = prog.get("message") or ""
new_ev = data.get("new_events") or []
if new_ev:
    for ev in new_ev:
        et = ev.get("type") or ""
        if et == "progress":
            print(
                "[ticket] watch · %s · %s"
                % (ev.get("step") or "?", ev.get("message") or ""),
                file=sys.stderr,
            )
        elif et:
            print("[ticket] watch · event:%s" % et, file=sys.stderr)
elif msg:
    print("[ticket] watch · %s · %s" % (step, msg), file=sys.stderr)
print(json.dumps(data, ensure_ascii=False))
'
}

cmd_progress() {
  local id="" after=0 events_limit=20
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --after) after=$2; shift 2 ;;
      --events-limit) events_limit=$2; shift 2 ;;
      *) ticket_die "unknown progress arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || ticket_die "progress requires --id"
  ticket_ensure_tree
  env TICKETS_ROOT="$(ticket_store_root)" \
    python3 "$(ticket_tool_root)/lib/ticket_fs.py" progress-read "$id" \
      --after "$after" --events-limit "$events_limit"
}

cmd_watch() {
  local id="" interval=20 once=0 max_rounds=60 backend="claude" mock=0
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --interval) interval=$2; shift 2 ;;
      --once) once=1; shift ;;
      --max-rounds) max_rounds=$2; shift 2 ;;
      --backend) backend=$2; shift 2 ;;
      --mock) mock=1; shift ;;
      *) ticket_die "unknown watch arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || ticket_die "watch requires --id"
  ticket_ensure_tree
  ((mock)) && export TICKET_WORKER_MOCK=1

  local round=0 root status phase owner events_cursor=0 tick
  root="$(ticket_store_root)"
  [[ -f "$root/_data/$id/ticket.md" ]] || ticket_die "ticket not found: $id" 2

  while (( round < max_rounds )); do
    round=$((round + 1))
    status="$(awk -F': ' '/^status:/{print $2; exit}' "$root/_data/$id/ticket.md" | tr -d '"')"
    phase="$(awk -F': ' '/^phase:/{print $2; exit}' "$root/_data/$id/ticket.md" | tr -d '"')"
    owner="$(awk -F': ' '/^owner:/{print $2; exit}' "$root/_data/$id/ticket.md" | tr -d '"')"
    ticket_log "watch round=$round status=$status phase=$phase owner=$owner"

    case "$status" in
      closed|rejected)
        tick="$(_ticket_watch_tick_json "$id" "$events_cursor" "$round" done)"
        printf '%s\n' "$tick"
        return 0
        ;;
      shipped)
        tick="$(_ticket_watch_tick_json "$id" "$events_cursor" "$round" done)"
        printf '%s\n' "$tick" | python3 -c '
import json,sys
d=json.load(sys.stdin)
d["done"]=True
d["status"]="shipped"
d["hint"]="initiator verify / close"
print(json.dumps(d,ensure_ascii=False))
'
        return 0
        ;;
      waiting_initiator|failed)
        tick="$(_ticket_watch_tick_json "$id" "$events_cursor" "$round" blocked)"
        printf '%s\n' "$tick"
        events_cursor="$(printf '%s' "$tick" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("events_cursor") or 0)')"
        ((once)) && return 0
        sleep "$interval"
        continue
        ;;
    esac

    # Auto-continue implement only for worker-owned tickets. Session claims stay in TUI.
    if [[ "$owner" == "human" && ( "$phase" == "approved_to_implement" || "$phase" == "research_done" || "$phase" == "session" ) ]]; then
      tick="$(_ticket_watch_tick_json "$id" "$events_cursor" "$round" session_blocked)"
      printf '%s\n' "$tick"
      events_cursor="$(printf '%s' "$tick" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("events_cursor") or 0)')"
      ((once)) && return 0
      sleep "$interval"
      continue
    fi
    if [[ "$phase" == "approved_to_implement" || "$phase" == "research_done" ]]; then
      ticket_log "watch: kicking implement (phase=$phase)"
      ticket_progress_emit "$id" "implement_kick" "watch kicking implement (phase=$phase)"
      local run_args=(--id "$id" --phase implement --backend "$backend")
      ((mock)) && run_args+=(--mock)
      cmd_run "${run_args[@]}"
      ((once)) && return 0
      sleep 1
      continue
    fi

    if [[ "$phase" == "implement_incomplete" ]]; then
      ticket_log "watch: retry implement"
      ticket_progress_emit "$id" "implement_retry" "watch retrying incomplete implement"
      local run_args=(--id "$id" --phase implement --backend "$backend")
      ((mock)) && run_args+=(--mock)
      cmd_run "${run_args[@]}"
      ((once)) && return 0
      sleep 1
      continue
    fi

    # in_progress / researching / implementing — emit progress tick
    tick="$(_ticket_watch_tick_json "$id" "$events_cursor" "$round" waiting)"
    printf '%s\n' "$tick"
    events_cursor="$(printf '%s' "$tick" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("events_cursor") or 0)')"
    ((once)) && return 0
    sleep "$interval"
  done

  printf '{"ok":false,"id":"%s","error":"max rounds reached","rounds":%s}\n' "$id" "$max_rounds" >&2
  return 2
}
