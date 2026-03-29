#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEZTERM_CONFIG_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"
RUNTIME_SCRIPT_DIR="$WEZTERM_CONFIG_REPO/scripts/runtime"
# shellcheck disable=SC1091
source "$RUNTIME_SCRIPT_DIR/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$RUNTIME_SCRIPT_DIR/tmux-worktree-lib.sh"

usage() {
  cat <<'EOF' >&2
usage:
  reclaim-worktree-task.sh [options]

options:
  --cwd PATH           Repository or task worktree path. Default: current directory
  --task-slug VALUE    Reclaim .worktrees/<slug> from the resolved repo family
  --worktree-root PATH Reclaim a specific linked task worktree
  --force              Reclaim even when the task worktree has local changes
  --keep-branch        Keep the task branch even if it is already merged
  --keep-prompt        Keep the archived task prompt file
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

cwd="$PWD"
task_slug=""
worktree_root=""
force_mode="0"
keep_branch="0"
keep_prompt="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      cwd="$2"
      shift 2
      ;;
    --task-slug)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      task_slug="$2"
      shift 2
      ;;
    --worktree-root)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      worktree_root="$2"
      shift 2
      ;;
    --force)
      force_mode="1"
      shift
      ;;
    --keep-branch)
      keep_branch="1"
      shift
      ;;
    --keep-prompt)
      keep_prompt="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

if [[ -n "$task_slug" && -n "$worktree_root" ]]; then
  die "use either --task-slug or --worktree-root, not both"
fi

resolved_cwd="$(tmux_worktree_abs_path "$cwd")"
if ! tmux_worktree_in_git_repo "$resolved_cwd"; then
  die "target path is not in a git repository: $resolved_cwd"
fi

repo_root="$(tmux_worktree_repo_root "$resolved_cwd")"
repo_common_dir="$(tmux_worktree_common_dir "$resolved_cwd")"
main_worktree_root="$(tmux_worktree_main_root "$repo_common_dir" || true)"
if [[ -z "$main_worktree_root" || ! -d "$main_worktree_root" ]]; then
  main_worktree_root="$repo_root"
fi

worktrees_dir="$main_worktree_root/.worktrees"
prompt_dir="$worktrees_dir/.codex-prompts"

if [[ -n "$worktree_root" ]]; then
  target_worktree_root="$(tmux_worktree_abs_path "$worktree_root")"
elif [[ -n "$task_slug" ]]; then
  target_worktree_root="$worktrees_dir/$task_slug"
else
  target_worktree_root="$repo_root"
fi

if [[ "$target_worktree_root" == "$main_worktree_root" ]]; then
  die "refusing to reclaim the primary worktree; use --task-slug or --worktree-root for a linked task worktree"
fi

case "$target_worktree_root" in
  "$worktrees_dir"/*)
    ;;
  *)
    die "target worktree is not under the skill-managed task directory: $target_worktree_root"
    ;;
esac

if [[ ! -d "$target_worktree_root" ]]; then
  die "task worktree does not exist: $target_worktree_root"
fi

if ! tmux_worktree_in_git_repo "$target_worktree_root"; then
  die "task worktree is not a git worktree: $target_worktree_root"
fi

target_common_dir="$(tmux_worktree_common_dir "$target_worktree_root" || true)"
if [[ "$target_common_dir" != "$repo_common_dir" ]]; then
  die "task worktree belongs to another repo family: $target_worktree_root"
fi

task_slug="$(basename "$target_worktree_root")"
prompt_file="$prompt_dir/$task_slug.md"
branch_name="$(git -C "$target_worktree_root" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
dirty_status="$(git -C "$target_worktree_root" status --porcelain --untracked-files=all)"

if [[ "$force_mode" != "1" && -n "$dirty_status" ]]; then
  die "task worktree has uncommitted changes; rerun with --force to discard them"
fi

closed_tmux_windows=0
if command -v tmux >/dev/null 2>&1; then
  while IFS= read -r session_name; do
    [[ -n "$session_name" ]] || continue
    session_common_dir="$(tmux_worktree_session_option "$session_name" @wezterm_repo_common_dir)"
    if [[ "$session_common_dir" != "$repo_common_dir" ]]; then
      continue
    fi

    while IFS=$'\t' read -r window_id window_root; do
      [[ -n "$window_id" ]] || continue
      if [[ "$window_root" == "$target_worktree_root" ]]; then
        runtime_log_info worktree "closing task worktree window" "session_name=$session_name" "window_id=$window_id" "worktree_root=$target_worktree_root"
        tmux kill-window -t "${session_name}:${window_id}" 2>/dev/null || true
        closed_tmux_windows=$((closed_tmux_windows + 1))
      fi
    done < <(tmux list-windows -t "$session_name" -F '#{window_id}	#{@wezterm_worktree_root}' 2>/dev/null || true)
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
fi

remove_args=(git -C "$main_worktree_root" worktree remove)
if [[ "$force_mode" == "1" ]]; then
  remove_args+=(-f)
fi
remove_args+=("$target_worktree_root")

runtime_log_info worktree "removing task worktree" "worktree_root=$target_worktree_root" "branch=${branch_name:-detached}" "force=$force_mode"
"${remove_args[@]}"

prompt_deleted="no"
if [[ "$keep_prompt" != "1" && -f "$prompt_file" ]]; then
  rm -f "$prompt_file"
  prompt_deleted="yes"
fi

rmdir "$prompt_dir" 2>/dev/null || true
rmdir "$worktrees_dir" 2>/dev/null || true

branch_deleted="no"
branch_delete_reason="kept"
if [[ "$keep_branch" == "1" ]]; then
  branch_delete_reason="kept-by-option"
elif [[ -z "$branch_name" ]]; then
  branch_delete_reason="detached-head"
elif git -C "$main_worktree_root" merge-base --is-ancestor "$branch_name" HEAD 2>/dev/null; then
  if git -C "$main_worktree_root" branch -d "$branch_name" >/dev/null 2>&1; then
    branch_deleted="yes"
    branch_delete_reason="merged"
  else
    branch_delete_reason="delete-failed"
  fi
else
  branch_delete_reason="not-merged"
fi

printf 'worktree_path=%s\n' "$target_worktree_root"
printf 'branch_name=%s\n' "$branch_name"
printf 'prompt_file=%s\n' "$prompt_file"
printf 'tmux_windows_closed=%s\n' "$closed_tmux_windows"
printf 'prompt_deleted=%s\n' "$prompt_deleted"
printf 'branch_deleted=%s\n' "$branch_deleted"
printf 'branch_delete_reason=%s\n' "$branch_delete_reason"
