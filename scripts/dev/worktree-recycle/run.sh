#!/usr/bin/env bash
# worktree-recycle runner — soft preflight + worktree-task recycle.
# Project init is opt-in (--with-init); follow-up tasks bootstrap as needed.
set -euo pipefail

# Resolve through symlinks so ~/.agents/skills/worktree-recycle → this checkout
# owns TOOL_HOME (and therefore the co-located worktree-task), not $HOME/../...
_wr_src="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1; then
  _wr_src="$(readlink -f "$_wr_src" 2>/dev/null || printf '%s' "$_wr_src")"
fi
TOOL_HOME="$(cd "$(dirname "$_wr_src")" && pwd)"
unset _wr_src
# shellcheck disable=SC1091
source "$TOOL_HOME/lib/preflight.sh"
# shellcheck disable=SC1091
source "$TOOL_HOME/lib/init.sh"

wr_die() {
  printf 'worktree-recycle: %s\n' "$*" >&2
  exit 1
}

wr_resolve_wezdeck_repo() {
  local candidate=""
  if [[ -n "${WEZDECK_REPO:-}" && -f "${WEZDECK_REPO}/scripts/runtime/worktree/worktree-task" ]]; then
    printf '%s\n' "$(cd "$WEZDECK_REPO" && pwd -P)"
    return 0
  fi
  # Prefer the wezdeck checkout that owns this skill (…/scripts/dev/worktree-recycle).
  candidate="$(cd "$TOOL_HOME/../../.." && pwd -P)"
  if [[ -f "$candidate/scripts/runtime/worktree/worktree-task" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  for candidate in \
    "${WEZDECK_ROOT:-}" \
    "$HOME/github/wezterm-config" \
    "$HOME/github/.worktrees/wezterm-config/dev-agent"; do
    [[ -n "$candidate" ]] || continue
    if [[ -f "$candidate/scripts/runtime/worktree/worktree-task" ]]; then
      printf '%s\n' "$(cd "$candidate" && pwd -P)"
      return 0
    fi
  done
  return 1
}

wr_resolve_cli() {
  local wezdeck=""
  wezdeck="$(wr_resolve_wezdeck_repo)" || wr_die "cannot locate wezdeck worktree-task CLI; set WEZDECK_REPO"
  WR_WEZDECK_REPO="$wezdeck"
  WR_WORKTREE_TASK_CLI="$wezdeck/scripts/runtime/worktree/worktree-task"
  [[ -x "$WR_WORKTREE_TASK_CLI" ]] || wr_die "worktree-task not executable: $WR_WORKTREE_TASK_CLI"
  export WR_WEZDECK_REPO WR_WORKTREE_TASK_CLI
  export WEZDECK_REPO="${WEZDECK_REPO:-$WR_WEZDECK_REPO}"
}

wr_usage() {
  cat <<'EOF'
usage:
  run.sh preflight [--cwd PATH] [--json]
  run.sh recycle  [--cwd PATH] [-y] [--task TEXT] [--fresh-agent] [--force] [--dry-run]
                  [--keep-temp-branches] [--no-clean-files] [--no-sync-remote]
                  [--keep-branch-name] [--require-delivered] [--with-init]
  run.sh init     [--cwd PATH]
  run.sh selfcheck

Orchestrates soft preflight → worktree-task recycle.
Project init is skipped by default; pass --with-init to run it.
EOF
}

cmd_preflight() {
  local cwd="$PWD"
  local json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd)
        [[ $# -ge 2 ]] || wr_die "--cwd needs a path"
        cwd="$2"
        shift 2
        ;;
      --json)
        json=1
        shift
        ;;
      -h|--help)
        wr_usage
        exit 0
        ;;
      *)
        wr_die "unknown preflight arg: $1"
        ;;
    esac
  done
  wr_resolve_cli
  wr_preflight_run "$cwd" "$json"
}

cmd_recycle() {
  local cwd="$PWD"
  local passthrough=()
  local do_init=0
  local dry_run=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd)
        [[ $# -ge 2 ]] || wr_die "--cwd needs a path"
        cwd="$2"
        shift 2
        ;;
      --dry-run)
        dry_run=1
        passthrough+=(--dry-run)
        shift
        ;;
      --task|--title)
        [[ $# -ge 2 ]] || wr_die "$1 needs a value"
        passthrough+=(--task "$2")
        shift 2
        ;;
      --fresh-agent|--force|--keep-temp-branches|--no-clean-files|--no-sync-remote|--keep-branch-name|--require-delivered|-y|--yes)
        passthrough+=("$1")
        shift
        ;;
      --with-init)
        do_init=1
        shift
        ;;
      --skip-init)
        # Kept for backward compatibility; init is already off by default.
        do_init=0
        shift
        ;;
      -h|--help)
        wr_usage
        exit 0
        ;;
      *)
        wr_die "unknown recycle arg: $1"
        ;;
    esac
  done

  wr_resolve_cli

  # Soft report first (non-fatal for --dry-run / explicit -y with prior user confirm).
  if ! wr_preflight_run "$cwd" 0; then
    if [[ "$dry_run" == "1" ]]; then
      return 1
    fi
    # If caller passed -y/--yes, they already accepted responsibility after skill procedure.
    local has_yes=0
    local arg
    for arg in "${passthrough[@]+"${passthrough[@]}"}"; do
      case "$arg" in
        -y|--yes) has_yes=1 ;;
      esac
    done
    if [[ "$has_yes" != "1" ]]; then
      wr_die "preflight blocked; fix blockers or re-run with an explicit -y after user override"
    fi
    printf 'worktree-recycle: preflight blocked but -y given; continuing under user override\n' >&2
  fi

  WT_RECYCLE_NO_CONFIRM=1 \
    "$WR_WORKTREE_TASK_CLI" recycle --cwd "$cwd" "${passthrough[@]+"${passthrough[@]}"}"

  if [[ "$dry_run" == "1" || "$do_init" != "1" ]]; then
    return 0
  fi
  wr_init_run "$cwd"
}

cmd_init() {
  local cwd="$PWD"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd)
        [[ $# -ge 2 ]] || wr_die "--cwd needs a path"
        cwd="$2"
        shift 2
        ;;
      -h|--help)
        wr_usage
        exit 0
        ;;
      *)
        wr_die "unknown init arg: $1"
        ;;
    esac
  done
  wr_resolve_cli
  wr_init_run "$cwd"
}

cmd_selfcheck() {
  wr_resolve_cli
  printf 'TOOL_HOME=%s\n' "$TOOL_HOME"
  printf 'WEZDECK_REPO=%s\n' "$WR_WEZDECK_REPO"
  printf 'worktree-task=%s\n' "$WR_WORKTREE_TASK_CLI"
  "$WR_WORKTREE_TASK_CLI" -h >/dev/null
  "$WR_WORKTREE_TASK_CLI" recycle -h >/dev/null
  printf 'selfcheck: ok\n'
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    preflight) cmd_preflight "$@" ;;
    recycle) cmd_recycle "$@" ;;
    init) cmd_init "$@" ;;
    selfcheck) cmd_selfcheck "$@" ;;
    -h|--help|help|'') wr_usage ;;
    *)
      wr_usage >&2
      exit 1
      ;;
  esac
}

main "$@"
