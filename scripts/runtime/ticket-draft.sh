#!/usr/bin/env bash
# Single-shot AI ticket structuring helper for `wezdeck-wsl`.
# Routes host-CLI invocation exclusively through adversarial-review/lib/provider.sh
# (read-only profile, attention-skip, pane-env strip).
#
# Usage:
#   printf '%s' "$context" | scripts/runtime/ticket-draft.sh [--provider <name>] [--order <a,b,c>]
#
# Env:
#   WEZDECK_TICKET_DRAFT_PROVIDER      explicit provider (grok|claude|codex); empty = auto
#   WEZDECK_TICKET_DRAFT_EFFORT        reasoning effort (default: low)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [ ! -f "$REPO_ROOT/skills/adversarial-review/lib/provider.sh" ] && [ -n "${WEZDECK_REPO:-}" ]; then
  REPO_ROOT="$WEZDECK_REPO"
fi
PROMPT_FILE="$SCRIPT_DIR/ticket-draft-prompt.md"
PROVIDER_LIB="$REPO_ROOT/skills/adversarial-review/lib/provider.sh"

req_provider="${WEZDECK_TICKET_DRAFT_PROVIDER:-}"
req_order="${WEZDECK_TICKET_DRAFT_ORDER:-}"
effort="${WEZDECK_TICKET_DRAFT_EFFORT:-low}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --provider)
      req_provider="${2:-}"
      shift 2
      ;;
    --order)
      req_order="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# Ensure user/fnm/nvm CLI paths are visible under minimal systemd service PATH.
for extra_bin in \
  "$HOME/.local/bin" \
  "$HOME/.local/share/fnm/aliases/default/bin" \
  "$HOME/.fnm/aliases/default/bin" \
  "$HOME/.nvm/current/bin" \
  "$HOME/.grok/bin" \
  "$HOME/.codex/bin"; do
  if [ -d "$extra_bin" ] && [[ ":$PATH:" != *":$extra_bin:"* ]]; then
    PATH="$extra_bin:$PATH"
  fi
done
export PATH

[ -f "$PROMPT_FILE" ] || { echo "missing prompt: $PROMPT_FILE" >&2; exit 2; }
[ -f "$PROVIDER_LIB" ] || { echo "missing provider lib: $PROVIDER_LIB" >&2; exit 2; }

# shellcheck source=/dev/null
. "$PROVIDER_LIB"

input="$(cat)"
[ -n "$input" ] || exit 0

candidates=()
if [ -n "$req_provider" ]; then
  candidates+=("$req_provider")
elif [ -n "$req_order" ]; then
  IFS=',' read -r -a candidates <<<"$req_order"
else
  candidates=(grok claude codex)
fi

last_rc=3
for p in "${candidates[@]}"; do
  if ! provider_available "$p"; then
    continue
  fi
  if out="$(printf '%s' "$input" | agent_text "$p" "$PROMPT_FILE" "$effort")"; then
    if [ -n "$out" ] && [ "$out" != "__PROVIDER_UNAVAILABLE__" ]; then
      printf 'provider=%s\n' "$p" >&2
      printf '%s\n' "$out"
      exit 0
    fi
  else
    last_rc=$?
  fi
done

exit "$last_rc"
