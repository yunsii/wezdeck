#!/usr/bin/env bash
# Soft + hard preflight report for worktree recycle (skill layer).
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

wr_preflight_attention_hint() {
  # Soft only: best-effort peek at attention state files; never hard-fail.
  local state_dir="${WEZTERM_RUNTIME_STATE_DIR:-$HOME/.local/state/wezterm-runtime}"
  local attention_root="$state_dir/state/agent-attention"
  [[ -d "$attention_root" ]] || return 0
  if grep -R --include='*.json' -l '"waiting"' "$attention_root" >/dev/null 2>&1; then
    printf '  soft: attention has waiting entr(y/ies) under %s — confirm before recycle\n' "$attention_root"
  fi
}

wr_preflight_delegate_hint() {
  local worktree_root="${1:?}"
  if [[ -d "$worktree_root/.delegate" ]]; then
    printf 'delegate: %s/.delegate present (will be cleaned by allowlist; ensure ticket is closed/shipped)\n' "$worktree_root"
  fi
}

wr_preflight_brief_hint() {
  local worktree_root="${1:?}"
  local brief="$worktree_root/.task-brief.md"
  if [[ -f "$brief" ]]; then
    printf 'brief: existing %s will be removed by clean allowlist unless --no-clean-files\n' "$brief"
  fi
}

wr_preflight_run() {
  local cwd="${1:-$PWD}"
  local json="${2:-0}"
  local worktree_root=""
  local slug=""
  local cli="${WR_WORKTREE_TASK_CLI:?missing WR_WORKTREE_TASK_CLI}"
  local dry_out=""
  local dry_rc=0
  local blockers=0

  worktree_root="$(wr_preflight_resolve_worktree "$cwd")" \
    || { printf 'preflight: not a git worktree: %s\n' "$cwd" >&2; return 2; }
  slug="$(wr_preflight_slug "$worktree_root")"

  printf 'preflight\n'
  printf '  cwd: %s\n' "$worktree_root"
  printf '  slug: %s\n' "$slug"

  case "$slug" in
    dev-*)
      printf '  lifecycle: long-lived workstation (recycle OK)\n'
      ;;
    task-*|hotfix-*)
      printf '  blocker: %s is short-lived — use worktree-task reclaim / Ctrl+k g r\n' "$slug"
      blockers=1
      ;;
    *)
      printf '  blocker: slug %s is not a managed dev-* workstation\n' "$slug"
      blockers=1
      ;;
  esac

  wr_preflight_delegate_hint "$worktree_root"
  wr_preflight_brief_hint "$worktree_root"
  wr_preflight_attention_hint

  # Hard gates via the real CLI dry-run (single source with recycle).
  set +e
  dry_out="$(
    WEZDECK_REPO="${WEZDECK_REPO:-${WR_WEZDECK_REPO:-}}" \
    WT_RECYCLE_NO_CONFIRM=1 \
      "$cli" recycle --cwd "$worktree_root" --dry-run 2>&1
  )"
  dry_rc=$?
  set -e

  printf '  recycle --dry-run (exit %s):\n' "$dry_rc"
  while IFS= read -r line; do
    printf '    %s\n' "$line"
  done <<<"$dry_out"

  if [[ "$dry_rc" -ne 0 ]]; then
    blockers=1
  fi

  if [[ "$json" == "1" ]]; then
    printf '{"worktree":%s,"slug":%s,"blockers":%s,"dry_run_exit":%s}\n' \
      "$(printf '%s' "$worktree_root" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
      "$(printf '%s' "$slug" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
      "$blockers" \
      "$dry_rc"
  fi

  if [[ "$blockers" -ne 0 ]]; then
    printf 'preflight: BLOCKED\n'
    return 1
  fi
  printf 'preflight: OK\n'
  return 0
}
