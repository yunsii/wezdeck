#!/usr/bin/env bash
# Local remote-access test stack: the production web build (vite preview with
# the Worker + HostRelay Durable Object on :3018) and a throwaway host relay,
# with EVERY path the relay writes or reads pointed into a temp dir — attention
# file, device approvals, phone uploads, Claude status snapshots. Twice a
# hand-typed stack missed WEZDECK_REMOTE_UPLOADS and test uploads landed in
# the real ~/.local/state/wezdeck/remote-uploads; this script is the fix.
#
#   scripts/dev/remote-test-stack.sh start [--home DIR]   # build + start, print env
#   scripts/dev/remote-test-stack.sh env                  # print the test env again
#   scripts/dev/remote-test-stack.sh stop
#
# `start` prints `export …` lines for the cdp tests (WEZDECK_TEST_ATTENTION,
# WEZDECK_TEST_DEVICES, WEZDECK_TEST_UPLOADS); `--home DIR` runs the relay
# with HOME=DIR so it reads fixture transcripts instead of the real ones.
# The real relay (systemd wezdeck-relay) is never touched.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="${WEZDECK_TEST_STACK_DIR:-${TMPDIR:-/tmp}/wezdeck-remote-test-stack}"
PORT=3018

print_env() {
  cat <<EOF
export WEZDECK_TEST_ATTENTION=$STATE/attention.json
export WEZDECK_TEST_DEVICES=$STATE/devices.json
export WEZDECK_TEST_UPLOADS=$STATE/uploads
export WEZDECK_TEST_CLAUDE_STATUS=$STATE/claude-status
export WEZDECK_RELAY_CONTROL=$STATE/relay.sock
EOF
}

stop() {
  for f in relay vite; do
    if [[ -f "$STATE/$f.pid" ]]; then
      local pid
      pid="$(cat "$STATE/$f.pid")"
      pkill -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
      rm -f "$STATE/$f.pid"
    fi
  done
}

start() {
  local home=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --home) home="$2"; shift 2 ;;
      *) echo "unknown option $1" >&2; exit 1 ;;
    esac
  done
  stop
  mkdir -p "$STATE/uploads" "$STATE/claude-status" "$STATE/relaylog"
  [[ -f "$STATE/attention.json" ]] || echo '{"entries":{}}' >"$STATE/attention.json"
  PATH="$HOME/.local/go/bin:$PATH" "$REPO/native/wezdeck-wsl/build.sh" >/dev/null 2>&1
  (cd "$REPO/web" && corepack pnpm exec vite build >"$STATE/build.log" 2>&1)
  # the whole subshell is redirected and backgrounded: an un-redirected
  # backgrounded `cd && cmd` keeps $(…) callers' pipe open forever
  (cd "$REPO/web" && exec env VITE_WEZDECK_RUNTIME_URL=http://127.0.0.1:9 \
    corepack pnpm exec vite preview --port "$PORT" --strictPort) \
    >"$STATE/vite.log" 2>&1 </dev/null &
  echo $! >"$STATE/vite.pid"
  for _ in $(seq 1 40); do
    curl -sf -m 2 "http://127.0.0.1:$PORT/relay/health" >/dev/null && break
    sleep 1
  done
  (exec env ${home:+HOME="$home"} \
    WEZDECK_RELAY_URL="ws://127.0.0.1:$PORT/relay/host" \
    WEZDECK_RELAY_HOST_TOKEN=dev-host-token \
    WEZDECK_RELAY_LOG_DIR="$STATE/relaylog" \
    WEZDECK_ATTENTION_FILE="$STATE/attention.json" \
    WEZDECK_REMOTE_DEVICES="$STATE/devices.json" \
    WEZDECK_REMOTE_UPLOADS="$STATE/uploads" \
    WEZDECK_CLAUDE_STATUS_DIR="$STATE/claude-status" \
    WEZDECK_RELAY_CONTROL="$STATE/relay.sock" \
    "$REPO/native/wezdeck-wsl/bin/wezdeck-wsl" relay) \
    >"$STATE/relay.out" 2>&1 </dev/null &
  echo $! >"$STATE/relay.pid"
  for _ in $(seq 1 20); do
    grep -q 'event=connected' "$STATE/relay.out" 2>/dev/null && break
    sleep 0.5
  done
  grep -q 'event=connected' "$STATE/relay.out" || { echo "test relay did not connect; see $STATE/relay.out" >&2; exit 1; }
  echo "# test stack up on http://127.0.0.1:$PORT (state $STATE)"
  print_env
}

case "${1:-}" in
  start) shift; start "$@" ;;
  stop) stop ;;
  env) print_env ;;
  *) echo "usage: $0 start [--home DIR] | env | stop" >&2; exit 1 ;;
esac
