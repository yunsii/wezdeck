#!/usr/bin/env bash
# Read-only system-disk (C:) triage for the next time the C· badge lights up.
#
# Prints:
#   1) df + disk-guard system/WSL snapshot
#   2) known hotspot sizes via PowerShell (drvfs `du` is too slow)
#   3) ranked cleanup recipe with safety tiers
#
# Does not delete anything. Cleanup commands live in docs/host-disk.md
# (System disk triage) — confirm with the human before rm.
#
# Usage:
#   scripts/dev/host-disk-triage.sh
#   scripts/dev/host-disk-triage.sh --user Yuns
#
# Docs: docs/host-disk.md#system-disk-c-triage
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/runtime/windows-shell-lib.sh"

WIN_USER="${WEZTERM_DISK_TRIAGE_USER:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      WIN_USER="${2:-}"
      shift
      ;;
    --user=*)
      WIN_USER="${1#--user=}"
      ;;
    -h | --help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      exit 64
      ;;
  esac
  shift
done

if [[ -z "$WIN_USER" ]]; then
  if [[ -n "${USERPROFILE:-}" ]]; then
    WIN_USER="$(basename "$(wslpath -u "$USERPROFILE" 2>/dev/null || printf '%s' "$USERPROFILE")")"
  fi
  [[ -n "$WIN_USER" ]] || WIN_USER="$(basename /mnt/c/Users/*/ 2>/dev/null | head -1)"
  [[ -n "$WIN_USER" ]] || WIN_USER="$USER"
fi

die() { printf 'host-disk-triage: %s\n' "$*" >&2; exit 1; }
[[ -d /mnt/c/Windows ]] || die "/mnt/c/Windows missing — system volume not mounted"
command -v powershell.exe >/dev/null 2>&1 || die "powershell.exe not on PATH"

echo "=== glance ==="
df -h /mnt/c /mnt/d 2>/dev/null | sed 's/^/  /' || df -h /mnt/c | sed 's/^/  /'
if [[ -x "$ROOT/scripts/runtime/wsl-disk-guard.sh" ]]; then
  echo
  "$ROOT/scripts/runtime/wsl-disk-guard.sh" status 2>/dev/null \
    | sed -n '/^=== /,/^thresholds/p' \
    | sed 's/^/  /'
fi

echo
echo "=== known hotspots (user=$WIN_USER) ==="
# Measure only the paths that have burned us before. Full-tree du on /mnt/c
# via drvfs is multi-minute; PowerShell on specific folders is seconds–tens.
windows_run_powershell_command_utf8 "
function DeepSizeGB(\$p) {
  if (-not (Test-Path -LiteralPath \$p)) { return \$null }
  try {
    \$bytes = (Get-ChildItem -LiteralPath \$p -Recurse -Force -File -ErrorAction SilentlyContinue |
      Measure-Object Length -Sum).Sum
    if (\$null -eq \$bytes) { return 0 }
    return [math]::Round(\$bytes / 1GB, 2)
  } catch { return \$null }
}
\$u = $(windows_powershell_quote "$WIN_USER")
\$paths = @(
  \"C:\\Users\\\$u\\AppData\\Local\\Temp\\wsl-crashes\",
  \"C:\\Users\\\$u\\AppData\\Local\\Temp\",
  \"C:\\Users\\\$u\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Service Worker\\CacheStorage\",
  \"C:\\Users\\\$u\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\",
  \"C:\\Users\\\$u\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Code Cache\",
  \"C:\\Users\\\$u\\AppData\\Roaming\\LarkShell\\aha\",
  \"C:\\Users\\\$u\\AppData\\Local\\Programs\\Microsoft VS Code\",
  \"C:\\Users\\\$u\\vscode-remote-wsl\",
  \"C:\\Users\\\$u\\Downloads\",
  \"C:\\Users\\\$u\\AppData\\Local\",
  \"C:\\Users\\\$u\\AppData\\Roaming\",
  \"C:\\Users\\\$u\",
  'C:\\Windows\\WinSxS',
  'C:\\Windows\\SoftwareDistribution\\Download',
  'C:\\Windows\\Temp',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData'
)
\$rows = foreach (\$p in \$paths) {
  \$g = DeepSizeGB \$p
  if (\$null -eq \$g) { continue }
  [pscustomobject]@{ GB = \$g; Path = \$p }
}
\$rows | Sort-Object GB -Descending | ForEach-Object {
  '{0,8}G  {1}' -f \$_.GB, \$_.Path
}
"

echo
echo "=== recipe (read-only; confirm before delete) ==="
cat <<EOF
  Tier A — usually safe, often the whole win (confirm first):
    • %LOCALAPPDATA%\\Temp\\wsl-crashes\\*.dmp
      (Playwright/WebKit / guest crash dumps; 2026-11-10 freed ~64G)
    • orphan GUID folders under %LOCALAPPDATA%\\Temp\\ containing only swap.vhdx
    • Chrome Service Worker\\CacheStorage (rebuilt on next visit)
    • confirmed-junk Downloads (old deploy tars, duplicate APKs)

  Tier B — app-owned caches (prefer in-app UI when possible):
    • LarkShell\\aha\\users  → Feishu / Lark clear-cache
    • Chrome Cache / Code Cache → chrome://settings/clearBrowserData
    • vscode-remote-wsl\\stable\\<old hashes> → keep newest 1–2

  Tier C — Windows component store (do not hand-delete):
    • WinSxS / SoftwareDistribution → Disk Cleanup (system files)
      or elevated: DISM /Online /Cleanup-Image /StartComponentCleanup

  After ANY reclaim (mandatory — do not wait for the 5 min timer):
    scripts/runtime/wsl-disk-guard.sh sample   # publishes status.json for the badge
    df -h /mnt/c
    # `status` alone does NOT update the badge; it only prints a live measure.
    scripts/runtime/wsl-disk-guard.sh history --days 2

  Full playbook: docs/host-disk.md#system-disk-c-triage
EOF
