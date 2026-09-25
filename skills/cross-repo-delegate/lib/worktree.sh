#!/usr/bin/env bash
# Ensure a delegate-* linked worktree for a ticket via worktree-task.
# shellcheck shell=bash

delegate_wezdeck_repo() {
  if [[ -n "${WEZDECK_REPO:-}" && -d "${WEZDECK_REPO}" ]]; then
    printf '%s' "$WEZDECK_REPO"
    return 0
  fi
  if [[ -f "${HOME}/.config/worktree-task/config.env" ]]; then
    # shellcheck disable=SC1090
    . "${HOME}/.config/worktree-task/config.env"
    if [[ -n "${WEZDECK_REPO:-}" && -d "${WEZDECK_REPO}" ]]; then
      printf '%s' "$WEZDECK_REPO"
      return 0
    fi
  fi
  local guess="${HOME}/github/wezterm-config"
  if [[ -d "$guess/scripts/runtime/worktree" ]]; then
    printf '%s' "$guess"
    return 0
  fi
  return 1
}

# Prints worktree_path=... lines from worktree-task; echoes path on stdout last line via RESULT
# Usage: delegate_ensure_worktree <target_repo_path> <ticket_id> <title>
# Sets: DELEGATE_WORKTREE_PATH DELEGATE_WORKTREE_BRANCH
delegate_ensure_worktree() {
  local target_repo=$1 ticket_id=$2 title=$3
  local wezdeck wt_bin slug branch out path
  wezdeck="$(delegate_wezdeck_repo)" || delegate_die "WEZDECK_REPO not found (configure worktree-task or set WEZDECK_REPO)"
  wt_bin="$wezdeck/scripts/runtime/worktree/worktree-task"
  [[ -x "$wt_bin" ]] || delegate_die "worktree-task missing: $wt_bin"

  slug="delegate-${ticket_id}"
  branch="delegate/${ticket_id}"

  # Reuse if already recorded
  local meta_path
  meta_path="$(delegate_tickets_root)/_data/${ticket_id}/meta.json"
  if [[ -f "$meta_path" ]]; then
    path="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("worktree") or "")' "$meta_path")"
    if [[ -n "$path" && -d "$path" ]]; then
      DELEGATE_WORKTREE_PATH="$path"
      DELEGATE_WORKTREE_BRANCH="$(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "$branch")"
      printf '%s\n' "$DELEGATE_WORKTREE_PATH"
      return 0
    fi
  fi

  delegate_log "launching worktree slug=$slug cwd=$target_repo"
  out="$(
    WEZDECK_REPO="$wezdeck" "$wt_bin" launch \
      --cwd "$target_repo" \
      --title "${title:-$ticket_id}" \
      --task-slug "$slug" \
      --branch "$branch" \
      --provider none \
      --no-attach \
      --provider-mode off
  )" || delegate_die "worktree-task launch failed"

  path="$(printf '%s\n' "$out" | awk -F= '/^worktree_path=/{print $2; exit}')"
  [[ -n "$path" && -d "$path" ]] || {
    printf '%s\n' "$out" >&2
    delegate_die "worktree_path missing from launch output"
  }
  DELEGATE_WORKTREE_PATH="$path"
  DELEGATE_WORKTREE_BRANCH="$(printf '%s\n' "$out" | awk -F= '/^branch_name=/{print $2; exit}')"
  printf '%s\n' "$DELEGATE_WORKTREE_PATH"
}
