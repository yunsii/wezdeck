#!/usr/bin/env bash
# Local remote-access test stack: the production web build (vite preview with
# the Worker + HostRelay Durable Object on :3018) and a throwaway host relay,
# with EVERY path the relay writes or reads pointed into a temp dir — attention
# file, device approvals, phone uploads, Claude status snapshots. Twice a
# hand-typed stack missed WEZDECK_REMOTE_UPLOADS and test uploads landed in
# the real ~/.local/state/wezdeck/remote-uploads; this script is the fix.
#
#   scripts/dev/remote-test-stack.sh start [--home DIR]   # build + start, print env
#   scripts/dev/remote-test-stack.sh ensure [--home DIR]  # reuse a current stack, else start
#   scripts/dev/remote-test-stack.sh restart-relay        # the relay only (browser sockets stay up)
#   scripts/dev/remote-test-stack.sh env                  # print the test env again
#   scripts/dev/remote-test-stack.sh stop
#
# `start` prints `export …` lines for the cdp tests (WEZDECK_TEST_ATTENTION,
# WEZDECK_TEST_DEVICES, WEZDECK_TEST_UPLOADS); `--home DIR` runs the relay
# with HOME=DIR so it reads fixture transcripts instead of the real ones.
# The real relay (systemd wezdeck-relay) is never touched.
# Reads are open on this throwaway relay (WEZDECK_RELAY_OPEN_READS=1: the
# test browsers' device keys are made in the page and cannot be pre-approved);
# WEZDECK_TEST_GATED_READS=1 starts it gated like production, to walk the
# approve-then-read path by hand.
# Builds are skip-if-current: the relay by build.sh, the web when
# web/dist/client/build.json already carries the web source fingerprint (a
# release then deploys that same dist without building again). `ensure`
# keeps a running stack whose web build and relay both match the sources —
# the cdp tests' own version check (web/tests/version.setup.ts), done here
# first so a current stack is not torn down and rebuilt.
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
export WEZDECK_TEST_STACK_DIR=$STATE
EOF
}

stop() {
  tmux -S "$STATE/new.sock" kill-server 2>/dev/null || true
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

built_web_id() {
  sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p' "$REPO/web/dist/client/build.json" 2>/dev/null
}

alive() { [[ -f "$STATE/$1.pid" ]] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }

# a running stack serving these sources, with the relay HOME asked for
# (`start` records it; a stack started for fixture transcripts is not the
# one a plain run wants, and the other way round)
current() {
  local want_home="${1:-}"
  alive vite && alive relay || return 1
  [[ "$(cat "$STATE/home" 2>/dev/null)" == "$want_home" ]] || return 1
  local served running
  served="$(curl -sf -m 3 "http://127.0.0.1:$PORT/build.json?t=$(date +%s%N)" |
    sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p')"
  [[ "$served" == "$("$REPO/scripts/dev/source-fingerprint.sh" web)" ]] || return 1
  running="$(grep -o 'event=connected .*version=[^ ]*' "$STATE/relay.out" 2>/dev/null |
    tail -1 | sed 's/.*version=//')"
  [[ "$running" == "$("$REPO/scripts/dev/source-fingerprint.sh" native/wezdeck-wsl)" ]]
}

ensure() {
  local home=''
  [[ "${1:-}" == --home ]] && home="${2:-}"
  if current "$home"; then
    echo "# test stack current on http://127.0.0.1:$PORT (reused)"
    print_env
  else
    start "$@"
  fi
}

# the relay alone (start, restart-relay): HOME for fixture transcripts, and
# gated or open reads as `start` recorded them
start_relay() {
  local home="${1:-}"
  (exec env ${home:+HOME="$home"} \
    WEZDECK_RELAY_URL="ws://127.0.0.1:$PORT/relay/host" \
    WEZDECK_RELAY_HOST_TOKEN=dev-host-token \
    WEZDECK_RELAY_LOG_DIR="$STATE/relaylog" \
    WEZDECK_ATTENTION_FILE="$STATE/attention.json" \
    WEZDECK_REMOTE_DEVICES="$STATE/devices.json" \
    WEZDECK_REMOTE_UPLOADS="$STATE/uploads" \
    WEZDECK_CLAUDE_STATUS_DIR="$STATE/claude-status" \
    WEZDECK_RELAY_CONTROL="$STATE/relay.sock" \
    WEZDECK_ACCESS_LEDGER="$STATE/access-ledger.json" \
    WEZDECK_TODO_DB="$STATE/todo.db" \
    WEZDECK_SESSION_NEW_CMD="$STATE/fake-open-task-window" \
    TICKETS_ROOT="$STATE/tickets" \
    WEZDECK_TICKET_RUN_CMD="$STATE/fake-ticket-run" \
    WEZDECK_RELAY_OPEN_READS="$([[ "$(cat "$STATE/gated" 2>/dev/null)" == 1 ]] && echo 0 || echo 1)" \
    "$REPO/native/wezdeck-wsl/bin/wezdeck-wsl" relay) \
    >"$STATE/relay.out" 2>&1 </dev/null &
  echo $! >"$STATE/relay.pid"
  for _ in $(seq 1 20); do
    grep -q 'event=connected' "$STATE/relay.out" 2>/dev/null && break
    sleep 0.5
  done
  grep -q 'event=connected' "$STATE/relay.out" || { echo "test relay did not connect; see $STATE/relay.out" >&2; exit 1; }
}

# a relay restart with the browser's socket to the Worker still up: the host
# forgets which device each connection said hello as (relay_auth.go) — the
# case remote-link.ts re-says hello for
restart_relay() {
  if [[ -f "$STATE/relay.pid" ]]; then
    local pid
    pid="$(cat "$STATE/relay.pid")"
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  fi
  start_relay "$(cat "$STATE/home" 2>/dev/null)"
  echo "# test relay restarted"
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
  printf '%s' "$home" >"$STATE/home"
  printf '%s' "${WEZDECK_TEST_GATED_READS:-}" >"$STATE/gated"
  [[ -f "$STATE/attention.json" ]] || echo '{"entries":{}}' >"$STATE/attention.json"
  # stand-in for open-task-window (phone 新会话, session_new.go): a real
  # `git worktree add` in whatever throwaway repo the test offers, its pane a
  # `cat` on the stack's own tmux socket — never a real agent or tmux server
  cat >"$STATE/fake-open-task-window" <<FAKE
#!/usr/bin/env bash
set -euo pipefail
[[ "\$1" == --no-attach && "\$2" == --type ]] || { echo "fake: bad args \$*" >&2; exit 2; }
kind="\$3"; subject="\$5"
path="\$PWD/.worktrees/\$kind-\$subject"
git worktree add -q -b "\$kind/\$subject" "\$path" >&2
tmux -S "$STATE/new.sock" new-session -d -s "\$kind-\$subject" -c "\$path" -x 100 -y 20 "sh -c 'echo ready; exec cat'"
echo "branch_name=\$kind/\$subject"
echo "worktree_path=\$path"
echo "window_id=\$(tmux -S "$STATE/new.sock" display-message -p -t "\$kind-\$subject" '#{window_id}')"
echo "tmux_socket=$STATE/new.sock"
FAKE
  chmod +x "$STATE/fake-open-task-window"
  # a private copy of the ticket store: reads stay realistic (the tickets
  # page shows real tickets) while 新工单 / replies only write the copy; a
  # ticket run is recorded, never started
  rm -rf "$STATE/tickets"
  if [[ -d "${TICKETS_ROOT:-$HOME/.agent/tickets}" ]]; then
    cp -a "${TICKETS_ROOT:-$HOME/.agent/tickets}" "$STATE/tickets"
  else
    mkdir -p "$STATE/tickets"
  fi
  chmod 700 "$STATE/tickets"
  printf '#!/usr/bin/env bash\necho "$1" >>"%s/ticket-runs"\n' "$STATE" >"$STATE/fake-ticket-run"
  chmod +x "$STATE/fake-ticket-run"
  PATH="$HOME/.local/go/bin:$PATH" "$REPO/native/wezdeck-wsl/build.sh" >/dev/null 2>&1
  # build id = web/ source fingerprint: the cdp tests compare it with the
  # sources they test (web/tests/version.setup.ts) and refuse a stale stack
  local web_id
  web_id="$("$REPO/scripts/dev/source-fingerprint.sh" web)"
  if [[ "$(built_web_id)" != "$web_id" ]]; then
    (cd "$REPO/web" && WEZDECK_BUILD_ID="$web_id" \
      corepack pnpm exec vite build >"$STATE/build.log" 2>&1)
  fi
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
  start_relay "$home"
  echo "# test stack up on http://127.0.0.1:$PORT (state $STATE)"
  print_env
}

case "${1:-}" in
  start) shift; start "$@" ;;
  ensure) shift; ensure "$@" ;;
  restart-relay) restart_relay ;;
  stop) stop ;;
  env) print_env ;;
  *) echo "usage: $0 start [--home DIR] | ensure [--home DIR] | restart-relay | env | stop" >&2; exit 1 ;;
esac
