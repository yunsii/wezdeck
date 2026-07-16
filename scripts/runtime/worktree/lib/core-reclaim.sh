#!/usr/bin/env bash
# core-reclaim.sh — worktree-task reclaim.
# shellcheck shell=bash

wt_core_reclaim() {
  local cwd="$PWD"
  local task_slug=""
  local worktree_root=""
  local provider_override=""
  local provider_mode_override=""
  local force_mode="0"
  local allow_long_lived="0"
  local keep_branch="0"
  local context_path=""
  local manifest_provider=""
  local manifest_session_name=""
  local manifest_window_id=""
  local start_ms

  start_ms="$(runtime_log_now_ms)"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd)
        [[ $# -ge 2 ]] || { wt_core_reclaim_usage; exit 1; }
        cwd="$2"
        shift 2
        ;;
      --task-slug)
        [[ $# -ge 2 ]] || { wt_core_reclaim_usage; exit 1; }
        task_slug="$2"
        shift 2
        ;;
      --worktree-root)
        [[ $# -ge 2 ]] || { wt_core_reclaim_usage; exit 1; }
        worktree_root="$2"
        shift 2
        ;;
      --provider)
        [[ $# -ge 2 ]] || { wt_core_reclaim_usage; exit 1; }
        provider_override="$2"
        shift 2
        ;;
      --provider-mode)
        [[ $# -ge 2 ]] || { wt_core_reclaim_usage; exit 1; }
        provider_mode_override="$2"
        shift 2
        ;;
      --force)
        force_mode="1"
        shift
        ;;
      --allow-long-lived)
        allow_long_lived="1"
        shift
        ;;
      --keep-branch)
        keep_branch="1"
        shift
        ;;
      -h|--help)
        wt_core_reclaim_usage
        exit 0
        ;;
      *)
        wt_core_reclaim_usage
        exit 1
        ;;
    esac
  done

  if [[ -n "$task_slug" && -n "$worktree_root" ]]; then
    wt_die "use either --task-slug or --worktree-root, not both"
  fi

  if [[ -n "$worktree_root" ]]; then
    [[ -d "$worktree_root" ]] || wt_die "task worktree does not exist: $worktree_root"
    context_path="$worktree_root"
  else
    context_path="$cwd"
  fi
  wt_core_resolve_repo_context "$context_path"
  wt_config_load
  wt_core_apply_reclaim_overrides "$provider_override" "$provider_mode_override"
  wt_core_resolve_policy_paths
  runtime_log_info task "reclaim requested" \
    "cwd=$WT_RESOLVED_CWD" \
    "repo_root=$WT_REPO_ROOT" \
    "provider_mode=$WT_PROVIDER_MODE" \
    "provider=${provider_override:-$WT_PROVIDER}" \
    "force=$force_mode" \
    "allow_long_lived=$allow_long_lived" \
    "keep_branch=$keep_branch"

  if [[ -n "$worktree_root" ]]; then
    WT_WORKTREE_PATH="$(wt_abs_path "$worktree_root")"
  elif [[ -n "$task_slug" ]]; then
    WT_WORKTREE_PATH="$WT_POLICY_WORKTREE_DIR_ABS/$task_slug"
  else
    WT_WORKTREE_PATH="$WT_REPO_ROOT"
  fi

  if [[ "$WT_WORKTREE_PATH" == "$WT_MAIN_WORKTREE_ROOT" ]]; then
    wt_die "refusing to reclaim the primary worktree; use --task-slug or --worktree-root for a linked task worktree"
  fi

  case "$WT_WORKTREE_PATH" in
    "$WT_POLICY_WORKTREE_DIR_ABS"/*)
      ;;
    *)
      wt_die "target worktree is not under the managed task directory: $WT_WORKTREE_PATH"
      ;;
  esac

  [[ -d "$WT_WORKTREE_PATH" ]] || wt_die "task worktree does not exist: $WT_WORKTREE_PATH"
  wt_git_in_repo "$WT_WORKTREE_PATH" || wt_die "task worktree is not a git worktree: $WT_WORKTREE_PATH"

  if [[ "$(wt_git_common_dir "$WT_WORKTREE_PATH" || true)" != "$WT_REPO_COMMON_DIR" ]]; then
    wt_die "task worktree belongs to another repo family: $WT_WORKTREE_PATH"
  fi

  WT_TASK_SLUG="$(basename "$WT_WORKTREE_PATH")"

  # Refuse to reclaim long-lived workstation worktrees by lifecycle prefix.
  # `dev-*` is reserved for multi-week parallel development; reclaiming
  # them by accident would lose accumulated agent context and dev-server
  # state. Use `git worktree remove` directly if you really mean it.
  case "$WT_TASK_SLUG" in
    dev-*)
      if [[ "$allow_long_lived" != "1" ]]; then
        wt_die "refusing to reclaim long-lived worktree: $WT_TASK_SLUG (rerun with --allow-long-lived if intentional)"
      fi
      ;;
  esac

  WT_MANIFEST_FILE="$(wt_manifest_path "$WT_POLICY_METADATA_DIR_ABS" "$WT_TASK_SLUG")"
  WT_BRANCH_NAME="$(git -C "$WT_WORKTREE_PATH" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"

  if [[ -f "$WT_MANIFEST_FILE" ]]; then
    manifest_provider="$(wt_manifest_read_field "$WT_MANIFEST_FILE" provider || true)"
    manifest_session_name="$(wt_manifest_read_field "$WT_MANIFEST_FILE" provider_session_name || true)"
    manifest_window_id="$(wt_manifest_read_field "$WT_MANIFEST_FILE" provider_window_id || true)"
  fi

  if [[ "$force_mode" != "1" ]]; then
    if [[ -n "$(git -C "$WT_WORKTREE_PATH" status --porcelain --untracked-files=all)" ]]; then
      wt_die "task worktree has uncommitted changes; rerun with --force to discard them"
    fi
  fi

  WT_SELECTED_PROVIDER="${provider_override:-${manifest_provider:-$WT_PROVIDER}}"
  WT_PROVIDER_CLEANUP_STATUS="skipped"
  WT_PROVIDER_SESSION_NAME="$manifest_session_name"
  WT_PROVIDER_WINDOW_ID="$manifest_window_id"
  WT_RUNTIME_ATTACH="0"
  WT_RUNTIME_VARIANT="$WT_PROVIDER_DEFAULT_VARIANT"
  WT_RUNTIME_WORKSPACE="$WT_PROVIDER_WORKSPACE"

  if [[ -z "$WT_SELECTED_PROVIDER" ]]; then
    WT_SELECTED_PROVIDER="none"
  fi

  case "$WT_PROVIDER_MODE" in
    off)
      WT_SELECTED_PROVIDER="none"
      ;;
    auto|required)
      ;;
    *)
      wt_die "invalid provider mode: $WT_PROVIDER_MODE"
      ;;
  esac

  if [[ "$WT_SELECTED_PROVIDER" != "none" ]]; then
    if wt_core_run_provider "$WT_SELECTED_PROVIDER" cleanup; then
      WT_PROVIDER_CLEANUP_STATUS="ok"
    else
      case "$?" in
        10)
          WT_PROVIDER_CLEANUP_STATUS="unavailable"
          ;;
        *)
          WT_PROVIDER_CLEANUP_STATUS="failed"
          ;;
      esac
    fi
  fi

  if [[ "$force_mode" == "1" ]]; then
    git -C "$WT_MAIN_WORKTREE_ROOT" worktree remove -f "$WT_WORKTREE_PATH"
  else
    git -C "$WT_MAIN_WORKTREE_ROOT" worktree remove "$WT_WORKTREE_PATH"
  fi
  runtime_log_info task "removed linked worktree" "worktree_path=$WT_WORKTREE_PATH" "provider_cleanup_status=$WT_PROVIDER_CLEANUP_STATUS"

  # Defense-in-depth: drop any phantom admin entry git may still hold
  # (e.g., when an earlier `rm -rf` raced ahead of `worktree remove`).
  git -C "$WT_MAIN_WORKTREE_ROOT" worktree prune 2>/dev/null || true

  if [[ -f "$WT_MANIFEST_FILE" ]]; then
    rm -f "$WT_MANIFEST_FILE"
  fi

  rmdir "$WT_POLICY_METADATA_DIR_ABS" 2>/dev/null || true
  rmdir "$WT_POLICY_WORKTREE_DIR_ABS" 2>/dev/null || true

  WT_BRANCH_DELETED="no"
  WT_BRANCH_DELETE_REASON="kept"
  if [[ "$keep_branch" == "1" ]]; then
    WT_BRANCH_DELETE_REASON="kept-by-option"
  elif [[ -z "$WT_BRANCH_NAME" ]]; then
    WT_BRANCH_DELETE_REASON="detached-head"
  elif git -C "$WT_MAIN_WORKTREE_ROOT" merge-base --is-ancestor "$WT_BRANCH_NAME" HEAD 2>/dev/null; then
    if git -C "$WT_MAIN_WORKTREE_ROOT" branch -d "$WT_BRANCH_NAME" >/dev/null 2>&1; then
      WT_BRANCH_DELETED="yes"
      WT_BRANCH_DELETE_REASON="merged"
    else
      WT_BRANCH_DELETE_REASON="delete-failed"
    fi
  else
    WT_BRANCH_DELETE_REASON="not-merged"
  fi

  runtime_log_info task "reclaim completed" \
    "worktree_path=$WT_WORKTREE_PATH" \
    "branch_name=$WT_BRANCH_NAME" \
    "provider=$WT_SELECTED_PROVIDER" \
    "provider_cleanup_status=$WT_PROVIDER_CLEANUP_STATUS" \
    "branch_deleted=$WT_BRANCH_DELETED" \
    "branch_delete_reason=$WT_BRANCH_DELETE_REASON" \
    "duration_ms=$(runtime_log_duration_ms "$start_ms")"

  wt_core_emit_reclaim_result
}
