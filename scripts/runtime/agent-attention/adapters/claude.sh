#!/usr/bin/env bash
# Normalize Claude Code hook payloads into the provider-agnostic attention
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
notification_type=""
raw_event=""
if [[ -n "$payload" ]] && command -v jq >/dev/null 2>&1; then
  session_id="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null || true)"
  raw_event="$(printf '%s' "$payload" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
  notification_type="$(printf '%s' "$payload" | jq -r '.notification_type // empty' 2>/dev/null || true)"
  reason="$(printf '%s' "$payload" \
    | jq -r '.message // .stop_reason // (.prompt | if . == null then empty else (split("\n")[0] | .[0:80]) end) // empty' \
      2>/dev/null || true)"
fi

args=(--provider claude)
[[ -n "$session_id" ]] && args+=(--session-id "$session_id")
[[ -n "$reason" ]] && args+=(--reason "$reason")
[[ -n "$notification_type" ]] && args+=(--notification-type "$notification_type")
[[ -n "$raw_event" ]] && args+=(--raw-event "$raw_event")

if [[ -n "$payload" ]]; then
  printf '%s' "$payload" | "$emit" "${args[@]}" "$status"
else
  "$emit" "${args[@]}" "$status"
fi
