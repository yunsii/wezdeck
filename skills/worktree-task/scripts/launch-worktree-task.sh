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
  launch-worktree-task.sh --title TITLE [options]

options:
  --cwd PATH         Target repository path. Default: current directory
  --task-slug VALUE  Slug prefix for the worktree directory and prompt file
  --branch VALUE     Explicit branch name. Default: codex/<resolved-slug>
  --base-ref VALUE   Base ref for the new branch. Default: primary worktree HEAD
  --prompt-file FILE Read the cleaned-up task prompt from FILE instead of stdin
  --workspace NAME   Session namespace when a new tmux session must be created. Default: task
  --session-name NAME Reuse or create a specific tmux session
  --variant MODE     Managed Codex variant: auto, light, or dark. Default: auto
  --no-attach        Create/select the tmux window without switching the client or attaching
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

slugify_name() {
  local raw_value="$1"
  local fallback="$2"
  local slug=""

  slug="$(printf '%s' "$raw_value" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
  slug="${slug#-}"
  slug="${slug%-}"

  if [[ -z "$slug" ]]; then
    slug="$fallback"
  fi

  printf '%s\n' "$slug"
}

branch_exists() {
  local repo_root="$1"
  local branch_name="$2"

  git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch_name"
}

task_title=""
cwd="$PWD"
task_slug=""
branch_name=""
base_ref=""
prompt_file=""
workspace="task"
session_name=""
variant="auto"
attach_mode="1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      task_title="$2"
      shift 2
      ;;
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
    --branch)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      branch_name="$2"
      shift 2
      ;;
    --base-ref)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      base_ref="$2"
      shift 2
      ;;
    --prompt-file)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      prompt_file="$2"
      shift 2
      ;;
    --workspace)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      workspace="$2"
      shift 2
      ;;
    --session-name)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      session_name="$2"
      shift 2
      ;;
    --variant)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      variant="$2"
      shift 2
      ;;
    --no-attach)
      attach_mode="0"
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

[[ -n "$task_title" ]] || { usage; exit 1; }

case "$variant" in
  auto|light|dark)
    ;;
  *)
    die "invalid variant: $variant"
    ;;
esac

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

if [[ -z "$base_ref" ]]; then
  base_ref="$(git -C "$main_worktree_root" rev-parse --verify HEAD)"
fi

base_slug="$(slugify_name "${task_slug:-$task_title}" "task")"
worktrees_dir="$main_worktree_root/.worktrees"
prompt_dir="$worktrees_dir/.codex-prompts"
mkdir -p "$worktrees_dir" "$prompt_dir"

resolved_slug="$base_slug"
if [[ -z "$branch_name" ]]; then
  suffix=1
  while [[ -e "$worktrees_dir/$resolved_slug" ]] || branch_exists "$main_worktree_root" "codex/$resolved_slug"; do
    suffix=$((suffix + 1))
    resolved_slug="${base_slug}-${suffix}"
  done
fi

if [[ -z "$branch_name" ]]; then
  resolved_branch_name="codex/$resolved_slug"
else
  resolved_branch_name="$branch_name"
  path_suffix=1
  while [[ -e "$worktrees_dir/$resolved_slug" ]]; do
    path_suffix=$((path_suffix + 1))
    resolved_slug="${base_slug}-${path_suffix}"
  done
fi

worktree_path="$worktrees_dir/$resolved_slug"
prompt_path="$prompt_dir/$resolved_slug.md"

if [[ -n "$prompt_file" ]]; then
  [[ -f "$prompt_file" ]] || die "prompt file does not exist: $prompt_file"
  prompt_content="$(< "$prompt_file")"
else
  [[ ! -t 0 ]] || die "pipe the cleaned-up task prompt on stdin or use --prompt-file"
  prompt_content="$(cat)"
fi

if [[ -z "${prompt_content//[[:space:]]/}" ]]; then
  die "task prompt is empty"
fi

if [[ -d "$worktree_path" ]]; then
  if ! tmux_worktree_in_git_repo "$worktree_path"; then
    die "worktree path already exists and is not a git worktree: $worktree_path"
  fi

  existing_common_dir="$(tmux_worktree_common_dir "$worktree_path" || true)"
  if [[ "$existing_common_dir" != "$repo_common_dir" ]]; then
    die "worktree path already belongs to another repo family: $worktree_path"
  fi
else
  runtime_log_info worktree "creating linked task worktree" "repo_root=$main_worktree_root" "branch=$resolved_branch_name" "worktree_path=$worktree_path" "base_ref=$base_ref"
  if branch_exists "$main_worktree_root" "$resolved_branch_name"; then
    git -C "$main_worktree_root" worktree add "$worktree_path" "$resolved_branch_name"
  else
    git -C "$main_worktree_root" worktree add -b "$resolved_branch_name" "$worktree_path" "$base_ref"
  fi
fi

printf '%s\n' "$prompt_content" > "$prompt_path"

printf 'branch_name=%s\n' "$resolved_branch_name"
printf 'worktree_path=%s\n' "$worktree_path"
printf 'prompt_file=%s\n' "$prompt_path"

launch_args=(
  --workspace "$workspace"
  --cwd "$resolved_cwd"
  --worktree-root "$worktree_path"
  --prompt-file "$prompt_path"
  --variant "$variant"
)

if [[ -n "$session_name" ]]; then
  launch_args+=(--session-name "$session_name")
fi

if [[ "$attach_mode" != "1" ]]; then
  launch_args+=(--no-attach)
fi

runtime_log_info worktree "launching linked task worktree" "repo_root=$main_worktree_root" "branch=$resolved_branch_name" "worktree_path=$worktree_path" "workspace=$workspace" "variant=$variant"

bash "$RUNTIME_SCRIPT_DIR/tmux-worktree-task-window.sh" "${launch_args[@]}"
