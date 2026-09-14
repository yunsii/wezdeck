#!/usr/bin/env bash
# Helpers for tmux-fix-layout.sh — kept sourceable so hook-unit tests can
# exercise PTY↔client size drift without booting a full WezTerm stack.
#
# Standing failure mode (2026-09-14): WezTerm resizes the pts (TIOCGWINSZ)
# while `tmux attach` keeps a stale client_width/height. `refresh-client -S`
# alone often does not converge; SIGWINCH on the attach process does.
# Docs: docs/tmux-ui.md#layout-heal-fix-layout

# Print COLSxROWS from TIOCGWINSZ, or empty on failure.
tmux_fix_layout_pty_winsize() {
  local tty="$1"
  python3 - "$tty" <<'PY' 2>/dev/null || true
import fcntl, struct, sys, termios
path = sys.argv[1]
try:
    fd = open(path, "rb")
except OSError:
    raise SystemExit(0)
try:
    rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))
finally:
    fd.close()
if rows > 0 and cols > 0:
    print(f"{cols}x{rows}")
PY
}

# Set TIOCSWINSZ on a tty (cols x rows). Used by tests to simulate WezTerm
# growing the pts under a live attach client.
tmux_fix_layout_pty_set_winsize() {
  local tty="$1"
  local cols="$2"
  local rows="$3"
  python3 - "$tty" "$cols" "$rows" <<'PY'
import fcntl, struct, sys, termios
path, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
fd = open(path, "rb")
try:
    # rows, cols, xpixel, ypixel
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
finally:
    fd.close()
PY
}

# PID of `tmux attach…` on this tty, else first process on the tty, else empty.
tmux_fix_layout_attach_pid() {
  local tty="$1"
  local pid=""
  [[ -n "$tty" && -e "$tty" ]] || return 0
  pid="$(ps -t "${tty#/dev/}" -o pid=,cmd= 2>/dev/null \
    | awk '/tmux attach/{print $1; exit}')"
  if [[ -z "$pid" ]]; then
    pid="$(ps -t "${tty#/dev/}" -o pid= 2>/dev/null | awk 'NR==1{print $1}')"
  fi
  printf '%s' "$pid"
}

tmux_fix_layout_winch_attach_client() {
  local tty="$1"
  local pid=""
  pid="$(tmux_fix_layout_attach_pid "$tty")"
  [[ -n "$pid" ]] || return 0
  kill -WINCH "$pid" 2>/dev/null || true
}

# Window height excludes status rows (client 56 / status 3 → usable 53).
tmux_fix_layout_usable_rows() {
  local pty_rows="$1"
  local status_opt="${2:-on}"
  local status_rows=1
  case "$status_opt" in
    off|0) status_rows=0 ;;
    on|1) status_rows=1 ;;
    [0-9]*) status_rows="$status_opt" ;;
  esac
  if [[ "$pty_rows" =~ ^[0-9]+$ ]] && (( pty_rows > status_rows )); then
    printf '%s' "$((pty_rows - status_rows))"
  else
    printf '%s' "$pty_rows"
  fi
}

tmux_fix_layout_sizes_differ() {
  local a="${1:-}"
  local b="${2:-}"
  [[ -n "$a" && -n "$b" && "$a" != "$b" ]]
}
