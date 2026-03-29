#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/sync-prompt-lib.sh"

mode="${1:-tty}"
lang="${2:-en}"
candidates=(
  "/home/example-user"
  "/mnt/c/Users/example-user"
)

case "$mode" in
  tty)
    render_sync_prompt_output tty "$lang" "${candidates[@]}"
    ;;
  non-tty)
    render_sync_prompt_output non-tty "$lang" "${candidates[@]}"
    ;;
  *)
    printf 'usage: %s [tty|non-tty]\n' "$0" >&2
    exit 1
    ;;
esac
