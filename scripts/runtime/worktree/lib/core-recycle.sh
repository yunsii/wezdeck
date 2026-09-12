#!/usr/bin/env bash
# core-recycle.sh — worktree-task recycle (in-place reset of long-lived dev-*).
# shellcheck shell=bash

wt_core_recycle_usage() {
  cat <<'EOF'
usage:
  worktree-task recycle [options]

Reset a long-lived linked worktree (dev-*) onto origin/HEAD in place:
  preflight (clean + delivered) → prune temp locals / debug files →
  hard-reset current branch to origin/HEAD → optional next-task brief.

options:
  --cwd PATH              Worktree or repo path. Default: current directory
  --worktree-root PATH    Explicit linked worktree to recycle
  --dry-run               Print planned actions without changing the tree
  --force                 Allow discarding uncommitted/untracked changes
  --title TEXT            Write next-task brief after reset (alias: --task)
  --task TEXT             Same as --title
  --fresh-agent           Remind to /clear the resumed agent session
  --prune-merged-locals   Delete merged temp local branches (default)
  --keep-temp-branches    Skip local temp-branch pruning
  --no-clean-files        Skip allowlisted debug-file cleanup
  -y, --yes               Skip confirmation (or set WT_RECYCLE_NO_CONFIRM=1)
EOF
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

wt_core_recycle() {
  local cwd="$PWD"
  local worktree_root=""
  local dry_run="0"
  local force_mode="0"
  local task_brief=""
  local fresh_agent="0"
  local prune_merged_locals="1"
  local clean_files="1"
  local skip_confirm="0"
  local branch_name=""
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

  start_ms="$(runtime_log_now_ms)"

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

  WT_WORKTREE_PATH="$(wt_abs_path "${worktree_root:-$WT_REPO_ROOT}")"
  if [[ "$WT_WORKTREE_PATH" == "$WT_MAIN_WORKTREE_ROOT" ]]; then
    wt_die "refusing to recycle the primary worktree; recycle is for linked long-lived workstations"
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
  case "$WT_TASK_SLUG" in
    dev-*)
      ;;
    *)
      wt_die "recycle is for long-lived dev-* worktrees; use reclaim for $WT_TASK_SLUG"
      ;;
  esac

  branch_name="$(git -C "$WT_WORKTREE_PATH" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ -z "$branch_name" ]]; then
    wt_die "$WT_TASK_SLUG is in detached-HEAD state; not safe to recycle"
  fi
  WT_BRANCH_NAME="$branch_name"

  # Plan file cleanup first so dirty checks can ignore allowlisted leftovers.
  if [[ "$clean_files" == "1" ]]; then
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

  wt_tmux_progress "[worktree-task] recycle: checking delivery…"
  if ! wt_delivery_fetch_origin "$WT_MAIN_WORKTREE_ROOT"; then
    runtime_log_warn task "recycle fetch origin failed; using local refs" "worktree=$WT_WORKTREE_PATH"
    printf 'warning: git fetch origin failed; delivery check uses local refs only\n' >&2
  fi

  if ! wt_delivery_check "$WT_WORKTREE_PATH" "$WT_MAIN_WORKTREE_ROOT" "$branch_name"; then
    delivery_blocker="$WT_DELIVERY_REFUSE_REASON"
    if [[ "$dry_run" != "1" ]]; then
      wt_die "$delivery_blocker"
    fi
  fi

  wt_delivery_resolve_base_tip "$WT_MAIN_WORKTREE_ROOT" \
    || wt_die "could not resolve origin/HEAD (or primary HEAD) as recycle base"
  base_tip="$WT_DELIVERY_BASE_TIP"
  before_head="$(git -C "$WT_WORKTREE_PATH" rev-parse --verify HEAD)"

  # Plan temp branch deletions.
  if [[ "$prune_merged_locals" == "1" ]]; then
    while IFS= read -r candidate; do
      [[ -n "$candidate" ]] || continue
      [[ "$candidate" == "$branch_name" ]] && continue
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
  printf '  worktree: %s\n' "$WT_WORKTREE_PATH"
  printf '  slug: %s\n' "$WT_TASK_SLUG"
  printf '  branch: %s\n' "$branch_name"
  printf '  base: %s (%s)\n' "$WT_DELIVERY_BASE_REF_LABEL" "$(git -C "$WT_MAIN_WORKTREE_ROOT" rev-parse --short "$base_tip")"
  printf '  HEAD now: %s\n' "$(git -C "$WT_MAIN_WORKTREE_ROOT" rev-parse --short "$before_head")"
  if [[ -n "$dirty_blocker" ]]; then
    printf '  blocker: %s\n' "$dirty_blocker"
  fi
  if [[ -n "$delivery_blocker" ]]; then
    printf '  blocker: %s\n' "$delivery_blocker"
  elif [[ "$WT_DELIVERY_MERGED_INTO_DEFAULT" == "1" ]]; then
    printf '  delivery: merged into %s\n' "$WT_DELIVERY_DEFAULT_REF_LABEL"
  elif [[ "$WT_DELIVERY_PUSHED_AND_IN_SYNC" == "1" ]]; then
    printf '  delivery: pushed; origin/%s contains local HEAD (remote tip kept for recovery)\n' "$branch_name"
  fi
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
    printf '  next task brief: %s\n' "${WT_RECYCLE_BRIEF_FILE:-.task-brief.md}"
  fi
  if [[ "$fresh_agent" == "1" ]]; then
    printf '  fresh-agent: remind /clear after recycle\n'
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

  if ! wt_core_recycle_confirm "recycle long-lived $WT_TASK_SLUG onto $WT_DELIVERY_BASE_REF_LABEL? (y/N):"; then
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

  git -C "$WT_WORKTREE_PATH" reset --hard "$base_tip" >/dev/null
  # Keep --no-track semantics: never set upstream to the default branch.
  git -C "$WT_WORKTREE_PATH" branch --unset-upstream >/dev/null 2>&1 || true

  after_head="$(git -C "$WT_WORKTREE_PATH" rev-parse --verify HEAD)"
  if [[ "$after_head" != "$base_tip" ]]; then
    wt_die "recycle reset failed: HEAD=$after_head expected=$base_tip"
  fi

  brief_path="$WT_WORKTREE_PATH/${WT_RECYCLE_BRIEF_FILE:-.task-brief.md}"
  if [[ -n "$task_brief" ]]; then
    cat >"$brief_path" <<EOF
# Next task

$task_brief

Recycled: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Worktree: $WT_TASK_SLUG
Branch: $branch_name
Base: $WT_DELIVERY_BASE_REF_LABEL ($after_head)
EOF
  fi

  printf 'recycle ok\n'
  printf '  HEAD: %s -> %s\n' \
    "$(git -C "$WT_MAIN_WORKTREE_ROOT" rev-parse --short "$before_head")" \
    "$(git -C "$WT_MAIN_WORKTREE_ROOT" rev-parse --short "$after_head")"
  printf '  branch: %s (no upstream)\n' "$branch_name"
  if [[ "$WT_DELIVERY_PUSHED_AND_IN_SYNC" == "1" && "$WT_DELIVERY_MERGED_INTO_DEFAULT" != "1" ]]; then
    printf '  note: origin/%s still holds the previous tip for recovery\n' "$branch_name"
  fi
  if [[ -n "$task_brief" ]]; then
    printf '  brief: %s\n' "$brief_path"
  fi
  if [[ "$fresh_agent" == "1" ]]; then
    printf '  next: open the agent pane and run /clear for a blank session\n'
  else
    printf '  next: ready for the next task (agent resume keeps prior transcript)\n'
  fi

  runtime_log_info task "recycle completed" \
    "worktree_path=$WT_WORKTREE_PATH" \
    "branch=$branch_name" \
    "before=$before_head" \
    "after=$after_head" \
    "duration_ms=$(( $(runtime_log_now_ms) - start_ms ))"

  wt_tmux_progress "[worktree-task] $WT_TASK_SLUG recycled"
  wt_tmux_progress_clear_after 2
}
