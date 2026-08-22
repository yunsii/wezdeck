#!/usr/bin/env bash
# Light layout heal after DPI / RDP / client-size glitches.
#
# Does NOT respawn panes or restart agents. For a full rebuild use the
# palette refresh-current-* actions.
#
# Steps:
#   1. refresh-client -S — re-measure tty size after zoom / RDP attach
#   2. rebalance managed two-pane windows (even-horizontal)
#   3. clamp multi-line status to the expected 1–3 lines and force a
#      status recompute (fixes "status bar ate half the window")
#
# Usage:
#   tmux-fix-layout.sh
#   tmux-fix-layout.sh --session NAME --window ID --cwd PATH [--client NAME]
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/tmux-worktree-lib.sh"

session_name="${COMMAND_PANEL_SESSION_NAME:-}"
window_id="${COMMAND_PANEL_WINDOW_ID:-}"
cwd="${COMMAND_PANEL_CWD:-}"
client_tty="${COMMAND_PANEL_CLIENT_TTY:-}"
client_name=""
start_ms="$(runtime_log_now_ms)"

while (($# > 0)); do
  case "$1" in
    --session)
      session_name="${2:?}"
      shift 2
      ;;
    --window)
      window_id="${2:?}"
      shift 2
      ;;
    --cwd)
      cwd="${2:-}"
      shift 2
      ;;
    --client)
      client_name="${2:?}"
      shift 2
      ;;
    --client-tty)
      client_tty="${2:-}"
      shift 2
      ;;
    -h|--help)
      printf 'Usage: %s [--session NAME] [--window ID] [--cwd PATH] [--client NAME]\n' "$0"
      exit 0
      ;;
    *)
      printf 'tmux-fix-layout: unknown option: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

# Resolve live context when invoked from a chord (no COMMAND_PANEL_*).
if [[ -z "$session_name" || -z "$window_id" ]]; then
  meta="$(tmux display-message -p '#{session_name}\t#{window_id}\t#{pane_current_path}\t#{client_name}' 2>/dev/null || true)"
  IFS=$'\t' read -r live_session live_window live_cwd live_client <<< "$meta"
  [[ -n "$session_name" ]] || session_name="$live_session"
  [[ -n "$window_id" ]] || window_id="$live_window"
  [[ -n "$cwd" ]] || cwd="$live_cwd"
  [[ -n "$client_name" ]] || client_name="$live_client"
fi

if [[ -z "$session_name" || -z "$window_id" ]]; then
  runtime_log_warn layout "fix-layout missing session/window" \
    "session_name=${session_name:-}" "window_id=${window_id:-}"
  tmux display-message 'Layout fix failed: not inside a tmux session' 2>/dev/null || true
  exit 1
fi

[[ -n "$cwd" && -d "$cwd" ]] || cwd="$(tmux display-message -p -t "$window_id" '#{pane_current_path}' 2>/dev/null || true)"

runtime_log_info layout "fix-layout invoked" \
  "session_name=$session_name" \
  "window_id=$window_id" \
  "cwd=${cwd:-}" \
  "client_name=${client_name:-}" \
  "client_tty=${client_tty:-}"

# ── 1. Re-measure client size (DPI / RDP attach-detach) ──────────────
refresh_clients() {
  local client=""
  if [[ -n "$client_name" ]]; then
    tmux refresh-client -S -t "$client_name" 2>/dev/null || true
    return 0
  fi
  if [[ -n "$client_tty" ]]; then
    while IFS= read -r client; do
      [[ -n "$client" ]] || continue
      tmux refresh-client -S -t "$client" 2>/dev/null || true
    done < <(tmux list-clients -F '#{client_name}\t#{client_tty}' 2>/dev/null \
      | awk -F '\t' -v tty="$client_tty" '$2 == tty { print $1 }')
  fi
  while IFS= read -r client; do
    [[ -n "$client" ]] || continue
    tmux refresh-client -S -t "$client" 2>/dev/null || true
  done < <(tmux list-clients -t "$session_name" -F '#{client_name}' 2>/dev/null || true)
}
refresh_clients

# ── 2. Rebalance pane layout ─────────────────────────────────────────
# Prefer the managed two-pane contract (left agent / right shell). Custom
# multi-pane layouts fall back to even-horizontal so splits recentre after
# a size change without destroying the tree.
pane_count="$(tmux list-panes -t "$window_id" 2>/dev/null | wc -l | tr -d ' ')"
layout_meta="$(tmux_worktree_window_metadata "$window_id" @wezterm_window_layout 2>/dev/null || true)"
if [[ "${pane_count:-0}" -ge 2 ]]; then
  if [[ "$layout_meta" == "managed_two_pane" || -z "$layout_meta" ]]; then
    tmux select-layout -t "$window_id" even-horizontal >/dev/null 2>&1 || true
  else
    # Unknown token — still even out horizontally; user can re-split.
    tmux select-layout -t "$window_id" even-horizontal >/dev/null 2>&1 || true
  fi
  runtime_log_info layout "rebalanced panes" \
    "window_id=$window_id" "pane_count=$pane_count" "layout_meta=${layout_meta:-}"
fi

# ── 3. Clamp + recompute status lines ────────────────────────────────
# After RDP disconnect the multi-line status option can stick at a bad
# value (or line caches fill with junk), eating vertical space. Force the
# layout script to rewrite lines, then clamp anything above 3.
status_now="$(tmux show-options -qv -t "$session_name" status 2>/dev/null || true)"
[[ -n "$status_now" ]] || status_now="$(tmux show -gv status 2>/dev/null || printf 'on')"

if [[ "$status_now" =~ ^[0-9]+$ ]] && (( status_now > 3 )); then
  runtime_log_warn layout "clamping oversized status" \
    "session_name=$session_name" "status_was=$status_now"
  tmux set-option -q -t "$session_name" status 2 2>/dev/null || true
fi

# Clear cached lines so a forced refresh cannot keep a bloated string.
tmux set-option -q -t "$session_name" @tmux_status_line_0 '' 2>/dev/null || true
tmux set-option -q -t "$session_name" @tmux_status_line_1 '' 2>/dev/null || true
tmux set-option -q -t "$session_name" @tmux_status_line_2 '' 2>/dev/null || true

status_args=(
  --session "$session_name"
  --window "$window_id"
  --force
  --no-debounce
  --refresh-client
)
[[ -n "$cwd" ]] && status_args+=(--cwd "$cwd")
[[ -n "$client_name" ]] && status_args+=(--client "$client_name")
bash "$script_dir/tmux-status-refresh.sh" "${status_args[@]}" >/dev/null 2>&1 || true

# Re-read and clamp again in case layout script wrote an unexpected value.
status_after="$(tmux show-options -qv -t "$session_name" status 2>/dev/null || true)"
if [[ "$status_after" =~ ^[0-9]+$ ]] && (( status_after > 3 )); then
  tmux set-option -q -t "$session_name" status 2 2>/dev/null || true
fi

# One more size pass after status line count may have changed.
refresh_clients

runtime_log_info layout "fix-layout completed" \
  "session_name=$session_name" \
  "window_id=$window_id" \
  "status_before=$status_now" \
  "status_after=$(tmux show-options -qv -t "$session_name" status 2>/dev/null || true)" \
  "duration_ms=$(runtime_log_duration_ms "$start_ms")"

tmux display-message 'Layout fixed (size · panes · status)' 2>/dev/null || true
