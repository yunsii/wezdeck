#!/usr/bin/env bash
# Local remote-access test stack: the production web build (vite preview with
# the Worker + HostRelay Durable Object on :3018, WEZDECK_TEST_STACK_PORT) and a throwaway host relay,
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
# a second stack (another worktree / session) needs its own port + state dir
PORT="${WEZDECK_TEST_STACK_PORT:-3018}"

print_env() {
  cat <<EOF
export WEZDECK_TEST_ATTENTION=$STATE/attention.json
export WEZDECK_TEST_DEVICES=$STATE/devices.json
export WEZDECK_TEST_UPLOADS=$STATE/uploads
export WEZDECK_TEST_CLAUDE_STATUS=$STATE/claude-status
export WEZDECK_TEST_HABIT_DIR=$STATE/habit-weekly
export WEZDECK_RELAY_CONTROL=$STATE/relay.sock
export WEZDECK_TEST_STACK_DIR=$STATE
export WEZDECK_REMOTE_URL=http://127.0.0.1:$PORT
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
  # the page's own script must load: wezdeck-release.sh rebuilds web/dist in
  # place (same fingerprint), and a running preview kept rendering the old
  # bundle's script name — a 500 on every page until restarted (2026-11-24)
  local script
  script="$(curl -sf -m 3 "http://127.0.0.1:$PORT/console/sessions" |
    grep -ao '/assets/[^"]*\.js' | head -1)"
  [[ -n "$script" ]] && curl -sf -m 3 -o /dev/null "http://127.0.0.1:$PORT$script" || return 1
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
    WEZDECK_AGENT_PROFILE_SETTINGS_DIR="$STATE/agent-profiles" \
    WEZDECK_ACCESS_LEDGER="$STATE/access-ledger.json" \
    WEZDECK_SESSION_PINS="$STATE/session-pins.json" \
    WEZDECK_SENT_MESSAGES="$STATE/sent-messages.json" \
    WEZDECK_HABIT_SNAPSHOT_DIR="$STATE/habit-weekly" \
    WEZDECK_HABIT_SYSTEMD_DIR="$STATE/systemd-user" \
    WEZDECK_HABIT_SYSTEMCTL="$STATE/fake-habit-systemctl" \
    WEZDECK_SESSION_NEW_CMD="$STATE/fake-open-task-window" \
    WEZDECK_SESSION_REUSE_CMD="$STATE/fake-reuse-workstation" \
    WEZDECK_SESSION_RESTART_CMD="$STATE/fake-session-restart" \
    WEZDECK_SESSION_HANDOFF_CMD="$STATE/fake-session-handoff" \
    TICKETS_ROOT="$STATE/tickets" \
    WEZDECK_TICKET_RUN_CMD="$STATE/fake-ticket-run" \
    TICKET_COLLAB_RUN_CMD="$STATE/fake-ticket-run" \
    WEZDECK_REPO="$REPO" \
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
  # unix sockets cap paths at 108 bytes: a long state dir silently loses relay.sock
  if (( ${#STATE} > 90 )); then
    echo "state dir too long for unix sockets (${#STATE} > 90): set WEZDECK_TEST_STACK_DIR shorter" >&2
    exit 1
  fi
  # someone else's stack on this port would get our relay as its host
  # (each replaces the other): refuse instead of sharing it
  if curl -sf -m 2 "http://127.0.0.1:$PORT/build.json" >/dev/null 2>&1; then
    echo "port $PORT already serves another test stack: set WEZDECK_TEST_STACK_PORT (and a separate WEZDECK_TEST_STACK_DIR)" >&2
    exit 1
  fi
  mkdir -p "$STATE/uploads" "$STATE/claude-status" "$STATE/relaylog"
  # Each stack owns a fresh outbox. Fixed session ids in CDP fixtures must not
  # inherit failed/pending records from an earlier run or a release retry.
  rm -f "$STATE/sent-messages.json" "$STATE/sent-messages.json.lock"
  printf '%s' "$home" >"$STATE/home"
  printf '%s' "${WEZDECK_TEST_GATED_READS:-}" >"$STATE/gated"
  [[ -f "$STATE/attention.json" ]] || echo '{"entries":{}}' >"$STATE/attention.json"
  # stand-in for open-task-window (phone 新会话, session_new.go): a real
  # `git worktree add` in whatever throwaway repo the test offers, its pane a
  # `cat` on the stack's own tmux socket — never a real agent or tmux server
  cat >"$STATE/fake-open-task-window" <<FAKE
#!/usr/bin/env bash
set -euo pipefail
[[ "\$1" == --no-attach && "\$2" == --description ]] || { echo "fake: bad args \$*" >&2; exit 2; }
if [[ "\$4" == --agent-profile ]]; then
  set -- "\$1" "\$2" "\$3" "\${@:6}"
fi
[[ "\$4" == -- ]] || { echo "fake: bad args \$*" >&2; exit 2; }
description="\$3"; name="\$5"
path="\$PWD/.worktrees/\$name"
git worktree add -q -b "dev/\$name" "\$path" >&2
[[ -z "\$description" ]] || git config "branch.dev/\$name.description" "\$description"
tmux -S "$STATE/new.sock" new-session -d -s "\$name" -c "\$path" -x 100 -y 20 "sh -c 'echo ready; exec cat'"
echo "branch_name=dev/\$name"
echo "worktree_path=\$path"
echo "window_id=\$(tmux -S "$STATE/new.sock" display-message -p -t "\$name" '#{window_id}')"
echo "tmux_socket=$STATE/new.sock"
FAKE
  chmod +x "$STATE/fake-open-task-window"
  # stand-in for reuse-workstation (新会话 on an idle direction): records the
  # slot, opens a fresh `cat` pane for it — no recycle, no agent
  cat >"$STATE/fake-reuse-workstation" <<FAKE
#!/usr/bin/env bash
set -euo pipefail
[[ "\$1" == --no-attach ]] || { echo "fake: bad args \$*" >&2; exit 2; }
if [[ "\$2" == --agent-profile ]]; then
  set -- "\$1" "\${@:4}"
fi
[[ -d "\$2" ]] || { echo "fake: bad args \$*" >&2; exit 2; }
path="\$2"; s="reuse-\$RANDOM"
echo "\$path" >>"$STATE/reused"
tmux -S "$STATE/new.sock" new-session -d -s "\$s" -c "\$path" -x 100 -y 20 "sh -c 'echo ready; exec cat'"
echo "branch_name=\$(git -C "\$path" branch --show-current)"
echo "worktree_path=\$path"
echo "window_id=\$(tmux -S "$STATE/new.sock" display-message -p -t "\$s" '#{window_id}')"
echo "tmux_socket=$STATE/new.sock"
echo "session=\$s"
FAKE
  chmod +x "$STATE/fake-reuse-workstation"
  # stand-in for session-restart.sh (重启会话 / 新开会话, session_restart.go):
  # records each call in restart.log, never respawns a pane; a fresh start
  # names a new conversation like the real Claude path
  cat >"$STATE/fake-session-restart" <<FAKE
#!/usr/bin/env bash
echo "\$*" >>"$STATE/restart.log"
[[ " \$* " == *" --fresh "* ]] && echo "session_id=00000000-0000-4000-8000-000000000001"
echo outcome=respawned
FAKE
  chmod +x "$STATE/fake-session-restart"
  mkdir -p "$STATE/habit-weekly" "$STATE/systemd-user"
  printf '[Timer]\n' >"$STATE/systemd-user/wezdeck-habit-snapshot.timer"
  touch "$STATE/habit-enabled"
  cat >"$STATE/fake-habit-systemctl" <<FAKE
#!/usr/bin/env bash
set -euo pipefail
case " \$* " in
  *" is-enabled "*) [[ -f "$STATE/habit-enabled" ]] && echo enabled || { echo disabled; exit 1; } ;;
  *" show "*"habit-snapshot.timer"*) printf 'ActiveState=active\nNextElapseUSecRealtime=Sat 2026-11-28 12:30:00 +08\nLastTriggerUSec=Sat 2026-11-28 09:00:00 +08\n' ;;
  *" show "*"habit-snapshot.service"*) printf 'Result=success\n' ;;
  *" disable "*) rm -f "$STATE/habit-enabled" ;;
  *" enable "*) touch "$STATE/habit-enabled" ;;
  *" start "*) printf 'started\n' >>"$STATE/habit-refresh.log" ;;
esac
FAKE
  chmod +x "$STATE/fake-habit-systemctl"
  # stand-in for session-handoff.sh: record the relay argv, give the test pane
  # a stable ready screen and return a blank switch's pending id. Only the
  # test's own tmux socket is touched; no source transcript is read.
  ln -sf "$(command -v cat)" "$STATE/claude"
  cat >"$STATE/fake-session-handoff" <<FAKE
#!/usr/bin/env bash
echo "\$*" >>"$STATE/handoff.log"
tmux respawn-pane -k -t "\$2" "sh" "-c" "echo ready; exec '$STATE/claude'"
[[ " \$* " == *" --empty "* ]] && echo "session_id=pending-00000000-0000-4000-8000-000000000003"
echo outcome=respawned
FAKE
  chmod +x "$STATE/fake-session-handoff"
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
  if ! PATH="$HOME/.local/go/bin:$PATH" "$REPO/native/wezdeck-wsl/build.sh" >"$STATE/relay-build.log" 2>&1; then
    echo "test relay build failed; see $STATE/relay-build.log" >&2
    return 1
  fi
  # build id = web/ source fingerprint: the cdp tests compare it with the
  # sources they test (web/tests/version.setup.ts) and refuse a stale stack
  local web_id
  web_id="$("$REPO/scripts/dev/source-fingerprint.sh" web)"
  if [[ "$(built_web_id)" != "$web_id" ]]; then
    (cd "$REPO/web" && WEZDECK_BUILD_ID="$web_id" \
      corepack pnpm exec vite build >"$STATE/build.log" 2>&1)
  fi
  for d in "$REPO/web/dist/server" "$REPO/web/dist/wezdeck_relay_do"; do
    [[ -d "$d" ]] || continue
    printf 'RELAY_HOST_TOKEN=dev-host-token\nRELAY_CLIENT_TOKEN=dev-client-token\n' >"$d/.dev.vars"
  done
  # the whole subshell is redirected and backgrounded: an un-redirected
  # backgrounded `cd && cmd` keeps $(…) callers' pipe open forever
  (cd "$REPO/web" && exec env VITE_WEZDECK_RUNTIME_URL=http://127.0.0.1:9 \
    RELAY_HOST_TOKEN=dev-host-token RELAY_CLIENT_TOKEN=dev-client-token \
    corepack pnpm exec vite preview --port "$PORT" --strictPort) \
    >"$STATE/vite.log" 2>&1 </dev/null &
  echo $! >"$STATE/vite.pid"
  for _ in $(seq 1 40); do
    curl -sf -m 2 -H "authorization: Bearer dev-host-token" "http://127.0.0.1:$PORT/relay/health" >/dev/null && break
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
