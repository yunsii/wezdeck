#!/usr/bin/env bash
# Attribute tmux *user* input (key / mouse → client_activity) to the
# window that held focus when that input happened.
#
# Why this exists: Alt+g used to rank worktrees by tmux `window_activity`,
# which advances on *pane output* (agent streams, spinners, hooks). That
# made the picker order thrash whenever any background agent typed. The
# signal the user actually wants is "where did I last type / click", and
# tmux exposes that as client-scoped `client_activity` — not per-window.
# This lib bridges the gap:
#
#   session @wezterm_interact_focus_window  = window currently credited
#   session @wezterm_interact_ca_at_enter   = client_activity at enter
#   window  @wezterm_user_interact_ts       = last attributed client_activity
#
# On focus change: if client_activity advanced while the previous window
# held focus, stamp that window. On Alt+g open: flush the current window
# the same way so in-window typing is visible before the user leaves.
#
# Pure glance (focus change, no key/mouse) does not advance
# client_activity, so it does not reshuffle the list. Agent output alone
# never touches these options.
#
# Fail-open: every helper returns 0 and swallows tmux errors so hooks
# never surface a failure to the tmux server.

# shellcheck disable=SC2034  # sourced; callers use the functions below.

TMUX_USER_INTERACT_WINDOW_TS_OPT='@wezterm_user_interact_ts'
TMUX_USER_INTERACT_FOCUS_WINDOW_OPT='@wezterm_interact_focus_window'
TMUX_USER_INTERACT_CA_AT_ENTER_OPT='@wezterm_interact_ca_at_enter'

# Most-recent client_activity among clients attached to $session_name.
# Falls back to 0 when nothing is attached or the value is non-numeric.
tmux_user_interact_client_activity() {
  local session_name="${1:-}"
  local ca=""

  [[ -n "$session_name" ]] || { printf '0\n'; return 0; }

  ca="$(tmux list-clients -F '#{client_session}'$'\t''#{client_activity}' 2>/dev/null \
    | awk -F '\t' -v s="$session_name" '
        $1 == s && $2 ~ /^[0-9]+$/ { print $2 }
      ' \
    | sort -nr \
    | head -1)"

  if [[ "$ca" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$ca"
  else
    printf '0\n'
  fi
}

tmux_user_interact_show_session_opt() {
  local session_name="${1:-}"
  local opt="${2:-}"
  [[ -n "$session_name" && -n "$opt" ]] || return 0
  tmux show-options -t "$session_name" -v "$opt" 2>/dev/null || true
}

tmux_user_interact_show_window_opt() {
  local window_id="${1:-}"
  local opt="${2:-}"
  [[ -n "$window_id" && -n "$opt" ]] || return 0
  tmux show-window-options -t "$window_id" -v "$opt" 2>/dev/null || true
}

# Stamp $window_id with $ca when $ca is newer than the stored ts.
tmux_user_interact_stamp_window() {
  local window_id="${1:-}"
  local ca="${2:-0}"
  local prev=""

  [[ -n "$window_id" && "$ca" =~ ^[0-9]+$ ]] || return 0
  (( ca > 0 )) || return 0

  prev="$(tmux_user_interact_show_window_opt "$window_id" "$TMUX_USER_INTERACT_WINDOW_TS_OPT")"
  if [[ "$prev" =~ ^[0-9]+$ ]] && (( ca <= prev )); then
    return 0
  fi

  tmux set-window-option -t "$window_id" -q \
    "$TMUX_USER_INTERACT_WINDOW_TS_OPT" "$ca" 2>/dev/null || true
}

# Record a focus landing on $window_id. Attributes any client_activity
# advance since the previous enter to the previous focus window.
# $client_activity is optional; when empty we resolve it from attached
# clients of $session_name.
tmux_user_interact_note_focus() {
  local session_name="${1:-}"
  local window_id="${2:-}"
  local client_activity="${3:-}"
  local prev_window=""
  local ca_at_enter=""
  local ca=0

  [[ -n "$session_name" && -n "$window_id" ]] || return 0

  if [[ "$client_activity" =~ ^[0-9]+$ ]]; then
    ca="$client_activity"
  else
    ca="$(tmux_user_interact_client_activity "$session_name")"
  fi
  [[ "$ca" =~ ^[0-9]+$ ]] || ca=0

  prev_window="$(tmux_user_interact_show_session_opt "$session_name" "$TMUX_USER_INTERACT_FOCUS_WINDOW_OPT")"
  ca_at_enter="$(tmux_user_interact_show_session_opt "$session_name" "$TMUX_USER_INTERACT_CA_AT_ENTER_OPT")"
  [[ "$ca_at_enter" =~ ^[0-9]+$ ]] || ca_at_enter=0

  if [[ -n "$prev_window" ]] && (( ca > ca_at_enter )); then
    # Same-window pane switch still attributes: the window as a whole
    # received the input. Different-window leave attributes the previous.
    tmux_user_interact_stamp_window "$prev_window" "$ca"
  fi

  tmux set-option -t "$session_name" -q \
    "$TMUX_USER_INTERACT_FOCUS_WINDOW_OPT" "$window_id" 2>/dev/null || true
  tmux set-option -t "$session_name" -q \
    "$TMUX_USER_INTERACT_CA_AT_ENTER_OPT" "$ca" 2>/dev/null || true
}

# Flush typing that happened on the currently focused window without a
# subsequent focus change (the Alt+g open path). Only stamps when
# client_activity advanced past ca_at_enter, so a pure reopen with no
# new input does not rewrite the ts.
tmux_user_interact_flush_current() {
  local session_name="${1:-}"
  local window_id="${2:-}"
  local client_activity="${3:-}"
  local focus_window=""
  local ca_at_enter=""
  local ca=0

  [[ -n "$session_name" && -n "$window_id" ]] || return 0

  if [[ "$client_activity" =~ ^[0-9]+$ ]]; then
    ca="$client_activity"
  else
    ca="$(tmux_user_interact_client_activity "$session_name")"
  fi
  [[ "$ca" =~ ^[0-9]+$ ]] || ca=0

  focus_window="$(tmux_user_interact_show_session_opt "$session_name" "$TMUX_USER_INTERACT_FOCUS_WINDOW_OPT")"
  ca_at_enter="$(tmux_user_interact_show_session_opt "$session_name" "$TMUX_USER_INTERACT_CA_AT_ENTER_OPT")"
  [[ "$ca_at_enter" =~ ^[0-9]+$ ]] || ca_at_enter=0

  # Tracking never initialized (fresh session / pre-upgrade): treat the
  # current window as the focus baseline. Stamp only when we have a
  # positive ca so a detached edge does not write zeroes.
  if [[ -z "$focus_window" ]]; then
    tmux set-option -t "$session_name" -q \
      "$TMUX_USER_INTERACT_FOCUS_WINDOW_OPT" "$window_id" 2>/dev/null || true
    tmux set-option -t "$session_name" -q \
      "$TMUX_USER_INTERACT_CA_AT_ENTER_OPT" "$ca" 2>/dev/null || true
    tmux_user_interact_stamp_window "$window_id" "$ca"
    return 0
  fi

  # Focus file disagrees with the caller's window (rare race): re-base
  # without stamping the wrong window from this flush.
  if [[ "$focus_window" != "$window_id" ]]; then
    tmux_user_interact_note_focus "$session_name" "$window_id" "$ca"
    # After note_focus, ca_at_enter == ca so a second stamp would no-op
    # unless input arrives; if ca already advanced on this window under
    # the stale focus marker, note_focus stamped the stale previous.
    # One more stamp of the caller window when ca > 0 covers "I am here
    # and opening the picker" without requiring a prior enter event.
    if (( ca > 0 )); then
      tmux_user_interact_stamp_window "$window_id" "$ca"
    fi
    return 0
  fi

  if (( ca > ca_at_enter )); then
    tmux_user_interact_stamp_window "$window_id" "$ca"
    # Raise the baseline so a second flush in the same keypress path
    # (or a focus hook stacked on the same event) does not re-stamp
    # with a stale comparison window.
    tmux set-option -t "$session_name" -q \
      "$TMUX_USER_INTERACT_CA_AT_ENTER_OPT" "$ca" 2>/dev/null || true
  fi
}
