#!/usr/bin/env bash
# resume-command.sh — resolve the resume primary command for the current
# MANAGED_AGENT_PROFILE by reading the same `worktree-task.env` files
# `worktree-task launch` would consult, without dragging in the full
# `lib/config.sh` engine. Used by the Alt+g / Alt+Shift+G picker paths so
# windows created on demand still launch the resume variant of the agent
# (`sh -c 'claude --continue || exec claude'`, `sh -c 'codex resume
# --last || exec codex'`, …) instead of blindly cloning whatever start
# command the source pane was carrying.
#
# Search order matches `wt_config_load`:
#   1. user file: `${XDG_CONFIG_HOME:-$HOME/.config}/worktree-task/config.env`
#   2. repo file: `<wezdeck-repo>/config/worktree-task.env` (repo dir name is still `wezterm-config` on disk)
# Later files override earlier ones (repo wins over user) so a project
# that ships its own resume command takes precedence over a personal
# default.

# shellcheck shell=bash

resume_command_normalize_profile_key() {
  local profile="${1:-}"
  profile="${profile^^}"
  profile="${profile//[^A-Z0-9]/_}"
  printf '%s\n' "$profile"
}

resume_command_extract_value() {
  local file="${1:?missing config file}"
  local key="${2:?missing key}"
  local line value found=""
  [[ -f "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" == "${key}="* ]] || continue
    value="${line#${key}=}"
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    found="$value"
  done < "$file"
  if [[ -n "$found" ]]; then
    printf '%s\n' "$found"
    return 0
  fi
  return 1
}

# resolve_resume_primary_command <wezterm_config_repo>
# Prints the resume command on stdout, or nothing if it cannot be
# resolved (caller should fall back to the source pane's primary command).
resolve_resume_primary_command() {
  local wezterm_repo="${1:-}"
  local profile="${MANAGED_AGENT_PROFILE:-claude}"
  profile="${profile%-resume}"
  local normalized
  normalized="$(resume_command_normalize_profile_key "$profile")"
  [[ -n "$normalized" ]] || return 0

  local key="WT_PROVIDER_AGENT_PROFILE_${normalized}_RESUME_COMMAND"
  local user_file="${XDG_CONFIG_HOME:-$HOME/.config}/worktree-task/config.env"
  local repo_file=""
  if [[ -n "$wezterm_repo" ]]; then
    repo_file="$wezterm_repo/config/worktree-task.env"
  fi

  local resolved=""
  local candidate
  for candidate in "$user_file" "$repo_file"; do
    [[ -n "$candidate" ]] || continue
    if value="$(resume_command_extract_value "$candidate" "$key" 2>/dev/null)"; then
      resolved="$value"
    fi
  done

  [[ -n "$resolved" ]] || return 0
  # ${WEZTERM_REPO} is the canonical placeholder for the wezterm-config
  # repo root in worktree-task.env — used so resume commands can reference
  # repo-internal scripts (agent-launcher.sh) without hardcoding an
  # absolute path. Expanded here (rather than relying on the shell that
  # eventually runs the command) because tmux fork-execs the resolved
  # string verbatim via `sh -c`, and a bare ${WEZTERM_REPO} would expand
  # to empty and fail with `not found`.
  if [[ -n "$wezterm_repo" ]]; then
    resolved="${resolved//\$\{WEZTERM_REPO\}/$wezterm_repo}"
  fi
  printf '%s\n' "$resolved"
}
