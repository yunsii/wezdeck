#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"

usage() {
  cat <<'EOF' >&2
usage:
  start-managed-codex.sh [--prompt-file FILE] [--variant auto|light|dark]
EOF
}

resolve_login_shell() {
  if [[ -n "${WEZTERM_MANAGED_SHELL:-}" && -x "${WEZTERM_MANAGED_SHELL:-}" ]]; then
    printf '%s\n' "$WEZTERM_MANAGED_SHELL"
    return 0
  fi

  if [[ -n "${SHELL:-}" && -x "${SHELL:-}" ]]; then
    printf '%s\n' "$SHELL"
    return 0
  fi

  local candidate
  for candidate in /bin/zsh /usr/bin/zsh /bin/bash /usr/bin/bash /bin/sh /usr/bin/sh; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  printf '/bin/sh\n'
}

resolve_variant() {
  local requested="${1:-auto}"
  local session_name=""
  local session_command=""

  case "$requested" in
    light|dark)
      printf '%s\n' "$requested"
      return 0
      ;;
    auto)
      ;;
    *)
      printf 'invalid variant: %s\n' "$requested" >&2
      exit 1
      ;;
  esac

  case "${WEZTERM_MANAGED_CODEX_VARIANT:-}" in
    light|dark)
      printf '%s\n' "$WEZTERM_MANAGED_CODEX_VARIANT"
      return 0
      ;;
  esac

  if [[ -n "${TMUX:-}" ]]; then
    session_name="$(tmux display-message -p '#{session_name}' 2>/dev/null || true)"
    if [[ -n "$session_name" ]]; then
      session_command="$(tmux show-options -qv -t "$session_name" @wezterm_primary_shell_command 2>/dev/null || true)"
      case "$session_command" in
        *'tui.theme="github"'*|*'codex-github-theme'*)
          printf 'light\n'
          return 0
          ;;
        *'codex'*)
          printf 'dark\n'
          return 0
          ;;
      esac
    fi
  fi

  printf 'light\n'
}

variant="auto"
prompt_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt-file)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      prompt_file="$2"
      shift 2
      ;;
    --variant)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      variant="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

resolved_variant="$(resolve_variant "$variant")"
login_shell="$(resolve_login_shell)"
prompt_arg=""

if [[ -n "$prompt_file" ]]; then
  [[ -f "$prompt_file" ]] || { printf 'prompt file does not exist: %s\n' "$prompt_file" >&2; exit 1; }
  prompt_arg="$(< "$prompt_file")"
fi

command=("$SCRIPT_DIR/run-managed-command.sh")
case "$resolved_variant" in
  light)
    command+=("codex-github-theme")
    ;;
  dark)
    command+=("--bootstrap" "nvm" "codex")
    ;;
esac

if [[ -n "$prompt_file" ]]; then
  command+=("$prompt_arg")
fi

runtime_log_info worktree "starting managed codex" "variant=$resolved_variant" "has_prompt=$([[ -n "$prompt_file" ]] && printf yes || printf no)"

status=0
if ! "${command[@]}"; then
  status=$?
  runtime_log_warn worktree "managed codex exited with failure" "status=$status" "variant=$resolved_variant"
else
  runtime_log_info worktree "managed codex exited normally" "variant=$resolved_variant"
fi

exec "$login_shell" -l
