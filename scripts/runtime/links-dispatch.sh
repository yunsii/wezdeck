#!/usr/bin/env bash
# Dispatch action received from `picker links`. Two actions:
#   OPEN <url> [title]   open via link.open_target (slot|system; see link-open.sh)
#   COPY <url> [title]   write the URL to the Windows clipboard
# OPEN shares the same switch as Ctrl+LeftClick / QuickSelect.
# COPY goes through windows_run_powershell_command_utf8 for CJK /
# emoji round-trips (CLAUDE.md hard rule).

set -euo pipefail

action="${1:-}"
url="${2:-}"

if [[ -z "$action" ]] || [[ -z "$url" ]]; then
  printf 'links-dispatch: usage: links-dispatch.sh <OPEN|COPY> <url> [title]\n' >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/windows-shell-lib.sh"

case "$action" in
  OPEN)
    exec "$script_dir/link-open.sh" "$url"
    ;;
  COPY)
    # Single-quote escape: PowerShell uses '' to embed a literal '.
    escaped="${url//\'/\'\'}"
    windows_run_powershell_command_utf8 "Set-Clipboard -Value '$escaped'"
    ;;
  *)
    printf 'links-dispatch: unknown action "%s"\n' "$action" >&2
    exit 2
    ;;
esac
