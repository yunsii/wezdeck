#!/usr/bin/env bash
# Normalize Codex lifecycle hook payloads into the provider-agnostic attention
# emitter contract.

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
emit="$script_dir/../emit.sh"

status="${1:-}"
if [[ -z "$status" ]]; then
  exit 0
fi

payload=""
if [[ ! -t 0 ]]; then
  payload="$(cat || true)"
fi

session_id=""
reason=""
raw_event=""
if [[ -n "$payload" ]] && command -v jq >/dev/null 2>&1; then
  session_id="$(printf '%s' "$payload" \
    | jq -r '.thread_id // .threadId // .session_id // .sessionId // empty' \
      2>/dev/null || true)"
  raw_event="$(printf '%s' "$payload" \
    | jq -r '.hook_event_name // .event // .type // empty' \
      2>/dev/null || true)"
  reason="$(printf '%s' "$payload" \
    | jq -r '
        .message
        // .reason
        // .stop_reason
        // .tool.name
        // .tool_name
        // .toolName
        // (.prompt | if . == null then empty else (split("\n")[0] | .[0:80]) end)
        // empty
      ' 2>/dev/null || true)"
fi

args=(--provider codex)
[[ -n "$session_id" ]] && args+=(--session-id "$session_id")
[[ -n "$reason" ]] && args+=(--reason "$reason")
[[ -n "$raw_event" ]] && args+=(--raw-event "$raw_event")

if [[ -n "$payload" ]]; then
  printf '%s' "$payload" | "$emit" "${args[@]}" "$status"
else
  "$emit" "${args[@]}" "$status"
fi
