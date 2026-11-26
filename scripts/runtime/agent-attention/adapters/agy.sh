#!/usr/bin/env bash
# Agy hooks use camelCase conversationId and require JSON on stdout.
set -u

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
action="${1:-}"
payload="$(cat 2>/dev/null || true)"

if [[ "${WEZDECK_AGY_MANAGED:-0}" == 1 && -n "${TMUX_PANE:-}" && -n "$payload" ]] \
    && command -v jq >/dev/null 2>&1; then
  session_id="$(jq -r '.conversationId // empty' <<<"$payload" 2>/dev/null || true)"
  if [[ -n "$session_id" ]]; then
    # Extract clean first line of lastUserInput (strip <USER_REQUEST> wrapper if present).
    prompt_summary="$(jq -r '
      (.lastUserInput // empty)
      | gsub("(?s)^.*<USER_REQUEST>\\s*"; "")
      | gsub("(?s)\\s*</USER_REQUEST>.*$"; "")
      | split("\n")
      | map(gsub("^\\s+|\\s+$"; ""))
      | map(select(length > 0))
      | .[0] // empty
      | .[0:80]
    ' <<<"$payload" 2>/dev/null || true)"

    emit_status="$action"
    raw_event="$action"
    reason_arg=()
    extra_env=()

    case "$action" in
      running)
        raw_event="PreInvocation"
        [[ -n "$prompt_summary" ]] && extra_env+=("AGENT_ATTENTION_PROMPT_SUMMARY=$prompt_summary")
        ;;
      ask-waiting)
        emit_status="waiting"
        raw_event="PreToolUse"
        ask_q="$(jq -r '(.toolCall.args.questions[0].question // empty) | split("\n")[0] | .[0:80]' <<<"$payload" 2>/dev/null || true)"
        extra_env+=("AGENT_ATTENTION_NOTIFICATION_TYPE=elicitation_dialog")
        reason_arg=(--reason "${ask_q:-Waiting on your answer}")
        ;;
      ask-resolved)
        emit_status="running"
        raw_event="PostToolUse"
        [[ -n "$prompt_summary" ]] && extra_env+=("AGENT_ATTENTION_PROMPT_SUMMARY=$prompt_summary")
        ;;
      done)
        raw_event="Stop"
        err_text="$(jq -r '(.error // empty) | split("\n")[0] | .[0:80]' <<<"$payload" 2>/dev/null || true)"
        [[ -n "$err_text" ]] && reason_arg=(--reason "$err_text")
        ;;
    esac

    env "${extra_env[@]+"${extra_env[@]}"}" \
      "$script_dir/../emit.sh" \
      --provider agy --session-id "$session_id" --raw-event "$raw_event" \
      "${reason_arg[@]+"${reason_arg[@]}"}" \
      "$emit_status" <<<"$payload" >/dev/null 2>&1 || true
  fi
fi

case "$action" in
  done) printf '{"decision":"stop"}\n' ;;
  ask-waiting) printf '{"decision":"allow"}\n' ;;
  *) printf '{}\n' ;;
esac
