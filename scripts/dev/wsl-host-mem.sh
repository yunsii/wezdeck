#!/usr/bin/env bash
# One-shot WSL guest ↔ Windows host memory reconciliation for triage.
#
# Prints three meters that often disagree after a memory spike:
#   1) guest free / AnonPages / cgroup.current+peak
#   2) Windows VmmemWSL WorkingSet + Private
#   3) host physical used/free
#
# Must go through windows-shell-lib UTF-8 wrappers (never raw powershell.exe).
# Docs: docs/guest-oom.md#guest-vs-host-memory-meters
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/runtime/windows-shell-lib.sh"

die() { printf 'wsl-host-mem: %s\n' "$*" >&2; exit 1; }

[[ -n "${WSL_DISTRO_NAME:-}" ]] || die "not inside WSL (WSL_DISTRO_NAME unset)"
command -v powershell.exe >/dev/null 2>&1 || die "powershell.exe not on PATH"

echo "=== guest ==="
free -h | sed 's/^/  /'
python3 - <<'PY'
from pathlib import Path
import re

def meminfo():
    d = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        k, v, *_ = line.replace(':', ' ').split()
        d[k] = int(v)  # KiB
    return d

def mib(kib): return kib / 1024
def gib(kib): return kib / 1024 / 1024

mi = meminfo()
anon = mi.get('AnonPages', 0)
avail = mi.get('MemAvailable', 0)
total = mi.get('MemTotal', 0)
cur_p = Path('/sys/fs/cgroup/memory.current')
peak_p = Path('/sys/fs/cgroup/memory.peak')
cur = int(cur_p.read_text()) if cur_p.exists() else None
peak = int(peak_p.read_text()) if peak_p.exists() else None
print(f"  AnonPages     : {mib(anon):.0f} MiB ({gib(anon):.2f} GiB)")
print(f"  MemAvailable  : {mib(avail):.0f} MiB ({gib(avail):.2f} GiB) / total {gib(total):.2f} GiB")
if cur is not None:
    print(f"  cgroup.current: {cur/1024/1024:.0f} MiB ({cur/1024/1024/1024:.2f} GiB)")
if peak is not None:
    print(f"  cgroup.peak   : {peak/1024/1024:.0f} MiB ({peak/1024/1024/1024:.2f} GiB)  (this boot)")
PY

echo
echo "=== windows (VmmemWSL / host) ==="
windows_run_powershell_command_utf8 '
$rows = @(Get-Process -Name VmmemWSL,Vmmem -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{
    Name = $_.ProcessName
    Id = $_.Id
    WS_MiB = [math]::Round($_.WorkingSet64/1MB, 1)
    Private_MiB = [math]::Round($_.PrivateMemorySize64/1MB, 1)
  }
})
if (-not $rows) {
  Write-Output "  (no VmmemWSL / Vmmem process — distro may be stopped)"
} else {
  $rows | Sort-Object Private_MiB -Descending | ForEach-Object {
    "  {0,-12} pid={1}  WS={2} MiB  Private={3} MiB" -f $_.Name, $_.Id, $_.WS_MiB, $_.Private_MiB
  }
}
$os = Get-CimInstance Win32_OperatingSystem
"  host         total={0:N2} GiB  free={1:N2} GiB  used={2:N2} GiB" -f `
  ($os.TotalVisibleMemorySize/1MB), `
  ($os.FreePhysicalMemory/1MB), `
  (($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)/1MB)
'

echo
echo "=== read tip ==="
echo "  guest free calm + VmmemWSL still high ⇒ autoMemoryReclaim=gradual lag (or file cache)."
echo "  force host return: from Windows run  wsl --shutdown  (kills all panes/agents)."
echo "  detail: docs/guest-oom.md#guest-vs-host-memory-meters"
