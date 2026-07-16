#!/usr/bin/env bash
# core-shared.sh — usage text, provider helpers, repo context for worktree-task.
# Sourced by core.sh (not a CLI entry).
# shellcheck shell=bash

wt_core_usage() {
  cat <<'EOF'
usage:
  worktree-task <command> [options]

commands:
  configure Configure or update WEZDECK_REPO for worktree-task
  launch    Create a linked task worktree and optionally open it in tmux
  reclaim   Remove a linked task worktree created by worktree-task

environment:
  WEZDECK_REPO  Required wezdeck checkout root (legacy WEZTERM_CONFIG_REPO still accepted); if missing, run worktree-task configure --repo /absolute/path
EOF
}

wt_core_launch_usage() {
  cat <<'EOF'
usage:
  worktree-task launch --title TITLE [options]

options:
  --cwd PATH            Target repository path. Default: current directory
  --task-slug VALUE     Slug prefix for the worktree directory
  --branch VALUE        Explicit branch name. Default: WT_POLICY_BRANCH_PREFIX + slug
  --base-ref VALUE      Base ref for the new branch. Default: primary worktree HEAD
  --provider VALUE      Provider name or path. Builtins: none, tmux-agent
  --provider-mode MODE  off, auto, or required
  --workspace NAME      Provider workspace/session namespace override
  --session-name NAME   Force a specific tmux session name for tmux-agent
  --variant MODE        Provider variant override: auto, light, or dark
  --no-attach           Prepare the runtime target without switching/attaching
EOF
}

wt_core_configure_usage() {
  cat <<'EOF'
usage:
  worktree-task configure [options]

options:
  --cwd PATH   Target repository path used to resolve a relative --repo path. Default: current directory
  --repo PATH  Explicit wezdeck-checkout path to save
EOF
}

wt_core_reclaim_usage() {
  cat <<'EOF'
usage:
  worktree-task reclaim [options]

options:
  --cwd PATH            Repository or task worktree path. Default: current directory
  --task-slug VALUE     Reclaim WT_POLICY_WORKTREE_DIR/VALUE from the resolved repo family
  --worktree-root PATH  Reclaim a specific linked task worktree
  --provider VALUE      Provider name or path. Builtins: none, tmux-agent
  --provider-mode MODE  off, auto, or required
  --force               Reclaim even when the task worktree has local changes
  --allow-long-lived    Allow reclaiming dev-* long-lived worktrees
  --keep-branch         Keep the task branch even if it is already merged
EOF
}

wt_core_reset_provider_result() {
  WT_PROVIDER_RESULT_SESSION_NAME=""
  WT_PROVIDER_RESULT_WINDOW_ID=""
  WT_PROVIDER_RESULT_ATTACHED=""
  WT_PROVIDER_RESULT_VARIANT=""
  WT_PROVIDER_RESULT_WINDOWS_CLOSED=""
}

wt_core_parse_provider_result() {
  local result_file="${1:?missing result file}"
  local key=""
  local value=""

  wt_core_reset_provider_result

  while IFS=$'\t' read -r key value; do
    case "$key" in
      session_name)
        WT_PROVIDER_RESULT_SESSION_NAME="$value"
        ;;
      window_id)
        WT_PROVIDER_RESULT_WINDOW_ID="$value"
        ;;
      attached)
        WT_PROVIDER_RESULT_ATTACHED="$value"
        ;;
      variant)
        WT_PROVIDER_RESULT_VARIANT="$value"
        ;;
      windows_closed)
        WT_PROVIDER_RESULT_WINDOWS_CLOSED="$value"
        ;;
    esac
  done < <(wt_parse_kv_file "$result_file")
}

wt_core_resolve_repo_context() {
  WT_RESOLVED_CWD="$(wt_abs_path "${1:-$PWD}")"

  if ! wt_git_in_repo "$WT_RESOLVED_CWD"; then
    wt_die "target path is not in a git repository: $WT_RESOLVED_CWD"
  fi

  WT_REPO_ROOT="$(wt_git_repo_root "$WT_RESOLVED_CWD")"
  WT_REPO_COMMON_DIR="$(wt_git_common_dir "$WT_RESOLVED_CWD")"
  WT_MAIN_WORKTREE_ROOT="$(wt_git_main_root "$WT_REPO_COMMON_DIR" || true)"
  if [[ -z "$WT_MAIN_WORKTREE_ROOT" || ! -d "$WT_MAIN_WORKTREE_ROOT" ]]; then
    WT_MAIN_WORKTREE_ROOT="$WT_REPO_ROOT"
  fi
  WT_REPO_LABEL="$(wt_git_repo_label "$WT_MAIN_WORKTREE_ROOT")"
}

wt_core_apply_launch_overrides() {
  local provider_override="${1:-}"
  local provider_mode_override="${2:-}"
  local workspace_override="${3:-}"
  local session_name_override="${4:-}"
  local variant_override="${5:-}"
  local attach_override="${6:-}"

  [[ -n "$provider_override" ]] && WT_PROVIDER="$provider_override"
  [[ -n "$provider_mode_override" ]] && WT_PROVIDER_MODE="$provider_mode_override"
  [[ -n "$workspace_override" ]] && WT_PROVIDER_WORKSPACE="$workspace_override"
  [[ -n "$session_name_override" ]] && WT_PROVIDER_SESSION_NAME_OVERRIDE="$session_name_override"
  [[ -n "$variant_override" ]] && WT_PROVIDER_DEFAULT_VARIANT="$variant_override"
  [[ -n "$attach_override" ]] && WT_PROVIDER_ATTACH_DEFAULT="$attach_override"
  return 0
}

wt_core_apply_reclaim_overrides() {
  local provider_override="${1:-}"
  local provider_mode_override="${2:-}"

  [[ -n "$provider_override" ]] && WT_PROVIDER="$provider_override"
  [[ -n "$provider_mode_override" ]] && WT_PROVIDER_MODE="$provider_mode_override"
  return 0
}

wt_core_resolve_policy_paths() {
  WT_POLICY_WORKTREE_DIR_ABS="$(wt_config_resolve_under_repo_parent "$(wt_config_expand_repo_tokens "$WT_POLICY_WORKTREE_DIR")")"
  WT_POLICY_METADATA_DIR_ABS="$(wt_config_resolve_under_repo_parent "$(wt_config_expand_repo_tokens "$WT_POLICY_METADATA_DIR")")"

  WT_PROVIDER_TMUX_CONFIG_FILE_ABS=""
  if [[ -n "$WT_PROVIDER_TMUX_CONFIG_FILE" ]]; then
    WT_PROVIDER_TMUX_CONFIG_FILE_ABS="$(wt_config_resolve_under_wezterm_repo "$WT_PROVIDER_TMUX_CONFIG_FILE")"
  fi
}

wt_core_provider_command() {
  wt_provider_resolve_command "$WT_SCRIPTS_DIR" "${1:?missing provider name}"
}

wt_core_export_provider_env() {
  export WT_REPO_ROOT
  export WT_REPO_COMMON_DIR
  export WT_MAIN_WORKTREE_ROOT
  export WT_REPO_LABEL
  export WEZDECK_REPO_ROOT
  export WEZDECK_REPO
  export WT_WORKTREE_PATH
  export WT_BRANCH_NAME
  export WT_TASK_SLUG
  export WT_RUNTIME_WORKSPACE
  export WT_RUNTIME_VARIANT
  export WT_RUNTIME_ATTACH
  export WT_PROVIDER_TMUX_CONFIG_FILE_ABS
  export WT_PROVIDER_AGENT_COMMAND
  export WT_PROVIDER_AGENT_COMMAND_LIGHT
  export WT_PROVIDER_AGENT_COMMAND_DARK
  export WT_PROVIDER_LOGIN_SHELL
  export WT_PROVIDER_SESSION_NAME_OVERRIDE
  export WT_PROVIDER_SESSION_NAME
  export WT_PROVIDER_WINDOW_ID
}

wt_core_run_provider() {
  local provider_name="${1:?missing provider name}"
  local verb="${2:?missing provider verb}"
  local result_file=""
  local provider_cmd=""
  local status=0

  provider_cmd="$(wt_core_provider_command "$provider_name" 2>/dev/null || true)"
  if [[ -z "$provider_cmd" ]]; then
    return 10
  fi

  result_file="$(mktemp "${TMPDIR:-/tmp}/worktree-task-provider.XXXXXX")"
  export WT_RESULT_FILE="$result_file"
  wt_core_export_provider_env
  runtime_log_info task "invoking provider" "provider=$provider_name" "verb=$verb"

  if "$provider_cmd" "$verb"; then
    :
  else
    status=$?
    runtime_log_error task "provider invocation failed" "provider=$provider_name" "verb=$verb" "exit_code=$status"
    rm -f "$result_file"
    return "$status"
  fi

  wt_core_parse_provider_result "$result_file"
  runtime_log_info task "provider invocation completed" \
    "provider=$provider_name" \
    "verb=$verb" \
    "session_name=${WT_PROVIDER_RESULT_SESSION_NAME:-}" \
    "window_id=${WT_PROVIDER_RESULT_WINDOW_ID:-}" \
    "variant=${WT_PROVIDER_RESULT_VARIANT:-}"
  rm -f "$result_file"
  return 0
}

wt_core_prepare_launch_provider() {
  WT_SELECTED_PROVIDER="$WT_PROVIDER"

  case "$WT_PROVIDER_MODE" in
    off)
      WT_SELECTED_PROVIDER="none"
      return 0
      ;;
    auto|required)
      ;;
    *)
      wt_die "invalid provider mode: $WT_PROVIDER_MODE"
      ;;
  esac

  if wt_core_run_provider "$WT_SELECTED_PROVIDER" validate; then
    return 0
  fi

  if [[ "$WT_PROVIDER_MODE" == "auto" && "$WT_SELECTED_PROVIDER" != "none" ]]; then
    WT_SELECTED_PROVIDER="none"
    return 0
  fi

  wt_die "provider validation failed: $WT_SELECTED_PROVIDER"
}

wt_core_run_launch_provider() {
  local status=0

  if wt_core_run_provider "$WT_SELECTED_PROVIDER" launch; then
    return 0
  else
    status=$?
  fi

  if [[ "$WT_PROVIDER_MODE" == "auto" && "$WT_SELECTED_PROVIDER" != "none" ]]; then
    WT_SELECTED_PROVIDER="none"
    wt_core_run_provider "$WT_SELECTED_PROVIDER" launch
    return $?
  fi

  return "$status"
}

wt_core_rollback_launch_failure() {
  local worktree_created="${1:-0}"
  local branch_created="${2:-0}"

  runtime_log_warn task "rolling back failed launch" \
    "worktree_created=$worktree_created" \
    "branch_created=$branch_created" \
    "worktree_path=${WT_WORKTREE_PATH:-}" \
    "branch_name=${WT_BRANCH_NAME:-}" \
    "provider=${WT_SELECTED_PROVIDER:-}"

  rm -f "$WT_MANIFEST_FILE" 2>/dev/null || true

  if [[ "$WT_SELECTED_PROVIDER" != "none" ]]; then
    wt_core_run_provider "$WT_SELECTED_PROVIDER" cleanup >/dev/null 2>&1 || true
  fi

  if [[ "$worktree_created" == "1" && -d "$WT_WORKTREE_PATH" ]]; then
    git -C "$WT_MAIN_WORKTREE_ROOT" worktree remove -f "$WT_WORKTREE_PATH" >/dev/null 2>&1 || true
  fi

  if [[ "$branch_created" == "1" && -n "$WT_BRANCH_NAME" ]]; then
    git -C "$WT_MAIN_WORKTREE_ROOT" branch -D "$WT_BRANCH_NAME" >/dev/null 2>&1 || true
  fi

  rmdir "$WT_POLICY_METADATA_DIR_ABS" 2>/dev/null || true
  rmdir "$WT_POLICY_WORKTREE_DIR_ABS" 2>/dev/null || true
}

wt_core_emit_launch_result() {
  printf 'branch_name=%s\n' "$WT_BRANCH_NAME"
  printf 'worktree_path=%s\n' "$WT_WORKTREE_PATH"
  printf 'manifest_file=%s\n' "$WT_MANIFEST_FILE"
  printf 'provider=%s\n' "$WT_SELECTED_PROVIDER"
  if [[ -n "$WT_PROVIDER_RESULT_SESSION_NAME" ]]; then
    printf 'session_name=%s\n' "$WT_PROVIDER_RESULT_SESSION_NAME"
  fi
  if [[ -n "$WT_PROVIDER_RESULT_WINDOW_ID" ]]; then
    printf 'window_id=%s\n' "$WT_PROVIDER_RESULT_WINDOW_ID"
  fi
}

wt_core_emit_reclaim_result() {
  printf 'worktree_path=%s\n' "$WT_WORKTREE_PATH"
  printf 'branch_name=%s\n' "$WT_BRANCH_NAME"
  printf 'manifest_file=%s\n' "$WT_MANIFEST_FILE"
  printf 'provider=%s\n' "$WT_SELECTED_PROVIDER"
  printf 'provider_cleanup_status=%s\n' "$WT_PROVIDER_CLEANUP_STATUS"
  printf 'tmux_windows_closed=%s\n' "${WT_PROVIDER_RESULT_WINDOWS_CLOSED:-0}"
  printf 'branch_deleted=%s\n' "$WT_BRANCH_DELETED"
  printf 'branch_delete_reason=%s\n' "$WT_BRANCH_DELETE_REASON"
}

