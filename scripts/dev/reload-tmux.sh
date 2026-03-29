#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMUX_CONF="$SCRIPT_DIR/../../tmux.conf"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

tmux set-option -g @wezterm_repo_root "$REPO_ROOT"
tmux source-file "$TMUX_CONF"
printf 'Reloaded tmux config: %s\n' "$TMUX_CONF"
