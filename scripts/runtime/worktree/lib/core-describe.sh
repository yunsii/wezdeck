#!/usr/bin/env bash
# core-describe.sh — worktree-task describe: a workstation's one-line purpose.
# shellcheck shell=bash

wt_core_describe() {
  local cwd="$PWD" mode="get" text="" root branch

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd)
        [[ $# -ge 2 ]] || { wt_core_describe_usage >&2; exit 1; }
        cwd="$2"
        shift 2
        ;;
      --set)
        [[ $# -ge 2 ]] || { wt_core_describe_usage >&2; exit 1; }
        mode="set"
        text="$2"
        shift 2
        ;;
      --clear)
        mode="clear"
        shift
        ;;
      -h|--help)
        wt_core_describe_usage
        return 0
        ;;
      *)
        wt_core_describe_usage >&2
        exit 1
        ;;
    esac
  done

  root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" || wt_die "not inside a git worktree: $cwd"
  branch="$(git -C "$root" symbolic-ref --quiet --short HEAD 2>/dev/null)" || wt_die "detached HEAD has no branch to describe: $root"

  case "$mode" in
    get)
      wt_workstation_description "$root" "$branch"
      ;;
    set)
      text="$(wt_workstation_clean_description "$text")"
      [[ -n "$text" ]] || wt_die "empty description (use --clear to remove it)"
      wt_workstation_set_description "$root" "$branch" "$text"
      runtime_log_info task "workstation described" "branch_name=$branch" "chars=${#text}"
      printf '%s\n' "$text"
      ;;
    clear)
      wt_workstation_set_description "$root" "$branch" ""
      runtime_log_info task "workstation description cleared" "branch_name=$branch"
      ;;
  esac
}
