#!/usr/bin/env bash
# Unit tests for scripts/runtime/tmux-user-interact-lib.sh — the Alt+g
# sort key that attributes tmux client_activity to the focused window
# so agent pane output no longer reshuffles the worktree picker.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lib="$repo_root/scripts/runtime/tmux-user-interact-lib.sh"

pass=0
fail=0

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s\n    got:  %q\n    want: %q\n' "$name" "$got" "$want"
  fi
}

# In-memory mock tmux: session opts + window opts + list-clients.
# Driven by env MOCK_* tables encoded as lines of "key=value".
setup_mock_tmux() {
  local sandbox="$1"
  mkdir -p "$sandbox/bin" "$sandbox/state"
  : >"$sandbox/state/session_opts"
  : >"$sandbox/state/window_opts"
  : >"$sandbox/state/clients"

  cat >"$sandbox/bin/tmux" <<'TMUX_EOF'
#!/usr/bin/env bash
STATE_DIR="${MOCK_TMUX_STATE_DIR:?}"
session_opts="$STATE_DIR/session_opts"
window_opts="$STATE_DIR/window_opts"
clients="$STATE_DIR/clients"

opt_get() {
  local file="$1" key="$2" line=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      printf '%s\n' "${line#*=}"
      return 0
    fi
  done <"$file"
  return 0
}

opt_set() {
  local file="$1" key="$2" val="$3"
  local tmp="$file.tmp.$$" line=""
  : >"$tmp"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$key="* ]] && continue
    printf '%s\n' "$line" >>"$tmp"
  done <"$file"
  printf '%s=%s\n' "$key" "$val" >>"$tmp"
  mv "$tmp" "$file"
}

cmd="${1:-}"
shift || true
case "$cmd" in
  list-clients)
    # -F '#{client_session}\t#{client_activity}'
    cat "$clients"
    ;;
  show-options)
    # show-options -t SESSION -v OPT
    target=""; opt=""; want_t=0 want_v=0
    for arg in "$@"; do
      if (( want_t )); then target="$arg"; want_t=0
      elif (( want_v )); then opt="$arg"; want_v=0
      elif [[ "$arg" == "-t" ]]; then want_t=1
      elif [[ "$arg" == "-v" ]]; then want_v=1
      elif [[ "$arg" == -* ]]; then continue
      else opt="$arg"
      fi
    done
    opt_get "$session_opts" "${target}|${opt}"
    ;;
  show-window-options)
    target=""; opt=""; want_t=0 want_v=0
    for arg in "$@"; do
      if (( want_t )); then target="$arg"; want_t=0
      elif (( want_v )); then opt="$arg"; want_v=0
      elif [[ "$arg" == "-t" ]]; then want_t=1
      elif [[ "$arg" == "-v" ]]; then want_v=1
      elif [[ "$arg" == -* ]]; then continue
      else opt="$arg"
      fi
    done
    opt_get "$window_opts" "${target}|${opt}"
    ;;
  set-option)
    # set-option -t SESSION -q OPT VAL
    target=""; opt=""; val=""; quiet=0 want_t=0
    args=("$@")
    i=0
    while (( i < ${#args[@]} )); do
      a="${args[$i]}"
      if [[ "$a" == "-t" ]]; then
        i=$((i + 1)); target="${args[$i]}"
      elif [[ "$a" == "-q" ]]; then
        quiet=1
      elif [[ "$a" == -* ]]; then
        :
      elif [[ -z "$opt" ]]; then
        opt="$a"
      else
        val="$a"
      fi
      i=$((i + 1))
    done
    opt_set "$session_opts" "${target}|${opt}" "$val"
    ;;
  set-window-option)
    target=""; opt=""; val=""; want_t=0
    args=("$@")
    i=0
    while (( i < ${#args[@]} )); do
      a="${args[$i]}"
      if [[ "$a" == "-t" ]]; then
        i=$((i + 1)); target="${args[$i]}"
      elif [[ "$a" == "-q" || "$a" == "-u" ]]; then
        :
      elif [[ "$a" == -* ]]; then
        :
      elif [[ -z "$opt" ]]; then
        opt="$a"
      else
        val="$a"
      fi
      i=$((i + 1))
    done
    opt_set "$window_opts" "${target}|${opt}" "$val"
    ;;
  *)
    exit 0
    ;;
esac
TMUX_EOF
  chmod +x "$sandbox/bin/tmux"
  export PATH="$sandbox/bin:$PATH"
  export MOCK_TMUX_STATE_DIR="$sandbox/state"
}

set_clients() {
  # args: session:activity pairs
  local sandbox_state="$MOCK_TMUX_STATE_DIR/clients"
  : >"$sandbox_state"
  local pair sess act
  for pair in "$@"; do
    sess="${pair%%:*}"
    act="${pair#*:}"
    printf '%s\t%s\n' "$sess" "$act" >>"$sandbox_state"
  done
}

read_window_ts() {
  local win="$1"
  tmux show-window-options -t "$win" -v @wezterm_user_interact_ts 2>/dev/null || true
}

read_session_focus() {
  local sess="$1"
  tmux show-options -t "$sess" -v @wezterm_interact_focus_window 2>/dev/null || true
}

read_session_ca_enter() {
  local sess="$1"
  tmux show-options -t "$sess" -v @wezterm_interact_ca_at_enter 2>/dev/null || true
}

# --- cases -----------------------------------------------------------------

sandbox="$(mktemp -d -t wezterm-user-interact.XXXXXX)"
trap 'rm -rf "$sandbox"' EXIT
setup_mock_tmux "$sandbox"
# shellcheck disable=SC1090
. "$lib"

SESS=wezterm_work_demo
echo "== client_activity prefers the hottest client on the session =="
set_clients "${SESS}:100" "other:999" "${SESS}:150"
got="$(tmux_user_interact_client_activity "$SESS")"
assert_eq "max ca on session" "$got" "150"

echo "== note_focus: glance (no ca advance) does not stamp previous =="
set_clients "${SESS}:200"
tmux_user_interact_note_focus "$SESS" "@1" "200"
assert_eq "focus after enter A" "$(read_session_focus "$SESS")" "@1"
assert_eq "ca_at_enter after enter A" "$(read_session_ca_enter "$SESS")" "200"
assert_eq "A unstamped on bare enter" "$(read_window_ts "@1")" ""

# Switch to B without new input — pure glance.
tmux_user_interact_note_focus "$SESS" "@2" "200"
assert_eq "focus now B" "$(read_session_focus "$SESS")" "@2"
assert_eq "A still unstamped after glance leave" "$(read_window_ts "@1")" ""
assert_eq "B unstamped after glance enter" "$(read_window_ts "@2")" ""

echo "== note_focus: typing on A then leave stamps A =="
# Re-enter A at ca=200, type (ca→250), leave to B.
tmux_user_interact_note_focus "$SESS" "@1" "200"
tmux_user_interact_note_focus "$SESS" "@2" "250"
assert_eq "A stamped with typing ca" "$(read_window_ts "@1")" "250"
assert_eq "B not stamped on enter after A's typing" "$(read_window_ts "@2")" ""
assert_eq "ca_at_enter is B baseline" "$(read_session_ca_enter "$SESS")" "250"

echo "== flush_current: in-window typing without leave =="
# Still on B (focus=@2, ca_at_enter=250). User types → ca=300.
tmux_user_interact_flush_current "$SESS" "@2" "300"
assert_eq "B stamped on flush after typing" "$(read_window_ts "@2")" "300"
assert_eq "ca_at_enter raised after flush" "$(read_session_ca_enter "$SESS")" "300"
# Second flush with same ca is a no-op (no rewrite storm).
tmux_user_interact_flush_current "$SESS" "@2" "300"
assert_eq "B ts stable on idle flush" "$(read_window_ts "@2")" "300"

echo "== flush_current: no typing since enter does not stamp =="
tmux_user_interact_note_focus "$SESS" "@3" "300"
tmux_user_interact_flush_current "$SESS" "@3" "300"
assert_eq "C unstamped when ca flat" "$(read_window_ts "@3")" ""

echo "== stamp is monotonic (older ca cannot go backwards) =="
tmux_user_interact_stamp_window "@1" "100"
assert_eq "A keeps higher ts" "$(read_window_ts "@1")" "250"

echo "== agent-output-like noise: window_activity is irrelevant =="
# The lib never reads window_activity; stamping only happens through the
# client_activity path tested above. This case just documents the
# contract: calling note_focus with an unchanged ca leaves stamps alone
# even if we pretend "lots of output happened".
before_a="$(read_window_ts "@1")"
before_b="$(read_window_ts "@2")"
tmux_user_interact_note_focus "$SESS" "@1" "300"  # back to A, ca flat vs B's leave baseline... wait
# After C enter, focus=@3 ca_enter=300. Leave C to A with ca still 300.
tmux_user_interact_note_focus "$SESS" "@1" "300"
assert_eq "A unchanged when returning without input" "$(read_window_ts "@1")" "$before_a"
assert_eq "B unchanged when unrelated focus moves" "$(read_window_ts "@2")" "$before_b"

echo
echo "pass=$pass fail=$fail"
if (( fail > 0 )); then
  exit 1
fi
exit 0
