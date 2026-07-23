#!/usr/bin/env bash
# Normalize Claude Code hook payloads into the provider-agnostic attention
# emitter contract.
#
# Also used by Grok via Claude-compat hook loading (`~/.claude/settings.json`).
# Grok payloads often use camelCase (`sessionId`, `hookEventName`) and fire
# Notification for turn_complete — emit.sh applies a waiting whitelist so
# those do not raise ⚠ (see docs/agent-attention.md "Grok Claude-compat").

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
provider="claude"
if [[ -n "$payload" ]] && command -v jq >/dev/null 2>&1; then
  # Snake_case is Claude Code; camelCase is Grok Claude-compat (and Cursor).
  session_id="$(printf '%s' "$payload" \
    | jq -r '.session_id // .sessionId // empty' 2>/dev/null || true)"
  raw_event="$(printf '%s' "$payload" \
    | jq -r '.hook_event_name // .hookEventName // empty' 2>/dev/null || true)"
  notification_type="$(printf '%s' "$payload" \
    | jq -r '.notification_type // .notificationType // .type // empty' \
      2>/dev/null || true)"
  reason="$(printf '%s' "$payload" \
    | jq -r '
        .message
        // .stop_reason
        // .stopReason
        // (.prompt | if . == null then empty else (split("\n")[0] | .[0:80]) end)
        // empty
      ' 2>/dev/null || true)"

  # Prefer provider=grok when the payload is camelCase-only or GROK_* is set,
  # so runtime.log can separate false-positive waiting diagnoses from Claude.
  has_snake_session="$(printf '%s' "$payload" | jq -r 'if has("session_id") then "1" else empty end' 2>/dev/null || true)"
  has_camel_session="$(printf '%s' "$payload" | jq -r 'if has("sessionId") then "1" else empty end' 2>/dev/null || true)"
  if [[ -n "${GROK_SESSION_ID:-}${GROK_EVENT:-}" ]] \
      || { [[ -n "$has_camel_session" && -z "$has_snake_session" ]]; }; then
    provider="grok"
  fi
fi

args=(--provider "$provider")
[[ -n "$session_id" ]] && args+=(--session-id "$session_id")
[[ -n "$reason" ]] && args+=(--reason "$reason")
[[ -n "$notification_type" ]] && args+=(--notification-type "$notification_type")
[[ -n "$raw_event" ]] && args+=(--raw-event "$raw_event")

if [[ -n "$payload" ]]; then
  printf '%s' "$payload" | "$emit" "${args[@]}" "$status"
else
  "$emit" "${args[@]}" "$status"
fi
