#!/usr/bin/env bash
# Start post-deploy verification outside the releasing terminal's process group.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/wezdeck"
source "$REPO/scripts/dev/release-queue-lib.sh"

base_sha="${1:-}"
target_sha="${2:-}"
[[ "$target_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'verify launch: expected target SHA' >&2; exit 2; }

mkdir -p "$STATE/release"
unit="wezdeck-verify-${target_sha:0:12}-$(date +%s%N)"
log_file="$STATE/release/verify-$(date +%Y%m%d-%H%M%S-%N)-${target_sha:0:8}.log"
ack_file="$STATE/release/verify-${target_sha:0:12}.started"
rm -f "$ack_file"

old_unit="$(release_state_get verify_unit)"
if [[ -n "$old_unit" && "$old_unit" != "$unit" ]]; then
  systemctl --user stop "$old_unit" >/dev/null 2>&1 || true
fi
release_state_update verifying "sha=$target_sha" "unit=$unit" "log=$log_file"

fail_launch() {
  local reason="$1"
  release_state_update verify_lost "sha=$target_sha" "log=$log_file"
  if [[ "$(release_state_get verified_sha)" == "$target_sha" && "$(release_state_get verify_status)" == ok ]]; then
    echo "verify launch: completed before acknowledgement (log $log_file)"
    exit 0
  fi
  printf 'verify launch failed: %s\n' "$reason" >>"$log_file"
  printf '%s event=verify_done head=%s status=FAIL reason=%s log=%s\n' \
    "$(date -Iseconds)" "${target_sha:0:8}" "$reason" "$log_file" >>"$STATE/release.log"
  echo "verify launch: $reason (log $log_file)" >&2
  exit 1
}

if ! systemd-run --user --quiet --collect --unit="$unit" \
  --setenv="HOME=$HOME" \
  --setenv="PATH=$PATH" \
  --setenv="XDG_STATE_HOME=${XDG_STATE_HOME:-$HOME/.local/state}" \
  --setenv="TMPDIR=${TMPDIR:-/tmp}" \
  --setenv="WEZDECK_VERIFY_STACK_PORT=${WEZDECK_VERIFY_STACK_PORT:-3020}" \
  --setenv="WEZDECK_VERIFY_UNIT=$unit" \
  --setenv="WEZDECK_VERIFY_LOG=$log_file" \
  --setenv="WEZDECK_VERIFY_ACK=$ack_file" \
  /usr/bin/bash "$REPO/scripts/dev/release-async-verify.sh" "$base_sha" "$target_sha"; then
  fail_launch 'systemd-run rejected the verifier'
fi

for attempt in {1..100}; do
  if [[ -s "$ack_file" ]]; then
    echo "verify launch: started $unit (log $log_file)"
    exit 0
  fi
  if ((attempt >= 10)); then
    active="$(systemctl --user show "$unit" -p ActiveState --value 2>/dev/null)" || active=""
    if [[ "$active" == inactive || "$active" == failed ]] || \
      { [[ -z "$active" ]] && systemctl --user show-environment >/dev/null 2>&1; }; then
      fail_launch 'verifier exited before startup acknowledgement'
    fi
  fi
  sleep 0.1
done

echo "verify launch: service accepted, waiting for verifier lock ($unit; log $log_file)"
