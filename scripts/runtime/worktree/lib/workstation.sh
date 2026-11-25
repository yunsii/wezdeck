#!/usr/bin/env bash
# workstation.sh — every linked worktree is a workstation for one direction
# (ux, ci, i18n …): directory <name> under WT_POLICY_WORKTREE_DIR, branch
# WT_POLICY_BRANCH_PREFIX<name> (dev/<name>), a one-line purpose in the git
# branch description (`git branch --edit-description`, branch.<b>.description
# in the shared config: every worktree reads it, recycle keeps it).
#
# Directories made before 2026-11-25 carry a `dev-` lifecycle prefix; they
# keep it on disk (Claude / Codex transcripts, attention rows and resume pins
# are keyed by that path) and only displays drop it (wt_workstation_name).
# `ticket-*` (agent-collab) and `claw-*` (OpenClaw) belong to other owners.
#
# A direction may hold several workstations (parallel slots): ux, ux-2,
# ux-3 … Membership is explicit — branch.<b>.workstationDirection in the
# shared config, written when a slot is opened next to an existing one —
# never guessed from a -N suffix (a direction may itself be called ci-2).
# A workstation without the key is its own direction.
# shellcheck shell=bash

# 0 when the slug belongs to another owner, not a workstation.
wt_workstation_reserved() {
  case "${1:-}" in
    ticket-*|claw-*) return 0 ;;
  esac
  return 1
}

# The direction name a slug stands for: `dev-ux` (made before 2026-11-25)
# and `ux` both → ux.
wt_workstation_name() {
  local slug="${1:-}"
  case "$slug" in
    dev-?*) printf '%s\n' "${slug#dev-}" ;;
    *) printf '%s\n' "$slug" ;;
  esac
}

# The branch a workstation slug maps to (recycle aligns to it).
wt_workstation_branch() {
  local slug="${1:?missing slug}"
  local name
  name="$(wt_workstation_name "$slug")"
  [[ -n "$name" ]] || return 1
  printf '%s%s\n' "${WT_POLICY_BRANCH_PREFIX:-dev/}" "$name"
}

# One line, at most 120 characters: the purpose shown next to the name.
wt_workstation_clean_description() {
  local text="${1:-}"
  text="${text//$'\r'/ }"
  text="${text//$'\n'/ }"
  text="${text//$'\t'/ }"
  text="$(printf '%s' "$text" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  printf '%s\n' "${text:0:120}"
}

# Set (or with empty text, clear) the purpose of <branch> in <repo>.
wt_workstation_set_description() {
  local repo="${1:?missing repo}" branch="${2:?missing branch}" text
  text="$(wt_workstation_clean_description "${3:-}")"
  if [[ -n "$text" ]]; then
    git -C "$repo" config "branch.$branch.description" "$text"
  else
    git -C "$repo" config --unset "branch.$branch.description" 2>/dev/null || true
  fi
}

wt_workstation_description() {
  local repo="${1:?missing repo}" branch="${2:?missing branch}"
  git -C "$repo" config --get "branch.$branch.description" 2>/dev/null || true
}

# Plan a new workstation from what was typed (requires the repo context and
# policy paths: wt_core_resolve_repo_context + wt_config_load +
# wt_core_resolve_policy_paths). Sets
#   WT_PLAN_NAME    the direction as typed, without a dev- / dev/ prefix
#   WT_PLAN_SLUG    directory name (bumped -2, -3 … on a collision)
#   WT_PLAN_BRANCH  WT_POLICY_BRANCH_PREFIX + WT_PLAN_SLUG
#   WT_PLAN_BUMPED  1 when the plain name was taken
#   WT_PLAN_TAKEN   the existing directory that took it (also a dev-<name>
#                   one from before 2026-11-25), empty when none
#   WT_PLAN_ERROR   why the name cannot be used ("" when it can)
#   WT_PLAN_PARALLEL_OF  the direction when the name is an existing
#                   workstation's (this opens a parallel slot), else ""
#   WT_PLAN_PARALLEL_DESCRIPTION  that direction's purpose, to inherit
# The same walk as worktree-task launch's default naming, so the preview in
# create-prompt names exactly what open-task-window creates.
wt_workstation_plan() {
  local raw="${1:-}" slug suffix=1 base
  WT_PLAN_NAME="" WT_PLAN_SLUG="" WT_PLAN_BRANCH="" WT_PLAN_BUMPED=0 WT_PLAN_TAKEN="" WT_PLAN_ERROR=""
  WT_PLAN_PARALLEL_OF="" WT_PLAN_PARALLEL_DESCRIPTION=""

  raw="$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$raw" in
    dev/*) raw="${raw#dev/}" ;;
    dev-*) raw="${raw#dev-}" ;;
  esac
  WT_PLAN_NAME="$raw"
  [[ -n "$raw" ]] || { WT_PLAN_ERROR="empty"; return 1; }

  # wt_slugify's rule without its fallback ("" → "task" there): a name of
  # only Chinese must fail here, not become a directory called task
  base="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | LC_ALL=C tr -cs 'a-z0-9' '-')"
  base="${base#-}"
  base="${base%-}"
  if [[ -z "$base" ]]; then
    WT_PLAN_ERROR="the name needs letters or digits (it becomes the directory and branch); put the rest in the description"
    return 1
  fi
  if wt_workstation_reserved "$base"; then
    WT_PLAN_ERROR="ticket-* / claw-* belong to agent-collab / OpenClaw; pick another name"
    return 1
  fi

  if [[ -e "$WT_POLICY_WORKTREE_DIR_ABS/$base" ]]; then
    WT_PLAN_TAKEN="$WT_POLICY_WORKTREE_DIR_ABS/$base"
  elif [[ -e "$WT_POLICY_WORKTREE_DIR_ABS/dev-$base" ]]; then
    WT_PLAN_TAKEN="$WT_POLICY_WORKTREE_DIR_ABS/dev-$base"
  fi

  slug="$base"
  while [[ -e "$WT_POLICY_WORKTREE_DIR_ABS/$slug" ]] \
    || [[ -e "$WT_POLICY_WORKTREE_DIR_ABS/dev-$slug" ]] \
    || wt_git_branch_exists "$WT_MAIN_WORKTREE_ROOT" "${WT_POLICY_BRANCH_PREFIX}${slug}"; do
    suffix=$((suffix + 1))
    slug="${base}-${suffix}"
  done
  WT_PLAN_SLUG="$slug"
  WT_PLAN_BRANCH="${WT_POLICY_BRANCH_PREFIX}${slug}"
  [[ "$slug" == "$base" ]] || WT_PLAN_BUMPED=1
  # the name is an existing workstation's: this is a parallel slot of its
  # direction (marked, and it inherits the purpose unless one is typed)
  WT_PLAN_PARALLEL_OF="" WT_PLAN_PARALLEL_DESCRIPTION=""
  if [[ -n "$WT_PLAN_TAKEN" ]]; then
    local taken_branch
    taken_branch="$(wt_workstation_branch_of "$WT_PLAN_TAKEN")"
    if [[ -n "$taken_branch" ]]; then
      WT_PLAN_PARALLEL_OF="$(wt_workstation_direction "$WT_MAIN_WORKTREE_ROOT" "$taken_branch" "$(basename "$WT_PLAN_TAKEN")")"
      WT_PLAN_PARALLEL_DESCRIPTION="$(wt_workstation_description "$WT_MAIN_WORKTREE_ROOT" "$taken_branch")"
    fi
  fi
  return 0
}

# The direction a workstation belongs to: its workstationDirection key, else
# its own name (slug without an old dev- prefix).
wt_workstation_direction() {
  local repo="${1:?missing repo}" branch="${2:?missing branch}" slug="${3:-}" dir
  dir="$(git -C "$repo" config --get "branch.$branch.workstationDirection" 2>/dev/null || true)"
  if [[ -n "$dir" ]]; then
    printf '%s\n' "$dir"
  else
    wt_workstation_name "${slug:-${branch#"${WT_POLICY_BRANCH_PREFIX:-dev/}"}}"
  fi
}

wt_workstation_set_direction() {
  local repo="${1:?missing repo}" branch="${2:?missing branch}" dir="${3:?missing direction}"
  git -C "$repo" config "branch.$branch.workstationDirection" "$dir"
}

# The branch of the workstation directory that took a name (WT_PLAN_TAKEN),
# empty when it has none.
wt_workstation_branch_of() {
  git -C "${1:?missing worktree}" symbolic-ref --quiet --short HEAD 2>/dev/null || true
}

# The workstations of a direction, one "<path>\t<branch>" line each (git
# worktree list order). The primary checkout and ticket-* / claw-* are never
# members.
wt_workstation_slots() {
  local repo="${1:?missing repo}" want="${2:?missing direction}" line path="" branch="" main
  main="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  main="${main%/.git}"
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "worktree "*) path="${line#worktree }"; branch="" ;;
      "branch refs/heads/"*) branch="${line#branch refs/heads/}" ;;
      "")
        if [[ -n "$path" && -n "$branch" && "$path" != "$main" ]] \
          && ! wt_workstation_reserved "$(basename "$path")" \
          && [[ "$(wt_workstation_direction "$repo" "$branch" "$(basename "$path")")" == "$want" ]]; then
          printf '%s\t%s\n' "$path" "$branch"
        fi
        path="" branch=""
        ;;
    esac
  done < <(git -C "$repo" worktree list --porcelain 2>/dev/null; echo)
}
