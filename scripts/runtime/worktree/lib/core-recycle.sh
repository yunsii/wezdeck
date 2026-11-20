#!/usr/bin/env bash
# core-recycle.sh — worktree-task recycle (fast in-place reset onto origin/HEAD).
# shellcheck shell=bash

wt_core_recycle_usage() {
  cat <<'EOF'
usage:
  worktree-task recycle [options]

Fast reset onto origin/HEAD:
  fetch → dirty check → hard-reset → sync origin/<branch> (default).
  Linked dev-*: branch name is forced to the slug mapping (dev-agent → dev/agent).
  Primary worktree: reset the default branch (master/main) onto origin/HEAD.
  Delivery gate is off by default (use --require-delivered to restore).

options:
  --cwd PATH              Worktree or repo path. Default: current directory
  --worktree-root PATH    Explicit linked worktree to recycle
  --dry-run               Print planned actions without changing the tree
  --force                 Allow discarding uncommitted/untracked changes
  --title TEXT            Echo next-task text in recycle output/log (alias: --task)
  --task TEXT             Same as --title; does not write a worktree file
  --fresh-agent           Unpin + cold-respawn the worktree's agent pane
                          (replaces manual Ctrl+Shift+n after recycle)
  --prune-merged-locals   Delete merged temp local branches (default for linked)
  --keep-temp-branches    Skip local temp-branch pruning
  --no-clean-files        Skip allowlisted debug-file cleanup
  --no-sync-remote        Do not push origin/<branch> after reset
  --keep-branch-name      Do not rename linked branch to the slug mapping
  --require-delivered     Restore the old delivered/content-absorbed gate
  -y, --yes               Skip confirmation (or set WT_RECYCLE_NO_CONFIRM=1)
EOF
}

# Soft: locate the managed tmux window for this worktree (by @wezterm_window_root
# or primary pane cwd). Prints "session_name<TAB>window_id" on success.
wt_core_recycle_find_tmux_window() {
  local worktree_path="${1:?missing worktree path}"
  local abs=""
  local session_name=""
  local window_id=""
  local root=""
  local root_abs=""
  local pane_path=""
  local pane_abs=""

  command -v tmux >/dev/null 2>&1 || return 1
  tmux list-sessions >/dev/null 2>&1 || return 1

  abs="$(cd "$worktree_path" 2>/dev/null && pwd -P)" || abs="$worktree_path"
  [[ -n "$abs" ]] || return 1

  while IFS= read -r session_name; do
    [[ -n "$session_name" ]] || continue
    while IFS= read -r window_id; do
      [[ -n "$window_id" ]] || continue
      root="$(tmux show-options -w -t "$window_id" -v -q @wezterm_window_root 2>/dev/null || true)"
      if [[ -n "$root" ]]; then
        root_abs="$(cd "$root" 2>/dev/null && pwd -P || printf '%s' "$root")"
        if [[ "$root_abs" == "$abs" ]]; then
          printf '%s\t%s\n' "$session_name" "$window_id"
          return 0
        fi
      fi
      pane_path="$(tmux list-panes -t "$window_id" -F '#{pane_current_path}' 2>/dev/null | head -n 1 || true)"
      if [[ -n "$pane_path" && -d "$pane_path" ]]; then
        pane_abs="$(cd "$pane_path" 2>/dev/null && pwd -P || printf '%s' "$pane_path")"
        if [[ "$pane_abs" == "$abs" ]]; then
          printf '%s\t%s\n' "$session_name" "$window_id"
          return 0
        fi
      fi
    done < <(tmux list-windows -t "$session_name" -F '#{window_id}' 2>/dev/null || true)
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)

  return 1
}

# After git recycle: unpin typed resume and cold-respawn the primary agent pane.
# Soft-fail (print hint, return 0) when tmux/window is missing — recycle itself
# already succeeded. May kill the calling agent if it lives in that pane.
wt_core_recycle_fresh_agent_pane() {
  local worktree_path="${1:?missing worktree path}"
  local session_name=""
  local window_id=""
  local found=""
  local reset_bin=""
  local reset_out=""
  local ec=0

  found="$(wt_core_recycle_find_tmux_window "$worktree_path" || true)"
  if [[ -z "$found" ]]; then
    printf '  fresh-agent: no live tmux window for this worktree; open it and F5 if needed\n'
    runtime_log_info task "recycle fresh-agent skipped; no tmux window" \
      "worktree=$worktree_path" || true
    return 0
  fi
  IFS=$'\t' read -r session_name window_id <<<"$found"
  [[ -n "$session_name" && -n "$window_id" ]] || return 0

  reset_bin=""
  if [[ -n "${WEZDECK_REPO:-}" && -f "${WEZDECK_REPO}/scripts/runtime/tmux-reset.sh" ]]; then
    reset_bin="${WEZDECK_REPO}/scripts/runtime/tmux-reset.sh"
  elif [[ -n "${WR_WEZDECK_REPO:-}" && -f "${WR_WEZDECK_REPO}/scripts/runtime/tmux-reset.sh" ]]; then
    reset_bin="${WR_WEZDECK_REPO}/scripts/runtime/tmux-reset.sh"
  else
    # core-recycle.sh lives at scripts/runtime/worktree/lib/ → ../../../tmux-reset.sh
    reset_bin="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/tmux-reset.sh"
  fi
  if [[ ! -f "$reset_bin" ]]; then
    printf '  fresh-agent: tmux-reset.sh missing; run Ctrl+Shift+n manually\n'
    runtime_log_warn task "recycle fresh-agent missing tmux-reset" \
      "worktree=$worktree_path" || true
    return 0
  fi

  wt_tmux_progress "[worktree-task] recycle: fresh-agent respawn…"
  # Capture status token; do not print it (view-mode hazard for run-shell callers).
  reset_out="$(bash "$reset_bin" refresh-current-window \
    --session-name "$session_name" \
    --window-id "$window_id" \
    --cwd "$worktree_path" \
    --fresh-agent 2>/dev/null)" || ec=$?
  reset_out="${reset_out//$'\r'/}"
  reset_out="${reset_out##*$'\n'}"

  if [[ "$ec" -eq 0 && "$reset_out" == "reset_window_in_place" ]]; then
    printf '  fresh-agent: primary pane cold-respawned (session=%s window=%s)\n' \
      "$session_name" "$window_id"
    runtime_log_info task "recycle fresh-agent respawned" \
      "worktree=$worktree_path" \
      "session_name=$session_name" \
      "window_id=$window_id" \
      "outcome=respawned" || true
    return 0
  fi

  printf '  fresh-agent: respawn failed (exit=%s out=%s); try F5 on the agent pane\n' \
    "$ec" "${reset_out:-}"
  runtime_log_warn task "recycle fresh-agent respawn failed" \
    "worktree=$worktree_path" \
    "session_name=$session_name" \
    "window_id=$window_id" \
    "exit_code=$ec" \
    "reset_out=${reset_out:-}" || true
  return 0
}

wt_core_recycle_confirm() {
  local prompt="${1:?missing prompt}"
  local reply=""

  if [[ -n "${WT_RECYCLE_NO_CONFIRM:-}" ]]; then
    return 0
  fi

  if [[ -n "${TMUX:-}" ]]; then
    local confirm_status_file
    confirm_status_file="$(mktemp -t wt-recycle-confirm.XXXXXX)"
    tmux command-prompt -1 -p "$prompt" \
      "run-shell 'printf %s %1 > $(printf '%q' "$confirm_status_file")'"
    for _ in $(seq 1 200); do
      [[ -s "$confirm_status_file" ]] && break
      sleep 0.05
    done
    reply="$(cat "$confirm_status_file" 2>/dev/null || true)"
    rm -f "$confirm_status_file"
    case "$reply" in
      y|Y) return 0 ;;
      *) return 1 ;;
    esac
  fi

  printf '%s ' "$prompt" >&2
  read -r reply || true
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

wt_core_recycle_branch_checked_out() {
  local main_root="${1:?missing main root}"
  local branch_name="${2:?missing branch}"
  local line=""
  local wt_path=""

  while IFS= read -r line; do
    case "$line" in
      worktree\ *)
        wt_path="${line#worktree }"
        ;;
      branch\ refs/heads/*)
        if [[ "${line#branch refs/heads/}" == "$branch_name" ]]; then
          printf '%s\n' "$wt_path"
          return 0
        fi
        ;;
      HEAD)
        wt_path=""
        ;;
    esac
  done < <(git -C "$main_root" worktree list --porcelain 2>/dev/null)
  return 1
}

wt_core_recycle_is_temp_branch() {
  local branch_name="${1:?missing branch}"
  local prefixes="${2:-}"
  local prefix=""

  IFS=',' read -r -a __wt_recycle_prefixes <<<"$prefixes"
  for prefix in "${__wt_recycle_prefixes[@]}"; do
    prefix="$(wt_trim "$prefix")"
    [[ -n "$prefix" ]] || continue
    case "$branch_name" in
      "$prefix"*) return 0 ;;
    esac
  done
  return 1
}

# Map lifecycle worktree slug → expected branch (dev-agent → dev/agent).
wt_core_recycle_branch_for_slug() {
  local slug="${1:?missing slug}"
  local subject=""

  case "$slug" in
    dev-*)
      subject="${slug#dev-}"
      [[ -n "$subject" ]] || return 1
      printf '%s%s\n' "${WT_POLICY_BRANCH_PREFIX_DEV:-dev/}" "$subject"
      ;;
    task-*)
      subject="${slug#task-}"
      [[ -n "$subject" ]] || return 1
      printf '%s%s\n' "${WT_POLICY_BRANCH_PREFIX_TASK:-task/}" "$subject"
      ;;
    hotfix-*)
      subject="${slug#hotfix-}"
      [[ -n "$subject" ]] || return 1
      printf '%s%s\n' "${WT_POLICY_BRANCH_PREFIX_HOTFIX:-hotfix/}" "$subject"
      ;;
    *)
      return 1
      ;;
  esac
}

# Default branch short name from origin/HEAD (origin/master → master).
wt_core_recycle_default_branch() {
  local main_root="${1:?missing main root}"
  local remote_head=""

  remote_head="$(git -C "$main_root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -n "$remote_head" ]]; then
    printf '%s\n' "${remote_head#origin/}"
    return 0
  fi
  if git -C "$main_root" show-ref --verify --quiet refs/heads/master; then
    printf 'master\n'
    return 0
  fi
  if git -C "$main_root" show-ref --verify --quiet refs/heads/main; then
    printf 'main\n'
    return 0
  fi
  return 1
}

wt_core_recycle_path_forbidden() {
  local rel="${1:?missing relative path}"

  case "$rel" in
    .git|.git/*|wezterm-x/local|wezterm-x/local/*|node_modules|node_modules/*|.worktree-recycle|.worktree-recycle/*)
      return 0
      ;;
  esac
  return 1
}

# Paths that may exist as untracked workstation metadata without blocking recycle.
wt_core_recycle_path_ignored_dirty() {
  local rel="${1:?missing relative path}"
  case "$rel" in
    .worktree-recycle|.worktree-recycle/*)
      return 0
      ;;
  esac
  return 1
}

wt_core_recycle_collect_clean_targets() {
  local worktree_root="${1:?missing worktree root}"
  local globs="${2:-}"
  local pattern=""
  local match=""

  [[ -n "$globs" ]] || return 0

  (
    cd "$worktree_root" || exit 0
    shopt -s nullglob dotglob globstar 2>/dev/null || true
    IFS=',' read -r -a __wt_recycle_globs <<<"$globs"
    for pattern in "${__wt_recycle_globs[@]}"; do
      pattern="$(wt_trim "$pattern")"
      [[ -n "$pattern" ]] || continue
      # shellcheck disable=SC2086
      for match in $pattern; do
        [[ -e "$match" || -L "$match" ]] || continue
        if wt_core_recycle_path_forbidden "$match"; then
          continue
        fi
        printf '%s\n' "$match"
      done
    done
  )
}

# True if relative path is covered by an allowlisted clean target (exact or under a cleaned dir).
wt_core_recycle_path_is_planned_clean() {
  local rel="${1:?missing path}"
  local planned="${2:-}"
  local item=""

  [[ -n "$planned" ]] || return 1
  while IFS= read -r item; do
    [[ -n "$item" ]] || continue
    if [[ "$rel" == "$item" || "$rel" == "$item"/* ]]; then
      return 0
    fi
    # Porcelain may list a file under a directory we plan to remove wholesale.
    if [[ "$item" == "$rel"/* ]]; then
      return 0
    fi
  done <<<"$planned"
  return 1
}

wt_core_recycle_blocking_dirty() {
  local worktree_root="${1:?missing worktree root}"
  local planned_clean="${2:-}"
  local line=""
  local path=""
  local blocking=0

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    # porcelain v1: XY PATH or XY ORIG -> PATH
    path="${line:3}"
    if [[ "$path" == *" -> "* ]]; then
      path="${path##* -> }"
    fi
    # Untracked dir entries end with /
    path="${path%/}"
    if wt_core_recycle_path_ignored_dirty "$path"; then
      continue
    fi
    if wt_core_recycle_path_is_planned_clean "$path" "$planned_clean"; then
      continue
    fi
    printf '%s\n' "$line"
    blocking=1
  done < <(git -C "$worktree_root" status --porcelain --untracked-files=all 2>/dev/null)

  [[ "$blocking" -eq 0 ]]
}

# Publish local tip to origin/<branch> after recycle reset.
# Sets WT_RECYCLE_REMOTE_SYNC_RESULT to one of:
#   skipped | created | fast-forward | force-with-lease | failed | noop
wt_core_recycle_sync_remote() {
  local worktree_path="${1:?missing worktree}"
  local branch_name="${2:?missing branch}"
  local tip="${3:?missing tip}"
  local remote_ref="refs/remotes/origin/$branch_name"
  local remote_tip=""

  WT_RECYCLE_REMOTE_SYNC_RESULT="skipped"

  if ! git -C "$worktree_path" remote get-url origin >/dev/null 2>&1; then
    WT_RECYCLE_REMOTE_SYNC_RESULT="skipped"
    return 0
  fi

  if git -C "$worktree_path" rev-parse --verify --quiet "$remote_ref" >/dev/null 2>&1; then
    remote_tip="$(git -C "$worktree_path" rev-parse "$remote_ref")"
    if [[ "$remote_tip" == "$tip" ]]; then
      git -C "$worktree_path" branch --set-upstream-to="origin/$branch_name" "$branch_name" >/dev/null 2>&1 || true
      WT_RECYCLE_REMOTE_SYNC_RESULT="noop"
      return 0
    fi
    if git -C "$worktree_path" merge-base --is-ancestor "$remote_tip" "$tip" 2>/dev/null; then
      if git -C "$worktree_path" push origin "refs/heads/$branch_name:refs/heads/$branch_name"; then
        git -C "$worktree_path" branch --set-upstream-to="origin/$branch_name" "$branch_name" >/dev/null 2>&1 || true
        WT_RECYCLE_REMOTE_SYNC_RESULT="fast-forward"
        return 0
      fi
      WT_RECYCLE_REMOTE_SYNC_RESULT="failed"
      return 1
    fi
    if git -C "$worktree_path" push --force-with-lease="refs/heads/$branch_name:$remote_tip" \
      origin "refs/heads/$branch_name:refs/heads/$branch_name"; then
      git -C "$worktree_path" branch --set-upstream-to="origin/$branch_name" "$branch_name" >/dev/null 2>&1 || true
      WT_RECYCLE_REMOTE_SYNC_RESULT="force-with-lease"
      return 0
    fi
    WT_RECYCLE_REMOTE_SYNC_RESULT="failed"
    return 1
  fi

  if git -C "$worktree_path" push -u origin "refs/heads/$branch_name:refs/heads/$branch_name"; then
    WT_RECYCLE_REMOTE_SYNC_RESULT="created"
    return 0
  fi
  WT_RECYCLE_REMOTE_SYNC_RESULT="failed"
  return 1
}

# Switch (or create) target_branch at tip inside worktree_path.
wt_core_recycle_checkout_branch_at() {
  local worktree_path="${1:?missing worktree}"
  local main_root="${2:?missing main root}"
  local target_branch="${3:?missing branch}"
  local tip="${4:?missing tip}"
  local occupied_by=""

  if occupied_by="$(wt_core_recycle_branch_checked_out "$main_root" "$target_branch")"; then
    if [[ "$(wt_abs_path "$occupied_by")" != "$(wt_abs_path "$worktree_path")" ]]; then
      wt_die "target branch $target_branch is checked out at $occupied_by"
    fi
  fi

  git -C "$worktree_path" switch --force -C "$target_branch" "$tip" >/dev/null
}

wt_core_recycle() {
  local cwd="$PWD"
  local worktree_root=""
  local dry_run="0"
  local force_mode="0"
  local task_brief=""
  local fresh_agent="0"
  local prune_merged_locals="1"
  local clean_files="1"
  local sync_remote=""
  local skip_confirm="0"
  local keep_branch_name="0"
  local require_delivered="0"
  local is_primary="0"
  local branch_name=""
  local current_branch=""
  local expected_branch=""
  local base_tip=""
  local before_head=""
  local after_head=""
  local pruned_branches=()
  local cleaned_files=()
  local planned_clean=""
  local dirty_blocker=""
  local delivery_blocker=""
  local candidate=""
  local occupied_by=""
  local start_ms
  local brief_path=""
  local backup_branch=""
  local remote_sync_plan=""
  local default_branch=""

  start_ms="$(runtime_log_now_ms)"
  WT_RECYCLE_REMOTE_SYNC_RESULT=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd)
        [[ $# -ge 2 ]] || { wt_core_recycle_usage; exit 1; }
        cwd="$2"
        shift 2
        ;;
      --worktree-root)
        [[ $# -ge 2 ]] || { wt_core_recycle_usage; exit 1; }
        worktree_root="$2"
        shift 2
        ;;
      --dry-run)
        dry_run="1"
        shift
        ;;
      --force)
        force_mode="1"
        shift
        ;;
      --title|--task)
        [[ $# -ge 2 ]] || { wt_core_recycle_usage; exit 1; }
        task_brief="$2"
        shift 2
        ;;
      --fresh-agent)
        fresh_agent="1"
        shift
        ;;
      --prune-merged-locals)
        prune_merged_locals="1"
        shift
        ;;
      --keep-temp-branches)
        prune_merged_locals="0"
        shift
        ;;
      --no-clean-files)
        clean_files="0"
        shift
        ;;
      --no-sync-remote)
        sync_remote="0"
        shift
        ;;
      --keep-branch-name)
        keep_branch_name="1"
        shift
        ;;
      --require-delivered)
        require_delivered="1"
        shift
        ;;
      -y|--yes)
        skip_confirm="1"
        shift
        ;;
      -h|--help)
        wt_core_recycle_usage
        exit 0
        ;;
      *)
        wt_core_recycle_usage
        exit 1
        ;;
    esac
  done

  if [[ "$skip_confirm" == "1" ]]; then
    WT_RECYCLE_NO_CONFIRM=1
  fi

  if [[ -n "$worktree_root" ]]; then
    [[ -d "$worktree_root" ]] || wt_die "worktree does not exist: $worktree_root"
    cwd="$worktree_root"
  fi

  wt_core_resolve_repo_context "$cwd"
  wt_config_load
  wt_core_resolve_policy_paths
  # CLI --no-sync-remote wins; otherwise honor WT_RECYCLE_SYNC_REMOTE (default 1).
  sync_remote="${sync_remote:-${WT_RECYCLE_SYNC_REMOTE:-1}}"
  if [[ "${WT_RECYCLE_REQUIRE_DELIVERED:-0}" == "1" ]]; then
    require_delivered="1"
  fi
  if [[ "${WT_RECYCLE_KEEP_BRANCH_NAME:-0}" == "1" ]]; then
    keep_branch_name="1"
  fi

  WT_WORKTREE_PATH="$(wt_abs_path "${worktree_root:-$WT_REPO_ROOT}")"
  if [[ "$WT_WORKTREE_PATH" == "$WT_MAIN_WORKTREE_ROOT" ]]; then
    is_primary="1"
  fi

  if [[ "$is_primary" != "1" ]]; then
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
    case "$WT_TASK_SLUG" in
      dev-*)
        ;;
      *)
        wt_die "recycle is for primary or long-lived dev-* worktrees; use reclaim for $WT_TASK_SLUG"
        ;;
    esac
  else
    WT_TASK_SLUG="$(basename "$WT_WORKTREE_PATH")"
  fi

  current_branch="$(git -C "$WT_WORKTREE_PATH" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ -z "$current_branch" ]]; then
    wt_die "$WT_TASK_SLUG is in detached-HEAD state; not safe to recycle"
  fi

  if [[ "$is_primary" == "1" ]]; then
    default_branch="$(wt_core_recycle_default_branch "$WT_MAIN_WORKTREE_ROOT")" \
      || wt_die "could not resolve default branch for primary recycle"
    branch_name="$default_branch"
    expected_branch="$default_branch"
    # Primary: skip temp-branch prune by default (workstation-only hygiene).
    if [[ "$prune_merged_locals" == "1" && -z "${WT_RECYCLE_PRUNE_ON_PRIMARY:-}" ]]; then
      prune_merged_locals="0"
    fi
  else
    if [[ "$keep_branch_name" == "1" ]]; then
      branch_name="$current_branch"
      expected_branch="$current_branch"
    else
      expected_branch="$(wt_core_recycle_branch_for_slug "$WT_TASK_SLUG")" \
        || wt_die "cannot derive branch name from slug: $WT_TASK_SLUG"
      branch_name="$expected_branch"
    fi
  fi
  WT_BRANCH_NAME="$branch_name"

  # Plan file cleanup first so dirty checks can ignore allowlisted leftovers.
  if [[ "$clean_files" == "1" && "$is_primary" != "1" ]]; then
    while IFS= read -r candidate; do
      [[ -n "$candidate" ]] || continue
      cleaned_files+=("$candidate")
    done < <(wt_core_recycle_collect_clean_targets "$WT_WORKTREE_PATH" "${WT_RECYCLE_CLEAN_GLOBS}")
  fi

  planned_clean=""
  if ((${#cleaned_files[@]})); then
    printf -v planned_clean '%s\n' "${cleaned_files[@]}"
  fi

  if [[ "$force_mode" != "1" ]]; then
    if ! wt_core_recycle_blocking_dirty "$WT_WORKTREE_PATH" "$planned_clean" >/dev/null; then
      dirty_blocker="worktree has uncommitted changes; commit/discard or rerun with --force"
      if [[ "$dry_run" != "1" ]]; then
        wt_die "$dirty_blocker"
      fi
    fi
  fi

  wt_tmux_progress "[worktree-task] recycle: fetching origin…"
  if ! wt_delivery_fetch_origin "$WT_MAIN_WORKTREE_ROOT"; then
    runtime_log_warn task "recycle fetch origin failed; using local refs" "worktree=$WT_WORKTREE_PATH"
    printf 'warning: git fetch origin failed; recycle uses local refs only\n' >&2
  fi

  if [[ "$require_delivered" == "1" ]]; then
    if [[ "$is_primary" == "1" ]]; then
      printf 'warning: --require-delivered ignored on primary worktree\n' >&2
    else
      wt_tmux_progress "[worktree-task] recycle: checking delivery…"
      if ! wt_delivery_check "$WT_WORKTREE_PATH" "$WT_MAIN_WORKTREE_ROOT" "$current_branch"; then
        delivery_blocker="$WT_DELIVERY_REFUSE_REASON"
        if [[ "$dry_run" != "1" ]]; then
          wt_die "$delivery_blocker"
        fi
      fi
    fi
  fi

  wt_delivery_resolve_base_tip "$WT_MAIN_WORKTREE_ROOT" \
    || wt_die "could not resolve origin/HEAD (or primary HEAD) as recycle base"
  base_tip="$WT_DELIVERY_BASE_TIP"
  before_head="$(git -C "$WT_WORKTREE_PATH" rev-parse --verify HEAD)"

  # Plan temp branch deletions (linked worktrees only by default).
  if [[ "$prune_merged_locals" == "1" ]]; then
    while IFS= read -r candidate; do
      [[ -n "$candidate" ]] || continue
      [[ "$candidate" == "$branch_name" ]] && continue
      [[ "$candidate" == "$current_branch" ]] && continue
      case "$candidate" in
        master|main) continue ;;
      esac
      wt_core_recycle_is_temp_branch "$candidate" "${WT_RECYCLE_TEMP_BRANCH_PREFIXES}" || continue
      git -C "$WT_MAIN_WORKTREE_ROOT" merge-base --is-ancestor "$candidate" "$base_tip" 2>/dev/null || continue
      if occupied_by="$(wt_core_recycle_branch_checked_out "$WT_MAIN_WORKTREE_ROOT" "$candidate")"; then
        printf 'skip pruning %s (checked out at %s)\n' "$candidate" "$occupied_by" >&2
        continue
      fi
      pruned_branches+=("$candidate")
    done < <(git -C "$WT_MAIN_WORKTREE_ROOT" for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null)
  fi

  printf 'recycle plan\n'
  if [[ "$is_primary" == "1" ]]; then
    printf '  mode: primary\n'
  else
    printf '  mode: linked\n'
  fi
  printf '  worktree: %s\n' "$WT_WORKTREE_PATH"
  printf '  slug: %s\n' "$WT_TASK_SLUG"
  printf '  branch now: %s\n' "$current_branch"
  printf '  branch target: %s\n' "$branch_name"
  if [[ "$current_branch" != "$branch_name" ]]; then
    printf '  branch align: %s → %s\n' "$current_branch" "$branch_name"
  fi
  printf '  base: %s (%s)\n' "$WT_DELIVERY_BASE_REF_LABEL" "$(git -C "$WT_MAIN_WORKTREE_ROOT" rev-parse --short "$base_tip")"
  printf '  HEAD now: %s\n' "$(git -C "$WT_MAIN_WORKTREE_ROOT" rev-parse --short "$before_head")"
  if [[ -n "$dirty_blocker" ]]; then
    printf '  blocker: %s\n' "$dirty_blocker"
  fi
  if [[ -n "$delivery_blocker" ]]; then
    printf '  blocker: %s\n' "$delivery_blocker"
  elif [[ "$require_delivered" == "1" ]]; then
    if [[ "${WT_DELIVERY_CONTENT_ABSORBED:-0}" == "1" ]]; then
      printf '  delivery: content absorbed into %s (squash/rebase-safe)\n' "$WT_DELIVERY_DEFAULT_REF_LABEL"
    elif [[ "${WT_DELIVERY_MERGED_INTO_DEFAULT:-0}" == "1" ]]; then
      printf '  delivery: merged into %s\n' "$WT_DELIVERY_DEFAULT_REF_LABEL"
    elif [[ "${WT_DELIVERY_PUSHED_AND_IN_SYNC:-0}" == "1" ]]; then
      printf '  delivery: pushed; origin/%s contains local HEAD\n' "$current_branch"
    fi
  else
    printf '  delivery: skipped (fast path; use --require-delivered to enforce)\n'
  fi
  if [[ "$before_head" != "$base_tip" || "$current_branch" != "$branch_name" ]]; then
    backup_branch="backup/$(printf '%s' "$current_branch" | tr '/' '-')-$(date +%Y%m%d-%H%M)"
    printf '  backup branch: %s (pre-reset tip)\n' "$backup_branch"
  else
    printf '  backup branch: (none; already on base)\n'
  fi
  if [[ "$sync_remote" == "1" ]]; then
    if git -C "$WT_WORKTREE_PATH" remote get-url origin >/dev/null 2>&1; then
      if [[ "$is_primary" == "1" ]]; then
        remote_sync_plan="ensure origin/$branch_name == base (usually noop after fetch)"
      elif git -C "$WT_MAIN_WORKTREE_ROOT" rev-parse --verify --quiet "refs/remotes/origin/$branch_name" >/dev/null 2>&1; then
        remote_sync_plan="push origin/$branch_name → base (FF or --force-with-lease)"
      else
        remote_sync_plan="create origin/$branch_name at base"
      fi
    else
      remote_sync_plan="skip (no origin remote)"
    fi
  else
    remote_sync_plan="skip (--no-sync-remote / WT_RECYCLE_SYNC_REMOTE=0)"
  fi
  printf '  remote sync: %s\n' "$remote_sync_plan"
  if ((${#pruned_branches[@]})); then
    printf '  prune branches: %s\n' "${pruned_branches[*]}"
  else
    printf '  prune branches: (none)\n'
  fi
  if ((${#cleaned_files[@]})); then
    printf '  clean files: %s\n' "${cleaned_files[*]}"
  else
    printf '  clean files: (none)\n'
  fi
  if [[ -n "$task_brief" ]]; then
    printf '  next task: %s\n' "$task_brief"
  fi
  if [[ "$fresh_agent" == "1" ]]; then
    printf '  fresh-agent: unpin + cold-respawn agent pane after reset\n'
  fi

  if [[ "$dry_run" == "1" ]]; then
    if [[ -n "$dirty_blocker" || -n "$delivery_blocker" ]]; then
      printf 'dry-run: blocked (no changes made)\n'
      wt_tmux_progress ""
      return 1
    fi
    printf 'dry-run: no changes made\n'
    wt_tmux_progress ""
    return 0
  fi

  if ! wt_core_recycle_confirm "recycle $WT_TASK_SLUG onto $WT_DELIVERY_BASE_REF_LABEL? (y/N):"; then
    printf 'recycle cancelled\n' >&2
    wt_tmux_progress ""
    return 0
  fi

  wt_tmux_progress "[worktree-task] recycle: resetting $WT_TASK_SLUG…"

  if [[ "$force_mode" == "1" ]]; then
    git -C "$WT_WORKTREE_PATH" reset --hard HEAD >/dev/null
    # Keep project recycle hooks; discard other untracked dirt.
    git -C "$WT_WORKTREE_PATH" clean -fd -e .worktree-recycle >/dev/null
  fi

  for candidate in "${pruned_branches[@]}"; do
    git -C "$WT_MAIN_WORKTREE_ROOT" branch -D "$candidate" >/dev/null
    runtime_log_info task "recycle pruned local branch" "branch=$candidate"
  done

  for candidate in "${cleaned_files[@]}"; do
    rm -rf "${WT_WORKTREE_PATH:?}/$candidate"
    runtime_log_info task "recycle cleaned path" "path=$candidate"
  done

  if [[ -n "$backup_branch" ]]; then
    git -C "$WT_MAIN_WORKTREE_ROOT" branch -f "$backup_branch" "$before_head" >/dev/null
    runtime_log_info task "recycle backup branch" "branch=$backup_branch" "tip=$before_head"
  fi

  if [[ "$current_branch" != "$branch_name" ]]; then
    wt_core_recycle_checkout_branch_at "$WT_WORKTREE_PATH" "$WT_MAIN_WORKTREE_ROOT" "$branch_name" "$base_tip"
  else
    git -C "$WT_WORKTREE_PATH" reset --hard "$base_tip" >/dev/null
  fi
  # Never track the default branch from a linked workstation; primary keeps origin/<default>.
  git -C "$WT_WORKTREE_PATH" branch --unset-upstream >/dev/null 2>&1 || true

  after_head="$(git -C "$WT_WORKTREE_PATH" rev-parse --verify HEAD)"
  if [[ "$after_head" != "$base_tip" ]]; then
    wt_die "recycle reset failed: HEAD=$after_head expected=$base_tip"
  fi
  current_branch="$(git -C "$WT_WORKTREE_PATH" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ "$current_branch" != "$branch_name" ]]; then
    wt_die "recycle branch align failed: HEAD=$current_branch expected=$branch_name"
  fi

  if [[ "$sync_remote" == "1" ]]; then
    wt_tmux_progress "[worktree-task] recycle: syncing origin/$branch_name…"
    if ! wt_core_recycle_sync_remote "$WT_WORKTREE_PATH" "$branch_name" "$after_head"; then
      wt_die "recycle local reset ok, but failed to sync origin/$branch_name (result=${WT_RECYCLE_REMOTE_SYNC_RESULT:-failed})"
    fi
  else
    WT_RECYCLE_REMOTE_SYNC_RESULT="skipped"
  fi

  # Legacy: older recycle --task wrote .task-brief.md into the worktree.
  # Never create it; remove leftovers so IDEs do not show a stray green N.
  brief_path="$WT_WORKTREE_PATH/${WT_RECYCLE_BRIEF_FILE:-.task-brief.md}"
  if [[ -e "$brief_path" ]]; then
    rm -f "$brief_path"
    runtime_log_info task "recycle removed legacy task brief file" "path=$brief_path" || true
  fi

  printf 'recycle ok\n'
  printf '  HEAD: %s -> %s\n' \
    "$(git -C "$WT_MAIN_WORKTREE_ROOT" rev-parse --short "$before_head")" \
    "$(git -C "$WT_MAIN_WORKTREE_ROOT" rev-parse --short "$after_head")"
  printf '  branch: %s\n' "$branch_name"
  if [[ -n "$backup_branch" ]]; then
    printf '  backup: %s\n' "$backup_branch"
  fi
  printf '  remote sync: %s\n' "${WT_RECYCLE_REMOTE_SYNC_RESULT:-skipped}"
  if git -C "$WT_WORKTREE_PATH" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
    printf '  upstream: %s\n' "$(git -C "$WT_WORKTREE_PATH" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')"
  else
    printf '  upstream: (none)\n'
  fi
  if [[ -n "$task_brief" ]]; then
    printf '  next task: %s\n' "$task_brief"
  fi
  if [[ "$fresh_agent" == "1" ]]; then
    # Last step: may kill this process if recycle ran inside the target pane.
    wt_core_recycle_fresh_agent_pane "$WT_WORKTREE_PATH"
    printf '  next: blank agent session (no Ctrl+Shift+n needed)\n'
  else
    printf '  next: ready for the next task (project init left to the follow-up task)\n'
  fi

  runtime_log_info task "recycle completed" \
    "worktree_path=$WT_WORKTREE_PATH" \
    "branch=$branch_name" \
    "primary=$is_primary" \
    "before=$before_head" \
    "after=$after_head" \
    "remote_sync=${WT_RECYCLE_REMOTE_SYNC_RESULT:-skipped}" \
    "fresh_agent=$fresh_agent" \
    "task_brief=${task_brief:-}" \
    "duration_ms=$(( $(runtime_log_now_ms) - start_ms ))"

  wt_tmux_progress "[worktree-task] $WT_TASK_SLUG recycled"
  wt_tmux_progress_clear_after 2
}
