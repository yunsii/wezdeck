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

resume_command_active_profile() {
  local wezterm_repo="${1:-}"
  local profile="${MANAGED_AGENT_PROFILE:-}"
  local shared_env=""
  local worktree_env=""

  if [[ -z "$profile" && -n "$wezterm_repo" ]]; then
    shared_env="$wezterm_repo/wezterm-x/local/shared.env"
    profile="$(resume_command_extract_value "$shared_env" MANAGED_AGENT_PROFILE 2>/dev/null || true)"
  fi
  # Match cold-spawn / worktree-task: when the machine has not selected a
  # profile in shared.env, accept the tracked default from worktree-task.env.
  if [[ -z "$profile" && -n "$wezterm_repo" ]]; then
    worktree_env="$wezterm_repo/config/worktree-task.env"
    profile="$(resume_command_extract_value "$worktree_env" WT_PROVIDER_AGENT_PROFILE 2>/dev/null || true)"
  fi

  profile="${profile:-claude}"
  profile="${profile%-resume}"
  printf '%s\n' "$profile"
}

resume_command_expand_placeholders() {
  local resolved="${1:-}"
  local wezterm_repo="${2:-}"
  # ${WEZTERM_REPO} is the canonical placeholder for the wezterm-config
  # repo root in worktree-task.env — used so resume commands can reference
  # repo-internal scripts (agent-launcher.sh) without hardcoding an
  # absolute path. Expanded here (rather than relying on the shell that
  # eventually runs the command) because tmux fork-execs the resolved
  # string verbatim via `sh -c`, and a bare ${WEZTERM_REPO} would expand
  # to empty and fail with `not found`.
  # Keep in lockstep with wezterm-x/lua/config/managed_cli.lua::expand_placeholders.
  if [[ -n "$wezterm_repo" && -n "$resolved" ]]; then
    resolved="${resolved//\$\{WEZTERM_REPO\}/$wezterm_repo}"
  fi
  printf '%s\n' "$resolved"
}

resume_command_lookup_profile_key() {
  local wezterm_repo="${1:-}"
  local key="${2:?missing key}"
  local user_file="${XDG_CONFIG_HOME:-$HOME/.config}/worktree-task/config.env"
  local repo_file=""
  local resolved="" candidate value

  if [[ -n "$wezterm_repo" ]]; then
    repo_file="$wezterm_repo/config/worktree-task.env"
  fi

  for candidate in "$user_file" "$repo_file"; do
    [[ -n "$candidate" ]] || continue
    if value="$(resume_command_extract_value "$candidate" "$key" 2>/dev/null)"; then
      resolved="$value"
    fi
  done

  [[ -n "$resolved" ]] || return 1
  resume_command_expand_placeholders "$resolved" "$wezterm_repo"
}

# resolve_resume_primary_command <wezterm_config_repo>
# Prints the resume command on stdout, or nothing if it cannot be
# resolved (caller should fall back to the source pane's primary command).
resolve_resume_primary_command() {
  local wezterm_repo="${1:-}"
  local profile
  profile="$(resume_command_active_profile "$wezterm_repo")"
  local normalized
  normalized="$(resume_command_normalize_profile_key "$profile")"
  [[ -n "$normalized" ]] || return 0

  local key="WT_PROVIDER_AGENT_PROFILE_${normalized}_RESUME_COMMAND"
  resume_command_lookup_profile_key "$wezterm_repo" "$key" || return 0
}

# resolve_managed_primary_command <wezterm_config_repo>
# Canonical managed-CLI argv string for every shell launch path that
# builds a fresh primary pane (Alt+g on-demand, refresh, cold-spawn).
# Preference: RESUME_COMMAND → bare COMMAND → profile name.
# Always expands ${WEZTERM_REPO}. Never prints empty when a profile is known.
resolve_managed_primary_command() {
  local wezterm_repo="${1:-}"
  local resolved=""
  local profile normalized key

  resolved="$(resolve_resume_primary_command "$wezterm_repo" || true)"
  if [[ -n "$resolved" ]]; then
    printf '%s\n' "$resolved"
    return 0
  fi

  profile="$(resume_command_active_profile "$wezterm_repo")"
  normalized="$(resume_command_normalize_profile_key "$profile")"
  if [[ -n "$normalized" ]]; then
    key="WT_PROVIDER_AGENT_PROFILE_${normalized}_COMMAND"
    if resolved="$(resume_command_lookup_profile_key "$wezterm_repo" "$key" 2>/dev/null)"; then
      printf '%s\n' "$resolved"
      return 0
    fi
  fi

  printf '%s\n' "$profile"
}

# resume_command_split_argv <command_string>
# Emit one argv token per line. Prefers xargs (POSIX single/double quotes);
# falls back to naïve whitespace split when xargs rejects nested quotes.
resume_command_split_argv() {
  local cmd="${1:-}"
  local tokens_output token
  [[ -n "$cmd" ]] || return 0

  if tokens_output="$(printf '%s\n' "$cmd" | xargs -n1 printf '%s\n' 2>/dev/null)" \
     && [[ -n "$tokens_output" ]]; then
    while IFS= read -r token; do
      [[ -n "$token" ]] && printf '%s\n' "$token"
    done <<< "$tokens_output"
    return 0
  fi

  # shellcheck disable=SC2206
  local -a naive=( $cmd )
  for token in "${naive[@]}"; do
    printf '%s\n' "$token"
  done
}
