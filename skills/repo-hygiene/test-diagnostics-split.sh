#!/usr/bin/env bash
# Structural invariants for the diagnostics.md domain split.
# Drives the real repo tree (not fixtures): Guest OOM / Host Disk must live
# in dedicated topic docs; diagnostics.md stays an entrypoint under budget.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
fail=0

check() {
  local label="$1"
  shift
  if "$@"; then
    echo "ok $label"
  else
    echo "FAIL $label" >&2
    fail=$((fail + 1))
  fi
}

diag="$root/docs/diagnostics.md"
oom="$root/docs/guest-oom.md"
disk="$root/docs/host-disk.md"

check "diagnostics.md exists" test -f "$diag"
check "guest-oom.md exists" test -f "$oom"
check "host-disk.md exists" test -f "$disk"

diag_lines="$(wc -l <"$diag" | tr -d '[:space:]')"
oom_lines="$(wc -l <"$oom" | tr -d '[:space:]')"
disk_lines="$(wc -l <"$disk" | tr -d '[:space:]')"

check "diagnostics.md <= 600 lines (got $diag_lines)" test "$diag_lines" -le 600
check "guest-oom.md <= 600 lines (got $oom_lines)" test "$oom_lines" -le 600
check "host-disk.md <= 600 lines (got $disk_lines)" test "$disk_lines" -le 600

check "diagnostics stubs link to guest-oom" grep -q 'guest-oom.md' "$diag"
check "diagnostics stubs link to host-disk" grep -q 'host-disk.md' "$diag"
check "guest-oom has Standing memory consumers" grep -q '^### Standing memory consumers' "$oom"
check "guest-oom is primary home for oom-protect unit" grep -q 'wezterm-oom-protect.service' "$oom"
check "diagnostics is not primary home for oom-protect unit" \
  bash -c "! grep -q 'wezterm-oom-protect.service' \"$diag\""
check "host-disk mentions ext4.vhdx" grep -q 'ext4.vhdx' "$disk"
check "host-disk owns Do not enable sparse VHD section" \
  grep -q 'Do not enable sparse VHD' "$disk"
check "diagnostics does not own sparse-VHD section" \
  bash -c "! grep -q 'Do not enable sparse VHD' \"$diag\""

agents="$root/AGENTS.md"
check "AGENTS routes to guest-oom.md" grep -q 'docs/guest-oom.md' "$agents"
check "AGENTS routes to host-disk.md" grep -q 'docs/host-disk.md' "$agents"

if (( fail > 0 )); then
  echo "$fail diagnostics-split check(s) failed" >&2
  exit 1
fi
echo "all diagnostics-split checks passed"
