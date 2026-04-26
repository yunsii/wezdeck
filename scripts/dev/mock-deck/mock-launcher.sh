#!/usr/bin/env bash
# Per-tab agent wrapper for the `mock-deck` WezDeck workspace.
#
# `wezterm-x/local/workspaces.lua` declares each mock-deck item with:
#   command = { '<repo>/scripts/dev/mock-deck/mock-launcher.sh',
#               '<project>', '<slot>' }
# project_session_args appends those parts after `open-project-session.sh
# <workspace> <cwd>`, so when WezDeck spawns the tab the tmux pane ends
# up running this script. We translate (project, slot) → tape path and
# exec mock-agent.sh, which streams the tape and drives the real attention
# pipeline using the spawned pane's actual coordinates.

set -eu

project="${1:-}"
slot="${2:-1}"
[[ -n "$project" ]] || { echo "mock-launcher: missing project arg" >&2; exit 2; }

script_dir="$(cd "$(dirname "$0")" && pwd)"
tape="$script_dir/tapes/${project}-${slot}.tape"
[[ -f "$tape" ]] || { echo "mock-launcher: tape not found: $tape" >&2; exit 1; }

# Default state dir matches the orchestrator's. mock-agent.sh consults
# files under here for the hero sentinel + log path.
: "${MOCK_DECK_STATE_DIR:=$HOME/.cache/wezdeck/mock-deck-state}"
: "${MOCK_DECK_LOG:=$MOCK_DECK_STATE_DIR/run.log}"
mkdir -p "$MOCK_DECK_STATE_DIR"
export MOCK_DECK_STATE_DIR MOCK_DECK_LOG

exec env MOCK_DECK_SLOT="$slot" "$script_dir/mock-agent.sh" "$tape" "$project"
