#!/usr/bin/env bash
# F2 / pane.scratch-float hotkey entry (tmux User5).
#
# WezTerm forwards `\e[20104~` here (see manifest `pane.scratch-float`).
# One scratch terminal per tmux window, as a tmux 3.8 floating pane laid
# over the top of the focused pane:
#   - none in this window          → open one (login shell, pane cwd)
#   - exists, focus elsewhere      → focus it
#   - exists, focus is the scratch → close it
# `exit` / Ctrl+D also closes it: pane-exit-keep.sh lets floating panes go.
#
# Outer box (-X/-Y/-x/-y) is aligned to the anchor pane's rectangle, so
# the float's border sits inside that pane and the content is 2 cells
# narrower. stdout MUST stay empty (tmux `run-shell -b` would open
# view-mode on any output).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/managed-shell-lib.sh"
export WEZTERM_RUNTIME_LOG_SOURCE="pane-scratch-float.sh"

SCRATCH_OPTION="@wezterm_scratch_float"
# Share of the anchor pane height, with a floor so a short pane still
# gets a usable prompt.
HEIGHT_PERCENT="${WEZTERM_SCRATCH_FLOAT_HEIGHT_PERCENT:-40}"
MIN_HEIGHT=6

pane_id="${1:-}"
if [[ -z "$pane_id" ]]; then
  echo "usage: $0 <pane-id>" >&2
  exit 2
fi

window_id="$(tmux display-message -p -t "$pane_id" '#{window_id}')"
scratch_id="$(tmux list-panes -t "$window_id" -F "#{pane_id} #{$SCRATCH_OPTION}" \
  | awk '$2 == "1" { print $1; exit }')"

if [[ -n "$scratch_id" ]]; then
  if [[ "$scratch_id" == "$pane_id" ]]; then
    tmux kill-pane -t "$scratch_id"
    action=closed
  else
    tmux select-pane -t "$scratch_id"
    action=focused
  fi
  runtime_log_info workspace "scratch float toggled" \
    "pane_id=$scratch_id" "window_id=$window_id" "action=$action"
  exit 0
fi

read -r left top width height cwd < <(tmux display-message -p -t "$pane_id" \
  '#{pane_left} #{pane_top} #{pane_width} #{pane_height} #{pane_current_path}')
[[ -d "$cwd" ]] || cwd="${HOME:-/tmp}"

float_height=$(( height * HEIGHT_PERCENT / 100 ))
(( float_height < MIN_HEIGHT )) && float_height=$MIN_HEIGHT
(( float_height > height )) && float_height=$height

new_id="$(tmux new-pane -P -F '#{pane_id}' -t "$pane_id" \
  -X "$left" -Y "$top" -x "$width" -y "$float_height" \
  -c "$cwd" "$(resolve_login_shell)" -l)"
tmux set-option -p -t "$new_id" "$SCRATCH_OPTION" 1

runtime_log_info workspace "scratch float toggled" \
  "pane_id=$new_id" "anchor_pane_id=$pane_id" "window_id=$window_id" \
  "action=opened" "size=${width}x${float_height}" "cwd=$cwd"
