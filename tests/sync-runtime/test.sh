#!/usr/bin/env bash
# sync-runtime's guards against what took the Windows runtime down for 68 s on
# 2026-11-25: one sync at a time (sync-lock-lib.sh) and a bounded wait for
# the helper installer (sync-helper-windows-lib.sh helper_install_wait).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIB_DIR="$REPO_ROOT/skills/wezdeck-runtime-ops/scripts"
TEST_ROOT="$(mktemp -d /tmp/wezdeck-sync-runtime-test.XXXXXX)"
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$TEST_ROOT"' EXIT

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }

# --- the sync lock ----------------------------------------------------------
lock="$TEST_ROOT/sync.lock"
run_locker() {
  # a fresh shell, as each sync-runtime is: logs go nowhere
  WEZDECK_SYNC_LOCK_FILE="$lock" WEZDECK_SYNC_LOCK_WAIT="$1" bash -c '
    runtime_log_warn() { :; }; runtime_log_error() { :; }
    source "'"$LIB_DIR"'/sync-lock-lib.sh"
    acquire_sync_lock "'"$2"'"
    echo acquired
    sleep "'"${3:-0}"'"
  '
}

# a first sync holds the lock for 3 s
run_locker 5 /repo/first 3 >"$TEST_ROOT/first.out" 2>&1 &
first=$!
for _ in $(seq 1 50); do grep -q acquired "$TEST_ROOT/first.out" 2>/dev/null && break; sleep 0.1; done
grep -q acquired "$TEST_ROOT/first.out" || fail "first sync did not take the lock"
grep -q 'repo=/repo/first' "$lock.holder" || fail "holder file does not name the first sync"
pass "the first sync takes the lock and records who it is"

# a second one that will not wait long enough gives up, names the holder,
# and changes nothing
set +e
out="$(run_locker 1 /repo/second 2>&1)"
ec=$?
set -e
[[ "$ec" == 75 ]] || fail "impatient second sync: want exit 75, got $ec ($out)"
[[ "$out" == *"repo=/repo/first"* && "$out" != *acquired* ]] || fail "second sync output: $out"
pass "a second sync gives up with exit 75 and names the holder"

# one that waits gets it once the first is done
out="$(run_locker 10 /repo/third 2>&1)"
[[ "$out" == *"waiting up to 10s"* && "$out" == *acquired* ]] || fail "patient sync output: $out"
grep -q 'repo=/repo/third' "$lock.holder" || fail "holder file not updated"
wait "$first"
pass "a waiting sync takes the lock after the first one ends"

# a background helper that closes fd 9 does not keep the lock
WEZDECK_SYNC_LOCK_FILE="$lock" bash -c '
  runtime_log_warn() { :; }; runtime_log_error() { :; }
  source "'"$LIB_DIR"'/sync-lock-lib.sh"
  acquire_sync_lock /repo/fourth
  nohup sleep 5 >/dev/null 2>&1 </dev/null 9>&- &
'
out="$(run_locker 1 /repo/fifth 2>&1)" || fail "a helper with fd 9 closed kept the lock: $out"
pass "a detached helper that closes fd 9 does not hold the lock"

# --- the installer wait -------------------------------------------------------
# shellcheck disable=SC1091
source "$LIB_DIR/sync-helper-windows-lib.sh"
out_file="$TEST_ROOT/install.out"

# exits on its own
: >"$out_file"
bash -c 'echo "[helper-install] installed_client=x"; exit 0' >"$out_file" &
read -r outcome _ < <(helper_install_wait $! "$out_file" 20)
[[ "$outcome" == exited ]] || fail "clean installer: $outcome"
pass "an installer that exits is reported as exited"

# printed its last line, then never exits (a child holding its output open)
: >"$out_file"
bash -c 'echo "[helper-install] installed_client=x"; exec sleep 60' >"$out_file" &
pid=$!
start=$SECONDS
read -r outcome waited < <(WEZDECK_HELPER_INSTALL_GRACE=2 helper_install_wait "$pid" "$out_file" 20)
[[ "$outcome" == done ]] || fail "finished-but-stuck installer: $outcome"
((SECONDS - start < 10)) || fail "waited ${waited}s for a finished installer"
# reap it (a killed child stays a zombie that `kill -0` still sees until
# waited for); 143 = ended by our SIGTERM
set +e; wait "$pid"; ec=$?; set -e
[[ "$ec" == 143 ]] || fail "the stuck installer was not stopped (exit $ec)"
pass "a finished installer that does not exit is stopped after the grace period"

# hangs before finishing
: >"$out_file"
bash -c 'echo "[helper-install] dotnet=x"; exec sleep 60' >"$out_file" &
pid=$!
read -r outcome waited < <(helper_install_wait "$pid" "$out_file" 2)
[[ "$outcome" == timeout ]] || fail "hung installer: $outcome"
set +e; wait "$pid"; ec=$?; set -e
[[ "$ec" == 143 ]] || fail "the hung installer was not stopped (exit $ec)"
pass "a hung installer times out and is stopped"
