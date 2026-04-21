#!/usr/bin/env bash
# open-task-window.sh — thin runtime wrapper that delegates to the
# `worktree-task` skill's `open-task-window` script, which owns the logic for
# creating or reusing a linked worktree for <branch> and opening it as a new
# tmux window in the current repo-family session.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/../../skills/worktree-task/scripts/open-task-window"

exec "$SKILL_SCRIPT" "$@"
