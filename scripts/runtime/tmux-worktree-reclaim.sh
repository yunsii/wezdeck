#!/usr/bin/env bash
# tmux-worktree-reclaim.sh — Alt+g Ctrl+d reclaim helper.
#
# Validates like reclaim-current-window (refuse primary / dirty / detached /
# undelivered; auto --allow-long-lived for dev-* after the picker's confirm),
# then runs `worktree-task reclaim`, kills the matching tmux window, and
# refreshes status. Designed to be called synchronously from the Go picker
# so the popup can flash the outcome and stay open.
#
# Args:
#   $1 session_name
#   $2 worktree_path   absolute linked worktree to reclaim
#   $3 source_window_id  (optional) window that opened the picker
#   $4 cwd               (optional) pane cwd when the picker opened
#
# Stdout (exactly one line, machine-readable for the picker):
#   OK<TAB>slug
#   REFUSE<TAB>short reason
#   ERROR<TAB>short reason
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wezterm_config_repo="${WEZTERM_CONFIG_REPO:-$(cd "$script_dir/../.." && pwd)}"
worktree_task_cli="$script_dir/worktree/worktree-task"

# shellcheck disable=SC1091
source "$script_dir/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/tmux-worktree-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/worktree/lib/helpers.sh"
# shellcheck disable=SC1091
source "$script_dir/worktree/lib/git.sh"
# shellcheck disable=SC1091
source "$script_dir/worktree/lib/delivery.sh"

export WEZTERM_RUNTIME_LOG_SOURCE="${WEZTERM_RUNTIME_LOG_SOURCE:-tmux-worktree-reclaim}"

session_name="${1:-}"
worktree_path="${2:-}"
source_window_id="${3:-}"
cwd="${4:-}"

emit() {
  # Keep stdout to a single protocol line; everything else goes to the log.
  printf '%s\t%s\n' "$1" "$2"
}

refuse() {
  local msg="$1"
  runtime_log_warn worktree "worktree reclaim refused" \
    "session_name=$session_name" \
    "worktree_path=$worktree_path" \
    "reason=$msg"
  emit "REFUSE" "$msg"
  exit 0
}

fail() {
  local msg="$1"
  runtime_log_error worktree "worktree reclaim failed" \
    "session_name=$session_name" \
    "worktree_path=$worktree_path" \
    "reason=$msg"
  emit "ERROR" "$msg"
  exit 1
}

if [[ -z "$session_name" || -z "$worktree_path" ]]; then
  fail "missing session or worktree path"
fi

worktree_path="$(tmux_worktree_normalize_pane_path "$worktree_path")"
worktree_path="$(tmux_worktree_abs_path "$worktree_path")"

if [[ ! -d "$worktree_path" ]]; then
  refuse "worktree path missing"
fi

if ! tmux_worktree_in_git_repo "$worktree_path"; then
  refuse "not a git worktree"
fi

repo_common_dir="$(tmux_worktree_common_dir "$worktree_path" || true)"
[[ -n "$repo_common_dir" ]] || refuse "could not resolve git common dir"
main_root="$(tmux_worktree_main_root "$repo_common_dir" || true)"
[[ -n "$main_root" ]] || refuse "could not resolve main worktree"

if [[ "$worktree_path" == "$main_root" ]]; then
  refuse "refusing primary worktree"
fi

slug="$(basename "$worktree_path")"
reclaim_extra_args=()
case "$slug" in
  dev-*)
    reclaim_extra_args+=(--allow-long-lived)
    ;;
esac

if [[ -n "$(git -C "$worktree_path" status --porcelain --untracked-files=all 2>/dev/null)" ]]; then
  refuse "$slug has uncommitted changes"
fi

branch_name="$(git -C "$worktree_path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ -z "$branch_name" ]]; then
  refuse "$slug is detached HEAD"
fi

runtime_log_info worktree "worktree reclaim invoked" \
  "session_name=$session_name" \
  "worktree_path=$worktree_path" \
  "slug=$slug" \
  "source_window_id=$source_window_id" \
  "cwd=$cwd"

# Delivery check matches Ctrl+k g r. Fetch best-effort; local refs still work.
if ! wt_delivery_fetch_origin "$main_root"; then
  runtime_log_warn worktree "worktree reclaim fetch failed; using local refs" \
    "session_name=$session_name" \
    "slug=$slug"
fi
if ! wt_delivery_check "$worktree_path" "$main_root" "$branch_name"; then
  refuse "${WT_DELIVERY_REFUSE_REASON:-$slug not delivered}"
fi

# If the doomed worktree owns a live window, leave it before remove so the
# pane does not sit on PATH (deleted). Prefer main; else last-window.
target_window_id="$(tmux_worktree_find_window "$session_name" "$worktree_path" || true)"
if [[ -n "$target_window_id" ]]; then
  survivor=""
  while IFS=$'\t' read -r wid wpath; do
    [[ "$wid" == "$target_window_id" ]] && continue
    wpath="$(tmux_worktree_normalize_pane_path "$wpath")"
    if [[ "$wpath" == "$main_root" || "$wpath" == "$main_root"/* ]]; then
      survivor="$wid"
      break
    fi
  done < <(tmux list-windows -t "$session_name" -F '#{window_id}	#{pane_current_path}' 2>/dev/null || true)
  if [[ -n "$survivor" ]]; then
    tmux select-window -t "$survivor" 2>/dev/null || true
  else
    tmux last-window -t "$session_name" 2>/dev/null || true
  fi
fi

# Reclaim from /tmp so this process cwd survives git worktree remove.
reclaim_log_root="${WEZTERM_RUNTIME_STATE_DIR:-$HOME/.local/state/wezterm-runtime}/state/worktree-task"
mkdir -p "$reclaim_log_root" 2>/dev/null || true
reclaim_log="$reclaim_log_root/reclaim-picker-${slug}-$(date -u +%Y%m%dT%H%M%SZ).log"

reclaim_rc=0
(
  cd /tmp
  "$worktree_task_cli" reclaim \
    --cwd "$main_root" \
    --worktree-root "$worktree_path" \
    "${reclaim_extra_args[@]}"
) >"$reclaim_log" 2>&1 || reclaim_rc=$?

if (( reclaim_rc != 0 )) || [[ -d "$worktree_path" ]]; then
  detail="$(tail -n 1 "$reclaim_log" 2>/dev/null || true)"
  detail="${detail//$'\t'/ }"
  if [[ -z "$detail" ]]; then
    detail="reclaim failed (see $reclaim_log)"
  fi
  fail "$detail"
fi

# Kill the window that belonged to the removed worktree (if still around).
if [[ -n "$target_window_id" ]]; then
  tmux kill-window -t "$target_window_id" 2>/dev/null || true
fi

if [[ -n "$session_name" ]]; then
  bash "$script_dir/tmux-status-refresh.sh" \
    --session "$session_name" \
    --force \
    --no-debounce \
    --refresh-client >/dev/null 2>&1 || true
fi

runtime_log_info worktree "worktree reclaim completed" \
  "session_name=$session_name" \
  "slug=$slug" \
  "worktree_path=$worktree_path" \
  "killed_window=${target_window_id:-}"

wt_tmux_progress "[worktree-task] reclaimed $slug" "$session_name"
wt_tmux_progress_clear_after 1.5

emit "OK" "$slug"
exit 0
