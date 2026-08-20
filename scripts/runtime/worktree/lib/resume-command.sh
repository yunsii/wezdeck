#!/usr/bin/env bash
# resume-command.sh — resolve the resume primary command for the active
# managed agent profile by reading the same `worktree-task.env` files
# `worktree-task launch` would consult, without dragging in the full
# `lib/config.sh` engine. Used by the Alt+g / Alt+Shift+G picker paths so
# windows created on demand still launch the resume variant of the agent
# (`sh -c 'claude --continue || exec claude'`, `sh -c 'codex resume
# --last || exec codex'`, …) instead of blindly cloning whatever start
# command the source pane was carrying.
#
# Profile selection order (when an optional cwd is passed):
#   1. wezterm-x/local/workspace-agent-map.tsv (from workspaces.lua via
#      render-workspace-agent-map.sh) — exact cwd, then longest path
#      prefix, then same git common-dir / main worktree family
#   2. MANAGED_AGENT_PROFILE env / wezterm-x/local/shared.env
#   3. WT_PROVIDER_AGENT_PROFILE in config/worktree-task.env
#   4. built-in default `claude`
#
# Env-key search order for command strings matches `wt_config_load`:
#   1. user file: `${XDG_CONFIG_HOME:-$HOME/.config}/worktree-task/config.env`
#   2. repo file: `<wezdeck-repo>/config/worktree-task.env`
# Later files override earlier ones (repo wins over user).

# shellcheck shell=bash

resume_command_normalize_profile_key() {
  local profile="${1:-}"
  profile="${profile^^}"
  profile="${profile//[^A-Z0-9]/_}"
  printf '%s\n' "$profile"
}

resume_command_strip_resume_suffix() {
  local profile="${1:-}"
  profile="${profile%-resume}"
  profile="${profile%_resume}"
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

resume_command_canonicalize_cwd() {
  local cwd="${1:-}"
  [[ -n "$cwd" ]] || return 1
  if [[ -d "$cwd" ]]; then
    (cd "$cwd" && pwd -P) 2>/dev/null || printf '%s\n' "$cwd"
    return 0
  fi
  # Configured workspace paths may be absent in unit fixtures; keep the
  # literal string so exact map matches still work in tests.
  printf '%s\n' "$cwd"
}

# True when $1 is $2 or a path under $2 (slash-boundary).
resume_command_path_under() {
  local path="${1:-}"
  local root="${2:-}"
  [[ -n "$path" && -n "$root" ]] || return 1
  [[ "$path" == "$root" || "$path" == "$root"/* ]]
}

resume_command_git_common_dir() {
  local cwd="${1:-}"
  local value=""
  [[ -n "$cwd" && -d "$cwd" ]] || return 1
  value="$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [[ -z "$value" ]]; then
    value="$(git -C "$cwd" rev-parse --git-common-dir 2>/dev/null || true)"
  fi
  [[ -n "$value" ]] || return 1
  if [[ "$value" != /* ]]; then
    value="$(cd "$cwd" && cd "$value" 2>/dev/null && pwd -P)" || return 1
  fi
  printf '%s\n' "$value"
}

resume_command_git_main_root() {
  local cwd="${1:-}"
  local common_dir="" main_root=""
  # Matches worktree/lib/git.sh::wt_git_main_root: for both the primary
  # checkout and linked worktrees, --git-common-dir points at the main
  # repo's `.git`, so dirname is the primary worktree root.
  common_dir="$(resume_command_git_common_dir "$cwd")" || return 1
  main_root="$(dirname "$common_dir")"
  [[ -n "$main_root" && -d "$main_root" ]] || return 1
  printf '%s\n' "$main_root"
}

# resume_command_lookup_workspace_profile <wezterm_repo> <cwd>
# Prints base profile from workspace-agent-map.tsv, or returns 1.
resume_command_lookup_workspace_profile() {
  local wezterm_repo="${1:-}"
  local cwd="${2:-}"
  local map_file=""
  local needle=""
  local map_cwd="" map_profile=""
  local best_prefix_cwd="" best_prefix_profile=""
  local cwd_common="" map_common="" main_root=""
  local family_profile="" family_cwd=""

  [[ -n "$wezterm_repo" && -n "$cwd" ]] || return 1
  map_file="$wezterm_repo/wezterm-x/local/workspace-agent-map.tsv"
  [[ -f "$map_file" ]] || return 1

  needle="$(resume_command_canonicalize_cwd "$cwd")" || return 1

  while IFS=$'\t' read -r map_cwd map_profile || [[ -n "$map_cwd" ]]; do
    [[ -n "$map_cwd" ]] || continue
    [[ "$map_cwd" =~ ^[[:space:]]*# ]] && continue
    [[ -n "$map_profile" ]] || continue
    map_profile="$(resume_command_strip_resume_suffix "$map_profile")"
    [[ -n "$map_profile" ]] || continue

    if [[ "$map_cwd" == "$needle" ]]; then
      printf '%s\n' "$map_profile"
      return 0
    fi

    # Longest map cwd that is a prefix of the needle (slash-bounded), so
    # `.worktrees/<repo>/task-foo` inherits the item configured at the
    # primary checkout or a longer-lived `dev-*` tab path.
    if resume_command_path_under "$needle" "$map_cwd"; then
      if [[ -z "$best_prefix_cwd" || ${#map_cwd} -gt ${#best_prefix_cwd} ]]; then
        best_prefix_cwd="$map_cwd"
        best_prefix_profile="$map_profile"
      fi
    fi
  done < "$map_file"

  if [[ -n "$best_prefix_profile" ]]; then
    printf '%s\n' "$best_prefix_profile"
    return 0
  fi

  # Same repo-family via git common-dir: prefer the map entry whose cwd
  # equals the primary worktree; otherwise the longest map cwd that
  # shares the common-dir.
  cwd_common="$(resume_command_git_common_dir "$needle" 2>/dev/null || true)"
  main_root="$(resume_command_git_main_root "$needle" 2>/dev/null || true)"
  if [[ -n "$cwd_common" ]]; then
    while IFS=$'\t' read -r map_cwd map_profile || [[ -n "$map_cwd" ]]; do
      [[ -n "$map_cwd" ]] || continue
      [[ "$map_cwd" =~ ^[[:space:]]*# ]] && continue
      [[ -n "$map_profile" ]] || continue
      [[ -d "$map_cwd" ]] || continue
      map_common="$(resume_command_git_common_dir "$map_cwd" 2>/dev/null || true)"
      [[ "$map_common" == "$cwd_common" ]] || continue
      map_profile="$(resume_command_strip_resume_suffix "$map_profile")"
      [[ -n "$map_profile" ]] || continue

      if [[ -n "$main_root" && "$map_cwd" == "$main_root" ]]; then
        printf '%s\n' "$map_profile"
        return 0
      fi
      if [[ -z "$family_cwd" || ${#map_cwd} -gt ${#family_cwd} ]]; then
        family_cwd="$map_cwd"
        family_profile="$map_profile"
      fi
    done < "$map_file"

    if [[ -n "$family_profile" ]]; then
      printf '%s\n' "$family_profile"
      return 0
    fi
  fi

  return 1
}

# resume_command_active_profile <wezterm_config_repo> [cwd]
resume_command_active_profile() {
  local wezterm_repo="${1:-}"
  local cwd="${2:-}"
  local profile=""
  local shared_env=""
  local worktree_env=""

  if [[ -n "$cwd" ]]; then
    profile="$(resume_command_lookup_workspace_profile "$wezterm_repo" "$cwd" 2>/dev/null || true)"
  fi

  if [[ -z "$profile" ]]; then
    profile="${MANAGED_AGENT_PROFILE:-}"
  fi

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
  profile="$(resume_command_strip_resume_suffix "$profile")"
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

# resolve_resume_primary_command <wezterm_config_repo> [cwd]
# Prints the resume command on stdout, or nothing if it cannot be
# resolved (caller should fall back to the source pane's primary command).
resolve_resume_primary_command() {
  local wezterm_repo="${1:-}"
  local cwd="${2:-}"
  local profile
  profile="$(resume_command_active_profile "$wezterm_repo" "$cwd")"
  local normalized
  normalized="$(resume_command_normalize_profile_key "$profile")"
  [[ -n "$normalized" ]] || return 0

  local key="WT_PROVIDER_AGENT_PROFILE_${normalized}_RESUME_COMMAND"
  resume_command_lookup_profile_key "$wezterm_repo" "$key" || return 0
}

# resolve_managed_primary_command <wezterm_config_repo> [cwd]
# Canonical managed-CLI argv string for every shell launch path that
# builds a fresh primary pane (Alt+g on-demand, refresh, cold-spawn).
# Preference: RESUME_COMMAND → bare COMMAND → profile name.
# Always expands ${WEZTERM_REPO}. Never prints empty when a profile is known.
resolve_managed_primary_command() {
  local wezterm_repo="${1:-}"
  local cwd="${2:-}"
  local resolved=""
  local profile normalized key

  resolved="$(resolve_resume_primary_command "$wezterm_repo" "$cwd" || true)"
  if [[ -n "$resolved" ]]; then
    printf '%s\n' "$resolved"
    return 0
  fi

  profile="$(resume_command_active_profile "$wezterm_repo" "$cwd")"
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
