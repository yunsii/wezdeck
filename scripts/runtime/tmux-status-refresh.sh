#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/tmux-status-lib.sh"

client_name=""
session_name=""
window_id=""
pane_id=""
cwd=""
print_line=""
force_refresh=0
refresh_client=0
no_debounce=0

sanitize_lock_key() {
  printf '%s' "${1:-global}" | tr -c 'A-Za-z0-9._-' '_'
}

numeric_option_or_default() {
  local env_name="$1"
  local option_name="$2"
  local default_value="$3"
  local value=""

  value="$(tmux_option_or_env "$env_name" "$option_name" "$default_value")"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    value="$default_value"
  fi

  printf '%s\n' "$value"
}

refresh_lock_dir() {
  local key=""

  key="$(sanitize_lock_key "$session_name")"
  printf '/tmp/.tmux-status-refresh.%s.lock\n' "$key"
}

acquire_refresh_lock() {
  local lock_dir="$1"
  local lock_ttl=""
  local now=""
  local lock_mtime=""

  if mkdir "$lock_dir" 2>/dev/null; then
    return 0
  fi

  if [[ ! -d "$lock_dir" ]]; then
    return 1
  fi

  lock_ttl="$(numeric_option_or_default TMUX_STATUS_REFRESH_LOCK_TTL @tmux_status_refresh_lock_ttl '30')"
  now="$(date +%s)"
  lock_mtime="$(file_mtime "$lock_dir" 2>/dev/null || printf '0')"

  if [[ "$lock_mtime" =~ ^[0-9]+$ ]] && (( now - lock_mtime >= lock_ttl )); then
    rm -rf "$lock_dir"
    mkdir "$lock_dir" 2>/dev/null
    return $?
  fi

  return 1
}

release_refresh_lock() {
  local lock_dir="$1"

  rm -rf "$lock_dir"
}

usage() {
  cat <<'EOF' >&2
Usage: tmux-status-refresh.sh [options]

Options:
  --client NAME         tmux client name
  --session NAME        tmux session name
  --window ID           tmux window id
  --pane ID             tmux pane id
  --cwd PATH            pane working directory
  --print-line INDEX    print cached status line 0, 1, or 2
  --force               bypass staleness checks and recompute now
  --no-debounce         bypass force-refresh debounce checks
  --refresh-client      refresh matching tmux client status line after recompute
EOF
}

session_option() {
  local option_name="$1"

  if [[ -n "$session_name" ]]; then
    tmux show-options -qv -t "$session_name" "$option_name" 2>/dev/null || true
  else
    tmux show -gv "$option_name" 2>/dev/null || true
  fi
}

set_session_option() {
  local option_name="$1"
  local value="$2"

  if [[ -n "$session_name" ]]; then
    tmux set-option -q -t "$session_name" "$option_name" "$value" 2>/dev/null || true
  else
    tmux set-option -gq "$option_name" "$value" 2>/dev/null || true
  fi
}

refresh_matching_clients() {
  local client

  if [[ -n "$client_name" ]]; then
    tmux refresh-client -S -t "$client_name" 2>/dev/null || true
    return
  fi

  if [[ -z "$session_name" ]]; then
    return
  fi

  while IFS= read -r client; do
    [[ -n "$client" ]] || continue
    tmux refresh-client -S -t "$client" 2>/dev/null || true
  done < <(tmux list-clients -t "$session_name" -F '#{client_name}' 2>/dev/null || true)
}

resolve_context_from_tmux() {
  local metadata=""
  local resolved_session=""
  local resolved_window=""
  local resolved_cwd=""

  if [[ -n "$client_name" ]]; then
    metadata="$(tmux display-message -p -c "$client_name" '#{session_name}	#{window_id}	#{pane_current_path}' 2>/dev/null || true)"
  elif [[ -n "$pane_id" ]]; then
    metadata="$(tmux display-message -p -t "$pane_id" '#{session_name}	#{window_id}	#{pane_current_path}' 2>/dev/null || true)"
  elif [[ -n "$window_id" ]]; then
    metadata="$(tmux display-message -p -t "$window_id" '#{session_name}	#{window_id}	#{pane_current_path}' 2>/dev/null || true)"
  elif [[ -n "$session_name" ]]; then
    metadata="$(tmux display-message -p -t "$session_name" '#{session_name}	#{window_id}	#{pane_current_path}' 2>/dev/null || true)"
  else
    metadata="$(tmux display-message -p '#{session_name}	#{window_id}	#{pane_current_path}' 2>/dev/null || true)"
  fi

  if [[ -z "$metadata" ]]; then
    return
  fi

  IFS=$'\t' read -r resolved_session resolved_window resolved_cwd <<< "$metadata"

  if [[ -z "$session_name" ]]; then
    session_name="$resolved_session"
  fi

  if [[ -z "$window_id" ]]; then
    window_id="$resolved_window"
  fi

  if [[ -z "$cwd" ]]; then
    cwd="$resolved_cwd"
  fi
}

should_refresh() {
  local last_refresh=""
  local now=""
  local debounce_seconds=""
  local poll_interval=""

  last_refresh="$(session_option '@tmux_status_last_refresh')"
  if [[ -z "$last_refresh" ]]; then
    return 0
  fi

  now="$(date +%s)"
  if ! [[ "$last_refresh" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  if (( force_refresh )); then
    if (( no_debounce )); then
      return 0
    fi

    # Context-aware debounce: a switch to a different pane cwd (e.g. moving
    # between repos in a worktree family) must recompute immediately, or the
    # branch/worktree segment keeps showing the previous repo until the next
    # hook fires >=2s later or the 30s poll lands. The time-based debounce
    # below only exists to collapse same-context storms (prompt hook firing on
    # every command, repeated focus events), so scope it to the unchanged cwd.
    local last_cwd=""
    last_cwd="$(session_option '@tmux_status_last_cwd')"
    if [[ -n "$cwd" && "$cwd" != "$last_cwd" ]]; then
      return 0
    fi

    debounce_seconds="$(numeric_option_or_default TMUX_STATUS_FORCE_DEBOUNCE @tmux_status_force_debounce '2')"
    (( now - last_refresh >= debounce_seconds ))
    return
  fi

  poll_interval="$(numeric_option_or_default TMUX_STATUS_POLL_INTERVAL @tmux_status_poll_interval '30')"
  (( now - last_refresh >= poll_interval ))
}

# Re-read the session's live active window / pane right before rendering.
# Every jump fires two or three refresh requests at once (the
# session-window-changed / window-pane-changed hook, attention-jump.sh's
# explicit --no-debounce refresh, client-focus-in), and each one captured its
# context when it was queued. Whichever request wins the lock must render what
# is active *now*, or a request queued a few ms before the switch lands wins
# and paints the previous worktree — which then survives until the poll (which
# measured 44s, not the nominal 30s). The status line only ever describes the
# active pane, so the live value is also the semantically correct one; the
# caller-supplied cwd stays the input to the debounce decision above.
adopt_live_context() {
  local metadata=""
  local live_window=""
  local live_cwd=""

  [[ -n "$session_name" ]] || return 0

  metadata="$(tmux display-message -p -t "$session_name" '#{window_id}	#{pane_current_path}' 2>/dev/null || true)"
  [[ -n "$metadata" ]] || return 0

  IFS=$'\t' read -r live_window live_cwd <<< "$metadata"
  if [[ -n "$live_window" && "$live_window" != "$window_id" ]]; then
    window_id="$live_window"
  fi
  if [[ -n "$live_cwd" && -d "$live_cwd" && "$live_cwd" != "$cwd" ]]; then
    cwd="$live_cwd"
  fi
}

perform_refresh() {
  adopt_live_context
  bash "$script_dir/tmux-status-layout.sh" "$session_name" "$window_id" "$cwd" >/dev/null
  set_session_option '@tmux_status_last_refresh' "$(date +%s)"
  set_session_option '@tmux_status_last_cwd' "$cwd"

  if (( refresh_client )); then
    refresh_matching_clients
  fi
}

# True when the cached line already describes the session's live active pane
# and was computed within the last second — i.e. the request that beat us to
# the lock did our work for us.
refresh_already_current() {
  local last_cwd=""
  local last_refresh=""
  local live_cwd=""
  local now=""

  [[ -n "$session_name" ]] || return 1

  live_cwd="$(tmux display-message -p -t "$session_name" '#{pane_current_path}' 2>/dev/null || true)"
  [[ -n "$live_cwd" ]] || return 1

  last_cwd="$(session_option '@tmux_status_last_cwd')"
  [[ "$last_cwd" == "$live_cwd" ]] || return 1

  last_refresh="$(session_option '@tmux_status_last_refresh')"
  [[ "$last_refresh" =~ ^[0-9]+$ ]] || return 1

  now="$(date +%s)"
  (( now - last_refresh <= 1 ))
}

# A forced refresh waits for a busy lock instead of dropping itself. Losing the
# race used to mean the switch you just made was never rendered until the poll
# came around, because nothing re-queued the request.
acquire_refresh_lock_waiting() {
  local lock_dir="$1"
  local attempts=0
  local max_attempts=0

  if (( force_refresh )); then
    max_attempts="$(numeric_option_or_default TMUX_STATUS_LOCK_WAIT_ATTEMPTS @tmux_status_lock_wait_attempts '20')"
  fi

  while :; do
    if acquire_refresh_lock "$lock_dir"; then
      return 0
    fi

    if (( attempts >= max_attempts )); then
      return 1
    fi

    if refresh_already_current; then
      return 1
    fi

    attempts=$(( attempts + 1 ))
    sleep 0.05
  done
}

perform_refresh_locked() {
  local lock_dir=""
  local status=0

  lock_dir="$(refresh_lock_dir)"
  if ! acquire_refresh_lock_waiting "$lock_dir"; then
    return 0
  fi

  # The request we waited behind may have landed on the same live context
  # while we held in the queue. Repainting it costs another git probe per
  # jump, so short-circuit to the client repaint.
  if (( force_refresh )) && refresh_already_current; then
    if (( refresh_client )); then
      refresh_matching_clients
    fi
    release_refresh_lock "$lock_dir"
    return 0
  fi

  if ! perform_refresh; then
    status=$?
  fi
  release_refresh_lock "$lock_dir"
  return "$status"
}

perform_refresh_async() {
  local lock_dir=""

  lock_dir="$(refresh_lock_dir)"
  if ! acquire_refresh_lock "$lock_dir"; then
    return 0
  fi

  (
    trap 'release_refresh_lock "$lock_dir"' EXIT
    perform_refresh
  ) >/dev/null 2>&1 &
}

# Callers are tmux hooks, so a value can arrive empty whenever the format
# variable behind it is unset for that hook scope (e.g. `hook_window` on the
# session-scoped `session-window-changed`). `--window #{q:hook_window} --force`
# then reaches us as `--window --force`; consuming the next token blindly
# would swallow `--force` and turn the whole invocation into a no-op. Treat a
# flag-shaped token as "no value given" instead.
opt_value=""
opt_shift=1
read_option_value() {
  opt_value=""
  opt_shift=1

  case "${1:-}" in
    '' | -*)
      return 0
      ;;
  esac

  opt_value="$1"
  opt_shift=2
}

while (( $# > 0 )); do
  case "$1" in
    --client)
      read_option_value "${2:-}"
      client_name="$opt_value"
      shift "$opt_shift"
      ;;
    --session)
      read_option_value "${2:-}"
      session_name="$opt_value"
      shift "$opt_shift"
      ;;
    --window)
      read_option_value "${2:-}"
      window_id="$opt_value"
      shift "$opt_shift"
      ;;
    --pane)
      read_option_value "${2:-}"
      pane_id="$opt_value"
      shift "$opt_shift"
      ;;
    --cwd)
      read_option_value "${2:-}"
      cwd="$opt_value"
      shift "$opt_shift"
      ;;
    --print-line)
      read_option_value "${2:-}"
      print_line="$opt_value"
      shift "$opt_shift"
      ;;
    --force)
      force_refresh=1
      shift
      ;;
    --no-debounce)
      no_debounce=1
      shift
      ;;
    --refresh-client)
      refresh_client=1
      shift
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$session_name" || -z "$window_id" || -z "$cwd" ]]; then
  resolve_context_from_tmux
fi


if [[ -n "$print_line" ]] && (( force_refresh == 0 )) && [[ -n "$session_name" ]] && [[ -n "$cwd" ]]; then
  if should_refresh; then
    refresh_client=1
    perform_refresh_async
  fi
  session_option "@tmux_status_line_${print_line}"
  exit 0
fi

if [[ -n "$session_name" ]] && [[ -n "$cwd" ]] && should_refresh; then
  perform_refresh_locked
elif (( refresh_client )); then
  refresh_matching_clients
fi

if [[ -n "$print_line" ]]; then
  session_option "@tmux_status_line_${print_line}"
fi
