#!/usr/bin/env bash
# Dispatch action received from `picker links`. Two actions:
#   OPEN <url> [title]   open in default Windows browser
#   COPY <url> [title]   write the URL to the Windows clipboard
# Both go through windows_run_powershell_command_utf8 to keep CJK /
# emoji round-trips clean (CLAUDE.md hard rule).

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

# Single-quote escape: PowerShell uses '' to embed a literal '.
escaped="${url//\'/\'\'}"

case "$action" in
  OPEN)
    windows_run_powershell_command_utf8 "Start-Process '$escaped'"
    ;;
  COPY)
    windows_run_powershell_command_utf8 "Set-Clipboard -Value '$escaped'"
    ;;
  *)
    printf 'links-dispatch: unknown action "%s"\n' "$action" >&2
    exit 2
    ;;
esac
