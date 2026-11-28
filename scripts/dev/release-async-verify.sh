#!/usr/bin/env bash
# Detached Stage-3 post-deploy regression verifier.
# Runs OUTSIDE land.lock and deploy.lock in a dedicated detached worktree so
# slow CDP suites never block concurrent merges or deploys. When a newer
# release finishes while an older verify is still running, the old run is
# cancelled and superseded automatically.
#
#   scripts/dev/release-async-verify.sh <base_sha> <target_sha>
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/wezdeck"
# shellcheck source=scripts/dev/release-queue-lib.sh
source "$REPO/scripts/dev/release-queue-lib.sh"

base_sha="${1:-}"
target_sha="${2:-}"
[[ -n "$target_sha" ]] || { echo "usage: $0 <base_sha> <target_sha>" >&2; exit 2; }

mkdir -p "$STATE/release"
pid_file="$STATE/release/verify.pid"
lock_file="$STATE/release/verify.lock"
wt_dir="$STATE/release/verify-worktree"
log_file="${WEZDECK_VERIFY_LOG:-$STATE/release/verify-$(date +%Y%m%d-%H%M%S)-${target_sha:0:8}.log}"

exec 7>>"$lock_file"
flock -w 30 7 || exit 0
echo "$$" >"$pid_file"
cleanup() {
  local rc=$?
  if [[ "${completed:-0}" != 1 ]]; then
    release_state_update verified "sha=$target_sha" 'status=FAIL' "log=$log_file" || true
    printf '%s event=verify_done head=%s status=FAIL reason=aborted log=%s\n' \
      "$(date -Iseconds)" "${target_sha:0:8}" "$log_file" >>"$STATE/release.log" || true
  fi
  if [[ "$(cat "$pid_file" 2>/dev/null || true)" == "$$" ]]; then
    rm -f "$pid_file"
  fi
  return "$rc"
}
trap cleanup EXIT
trap 'exit 143' TERM

completed=0
release_state_update verifying "sha=$target_sha" "unit=${WEZDECK_VERIFY_UNIT:-}" "log=$log_file"
if [[ -n "${WEZDECK_VERIFY_ACK:-}" ]]; then
  printf '%s\n' "$$" >"$WEZDECK_VERIFY_ACK"
fi

{
  echo "verify: target=$target_sha base=${base_sha:-HEAD~1}"
  if [[ -d "$wt_dir/.git" || -f "$wt_dir/.git" ]]; then
    git -C "$wt_dir" checkout --detach -q "$target_sha"
    git -C "$wt_dir" reset --hard -q "$target_sha"
  else
    git -C "$REPO" worktree add --detach "$wt_dir" "$target_sha"
  fi
  # Reuse primary node_modules / built artifacts when absent in the detached worktree.
  [[ -e "$wt_dir/web/node_modules" ]] || ln -s "$REPO/web/node_modules" "$wt_dir/web/node_modules"
  mkdir -p "$wt_dir/native/wezdeck-wsl/bin"
  if [[ -x "$REPO/native/wezdeck-wsl/bin/wezdeck-wsl" ]]; then
    cp -f "$REPO/native/wezdeck-wsl/bin/wezdeck-wsl" "$wt_dir/native/wezdeck-wsl/bin/wezdeck-wsl"
    cp -f "$REPO/native/wezdeck-wsl/bin/.version" "$wt_dir/native/wezdeck-wsl/bin/.version" 2>/dev/null || true
  fi
  args=(--run)
  if [[ -n "$base_sha" ]] && git -C "$wt_dir" cat-file -e "$base_sha^{commit}" 2>/dev/null; then
    args=(--base "$base_sha" --run)
  fi
  rc=0
  (cd "$wt_dir" && WEZDECK_TEST_STACK_DIR="${TMPDIR:-/tmp}/wezdeck-async-verify-stack" \
    WEZDECK_TEST_STACK_PORT="${WEZDECK_VERIFY_STACK_PORT:-3020}" \
    scripts/dev/web-affected-tests.sh "${args[@]}") || rc=$?
  WEZDECK_TEST_STACK_DIR="${TMPDIR:-/tmp}/wezdeck-async-verify-stack" \
    WEZDECK_TEST_STACK_PORT="${WEZDECK_VERIFY_STACK_PORT:-3020}" \
    "$wt_dir/scripts/dev/remote-test-stack.sh" stop >/dev/null 2>&1 || true
  status="ok"
  ((rc == 0)) || status="FAIL"
  release_state_update verified "sha=$target_sha" "status=$status" "log=$log_file"
  printf '%s event=verify_done head=%s status=%s log=%s\n' \
    "$(date -Iseconds)" "${target_sha:0:8}" "$status" "$log_file" >>"$STATE/release.log"
  completed=1
  exit "$rc"
} >"$log_file" 2>&1
