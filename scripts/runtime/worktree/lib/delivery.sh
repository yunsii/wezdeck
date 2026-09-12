#!/usr/bin/env bash
# delivery.sh — shared "is this branch delivered?" checks for reclaim / recycle.
# Sourced by worktree-task (via git.sh consumers) and reclaim-current-window.
# shellcheck shell=bash

# Best-effort fetch. Sets WT_DELIVERY_FETCH_OK=1 on success, 0 otherwise.
wt_delivery_fetch_origin() {
  local main_root="${1:?missing main worktree root}"
  WT_DELIVERY_FETCH_OK=0
  if git -C "$main_root" fetch origin --quiet 2>/dev/null; then
    WT_DELIVERY_FETCH_OK=1
    return 0
  fi
  return 1
}

# Resolve the tip used as the recycle / reset base (origin/HEAD, else primary HEAD).
# Sets WT_DELIVERY_BASE_TIP and WT_DELIVERY_BASE_REF_LABEL (must not be called
# inside a command substitution — those assignments would be lost).
wt_delivery_resolve_base_tip() {
  local main_root="${1:?missing main worktree root}"
  local tip=""

  WT_DELIVERY_BASE_TIP=""
  WT_DELIVERY_BASE_REF_LABEL=""

  tip="$(git -C "$main_root" rev-parse --verify origin/HEAD 2>/dev/null || true)"
  if [[ -n "$tip" ]]; then
    WT_DELIVERY_BASE_TIP="$tip"
    WT_DELIVERY_BASE_REF_LABEL="$(git -C "$main_root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/HEAD)"
    return 0
  fi

  tip="$(git -C "$main_root" rev-parse --verify HEAD 2>/dev/null || true)"
  if [[ -n "$tip" ]]; then
    WT_DELIVERY_BASE_TIP="$tip"
    WT_DELIVERY_BASE_REF_LABEL="HEAD"
    return 0
  fi

  return 1
}

# Check whether a worktree branch is safe to reclaim / recycle.
# Sets:
#   WT_DELIVERY_OK=0|1
#   WT_DELIVERY_MERGED_INTO_DEFAULT=0|1
#   WT_DELIVERY_PUSHED_AND_IN_SYNC=0|1
#   WT_DELIVERY_DEFAULT_REF_LABEL
#   WT_DELIVERY_REMOTE_REF (refs/remotes/origin/<branch> or empty)
#   WT_DELIVERY_REFUSE_REASON (when OK=0)
#   WT_DELIVERY_LOCAL_HEAD
wt_delivery_check() {
  local worktree_root="${1:?missing worktree root}"
  local main_root="${2:?missing main worktree root}"
  local branch_name="${3:?missing branch name}"
  local local_head=""
  local upstream_default=""
  local remote_ref=""

  WT_DELIVERY_OK=0
  WT_DELIVERY_MERGED_INTO_DEFAULT=0
  WT_DELIVERY_PUSHED_AND_IN_SYNC=0
  WT_DELIVERY_DEFAULT_REF_LABEL="origin/HEAD"
  WT_DELIVERY_REMOTE_REF=""
  WT_DELIVERY_REFUSE_REASON=""
  WT_DELIVERY_LOCAL_HEAD=""

  local_head="$(git -C "$worktree_root" rev-parse --verify HEAD 2>/dev/null || true)"
  WT_DELIVERY_LOCAL_HEAD="$local_head"

  upstream_default="$(git -C "$main_root" rev-parse --verify origin/HEAD 2>/dev/null || true)"
  if [[ -n "$upstream_default" ]]; then
    WT_DELIVERY_DEFAULT_REF_LABEL="$(git -C "$main_root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/HEAD)"
    if git -C "$main_root" merge-base --is-ancestor "$branch_name" "$upstream_default" 2>/dev/null; then
      WT_DELIVERY_MERGED_INTO_DEFAULT=1
    fi
  else
    WT_DELIVERY_DEFAULT_REF_LABEL="HEAD"
    if git -C "$main_root" merge-base --is-ancestor "$branch_name" HEAD 2>/dev/null; then
      WT_DELIVERY_MERGED_INTO_DEFAULT=1
    fi
  fi

  remote_ref="refs/remotes/origin/$branch_name"
  WT_DELIVERY_REMOTE_REF="$remote_ref"
  if [[ -n "$local_head" ]] && git -C "$main_root" rev-parse --verify --quiet "$remote_ref" >/dev/null 2>&1; then
    if git -C "$main_root" merge-base --is-ancestor "$local_head" "$remote_ref" 2>/dev/null; then
      WT_DELIVERY_PUSHED_AND_IN_SYNC=1
    fi
  else
    WT_DELIVERY_REMOTE_REF=""
  fi

  if [[ "$WT_DELIVERY_MERGED_INTO_DEFAULT" == "1" || "$WT_DELIVERY_PUSHED_AND_IN_SYNC" == "1" ]]; then
    WT_DELIVERY_OK=1
    return 0
  fi

  if git -C "$main_root" rev-parse --verify --quiet "refs/remotes/origin/$branch_name" >/dev/null 2>&1; then
    WT_DELIVERY_REFUSE_REASON="$branch_name has local commits not pushed to origin/$branch_name; push first (or merge into $WT_DELIVERY_DEFAULT_REF_LABEL)"
  else
    WT_DELIVERY_REFUSE_REASON="$branch_name not merged into $WT_DELIVERY_DEFAULT_REF_LABEL and not pushed to origin; push or merge first"
  fi
  return 1
}
