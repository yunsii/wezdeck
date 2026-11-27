#!/usr/bin/env bash
# Agy hooks use camelCase conversationId and require JSON on stdout.
set -u

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
action="${1:-}"
payload="$(cat 2>/dev/null || true)"

# Lightweight state-path lookup for fast-path reads (mirrors attention_state_path
# without sourcing attention-state-lib.sh on every synchronous PreInvocation / PostToolUse).
agy_attention_state_path() {
  if [[ -n "${WEZDECK_ATTENTION_STATE_PATH:-}" ]]; then
    printf '%s' "$WEZDECK_ATTENTION_STATE_PATH"
    return 0
  fi
  if [[ -z "${WINDOWS_RUNTIME_STATE_WSL:-}" && -z "${WEZTERM_NO_PATH_CACHE:-}" ]]; then
    local cache_file="${XDG_CACHE_HOME:-$HOME/.cache}/wezterm-runtime/windows-paths.env"
    if [[ -r "$cache_file" ]]; then
      # shellcheck disable=SC1090
      . "$cache_file" 2>/dev/null || true
    fi
  fi
  if [[ -n "${WINDOWS_RUNTIME_STATE_WSL:-}" ]]; then
    printf '%s/state/agent-attention/attention.json' "$WINDOWS_RUNTIME_STATE_WSL"
  else
    printf '%s/wezterm-runtime/state/agent-attention/attention.json' "${XDG_STATE_HOME:-$HOME/.local/state}"
  fi
}

# True when attention.json already holds a live turn-running entry for this
# session on this pane with a fresh ts (and matching prompt when check_prompt=1).
agy_entry_is_fresh_running() {
  local sid="$1" pane="$2" prompt="$3" max_age_ms="$4" check_prompt="$5"
  local state_file now_ms
  [[ "${WEZDECK_AGY_FASTPATH:-1}" == "0" ]] && return 1
  state_file="$(agy_attention_state_path)"
  [[ -r "$state_file" ]] || return 1
  now_ms="$(date +%s%3N 2>/dev/null || printf '0')"
  jq -e \
    --arg sid "$sid" \
    --arg pane "$pane" \
    --arg prompt "$prompt" \
    --argjson now "$now_ms" \
    --argjson max_age "$max_age_ms" \
    --argjson check_prompt "$check_prompt" '
      (.entries[$sid] // null) as $e
      | $e != null
      and ($e.status // "") == "running"
      and (($e.running_kind // "") == "")
      and (($e.tmux_pane // "") == $pane)
      and (($now - (($e.ts // 0) | tonumber)) >= 0)
      and (($now - (($e.ts // 0) | tonumber)) < $max_age)
      and (
        $check_prompt == 0
        or $prompt == ""
        or ($e.last_user_prompt // "") == $prompt
      )
    ' "$state_file" >/dev/null 2>&1
}

agy_log_deferred_stop() {
  local sid="$1" fully_idle="$2" term_reason="$3" refreshed="$4"
  # shellcheck disable=SC1091
  . "$script_dir/../../runtime-log-lib.sh" 2>/dev/null || return 0
  WEZTERM_RUNTIME_LOG_SOURCE="agent-attention-adapter-agy.sh"
  if declare -F runtime_log_info >/dev/null 2>&1; then
    runtime_log_info attention "agy stop deferred; not fullyIdle" \
      "provider=agy" \
      "raw_event=Stop" \
      "session_id=$sid" \
      "fully_idle=${fully_idle:-omitted}" \
      "termination_reason=${term_reason:-}" \
      "refreshed_running=$refreshed" \
      "wezterm_pane=${WEZTERM_PANE:-}" \
      "tmux_pane=${TMUX_PANE:-}" 2>/dev/null || true
  fi
}

if [[ "${WEZDECK_AGY_MANAGED:-0}" == 1 && -n "${TMUX_PANE:-}" && -n "$payload" ]] \
    && command -v jq >/dev/null 2>&1; then
  # Parse all hook fields in a single jq call. Guard empty strings before split()
  # because `"" | split("\n")[0]` yields null in jq (rendered as literal "null").
  parsed="$(jq -r '
    def first_line:
      if type == "string" and length > 0 then (split("\n")[0] | .[0:80]) else "" end;
    def clean_prompt:
      if type == "string" and length > 0 then
        gsub("(?s)^.*<USER_REQUEST>\\s*"; "")
        | gsub("(?s)\\s*</USER_REQUEST>.*$"; "")
        | split("\n")
        | map(gsub("^\\s+|\\s+$"; ""))
        | map(select(length > 0))
        | (.[0] // "") | .[0:80]
      else "" end;
    [
      (.conversationId // "" | tostring),
      ((.lastUserInput // "") | clean_prompt),
      ((.toolCall.args.questions[0].question // "") | first_line),
      ((.error // "") | first_line),
      (if has("fullyIdle") then "1" else "0" end),
      (if has("fullyIdle") then (.fullyIdle | tostring) else "" end),
      (.terminationReason // "" | tostring),
      "_"
    ] | join("\u001f")
  ' <<<"$payload" 2>/dev/null || true)"

  session_id="" prompt_summary="" ask_q="" err_text="" has_fully_idle="0" fully_idle="" term_reason="" _sentinel=""
  if [[ -n "$parsed" ]]; then
    IFS=$'\x1f' read -r session_id prompt_summary ask_q err_text has_fully_idle fully_idle term_reason _sentinel <<<"$parsed"
  fi

  if [[ -n "$session_id" ]]; then
    refresh_ms="${WEZDECK_AGY_RUNNING_REFRESH_MS:-60000}"
    [[ "$refresh_ms" =~ ^[0-9]+$ ]] || refresh_ms=60000

    should_emit=1
    emit_status="$action"
    raw_event="$action"
    reason_arg=()
    extra_env=()

    case "$action" in
      pane-evict)
        raw_event="SessionStart"
        ;;
      running)
        raw_event="PreInvocation"
        [[ -n "$prompt_summary" ]] && extra_env+=("AGENT_ATTENTION_PROMPT_SUMMARY=$prompt_summary")
        if agy_entry_is_fresh_running "$session_id" "$TMUX_PANE" "$prompt_summary" "$refresh_ms" 1; then
          should_emit=0
        fi
        ;;
      resolved)
        raw_event="PostToolUse"
        if agy_entry_is_fresh_running "$session_id" "$TMUX_PANE" "" "$refresh_ms" 0; then
          should_emit=0
        fi
        ;;
      ask-waiting)
        emit_status="waiting"
        raw_event="PreToolUse"
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
        is_abnormal_stop=0
        case "$term_reason" in
          ERROR|USER_CANCELED|MAX_INVOCATIONS|MAX_FORCED_INVOCATIONS|MAX_TOKEN_BUDGET_EXCEEDED|TERMINAL_CUSTOM_HOOK|TERMINAL_STEP_TYPE)
            is_abnormal_stop=1
            ;;
        esac
        # Agy ends its turn and fires Stop while waiting on backgrounded
        # run_command / schedule / subagent tasks (fullyIdle=false, or proto3
        # default-omitted alongside NO_TOOL_CALL). Stay on `running` instead of
        # raising a false `done` badge until a truly idle or abnormal Stop lands.
        is_bg_pause=0
        if [[ "$is_abnormal_stop" -eq 0 ]]; then
          if [[ "$fully_idle" == "false" ]] \
              || [[ "$has_fully_idle" == "0" && "$term_reason" == "NO_TOOL_CALL" ]]; then
            is_bg_pause=1
          fi
        fi

        if [[ "$is_bg_pause" -eq 1 ]]; then
          refreshed_running=0
          if agy_entry_is_fresh_running "$session_id" "$TMUX_PANE" "$prompt_summary" "$refresh_ms" 1; then
            should_emit=0
          else
            emit_status="running"
            [[ -n "$prompt_summary" ]] && extra_env+=("AGENT_ATTENTION_PROMPT_SUMMARY=$prompt_summary")
            refreshed_running=1
          fi
          agy_log_deferred_stop "$session_id" "$fully_idle" "$term_reason" "$refreshed_running"
        else
          if [[ -n "$err_text" ]]; then
            reason_arg=(--reason "$err_text")
          elif [[ "$is_abnormal_stop" -eq 1 ]]; then
            case "$term_reason" in
              USER_CANCELED) reason_arg=(--reason "canceled") ;;
              ERROR) reason_arg=(--reason "error") ;;
              MAX_INVOCATIONS) reason_arg=(--reason "max invocations") ;;
              MAX_FORCED_INVOCATIONS) reason_arg=(--reason "max forced invocations") ;;
              MAX_TOKEN_BUDGET_EXCEEDED) reason_arg=(--reason "token budget exceeded") ;;
              TERMINAL_CUSTOM_HOOK) reason_arg=(--reason "hook terminated") ;;
              TERMINAL_STEP_TYPE) reason_arg=(--reason "stopped") ;;
            esac
          fi
        fi
        ;;
    esac

    if [[ "$should_emit" -eq 1 ]]; then
      env "${extra_env[@]+"${extra_env[@]}"}" \
        "$script_dir/../emit.sh" \
        --provider agy --session-id "$session_id" --raw-event "$raw_event" \
        "${reason_arg[@]+"${reason_arg[@]}"}" \
        "$emit_status" <<<"$payload" >/dev/null 2>&1 || true
    fi
  fi
fi

case "$action" in
  done) printf '{"decision":"stop"}\n' ;;
  ask-waiting) printf '{"decision":"allow"}\n' ;;
  *) printf '{}\n' ;;
esac
