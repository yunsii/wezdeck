#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/tmux-status-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/runtime-env-lib.sh"
runtime_env_load_managed
runtime_env_add_user_cli_paths

cwd="${1:-$PWD}"
padding="${TMUX_STATUS_PADDING:- }"
padding="$(tmux_option_or_env TMUX_STATUS_PADDING @tmux_status_padding ' ')"
separator="$(tmux_option_or_env TMUX_STATUS_SEPARATOR @tmux_status_separator ' · ')"
render_repo="$(tmux_option_or_env TMUX_STATUS_RENDER_REPO @tmux_status_render_repo '1')"
render_branch="$(tmux_option_or_env TMUX_STATUS_RENDER_BRANCH @tmux_status_render_branch '1')"
render_git_changes="$(tmux_option_or_env TMUX_STATUS_RENDER_GIT_CHANGES @tmux_status_render_git_changes '1')"
render_node="$(tmux_option_or_env TMUX_STATUS_RENDER_NODE @tmux_status_render_node '1')"
parts=()

normalized_cwd="$cwd"
if [[ ! -d "$normalized_cwd" ]]; then
  normalized_cwd="$PWD"
fi

git_snapshot_loaded=0
git_inside_repo=0
git_repo_label=""
git_branch_label="no-branch"
git_changes_label="no-git"

load_git_snapshot() {
  local repo_root=""
  local status_output=""
  local branch_head=""
  local branch_oid=""
  local upstream_present=0
  local ahead_count="0"
  local behind_count="0"
  local staged=0
  local unstaged=0
  local untracked=0
  local line=""
  local xy=""
  local index_status=""
  local worktree_status=""

  if (( git_snapshot_loaded )); then
    return
  fi
  git_snapshot_loaded=1
  git_repo_label="$(basename "$normalized_cwd")"

  if ! repo_root="$(git -C "$normalized_cwd" rev-parse --show-toplevel 2>/dev/null)"; then
    return
  fi

  git_inside_repo=1
  git_repo_label="$(basename "$repo_root")"

  if ! status_output="$(git -C "$normalized_cwd" status --porcelain=v2 --branch 2>/dev/null)"; then
    return
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      '# branch.head '*)
        branch_head="${line#\# branch.head }"
        ;;
      '# branch.oid '*)
        branch_oid="${line#\# branch.oid }"
        ;;
      '# branch.upstream '*)
        upstream_present=1
        ;;
      '# branch.ab '*)
        if [[ "$line" =~ ^#\ branch\.ab\ \+([0-9]+)\ -([0-9]+)$ ]]; then
          ahead_count="${BASH_REMATCH[1]}"
          behind_count="${BASH_REMATCH[2]}"
        fi
        ;;
      [12u]\ *)
        xy="${line#?? }"
        xy="${xy%% *}"
        index_status="${xy:0:1}"
        worktree_status="${xy:1:1}"

        if [[ "$index_status" != "." && "$index_status" != " " ]]; then
          ((staged += 1))
        fi

        if [[ "$worktree_status" != "." && "$worktree_status" != " " ]]; then
          ((unstaged += 1))
        fi
        ;;
      '? '*)
        ((untracked += 1))
        ;;
    esac
  done <<< "$status_output"

  if [[ -n "$branch_head" && "$branch_head" != "(detached)" ]]; then
    git_branch_label="$branch_head"
  elif [[ -n "$branch_oid" && "$branch_oid" != "(initial)" ]]; then
    git_branch_label="${branch_oid:0:12}"
  fi

  git_changes_label="(+${staged},~${unstaged},?${untracked}"
  if (( upstream_present )); then
    if [[ "$ahead_count" != "0" ]]; then
      git_changes_label+=",^${ahead_count}"
    fi
    if [[ "$behind_count" != "0" ]]; then
      git_changes_label+=",v${behind_count}"
    fi
    if [[ "$ahead_count" == "0" && "$behind_count" == "0" ]]; then
      git_changes_label+=",=0"
    fi
  else
    git_changes_label+=",*0"
  fi
  git_changes_label+=")"
}

node_cache_file() {
  printf '%s\n' "${TMUX_STATUS_NODE_CACHE:-/tmp/.tmux-status-node-cache}"
}

node_cache_lock_dir() {
  printf '%s.lock\n' "$(node_cache_file)"
}

node_cache_ttl() {
  local value=""

  value="$(tmux_option_or_env TMUX_STATUS_NODE_CACHE_TTL @tmux_status_node_cache_ttl '3600')"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    value="3600"
  fi

  printf '%s\n' "$value"
}

read_cached_node_version() {
  local expected_identity="${1:-}"
  local cache_file=""
  local cached_time=""
  local cached_identity=""
  local cached_value=""
  local now=""
  local ttl=""

  cache_file="$(node_cache_file)"
  [[ -f "$cache_file" ]] || return 1

  cached_time="$(head -n 1 "$cache_file" 2>/dev/null || true)"
  cached_identity="$(sed -n '2p' "$cache_file" 2>/dev/null || true)"
  cached_value="$(sed -n '3p' "$cache_file" 2>/dev/null || true)"
  if ! [[ "$cached_time" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  [[ -n "$expected_identity" && "$cached_identity" == "$expected_identity" ]] || return 1

  now="$(date +%s)"
  ttl="$(node_cache_ttl)"
  if (( now - cached_time > ttl )); then
    return 1
  fi

  printf '%s\n' "$cached_value"
}

write_cached_node_version() {
  local identity="$1"
  local value="$2"
  local cache_file=""

  cache_file="$(node_cache_file)"
  printf '%s\n%s\n%s\n' "$(date +%s)" "$identity" "$value" > "$cache_file"
}

node_identity() {
  local node_path=""

  node_path="$(command -v node 2>/dev/null || true)"
  [[ -n "$node_path" ]] || return 1
  readlink -f "$node_path" 2>/dev/null || printf '%s\n' "$node_path"
}

resolve_node_version() {
  local cached_value=""
  local lock_dir=""
  local identity=""
  local version=""

  identity="$(node_identity || true)"
  if cached_value="$(read_cached_node_version "$identity")"; then
    if [[ "$cached_value" == "__missing__" ]]; then
      printf '\n'
    else
      printf '%s\n' "$cached_value"
    fi
    return
  fi

  lock_dir="$(node_cache_lock_dir)"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    if cached_value="$(read_cached_node_version "$identity")"; then
      printf '%s\n' "$cached_value"
    else
      printf '\n'
    fi
    return
  fi

  identity="$(node_identity || true)"
  if [[ -n "$identity" ]]; then
    version="$(node -v 2>/dev/null || true)"
  fi

  if [[ -n "$version" ]]; then
    write_cached_node_version "$identity" "$version"
    rm -rf "$lock_dir"
    printf '%s\n' "$version"
    return
  fi

  rm -f "$(node_cache_file)"
  rm -rf "$lock_dir"
  printf '\n'
}

if is_enabled "$render_repo" || is_enabled "$render_branch" || is_enabled "$render_git_changes"; then
  load_git_snapshot
fi

if is_enabled "$render_repo"; then
  parts+=("$(style 'fg=#3f5f94,bold' "$(tmux_status_repo_display_label "$git_repo_label")")")
fi

if is_enabled "$render_branch"; then
  if (( git_inside_repo )); then
    parts+=("$(style 'fg=#7b4f96' "$git_branch_label")")
  else
    parts+=("$(style 'fg=#7f7a72' 'no-branch')")
  fi
fi

if is_enabled "$render_git_changes"; then
  if (( git_inside_repo )); then
    parts+=("$(style 'fg=#9a6631' "$git_changes_label")")
  else
    parts+=("$(style 'fg=#7f7a72' 'no-git')")
  fi
fi

if is_enabled "$render_node"; then
  node_version="$(resolve_node_version)"
  if [[ -n "$node_version" ]]; then
    parts+=("$(style 'fg=#3f7a4a' "⬢ ${node_version}")")
  else
    parts+=("$(style 'fg=#7f7a72' 'Node unavailable')")
  fi
fi

if (( ${#parts[@]} == 0 )); then
  exit 0
fi

printf '%s' "$padding"
join_with_separator "$(style 'fg=#7f7a72' "$separator")" "${parts[@]}"
