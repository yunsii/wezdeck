#!/usr/bin/env bash
# Fast unit test for scripts/dev/release-queue-lib.sh coalescing state transitions.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

STATE="$TMP"
# shellcheck source=scripts/dev/release-queue-lib.sh
source "$REPO/scripts/dev/release-queue-lib.sh"

assert_eq() {
  local got="$1" want="$2" label="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL [$label]: got='$got', want='$want'" >&2
    exit 1
  fi
}

# 1. Multiple rapid lands coalesce into pending_commits & advance desired_sha.
release_state_update enqueue "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "aaaaaaaa" "feat: A"
release_state_update enqueue "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "bbbbbbbb" "feat: B"
assert_eq "$(release_state_get desired_sha)" "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "desired advances"

# 2. Gate failure records failed_sha; a newer commit clears stale failure.
release_state_update failed "sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "phase=gate_failed" "error=smoke failed" "run_dir=/tmp/r1"
assert_eq "$(release_state_get phase)" "gate_failed" "phase gate_failed"
assert_eq "$(release_state_get failed_sha)" "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "failed_sha stored"

release_state_update enqueue "cccccccccccccccccccccccccccccccccccccccc" "cccccccc" "fix: C"
assert_eq "$(release_state_get failed_sha)" "" "newer commit clears failed_sha"
assert_eq "$(release_state_get desired_sha)" "cccccccccccccccccccccccccccccccccccccccc" "desired at C"

# 3. Successful deploy advances deployed_sha, resets phase to idle, and clears pending.
release_state_update deployed "sha=cccccccccccccccccccccccccccccccccccccccc" "web_fp=w1" "relay_fp=r1" "run_dir=/tmp/r2"
assert_eq "$(release_state_get phase)" "idle" "phase idle after deploy"
assert_eq "$(release_state_get deployed_sha)" "cccccccccccccccccccccccccccccccccccccccc" "deployed at C"

# 4. Async verify records verdict without altering deployed_sha.
release_state_update verified "sha=cccccccccccccccccccccccccccccccccccccccc" "status=ok" "log=/tmp/v.log"
assert_eq "$(release_state_get verify_status)" "ok" "verify ok"
assert_eq "$(release_state_get deployed_sha)" "cccccccccccccccccccccccccccccccccccccccc" "deployed preserved"

echo "PASS: release-queue-lib state machine tests"
