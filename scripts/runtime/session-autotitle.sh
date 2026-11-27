#!/usr/bin/env bash
# Single-shot session auto-title helper for `wezdeck-wsl relay`.
# Routes host-CLI invocation exclusively through adversarial-review/lib/provider.sh
# (read-only profile, attention-skip, pane-env strip).
#
# Usage:
#   printf '%s' "$context" | scripts/runtime/session-autotitle.sh [--provider <name>]
#
# Env:
#   WEZDECK_AUTOTITLE_PROVIDER      explicit provider (grok|claude|codex); empty = auto
#   WEZDECK_AUTOTITLE_EFFORT        reasoning effort (default: low)
#   WEZDECK_AUTOTITLE_MODEL_GROK    optional model override for grok
#   WEZDECK_AUTOTITLE_MODEL_CLAUDE  optional model override for claude
#   WEZDECK_AUTOTITLE_MODEL_CODEX   optional model override for codex

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [ ! -f "$REPO_ROOT/skills/adversarial-review/lib/provider.sh" ] && [ -n "${WEZDECK_REPO:-}" ]; then
  REPO_ROOT="$WEZDECK_REPO"
fi
PROMPT_FILE="$SCRIPT_DIR/session-autotitle-prompt.md"
PROVIDER_LIB="$REPO_ROOT/skills/adversarial-review/lib/provider.sh"

req_provider="${WEZDECK_AUTOTITLE_PROVIDER:-}"
effort="${WEZDECK_AUTOTITLE_EFFORT:-low}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --provider)
      req_provider="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

[ -f "$PROMPT_FILE" ] || { echo "missing prompt: $PROMPT_FILE" >&2; exit 2; }
[ -f "$PROVIDER_LIB" ] || { echo "missing provider lib: $PROVIDER_LIB" >&2; exit 2; }

# Apply optional lighter model overrides before sourcing provider.sh.
[ -n "${WEZDECK_AUTOTITLE_MODEL_GROK:-}" ] && export ADV_MODEL_GROK="$WEZDECK_AUTOTITLE_MODEL_GROK"
[ -n "${WEZDECK_AUTOTITLE_MODEL_CLAUDE:-}" ] && export ADV_MODEL_CLAUDE="$WEZDECK_AUTOTITLE_MODEL_CLAUDE"
[ -n "${WEZDECK_AUTOTITLE_MODEL_CODEX:-}" ] && export ADV_MODEL_CODEX="$WEZDECK_AUTOTITLE_MODEL_CODEX"

# shellcheck source=/dev/null
. "$PROVIDER_LIB"

input="$(cat)"
[ -n "$input" ] || exit 0

candidates=()
if [ -n "$req_provider" ]; then
  candidates+=("$req_provider")
else
  # Prefer grok first (fast, does not consume primary Claude quota), then claude, then codex.
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
