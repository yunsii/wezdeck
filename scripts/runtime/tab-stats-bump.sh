#!/usr/bin/env bash
# Bump session focus stats. Called from the tmux `client-session-changed`
# / `client-attached` hooks (and any other producer that knows a session
# just took focus).
#
# Usage: tab-stats-bump.sh <session_name> [<client_tty> [<workspace>]]
#
# When called from a tmux hook, <client_tty> should be the firing
# client's #{client_tty}. That tty identifies WHICH client switched, so
# we can pay the previous session's dwell-weighted close-out on this
# client's behalf. Manual / agent-side callers may omit it; the bump
# still happens, but no close-out is computed (raw_count tracks the
# entry either way; weight only accrues when leave timing is available).
#
# Workspace defaults to the @wezterm_workspace tmux session-option when
# the caller does not pass it explicitly. If neither source resolves we
# log to stderr and return 0 (must not break the tmux hook chain).

set -u

__TAB_STATS_BUMP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$__TAB_STATS_BUMP_DIR/tab-stats-lib.sh"

session_name="${1:-}"
client_tty="${2:-}"
workspace="${3:-}"

if [[ -z "$session_name" ]]; then
  printf '[tab-stats-bump] missing session_name\n' >&2
  exit 0
fi

resolve_workspace_for_session() {
  local sess="$1" ws=""
  ws="$(tmux show-options -v -t "$sess" @wezterm_workspace 2>/dev/null || true)"
  if [[ -z "$ws" ]]; then
    ws="${WEZTERM_WORKSPACE:-}"
  fi
  if [[ -z "$ws" ]]; then
    # Untagged session — common for the `default` workspace shells that
    # never went through open-project-session. Bucket them under a
    # stable slug so the data is at least observable.
    ws="default"
  fi
  printf '%s' "$ws"
}

if [[ -z "$workspace" ]]; then
  workspace="$(resolve_workspace_for_session "$session_name")"
fi

# Close-out the previous session this client was on, if we have a
# client_tty AND an enter-state file for it. Read first, then decide
# whether this is a same-session re-fire (skip everything — duplicate
# hook within the throttle window) or a genuine switch.
if [[ -n "$client_tty" ]]; then
  enter_dir="$(tab_stats_enter_dir)"
  mkdir -p "$enter_dir"
  client_slug="$(tab_stats_client_slug "$client_tty")"
  enter_file="$enter_dir/${client_slug}.txt"

  if [[ -f "$enter_file" ]]; then
    # Format: <session>\t<workspace>\t<enter_ms>
    IFS=$'\t' read -r prev_session prev_workspace prev_enter_ms < "$enter_file" || true

    if [[ -n "${prev_session:-}" && "$prev_session" == "$session_name" ]]; then
      # Same session — duplicate hook fire (e.g. attached right after
      # session-changed). Keep the original enter_ms so the eventual
      # close-out reflects the actual dwell, not the most recent
      # re-fire.
      exit 0
    fi

    if [[ -n "${prev_session:-}" && -n "${prev_enter_ms:-}" ]]; then
      now_ms="$(tab_stats_now_ms)"
      dwell_ms=$(( now_ms - prev_enter_ms ))
      if (( dwell_ms < 0 )); then dwell_ms=0; fi
      # Fall back to the new workspace if the enter file didn't record
      # one (older state file) or its session is gone and we can't ask
      # tmux for it now. Mis-attribution across workspaces is rare and
      # the alternative (skip the close-out) loses signal.
      if [[ -z "${prev_workspace:-}" ]]; then
        prev_workspace="$workspace"
      fi
      tab_stats_close_out "$prev_workspace" "$prev_session" "$dwell_ms" || true
    fi
  fi
fi

tab_stats_bump "$workspace" "$session_name" || true

# Record the new enter state so the next switch on this client can
# pay this session's dwell.
if [[ -n "$client_tty" ]]; then
  now_ms="$(tab_stats_now_ms)"
  tmp="${enter_file}.tmp.$$"
  printf '%s\t%s\t%s\n' "$session_name" "$workspace" "$now_ms" > "$tmp"
  mv "$tmp" "$enter_file"
fi
