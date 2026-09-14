#!/usr/bin/env bash
# Unit tests for tmux-fix-layout-lib.sh (PTY↔client size helpers).
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/tmux-fix-layout-lib.sh"

pass=0
fail=0
KEEPALIVE_PID=""
CHILD_PID=""

cleanup() {
  [[ -n "$CHILD_PID" ]] && kill "$CHILD_PID" 2>/dev/null || true
  [[ -n "$CHILD_PID" ]] && wait "$CHILD_PID" 2>/dev/null || true
  [[ -n "$KEEPALIVE_PID" ]] && kill "$KEEPALIVE_PID" 2>/dev/null || true
  [[ -n "$KEEPALIVE_PID" ]] && wait "$KEEPALIVE_PID" 2>/dev/null || true
  rm -f /tmp/wezterm-fix-layout-lib-test.env
}
trap cleanup EXIT

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

assert_eq "usable_rows status=3" "$(tmux_fix_layout_usable_rows 56 3)" "53"
assert_eq "usable_rows status=on" "$(tmux_fix_layout_usable_rows 56 on)" "55"
assert_eq "usable_rows status=off" "$(tmux_fix_layout_usable_rows 56 off)" "56"
assert_eq "usable_rows status=2" "$(tmux_fix_layout_usable_rows 46 2)" "44"

tmux_fix_layout_sizes_differ "213x56" "170x46" \
  && assert_yes "sizes_differ detects drift" "yes" \
  || assert_yes "sizes_differ detects drift" "no"
tmux_fix_layout_sizes_differ "213x56" "213x56" \
  && assert_yes "sizes_differ equal is false" "no" \
  || assert_yes "sizes_differ equal is false" "yes"
tmux_fix_layout_sizes_differ "" "213x56" \
  && assert_yes "sizes_differ empty is false" "no" \
  || assert_yes "sizes_differ empty is false" "yes"

# Background Python holds master FD; child is a fake `tmux attach` on the slave.
python3 - <<'PY' &
import fcntl, os, pty, termios, time

master, slave = pty.openpty()
slave_name = os.ttyname(slave)
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
    os.execlp("bash", "bash", "-c",
              "exec -a 'tmux attach-session -t test' sleep 60")
os.close(slave)
with open("/tmp/wezterm-fix-layout-lib-test.env", "w", encoding="utf-8") as f:
    f.write(f"SLAVE={slave_name}\nPID={pid}\n")
while True:
    time.sleep(1)
PY
KEEPALIVE_PID=$!

for _ in $(seq 1 50); do
  [[ -f /tmp/wezterm-fix-layout-lib-test.env ]] && break
  sleep 0.05
done
# shellcheck disable=SC1091
source /tmp/wezterm-fix-layout-lib-test.env
CHILD_PID="$PID"

tmux_fix_layout_pty_set_winsize "$SLAVE" 213 56
got="$(tmux_fix_layout_pty_winsize "$SLAVE")"
assert_eq "pty_winsize after set" "$got" "213x56"

sleep 0.15
attach_pid="$(tmux_fix_layout_attach_pid "$SLAVE")"
assert_eq "attach_pid finds tmux attach argv" "$attach_pid" "$PID"

tmux_fix_layout_winch_attach_client "$SLAVE"
if kill -0 "$PID" 2>/dev/null; then
  assert_yes "winch target still alive" "yes"
else
  assert_yes "winch target still alive" "no"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
