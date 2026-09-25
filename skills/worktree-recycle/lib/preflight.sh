#!/usr/bin/env bash
# Soft + hard preflight report for worktree recycle (skill layer).
# Fast path: local checks only — no recycle --dry-run (avoids double fetch).
# shellcheck shell=bash

wr_preflight_resolve_worktree() {
  local cwd="${1:-$PWD}"
  local root=""
  root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "$root" ]] || return 1
  printf '%s\n' "$root"
}

wr_preflight_slug() {
  basename "${1:?}"
}

wr_preflight_is_primary() {
  local worktree_root="${1:?}"
  local primary_toplevel=""
  # First porcelain worktree entry is the primary checkout.
  primary_toplevel="$(git -C "$worktree_root" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')"
  [[ -n "$primary_toplevel" ]] || return 1
  [[ "$(cd "$worktree_root" && pwd -P)" == "$(cd "$primary_toplevel" && pwd -P)" ]]
}

wr_preflight_delegate_hint() {
  local worktree_root="${1:?}"
  if [[ -d "$worktree_root/.delegate" ]]; then
    printf '  soft: %s/.delegate present (will be cleaned by allowlist; ensure ticket is closed/shipped)\n' "$worktree_root"
  fi
}

wr_preflight_brief_hint() {
  local worktree_root="${1:?}"
  local brief="$worktree_root/.task-brief.md"
  if [[ -f "$brief" ]]; then
    printf '  soft: existing %s will be removed by clean allowlist unless --no-clean-files\n' "$brief"
  fi
}

wr_preflight_dirty_hint() {
  local worktree_root="${1:?}"
  local count=0
  count="$(git -C "$worktree_root" status --porcelain --untracked-files=all 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "${count:-0}" -gt 0 ]]; then
    printf '  note: dirty entries=%s (recycle refuses unless --force / allowlisted clean)\n' "$count"
  fi
}

wr_preflight_run() {
  local cwd="${1:-$PWD}"
  local json="${2:-0}"
  local worktree_root=""
  local slug=""
  local blockers=0
  local is_primary=0
  local branch=""
  local expected=""

  worktree_root="$(wr_preflight_resolve_worktree "$cwd")" \
    || { printf 'preflight: not a git worktree: %s\n' "$cwd" >&2; return 2; }
  slug="$(wr_preflight_slug "$worktree_root")"
  branch="$(git -C "$worktree_root" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"

  printf 'preflight\n'
  printf '  cwd: %s\n' "$worktree_root"
  printf '  slug: %s\n' "$slug"
  printf '  branch: %s\n' "${branch:-(detached)}"

  if wr_preflight_is_primary "$worktree_root"; then
    is_primary=1
    printf '  lifecycle: primary worktree (fast reset onto origin/HEAD)\n'
  else
    case "$slug" in
      dev-*)
        printf '  lifecycle: long-lived workstation (recycle OK)\n'
        expected="${slug#dev-}"
        expected="dev/${expected}"
        if [[ -n "$branch" && "$branch" != "$expected" ]]; then
          printf '  note: branch will align %s → %s\n' "$branch" "$expected"
        fi
        ;;
      task-*|hotfix-*)
        printf '  blocker: %s is short-lived — use worktree-task reclaim / Ctrl+k g r\n' "$slug"
        blockers=1
        ;;
      *)
        printf '  blocker: slug %s is not primary or a managed dev-* workstation\n' "$slug"
        blockers=1
        ;;
    esac
  fi

  if [[ "$is_primary" != "1" ]]; then
    wr_preflight_delegate_hint "$worktree_root"
    wr_preflight_brief_hint "$worktree_root"
  fi
  wr_preflight_dirty_hint "$worktree_root"
  printf '  delivery: skipped on fast path (pass --require-delivered to recycle if needed)\n'

  if [[ "$json" == "1" ]]; then
    printf '{"worktree":%s,"slug":%s,"primary":%s,"blockers":%s}\n' \
      "$(printf '%s' "$worktree_root" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
      "$(printf '%s' "$slug" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
      "$is_primary" \
      "$blockers"
  fi

  if [[ "$blockers" -ne 0 ]]; then
    printf 'preflight: BLOCKED\n'
    return 1
  fi
  printf 'preflight: OK\n'
  return 0
}
