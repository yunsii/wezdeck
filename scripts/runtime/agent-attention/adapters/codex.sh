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

codex_auto_review_enabled() {
  case "${WEZTERM_ATTENTION_CODEX_AUTO_REVIEW_WAITING:-auto}" in
    0|false|no|off) return 1 ;;
    1|true|yes|on) return 0 ;;
  esac

  local files=()
  if [[ -n "${HOME:-}" ]]; then
    files+=("$HOME/.codex/config.toml")
  fi

  local dir="${CODEX_PROJECT_DIR:-$PWD}"
  local project_files=()
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    project_files=("$dir/.codex/config.toml" "${project_files[@]}")
    dir="${dir%/*}"
  done
  files+=("${project_files[@]}")

  local file value=""
  for file in "${files[@]}"; do
    [[ -r "$file" ]] || continue
    value="$(awk '
      /^[[:space:]]*#/ { next }
      /^[[:space:]]*approvals_reviewer[[:space:]]*=/ {
        sub(/^[^=]*=/, "", $0)
        sub(/[[:space:]]+#.*$/, "", $0)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0)
        gsub(/^["'\''"]|["'\''"]$/, "", $0)
        print $0
      }
    ' "$file" 2>/dev/null | tail -n 1)"
    [[ -n "$value" ]] || continue
  done

  [[ "$value" == "auto_review" ]]
}

# PermissionRequest means "this action entered Codex's approval path". With
# auto-review, that path is reviewer-owned rather than a human prompt; denials
# are returned to the agent as turn context, not as an operator prompt.
if [[ "$status" == "waiting" && "$raw_event" == "PermissionRequest" ]] \
    && codex_auto_review_enabled; then
  status="resolved"
  if [[ -z "$reason" ]]; then
    reason="auto-review"
  fi
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
