#!/usr/bin/env bash
# Behavioral: private tmux + PTY-backed attach — PTY drift heal + even-horizontal.
# Mirrors 2026-09-14 coco-forge (pts grew, tmux client stayed small).
#
# Notes for future maintainers:
# - Must `unset TMUX` (tests often run inside an agent tmux pane).
# - Background PTY attach needs `TIOCSCTTY` or the child dies immediately.
# - Keep the attach keeper simple: hold master open, do not drain reads.
# - Keep tmux.conf minimal (`-f /dev/null` + a few set-option calls).
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fix_layout="$repo_root/scripts/runtime/tmux-fix-layout.sh"
# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/tmux-fix-layout-lib.sh"

pass=0
fail=0
TEST_ROOT=""
TEST_SOCKET=""
ATTACH_KEEPER=""
REAL_TMUX=""

assert_yes() {
  local name="$1" cond="$2"
  if [[ "$cond" == "yes" ]]; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s\n' "$name"
  fi
}

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s (got=%q want=%q)\n' "$name" "$got" "$want"
  fi
}

cleanup() {
  [[ -n "$ATTACH_KEEPER" ]] && kill "$ATTACH_KEEPER" 2>/dev/null || true
  [[ -n "$ATTACH_KEEPER" ]] && wait "$ATTACH_KEEPER" 2>/dev/null || true
  if [[ -n "$TEST_SOCKET" && -n "$REAL_TMUX" ]]; then
    "$REAL_TMUX" -L "$TEST_SOCKET" kill-server >/dev/null 2>&1 || true
  fi
  [[ -n "$TEST_ROOT" ]] && rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

command -v tmux >/dev/null || { echo 'missing tmux' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'missing python3' >&2; exit 1; }

REAL_TMUX="$(command -v tmux)"
TEST_ROOT="$(mktemp -d /tmp/wezterm-fix-layout-behavior.XXXXXX)"
TEST_SOCKET="wezterm-fix-layout-$$"
export WEZTERM_RUNTIME_LOG_FILE="$TEST_ROOT/runtime.log"
export WEZTERM_RUNTIME_LOG_ENABLED=1
: >"$WEZTERM_RUNTIME_LOG_FILE"
unset TMUX
unset TMUX_PANE

mkdir -p "$TEST_ROOT/bin"
cat >"$TEST_ROOT/bin/tmux" <<EOF
#!/usr/bin/env bash
exec "$REAL_TMUX" -L "$TEST_SOCKET" "\$@"
EOF
chmod +x "$TEST_ROOT/bin/tmux"
export PATH="$TEST_ROOT/bin:$PATH"

tmux -f /dev/null new-session -d -s fixlay -x 80 -y 24 \
  /bin/sh -lc 'pwd; exec sleep 300'
tmux set -g exit-empty off
tmux set -g window-size latest
tmux set -g status on
tmux split-window -h -t fixlay /bin/sh -lc 'exec sleep 300'
tmux select-layout -t fixlay even-horizontal
tmux set-window-option -t fixlay @wezterm_window_layout managed_two_pane

cat >"$TEST_ROOT/attach.py" <<'PY'
import fcntl, os, pty, select, sys, termios

sock, real_tmux = sys.argv[1], sys.argv[2]
os.environ.pop("TMUX", None)
os.environ.pop("TMUX_PANE", None)
os.environ["TERM"] = "xterm-256color"
master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    if slave > 2:
        os.close(slave)
    os.execv(real_tmux, [real_tmux, "-L", sock, "attach-session", "-t", "fixlay"])
os.close(slave)
while True:
    select.select([], [], [], 1.0)
PY

python3 "$TEST_ROOT/attach.py" "$TEST_SOCKET" "$REAL_TMUX" &
ATTACH_KEEPER=$!

CLIENT_TTY=""
CLIENT_NAME=""
WINDOW_ID=""
for _ in $(seq 1 50); do
  CLIENT_TTY="$(tmux list-clients -t fixlay -F '#{client_tty}' 2>/dev/null | head -1 || true)"
  CLIENT_NAME="$(tmux list-clients -t fixlay -F '#{client_name}' 2>/dev/null | head -1 || true)"
  WINDOW_ID="$(tmux display-message -p -t fixlay '#{window_id}' 2>/dev/null || true)"
  if [[ -n "$CLIENT_TTY" && -n "$CLIENT_NAME" && -n "$WINDOW_ID" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -n "$CLIENT_TTY" && -n "$CLIENT_NAME" && -n "$WINDOW_ID" ]]; then
  assert_yes "attached client present" "yes"
else
  assert_yes "attached client present" "no"
  printf '  detail list-clients=%s\n' "$(tmux list-clients 2>&1 | tr '\n' ';')"
  printf '  detail sessions=%s\n' "$(tmux list-sessions 2>&1 | tr '\n' ';')"
  printf '  detail keeper_ps=%s\n' "$(ps -p "$ATTACH_KEEPER" -o pid=,stat=,cmd= 2>/dev/null | tr '\n' ';')"
  printf '\n%d passed, %d failed\n' "$pass" "$fail"
  exit 1
fi

# --- A: uneven panes → even-horizontal ---
tmux resize-pane -t "${WINDOW_ID}.0" -x 20 2>/dev/null || tmux resize-pane -t fixlay:0.0 -x 20
w0="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_width}' | awk 'NR==1')"
w1="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_width}' | awk 'NR==2')"
[[ "$w0" != "$w1" ]] && assert_yes "precondition uneven panes" "yes" \
  || assert_yes "precondition uneven panes" "no"

bash "$fix_layout" --quiet --session fixlay --window "$WINDOW_ID" \
  --cwd "$TEST_ROOT" --client "$CLIENT_NAME"
w0="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_width}' | awk 'NR==1')"
w1="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_width}' | awk 'NR==2')"
diff=$(( w0 > w1 ? w0 - w1 : w1 - w0 ))
(( diff <= 1 )) && assert_yes "even-horizontal after fix-layout" "yes" \
  || assert_yes "even-horizontal after fix-layout (w=$w0/$w1)" "no"

# --- B: grow PTY under attach ---
tmux_fix_layout_pty_set_winsize "$CLIENT_TTY" 120 40
pty_now="$(tmux_fix_layout_pty_winsize "$CLIENT_TTY")"
assert_eq "pty grown to 120x40" "$pty_now" "120x40"

tmux refresh-client -S -t "$CLIENT_NAME" 2>/dev/null || true
after_S="$(tmux list-clients -t fixlay -F '#{client_width}x#{client_height}' | head -1)"
if tmux_fix_layout_sizes_differ "$pty_now" "$after_S"; then
  assert_yes "refresh-client -S alone leaves drift" "yes"
else
  assert_yes "refresh-client -S synced without WINCH (env-specific)" "yes"
fi

bash "$fix_layout" --quiet --session fixlay --window "$WINDOW_ID" \
  --cwd "$TEST_ROOT" --client "$CLIENT_NAME"
after_heal="$(tmux list-clients -t fixlay -F '#{client_width}x#{client_height}' | head -1)"
pty_after="$(tmux_fix_layout_pty_winsize "$CLIENT_TTY")"
win="$(tmux display-message -p -t "$WINDOW_ID" '#{window_width}x#{window_height}')"
status_opt="$(tmux show-options -qv -t fixlay status 2>/dev/null || printf 'on')"
usable="$(tmux_fix_layout_usable_rows 40 "$status_opt")"

if [[ "$after_heal" == "$pty_after" || "$after_heal" == "120x40" ]]; then
  assert_yes "fix-layout converges client to PTY" "yes"
elif [[ "$win" == "120x${usable}" ]]; then
  assert_yes "fix-layout converges via window fallback" "yes"
else
  printf '  detail client=%s pty=%s win=%s after_S=%s usable=%s\n' \
    "$after_heal" "$pty_after" "$win" "$after_S" "$usable"
  assert_yes "fix-layout converges client to PTY" "no"
fi

w0="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_width}' | awk 'NR==1')"
w1="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_width}' | awk 'NR==2')"
diff=$(( w0 > w1 ? w0 - w1 : w1 - w0 ))
(( diff <= 1 )) && assert_yes "panes even after size heal" "yes" \
  || assert_yes "panes even after size heal (w=$w0/$w1)" "no"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
