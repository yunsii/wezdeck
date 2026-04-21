# shellcheck shell=bash
# Sourceable prompt hook that asks tmux to refresh its status line after every
# shell command, so branch and git-change counters catch up immediately after
# `git` operations instead of waiting for the 30s background poll. Safe to
# re-source and a no-op outside tmux.

if [ -z "${TMUX:-}" ]; then
  return 0 2>/dev/null || exit 0
fi

__tmux_status_prompt_hook_root="$(tmux show -gv @wezterm_runtime_root 2>/dev/null || true)"
if [ -z "$__tmux_status_prompt_hook_root" ] || [ ! -f "$__tmux_status_prompt_hook_root/scripts/runtime/tmux-status-refresh.sh" ]; then
  unset __tmux_status_prompt_hook_root
  return 0 2>/dev/null || exit 0
fi

__tmux_status_prompt_refresh() {
  [ -n "${TMUX:-}" ] || return 0
  [ -n "${__tmux_status_prompt_hook_root:-}" ] || return 0

  local pane="${TMUX_PANE:-}"
  local script="$__tmux_status_prompt_hook_root/scripts/runtime/tmux-status-refresh.sh"
  if [ -n "$pane" ]; then
    ( bash "$script" --force --refresh-client --pane "$pane" >/dev/null 2>&1 & ) >/dev/null 2>&1
  else
    ( bash "$script" --force --refresh-client >/dev/null 2>&1 & ) >/dev/null 2>&1
  fi
}

if [ -n "${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook 2>/dev/null
  if typeset -f add-zsh-hook >/dev/null 2>&1; then
    add-zsh-hook -d precmd __tmux_status_prompt_refresh 2>/dev/null
    add-zsh-hook precmd __tmux_status_prompt_refresh
  fi
elif [ -n "${BASH_VERSION:-}" ]; then
  case ";${PROMPT_COMMAND:-};" in
    *";__tmux_status_prompt_refresh;"*) ;;
    *) PROMPT_COMMAND="__tmux_status_prompt_refresh${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
fi
