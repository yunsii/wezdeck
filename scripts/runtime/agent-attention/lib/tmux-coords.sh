#!/usr/bin/env bash
# Recover tmux coordinates when a hook inherits WEZTERM_PANE but not TMUX.
# Claude Code fork-session / bg-pty-host children often look like this:
# they keep WEZTERM_PANE from the parent TUI but strip TMUX, so a naive
# emit would persist empty tmux_session/window/pane and Alt+/ renders
# `?/?/?/<branch>`.
#
# Recovery order:
#   1. pane-session/<WEZTERM_PANE>.txt → hosting tmux session name
#   2. In that session, pick a pane whose pane_current_path matches the
#      hook cwd (CLAUDE_PROJECT_DIR / CODEX_PROJECT_DIR / PWD)
#   3. Fall back to the session's active pane
#
# Prints: socket|session|window_id|pane_id|window_name
# Empty stdout + non-zero = could not recover.

attention_pane_session_dir() {
  if windows_runtime_detect_paths 2>/dev/null; then
    printf '%s/state/pane-session' "${WINDOWS_RUNTIME_STATE_WSL}"
  else
    printf '%s/wezterm-runtime/state/pane-session' \
      "${XDG_STATE_HOME:-$HOME/.local/state}"
  fi
}

# True when this process or a near ancestor looks like a Claude Code
# fork-session / bg-pty host (hooks fire without TMUX).
# Match null-separated argv tokens only — do not scan joined cmdline
# text (a `bash -c '…fork-session…'` test harness would false-positive).
attention_is_claude_fork_bg() {
  local pid="${1:-$$}"
  local depth=0
  local arg ppid
  while [[ -n "$pid" && "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && $depth -lt 10 ]]; do
    if [[ -r "/proc/${pid}/cmdline" ]]; then
      while IFS= read -r -d '' arg; do
        case "$arg" in
          --fork-session|--bg-pty-host|--bg-pty|--bg-spare|bg-pty-host)
            return 0
            ;;
        esac
      done <"/proc/${pid}/cmdline"
    fi
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ -n "$ppid" && "$ppid" != "$pid" ]] || break
    pid="$ppid"
    depth=$((depth + 1))
  done
  return 1
}

# Resolve tmux meta for WEZTERM_PANE when TMUX is unset.
# Args: wezterm_pane_id [cwd_hint]
attention_recover_tmux_coords() {
  local wezterm_pane="${1:-}"
  local cwd_hint="${2:-}"
  local dir session_name meta line pane_path best=""
  local socket window_id pane_id window_name

  [[ -n "$wezterm_pane" ]] || return 1
  command -v tmux >/dev/null 2>&1 || return 1

  dir="$(attention_pane_session_dir)"
  [[ -r "${dir}/${wezterm_pane}.txt" ]] || return 1
  session_name="$(tr -d ' \n\r\t' <"${dir}/${wezterm_pane}.txt" 2>/dev/null || true)"
  [[ -n "$session_name" ]] || return 1

  if [[ -z "$cwd_hint" ]]; then
    cwd_hint="${CLAUDE_PROJECT_DIR:-${CODEX_PROJECT_DIR:-${PWD:-}}}"
  fi
  # Normalize trailing slash for path compare.
  cwd_hint="${cwd_hint%/}"

  if [[ -n "$cwd_hint" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      pane_path="${line##*|}"
      pane_path="${pane_path%/}"
      if [[ "$pane_path" == "$cwd_hint" ]]; then
        # Drop the trailing path field → socket|session|window|pane|name
        best="${line%|*}"
        break
      fi
    done < <(
      # -s: every pane in the target session (all windows).
      tmux list-panes -s -t "$session_name" -F \
        '#{socket_path}|#{session_name}|#{window_id}|#{pane_id}|#{window_name}|#{pane_current_path}' \
        2>/dev/null || true
    )
  fi

  if [[ -z "$best" ]]; then
    # Active pane in the session (client may be elsewhere; still better
    # than empty coords for Alt+/ label / jump).
    meta="$(tmux display-message -p -t "${session_name}:" \
      -F '#{socket_path}|#{session_name}|#{window_id}|#{pane_id}|#{window_name}' \
      2>/dev/null || true)"
    if [[ -z "$meta" ]]; then
      # Session may have no attached client; take first pane in session.
      meta="$(tmux list-panes -s -t "$session_name" -F \
        '#{socket_path}|#{session_name}|#{window_id}|#{pane_id}|#{window_name}' \
        2>/dev/null | head -n 1 || true)"
    fi
    best="$meta"
  fi

  [[ -n "$best" ]] || return 1
  IFS='|' read -r socket session_name window_id pane_id window_name <<<"$best"
  [[ -n "$pane_id" && -n "$session_name" ]] || return 1
  printf '%s|%s|%s|%s|%s\n' \
    "$socket" "$session_name" "$window_id" "$pane_id" "$window_name"
  return 0
}
