#!/usr/bin/env bash
# core-launch.sh — worktree-task launch.
# shellcheck shell=bash

wt_core_launch() {
  local cwd="$PWD"
  local task_title=""
  local task_slug=""
  local branch_name=""
  local base_ref=""
  local provider_override=""
  local provider_mode_override=""
  local workspace_override=""
  local session_name_override=""
  local variant_override=""
  local attach_override=""
  local base_slug=""
  local resolved_slug=""
  local suffix=1
  local path_suffix=1
  local worktree_created=0
  local branch_created=0
  local start_ms

  start_ms="$(runtime_log_now_ms)"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd)
        [[ $# -ge 2 ]] || { wt_core_launch_usage; exit 1; }
        cwd="$2"
        shift 2
        ;;
      --title)
        [[ $# -ge 2 ]] || { wt_core_launch_usage; exit 1; }
        task_title="$2"
        shift 2
        ;;
      --task-slug)
        [[ $# -ge 2 ]] || { wt_core_launch_usage; exit 1; }
        task_slug="$2"
        shift 2
        ;;
      --branch)
        [[ $# -ge 2 ]] || { wt_core_launch_usage; exit 1; }
        branch_name="$2"
        shift 2
        ;;
      --base-ref)
        [[ $# -ge 2 ]] || { wt_core_launch_usage; exit 1; }
        base_ref="$2"
        shift 2
        ;;
      --provider)
        [[ $# -ge 2 ]] || { wt_core_launch_usage; exit 1; }
        provider_override="$2"
        shift 2
        ;;
      --provider-mode)
        [[ $# -ge 2 ]] || { wt_core_launch_usage; exit 1; }
        provider_mode_override="$2"
        shift 2
        ;;
      --workspace)
        [[ $# -ge 2 ]] || { wt_core_launch_usage; exit 1; }
        workspace_override="$2"
        shift 2
        ;;
      --session-name)
        [[ $# -ge 2 ]] || { wt_core_launch_usage; exit 1; }
        session_name_override="$2"
        shift 2
        ;;
      --variant)
        [[ $# -ge 2 ]] || { wt_core_launch_usage; exit 1; }
        variant_override="$2"
        shift 2
        ;;
      --no-attach)
        attach_override="0"
        shift
        ;;
      -h|--help)
        wt_core_launch_usage
        exit 0
        ;;
      *)
        wt_core_launch_usage
        exit 1
        ;;
    esac
  done

  [[ -n "$task_title" ]] || { wt_core_launch_usage; exit 1; }

  wt_core_resolve_repo_context "$cwd"
  wt_config_load
  wt_core_apply_launch_overrides "$provider_override" "$provider_mode_override" "$workspace_override" "$session_name_override" "$variant_override" "$attach_override"
  wt_core_resolve_policy_paths
  runtime_log_info task "launch requested" \
    "cwd=$WT_RESOLVED_CWD" \
    "repo_root=$WT_REPO_ROOT" \
    "repo_common_dir=$WT_REPO_COMMON_DIR" \
    "task_title=$task_title" \
    "provider_mode=$WT_PROVIDER_MODE" \
    "provider=$WT_PROVIDER"

  if [[ -z "$base_ref" ]]; then
    case "$WT_POLICY_BASE_REF_STRATEGY" in
      primary-head)
        base_ref="$(git -C "$WT_MAIN_WORKTREE_ROOT" rev-parse --verify HEAD)"
        ;;
      origin-default-branch)
        # Always branch off the upstream default branch's tip — insulates
        # new worktrees from the primary worktree's current checkout AND
        # from local divergence with origin.
        wt_tmux_progress "[worktree-task] fetching origin…"
        if ! git -C "$WT_MAIN_WORKTREE_ROOT" fetch origin --quiet 2>/dev/null; then
          wt_die "fetch origin failed (network down or 'origin' remote missing)"
        fi
        base_ref="$(git -C "$WT_MAIN_WORKTREE_ROOT" rev-parse --verify origin/HEAD 2>/dev/null)" \
          || wt_die "origin/HEAD is not set; run 'git -C $WT_MAIN_WORKTREE_ROOT remote set-head origin -a' once, then retry"
        ;;
      *)
        wt_die "unsupported base ref strategy: $WT_POLICY_BASE_REF_STRATEGY"
        ;;
    esac
  fi

  base_slug="$(wt_slugify "${task_slug:-$task_title}" "$WT_POLICY_SLUG_FALLBACK")"
  resolved_slug="$base_slug"

  if [[ -z "$branch_name" ]]; then
    while [[ -e "$WT_POLICY_WORKTREE_DIR_ABS/$resolved_slug" ]] || wt_git_branch_exists "$WT_MAIN_WORKTREE_ROOT" "${WT_POLICY_BRANCH_PREFIX}${resolved_slug}"; do
      suffix=$((suffix + 1))
      resolved_slug="${base_slug}-${suffix}"
    done
    WT_BRANCH_NAME="${WT_POLICY_BRANCH_PREFIX}${resolved_slug}"
  else
    while [[ -e "$WT_POLICY_WORKTREE_DIR_ABS/$resolved_slug" ]]; do
      path_suffix=$((path_suffix + 1))
      resolved_slug="${base_slug}-${path_suffix}"
    done
    WT_BRANCH_NAME="$branch_name"
  fi

  WT_TASK_SLUG="$resolved_slug"
  WT_WORKTREE_PATH="$WT_POLICY_WORKTREE_DIR_ABS/$WT_TASK_SLUG"
  WT_MANIFEST_FILE="$(wt_manifest_path "$WT_POLICY_METADATA_DIR_ABS" "$WT_TASK_SLUG")"

  WT_RUNTIME_WORKSPACE="$WT_PROVIDER_WORKSPACE"
  WT_RUNTIME_VARIANT="$WT_PROVIDER_DEFAULT_VARIANT"
  WT_RUNTIME_ATTACH="$WT_PROVIDER_ATTACH_DEFAULT"
  WT_PROVIDER_SESSION_NAME=""
  WT_PROVIDER_WINDOW_ID=""

  wt_core_prepare_launch_provider

  mkdir -p "$WT_POLICY_WORKTREE_DIR_ABS" "$WT_POLICY_METADATA_DIR_ABS"

  if [[ -d "$WT_WORKTREE_PATH" ]]; then
    if ! wt_git_in_repo "$WT_WORKTREE_PATH"; then
      wt_die "worktree path already exists and is not a git worktree: $WT_WORKTREE_PATH"
    fi

    if [[ "$(wt_git_common_dir "$WT_WORKTREE_PATH" || true)" != "$WT_REPO_COMMON_DIR" ]]; then
      wt_die "worktree path already belongs to another repo family: $WT_WORKTREE_PATH"
    fi
    runtime_log_info task "reusing existing worktree path" "worktree_path=$WT_WORKTREE_PATH" "branch_name=$WT_BRANCH_NAME"
  else
    worktree_created=1
    wt_tmux_progress "[worktree-task] creating worktree $WT_TASK_SLUG…"
    if wt_git_branch_exists "$WT_MAIN_WORKTREE_ROOT" "$WT_BRANCH_NAME"; then
      git -C "$WT_MAIN_WORKTREE_ROOT" worktree add "$WT_WORKTREE_PATH" "$WT_BRANCH_NAME"
    else
      branch_created=1
      git -C "$WT_MAIN_WORKTREE_ROOT" worktree add -b "$WT_BRANCH_NAME" --no-track "$WT_WORKTREE_PATH" "$base_ref"
    fi
    runtime_log_info task "prepared linked worktree" \
      "worktree_path=$WT_WORKTREE_PATH" \
      "branch_name=$WT_BRANCH_NAME" \
      "base_ref=$base_ref" \
      "worktree_created=$worktree_created" \
      "branch_created=$branch_created"
  fi

  wt_tmux_progress "[worktree-task] $WT_TASK_SLUG ready, starting agent…"
  if wt_core_run_launch_provider; then
    :
  else
    wt_tmux_progress ''
    wt_core_rollback_launch_failure "$worktree_created" "$branch_created"
    wt_die "provider launch failed: $WT_SELECTED_PROVIDER"
  fi

  if [[ -n "$WT_PROVIDER_RESULT_SESSION_NAME" ]]; then
    WT_PROVIDER_SESSION_NAME="$WT_PROVIDER_RESULT_SESSION_NAME"
  fi
  if [[ -n "$WT_PROVIDER_RESULT_WINDOW_ID" ]]; then
    WT_PROVIDER_WINDOW_ID="$WT_PROVIDER_RESULT_WINDOW_ID"
  fi

  wt_manifest_write \
    "$WT_MANIFEST_FILE" \
    "$WT_TASK_SLUG" \
    "$WT_REPO_COMMON_DIR" \
    "$WT_MAIN_WORKTREE_ROOT" \
    "$WT_WORKTREE_PATH" \
    "$WT_BRANCH_NAME" \
    "$WT_SELECTED_PROVIDER" \
    "$WT_PROVIDER_RESULT_SESSION_NAME" \
    "$WT_PROVIDER_RESULT_WINDOW_ID"

  wt_tmux_progress "[worktree-task] $WT_TASK_SLUG launched"
  wt_tmux_progress_clear_after 1.5

  runtime_log_info task "launch completed" \
    "worktree_path=$WT_WORKTREE_PATH" \
    "branch_name=$WT_BRANCH_NAME" \
    "provider=$WT_SELECTED_PROVIDER" \
    "session_name=${WT_PROVIDER_RESULT_SESSION_NAME:-}" \
    "window_id=${WT_PROVIDER_RESULT_WINDOW_ID:-}" \
    "duration_ms=$(runtime_log_duration_ms "$start_ms")"

  wt_core_emit_launch_result

  if wt_bool_is_true "$WT_RUNTIME_ATTACH"; then
    wt_core_run_provider "$WT_SELECTED_PROVIDER" attach >/dev/null || wt_die "provider attach failed: $WT_SELECTED_PROVIDER"
  fi
}
