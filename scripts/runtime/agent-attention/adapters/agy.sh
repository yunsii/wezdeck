#!/usr/bin/env bash
# Agy hooks use camelCase conversationId and require JSON on stdout.
set -u

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
status="${1:-}"
payload="$(cat 2>/dev/null || true)"

if [[ "${WEZDECK_AGY_MANAGED:-0}" == 1 && -n "${TMUX_PANE:-}" && -n "$payload" ]] \
    && command -v jq >/dev/null 2>&1; then
  session_id="$(jq -r '.conversationId // empty' <<<"$payload" 2>/dev/null || true)"
  if [[ -n "$session_id" ]]; then
    printf '%s' "$payload" | "$script_dir/../emit.sh" \
      --provider agy --session-id "$session_id" --raw-event "${status}" \
      "$status" >/dev/null 2>&1 || true
  fi
fi

if [[ "$status" == done ]]; then
  printf '{"decision":"stop"}\n'
else
  printf '{}\n'
fi
