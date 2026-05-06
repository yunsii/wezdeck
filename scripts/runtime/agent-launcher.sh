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
case "$agent" in
  claude)
    exec sh -c 'claude --continue || exec claude'
    ;;
  codex)
    exec sh -c 'codex resume --last || exec codex'
    ;;
  codex-light)
    exec sh -c "codex -c 'tui.theme=\"github\"' resume --last || exec codex -c 'tui.theme=\"github\"'"
    ;;
  *)
    printf 'agent-launcher: unknown agent %s\n' "$agent" >&2
    printf 'usage: agent-launcher.sh <claude|codex|codex-light>\n' >&2
    exit 1
    ;;
esac
