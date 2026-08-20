#!/usr/bin/env bash
# Precise causal repro for Grok Build FocusGained → terminal.clear() flash.
#
# Isolated tmux server only — does not touch the daily work session.
#
# Why "inject" is the automated gold standard
# ------------------------------------------
# Grok enables CSI focus reporting (`\e[?1004h`) at startup. When it receives
# FocusIn (`\e[I`) under a detected multiplexer, upstream
# `event_loop.rs` sets `force_repaint` and the Presenter runs `terminal.clear()`
# (ED2 `\e[2J`) then a full `app.draw()`. Injecting `\e[I` into the pane is the
# same byte sequence tmux delivers when `focus-events on` and a real client
# switches panes — without needing an attached WezTerm window.
#
# Detached `select-pane` bounce does NOT reliably deliver FocusIn (no client
# focus path). Interactive bounce (`Alt+o` in a real attached WezTerm) is the
# UX repro; inject is the unit-level causal repro.
#
# Usage:
#   scripts/dev/repro-grok-focus-flash.sh           # default: inject A/B matrix
#   scripts/dev/repro-grok-focus-flash.sh inject-real
#   scripts/dev/repro-grok-focus-flash.sh inject-wrap
#   scripts/dev/repro-grok-focus-flash.sh inject-wrap-off
#   scripts/dev/repro-grok-focus-flash.sh all
#
# Expected (2026-08-20 measured):
#   inject-real       → ED2=1, starts with clear, ~1KiB+ full redraw
#   inject-wrap       → ED2=0 (focus-filter strips \e[I)
#   inject-wrap-off   → ED2=1 (GROK_FOCUS_FILTER=0 passthrough)
#
# After `grok-with-focus-filter.sh --install`, ~/.grok/bin/grok is the wrapper;
# the ELF lives at ~/.grok/bin/grok.real. inject-real must hit the ELF.
set -euo pipefail

resolve_default_real_bin() {
  if [[ -n "${GROK_REAL_BIN:-}" && -x "${GROK_REAL_BIN}" ]]; then
    printf '%s\n' "$GROK_REAL_BIN"
    return
  fi
  local candidate
  for candidate in \
    "${HOME}/.grok/bin/grok.real" \
    "${HOME}/.grok/downloads/grok-1.0.5-linux-x86_64"; do
    if [[ -x "$candidate" && ! -L "$candidate" ]]; then
      # Reject if somehow a symlink into the filter script.
      case "$(readlink -f "$candidate" 2>/dev/null || true)" in
        *grok-with-focus-filter.sh|*grok-focus-filter.py) continue ;;
      esac
      printf '%s\n' "$candidate"
      return
    fi
  done
  # Fallback only when --install has not been run (grok is still a plain ELF).
  if [[ -x "${HOME}/.grok/bin/grok" && ! -L "${HOME}/.grok/bin/grok" ]]; then
    printf '%s\n' "${HOME}/.grok/bin/grok"
    return
  fi
  return 1
}

REAL_BIN="$(resolve_default_real_bin || true)"
WRAP_BIN="${GROK_WRAP_BIN:-$HOME/.grok/bin/grok}"
SOCK="/tmp/grok-focus-repro.sock"
CONF="/tmp/grok-focus-repro.conf"
LABEL="grokrepro"
SESSION="repro"
OUT_DIR="${GROK_FOCUS_REPRO_DIR:-/tmp}"

if [[ ! -x "${REAL_BIN:-}" ]]; then
  printf 'missing real grok binary (expected ~/.grok/bin/grok.real). Run:\n' >&2
  printf '  scripts/runtime/grok-with-focus-filter.sh --install\n' >&2
  exit 1
fi
# Prefer the installed wrapper path; fall back to repo script.
if [[ ! -x "$WRAP_BIN" ]]; then
  WRAP_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/../runtime" && pwd)/grok-with-focus-filter.sh"
fi
if [[ ! -x "$WRAP_BIN" ]]; then
  printf 'missing wrap binary: %s\n' "$WRAP_BIN" >&2
  exit 1
fi

kill_server() {
  tmux -L "$LABEL" -S "$SOCK" kill-server 2>/dev/null || true
  rm -f "$SOCK"
}

analyze() {
  local raw="$1" name="$2"
  python3 - "$raw" "$name" <<'PY'
import re, sys
from pathlib import Path
raw = Path(sys.argv[1]).read_bytes()
name = sys.argv[2]
ed2 = raw.count(b"\x1b[2J")
bsu = len(re.findall(rb"\x1b\[\?2026h", raw))
clear = raw.startswith(b"\x1b[2J")
verdict = "FLASH(clear+redraw)" if ed2 >= 1 and clear else (
    "no-clear" if ed2 == 0 else "ED2-but-not-leading"
)
print(
    f"{name}: bytes={len(raw)} ED2={ed2} BSU={bsu} "
    f"starts_clear={clear} → {verdict}"
)
print(f"  raw={sys.argv[1]}")
PY
}

setup() {
  kill_server
  cat >"$CONF" <<'EOF'
set -g focus-events on
set -g mouse on
set -g status off
set -g history-limit 1000
set -g default-terminal "tmux-256color"
set -as terminal-features ',xterm*:sync,wezterm*:sync'
set -g window-style 'fg=default,bg=#eae9e1'
set -g window-active-style 'fg=default,bg=#f1f0e9'
EOF
  tmux -L "$LABEL" -S "$SOCK" -f "$CONF" new-session -d -s "$SESSION" -x 100 -y 30 \
    -c "${PWD:-$HOME}" -- bash --noprofile --norc
}

start_grok() {
  # $1 = shell command string executed in the right pane
  tmux -L "$LABEL" -S "$SOCK" split-window -h -t "$SESSION:0.0" -- \
    bash --noprofile --norc -c "$1"
  local i cmd
  for i in $(seq 1 60); do
    cmd="$(tmux -L "$LABEL" -S "$SOCK" display-message -t "$SESSION:0.1" -p '#{pane_current_command}' 2>/dev/null || true)"
    case "$cmd" in
      grok|python|python3) break ;;
    esac
    sleep 0.1
  done
  # Welcome / mode setup (?1004h etc.)
  sleep 1.5
}

run_inject() {
  local name="$1"
  local start_cmd="$2"
  local raw="$OUT_DIR/grok-focus-repro-${name}.raw"

  printf '\n== %s ==\n' "$name"
  setup
  start_grok "$start_cmd"
  rm -f "$raw"
  tmux -L "$LABEL" -S "$SOCK" pipe-pane -t "$SESSION:0.1" -o "cat >> ${raw}"
  sleep 0.1
  tmux -L "$LABEL" -S "$SOCK" send-keys -t "$SESSION:0.1" -l $'\x1b[I'
  sleep 0.7
  tmux -L "$LABEL" -S "$SOCK" pipe-pane -t "$SESSION:0.1"
  analyze "$raw" "$name"
  local pane_pid
  pane_pid="$(tmux -L "$LABEL" -S "$SOCK" display-message -t "$SESSION:0.1" -p '#{pane_pid}')"
  printf '  pane_pid=%s cmd=%s\n' "$pane_pid" \
    "$(tmux -L "$LABEL" -S "$SOCK" display-message -t "$SESSION:0.1" -p '#{pane_current_command}')"
}

trap kill_server EXIT

CASE="${1:-matrix}"
case "$CASE" in
  inject-real|real)
    run_inject inject-real "exec $(printf '%q' "$REAL_BIN")"
    ;;
  inject-wrap|wrap)
    run_inject inject-wrap "exec $(printf '%q' "$WRAP_BIN")"
    ;;
  inject-wrap-off|wrap-off)
    run_inject inject-wrap-off "GROK_FOCUS_FILTER=0 exec $(printf '%q' "$WRAP_BIN")"
    ;;
  matrix|all|"")
    run_inject inject-real "exec $(printf '%q' "$REAL_BIN")"
    run_inject inject-wrap "exec $(printf '%q' "$WRAP_BIN")"
    run_inject inject-wrap-off "GROK_FOCUS_FILTER=0 exec $(printf '%q' "$WRAP_BIN")"
    printf '\nVerdict: real/wrap-off must FLASH; wrap (filter on) must no-clear.\n'
    printf 'Interactive UX bounce: Alt+o in an attached WezTerm split (not automated here).\n'
    ;;
  *)
    printf 'unknown case: %s\n' "$CASE" >&2
    exit 2
    ;;
esac
