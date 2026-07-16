#!/usr/bin/env bash
# Fail if any runtime script opens a tmux popup without going through
# tmux-display-popup.sh. Bare `tmux display-popup -C` (close) is allowed
# — that path does not paint an overlay that races copy-mode refresh.
#
# Usage: scripts/dev/check-display-popup-guard.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
wrapper='scripts/runtime/tmux-display-popup.sh'
violations=0

# Only flag lines that look like real shell invocations of
# `tmux display-popup` (optional leading `exec`). Mentions in usage
# text / comments / prose do not match.
# Allowlist: the wrapper itself, and `display-popup -C` (close only).
while IFS= read -r line; do
  file="${line%%:*}"
  rest="${line#*:}"
  lineno="${rest%%:*}"
  text="${rest#*:}"

  if [[ "$file" == *"/tmux-display-popup.sh" ]]; then
    continue
  fi
  if [[ "$text" =~ display-popup[[:space:]]+-C ]]; then
    continue
  fi

  printf 'unguarded display-popup open: %s:%s:%s\n' "$file" "$lineno" "$text"
  violations=$((violations + 1))
done < <(
  grep -rn --include='*.sh' --include='create-prompt-popup' \
    -E '^[[:space:]]*(exec[[:space:]]+)?tmux[[:space:]]+display-popup\b' \
    "$repo_root/scripts" 2>/dev/null || true
)

if (( violations > 0 )); then
  printf '\n%d unguarded open(s). Route through %s instead.\n' \
    "$violations" "$wrapper" >&2
  exit 1
fi

printf 'check-display-popup-guard: ok (all opens go through %s)\n' "$wrapper"
