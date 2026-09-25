#!/usr/bin/env bash

print_usage() {
  cat <<'EOF' >&2
usage:
  tmux-reset.sh session-name --workspace NAME --cwd PATH
  tmux-reset.sh current-session --workspace NAME [--cwd PATH]
  tmux-reset.sh refresh-current-window [--session-name NAME] [--window-id ID] [--cwd PATH]
  tmux-reset.sh refresh-current-session [--session-name NAME] [--window-id ID] [--cwd PATH] [--client-tty TTY]
  tmux-reset.sh refresh-current-workspace [--session-name NAME] [--window-id ID] [--cwd PATH] [--client-tty TTY]
  tmux-reset.sh refresh-all [--session-name NAME] [--window-id ID] [--cwd PATH] [--client-tty TTY]
  tmux-reset.sh reset-managed-window --workspace NAME [--cwd PATH]
  tmux-reset.sh reset-current-window --session-name NAME --window-id ID [--cwd PATH]
  tmux-reset.sh reset-default --cwd PATH [--kill-other-default-sessions] [--kill-other-sessions]
  tmux-reset.sh resolve-default-session --cwd PATH
  tmux-reset.sh list-default-sessions
  tmux-reset.sh list-sessions
EOF
}

unique_lines() {
  awk 'NF && !seen[$0]++'
}

normalize_tmux_command() {
  local value="${1-}"
  if [[ -n "$value" && "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s\n' "$value"
}

normalize_requested_cwd() {
  local cwd="${1:-}"
  if [[ -n "$cwd" && -d "$cwd" && ! "$cwd" =~ ^/mnt/[a-z]/Users/[^/]+$ ]]; then
    tmux_worktree_abs_path "$cwd"
    return 0
  fi
  printf '\n'
}

context_value_or_env() {
  local explicit_value="${1-}"
  local env_name="${2:?missing env name}"
  if [[ -n "$explicit_value" ]]; then
    printf '%s\n' "$explicit_value"
    return 0
  fi
  printf '%s\n' "${!env_name:-}"
}

path_match_score() {
  local candidate="${1:-}"
  local target="${2:-}"

  if [[ -z "$candidate" || -z "$target" ]]; then
    printf '0\n'
    return 0
  fi

  if [[ "$candidate" == "$target" ]]; then
    printf '%s\n' "$((100000 + ${#candidate}))"
    return 0
  fi

  if [[ "$target" == "$candidate"/* ]]; then
    printf '%s\n' "$((50000 + ${#candidate}))"
    return 0
  fi

  if [[ "$candidate" == "$target"/* ]]; then
    printf '%s\n' "$((25000 + ${#target}))"
    return 0
  fi

  printf '0\n'
}

# resolve_login_shell lives in managed-shell-lib.sh (sourced by tmux-reset.sh).

build_primary_shell_command() {
  local login_shell quoted_shell
  login_shell="$(resolve_login_shell)"
  quoted_shell="$(printf '%q' "$login_shell")"
  printf '%s -il' "$quoted_shell"
}

# Keep the managed primary pane alive when a resume command exits before the
# agent has started. Fresh workspace panes already use this wrapper; refresh
# and session-replacement paths must use the same contract so a failed agent
# cannot destroy the pane itself.
build_primary_agent_command() {
  local command="${1:-}"
  local wrapper=""
  local token=""
  local -a argv=()

  [[ -n "$command" ]] || {
    build_primary_shell_command
    return 0
  }

  # Metadata from open-project-session already contains the wrapper. Avoid
  # nesting it when a later refresh reads that metadata back.
  if [[ "$command" == *"primary-pane-wrapper.sh"* ]]; then
    printf '%s\n' "$command"
    return 0
  fi

  if declare -F resume_command_split_argv >/dev/null 2>&1; then
    while IFS= read -r token; do
      [[ -n "$token" ]] && argv+=("$token")
    done < <(resume_command_split_argv "$command")
  else
    argv=("$command")
  fi

  if (( ${#argv[@]} == 0 )); then
    build_primary_shell_command
    return 0
  fi

  wrapper="${wezterm_config_repo:-}/scripts/runtime/primary-pane-wrapper.sh"
  if [[ ! -x "$wrapper" ]]; then
    printf '%s\n' "$command"
    return 0
  fi

  printf 'bash %q' "$wrapper"
  printf ' %q' "${argv[@]}"
  printf '\n'
}

# Returns the agent profile base (claude / codex / …) when the active
# `MANAGED_AGENT_PROFILE` has a configured `*_RESUME_COMMAND` — i.e. when
# `resolve_resume_primary_command` would actually override the metadata
# command with the agent wrapper. Empty otherwise. Used by the refresh
# path to decide whether to tag the pane with `@wezterm_pane_role` so
# the C-n binding can detect agent panes through the wrapper's
# leaf=sh / leaf=node startup transient.
agent_profile_for_managed_pane() {
  local wezterm_repo="$1"
  local cwd="${2:-}"
  if ! declare -F resolve_resume_primary_command >/dev/null 2>&1; then
    return 0
  fi
  local resume_command
  resume_command="$(resolve_resume_primary_command "$wezterm_repo" "$cwd" 2>/dev/null || true)"
  [[ -n "$resume_command" ]] || return 0
  local profile
  if declare -F resume_command_active_profile >/dev/null 2>&1; then
    profile="$(resume_command_active_profile "$wezterm_repo" "$cwd" 2>/dev/null || true)"
  else
    profile="${MANAGED_AGENT_PROFILE:-claude}"
    profile="${profile%-resume}"
    profile="${profile%_resume}"
  fi
  printf '%s\n' "$profile"
}

# Tag (or untag) a primary pane with `@wezterm_pane_role=agent-cli:<profile>`
# so the C-n binding can detect it through the resume wrapper's
# leaf=sh / leaf=node boot transient. Used by every path that respawns
# or freshly creates a managed primary pane (in-place window refresh,
# session-replacement clone, …) to keep the predicate semantics in one
# place.
ensure_primary_pane_role_tag() {
  local pane_id="${1:?missing pane id}"
  local role="${2:-}"
  local wezterm_repo="${3:-}"
  local cwd="${4:-}"
  local agent_profile=""
  local previous_role=""

  [[ -n "$pane_id" ]] || return 0
  previous_role="$(tmux show-options -p -t "$pane_id" -v -q @wezterm_pane_role 2>/dev/null || true)"
  if [[ "$role" == managed* ]]; then
    agent_profile="$(agent_profile_for_managed_pane "$wezterm_repo" "$cwd" 2>/dev/null || true)"
  fi
  if [[ -n "$agent_profile" ]]; then
    tmux set-option -p -t "$pane_id" @wezterm_pane_role "agent-cli:$agent_profile" 2>/dev/null || true
    if declare -F runtime_log_info >/dev/null 2>&1; then
      runtime_log_info agent_cli "set primary pane agent role tag" \
        "pane_id=$pane_id" \
        "cwd=$cwd" \
        "window_role=$role" \
        "previous_role=${previous_role:-}" \
        "pane_role=agent-cli:$agent_profile"
    fi
  else
    tmux set-option -p -t "$pane_id" -u @wezterm_pane_role 2>/dev/null || true
    # Only log clears when something was actually present — avoids noise
    # on every shell-window refresh that never carried a tag.
    if [[ -n "$previous_role" ]] && declare -F runtime_log_info >/dev/null 2>&1; then
      runtime_log_info agent_cli "cleared primary pane agent role tag" \
        "pane_id=$pane_id" \
        "cwd=$cwd" \
        "window_role=$role" \
        "previous_role=$previous_role"
    fi
  fi
}

active_window_id_for_session() {
  local session_name="${1:?missing session name}"
  tmux display-message -p -t "$session_name" '#{window_id}' 2>/dev/null || true
}

resolve_worktree_root_for_cwd() {
  local cwd="${1:-}"
  [[ -n "$cwd" && -d "$cwd" ]] || return 1

  if tmux_worktree_in_git_repo "$cwd"; then
    tmux_worktree_repo_root "$cwd"
    return 0
  fi

  tmux_worktree_abs_path "$cwd"
}
