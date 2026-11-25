#!/usr/bin/env bash
# core-idle.sh — worktree-task idle: may this workstation start a new round
# right now without losing anything? The git half of "idle" (the web
# console's 新会话 reuses an idle workstation of the chosen direction):
#
#   clean        no uncommitted changes beyond recycle's allowlisted leftovers
#   delivered    the tip is in origin/HEAD (ancestor, or its content absorbed
#                by a squash) — merely pushed to origin/<branch> is NOT
#                enough: recycle syncs origin/<branch> to the base with
#                --force-with-lease, so unmerged pushed work would go too
#
# Whether its agent is mid-turn or waiting on you is the caller's half
# (relay: attention.json); this command never reads attention.
#
# Prints key=value lines: state (idle | dirty | undelivered | detached |
# reserved | primary), reason, name, direction, branch, ahead. Exit 0 when
# idle, 3 when not, 1 on errors.
# shellcheck shell=bash

wt_core_idle_usage() {
  cat <<'USAGE'
usage:
  worktree-task idle [--cwd PATH] [--fetch]

Report whether the workstation at PATH can start a new round now (clean and
delivered into origin/HEAD). --fetch refreshes origin first (otherwise a
just-merged tip may still read as undelivered — the safe side).
USAGE
}

wt_core_idle() {
  local cwd="$PWD" fetch=0 root main branch slug name direction state="" reason="" ahead=0
  local planned="" candidate=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd)
        [[ $# -ge 2 ]] || { wt_core_idle_usage >&2; exit 1; }
        cwd="$2"
        shift 2
        ;;
      --fetch)
        fetch=1
        shift
        ;;
      -h|--help)
        wt_core_idle_usage
        return 0
        ;;
      *)
        wt_core_idle_usage >&2
        exit 1
        ;;
    esac
  done

  root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" || wt_die "not inside a git worktree: $cwd"
  wt_core_resolve_repo_context "$root"
  wt_config_load
  main="$WT_MAIN_WORKTREE_ROOT"
  slug="$(basename "$root")"
  name="$(wt_workstation_name "$slug")"
  branch="$(git -C "$root" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  direction=""
  [[ -n "$branch" ]] && direction="$(wt_workstation_direction "$main" "$branch" "$slug")"

  if [[ "$root" == "$main" ]]; then
    state="primary" reason="the primary checkout is not a workstation"
  elif wt_workstation_reserved "$slug"; then
    state="reserved" reason="$slug belongs to agent-collab / OpenClaw"
  elif [[ -z "$branch" ]]; then
    state="detached" reason="detached HEAD"
  else
    while IFS= read -r candidate; do
      [[ -n "$candidate" ]] && planned+="$candidate"$'\n'
    done < <(wt_core_recycle_collect_clean_targets "$root" "${WT_RECYCLE_CLEAN_GLOBS:-}")
    if [[ -n "$(wt_core_recycle_blocking_dirty "$root" "$planned")" ]]; then
      state="dirty" reason="uncommitted changes"
    else
      (( fetch )) && wt_delivery_fetch_origin "$main"
      if ! wt_delivery_check "$root" "$main" "$branch" || [[ "$WT_DELIVERY_MERGED_INTO_DEFAULT" != 1 ]]; then
        ahead="$(git -C "$root" rev-list --count "${WT_DELIVERY_DEFAULT_REF_LABEL:-origin/HEAD}..HEAD" 2>/dev/null || echo 0)"
        state="undelivered" reason="$ahead commit(s) not in ${WT_DELIVERY_DEFAULT_REF_LABEL:-origin/HEAD}"
      else
        state="idle"
      fi
    fi
  fi

  printf 'state=%s\nreason=%s\nname=%s\ndirection=%s\nbranch=%s\nahead=%s\n' \
    "$state" "$reason" "$name" "$direction" "$branch" "$ahead"
  [[ "$state" == idle ]] && return 0
  return 3
}
