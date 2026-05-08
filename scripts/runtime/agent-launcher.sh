#!/usr/bin/env bash
# agent-launcher.sh — entry point for managed agent panes spawned by tmux.
#
# Bash-only: the sourced runtime-env-lib.sh uses `[[`, `${var:0:1}` substring
# expansion, and `shopt -s nullglob`. Don't switch this shebang back to `sh`
# without also rewriting the lib in pure POSIX.
#
# Why this script exists:
#   Several launch paths fork the agent via `tmux new-window <cmd>` / tmux
#   respawn-pane, where tmux runs `<cmd>` through a plain `sh -c` direct
#   from the server process. That `sh` traverses no shell rc files, so
#   secrets exported by the user's ~/.zshrc (CNB_TOKEN from
#   ~/.config/cnb/env, etc.) never reach the agent or its child scripts —
#   leading to e.g. `npm view @coco/x-server` returning 401 inside the
#   agent's Bash tool while the same command works in the user's shell.
#
#   This script is the one place we explicitly load runtime env files
#   before exec'ing into the resume-or-fresh agent command. All managed
#   profiles in config/worktree-task.env reference it via
#   ${WEZTERM_REPO}/scripts/runtime/agent-launcher.sh <agent>, so every
#   path (Alt+g on-demand, refresh-current-window, tab-overflow,
#   workspace first-open) shares the same env view.
#
# Usage:
#   agent-launcher.sh <claude|codex|codex-light>

set -eu

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck disable=SC1091
. "$script_dir/runtime-env-lib.sh"
runtime_env_load_managed

agent="${1:-}"

# Visible boot cue. Until the agent CLI paints its first frame, the pane
# is blank — that's the shell-chain forks (~150ms, mainly `zsh -ilc`
# inheriting interactive PATH) plus the agent's own session-resume load
# (0.5-3s for `claude --continue`, similar for `codex resume --last`).
# Printing one dim line turns "blank pane for several seconds" into
# "pane shows what it's doing"; the agent's first paint typically clears
# the screen, so the banner is only visible while it's actually useful.
# This script is the universal terminus for every managed-agent launch
# path (workspace first-open, refresh-current-window, Alt+g on-demand,
# tab-overflow cold-spawn, worktree-task), so the cue lands once
# regardless of which entry point the user took. Disable with
# WEZTERM_NO_LOADING_BANNER=1 if it ever interferes.
print_loading_banner() {
  [[ -t 1 ]] || return 0
  [[ "${WEZTERM_NO_LOADING_BANNER:-}" == "1" ]] && return 0

  local label="$1"
  [[ -n "$label" ]] || label="agent"

  # \033[2J\033[H = clear + home so the banner anchors at top-left even
  # if the parent shell painted a prompt bit before this. Two newlines
  # of leading padding so the banner sits a couple rows down instead of
  # hugging the very top edge.
  printf '\033[2J\033[H\n\n  \033[2;36mLoading %s ...\033[0m\n' "$label"
}

print_loading_banner "$agent"

# Fallback re-paint: when `--continue` (or `resume --last`) finds no
# session, the CLI prints "No conversation found to continue" to the
# primary screen and exits non-zero. The fresh `<agent>`'s welcome card
# also renders on the primary screen (alt-screen is only entered once
# the user starts chatting), so without a re-clear the loading banner
# + error line stay visible above the welcome box. Re-clear and re-draw
# the banner inside the `||` branch so the fallback path looks the same
# as the resume-success path.
case "$agent" in
  claude)
    exec sh -c 'claude --continue || { printf "\033[2J\033[H\n\n  \033[2;36mLoading claude ...\033[0m\n"; exec claude; }'
    ;;
  codex)
    exec sh -c 'codex resume --last || { printf "\033[2J\033[H\n\n  \033[2;36mLoading codex ...\033[0m\n"; exec codex; }'
    ;;
  codex-light)
    exec sh -c "codex -c 'tui.theme=\"github\"' resume --last || { printf '\033[2J\033[H\n\n  \033[2;36mLoading codex-light ...\033[0m\n'; exec codex -c 'tui.theme=\"github\"'; }"
    ;;
  *)
    printf 'agent-launcher: unknown agent %s\n' "$agent" >&2
    printf 'usage: agent-launcher.sh <claude|codex|codex-light>\n' >&2
    exit 1
    ;;
esac
