#!/usr/bin/env bash
# F2 scratch float: open over the top of the focused pane, F2 from another
# pane focuses it, F2 inside closes it; `exit` also closes it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

SCRATCH="$REPO_ROOT/scripts/runtime/pane-scratch-float.sh"
ROOT="$TEST_ROOT/scratch-float"
mkdir -p "$ROOT"
WINDOW_ID="$(tmux new-session -d -P -F '#{window_id}' -s scratch -x 200 -y 50 -c "$ROOT" 'sleep 300')"
tmux set-option -g remain-on-exit on
tmux set-hook -g pane-died "run-shell -b \"bash $REPO_ROOT/scripts/runtime/pane-exit-keep.sh #{q:socket_path} #{q:hook_pane} #{q:pane_current_path} >/dev/null 2>&1\""
LEFT_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"
RIGHT_PANE="$(tmux split-window -h -P -F '#{pane_id}' -t "$LEFT_PANE" -c "$ROOT" 'sleep 300')"

scratch_pane() {
  tmux list-panes -t "$WINDOW_ID" -F '#{pane_id} #{@wezterm_scratch_float}' | awk '$2 == "1" { print $1 }'
}

# 1. Open over the right pane.
bash "$SCRATCH" "$RIGHT_PANE"
FLOAT="$(scratch_pane)"
[[ -n "$FLOAT" ]] || { echo 'F2 did not create a scratch float' >&2; exit 1; }
read -r floating active left top width height path < <(tmux display-message -p -t "$FLOAT" \
  '#{pane_floating_flag} #{pane_active} #{pane_left} #{pane_top} #{pane_width} #{pane_height} #{pane_current_path}')
read -r a_left a_top a_width a_height < <(tmux display-message -p -t "$RIGHT_PANE" \
  '#{pane_left} #{pane_top} #{pane_width} #{pane_height}')
tmux_test_assert_eq "1" "$floating" "scratch pane must be floating"
tmux_test_assert_eq "1" "$active" "new scratch float must take focus"
# Content sits one border cell inside the anchor's rectangle.
tmux_test_assert_eq "$((a_left + 1))" "$left" "float must start at the anchor pane's left edge"
tmux_test_assert_eq "$((a_top + 1))" "$top" "float must sit at the top of the anchor pane"
tmux_test_assert_eq "$((a_width - 2))" "$width" "float must span the anchor pane width"
tmux_test_assert_eq "$((a_height * 40 / 100 - 2))" "$height" "float height must be 40% of the anchor pane"
tmux_test_assert_eq "$(cd "$ROOT" && pwd -P)" "$(cd "$path" && pwd -P)" "float cwd must follow the anchor pane"

# 2. From another pane: focus, do not create a second one.
tmux select-pane -t "$LEFT_PANE"
bash "$SCRATCH" "$LEFT_PANE"
tmux_test_assert_eq "$FLOAT" "$(scratch_pane)" "second F2 must reuse the existing float"
tmux_test_assert_eq "1" "$(tmux display-message -p -t "$FLOAT" '#{pane_active}')" "F2 from another pane must focus the float"

# 3. Inside the float: close.
bash "$SCRATCH" "$FLOAT"
tmux_test_assert_eq "" "$(scratch_pane)" "F2 inside the float must close it"
tmux_test_assert_eq "2" "$(tmux list-panes -t "$WINDOW_ID" | wc -l | tr -d ' ')" "tiled panes must survive the toggle"

# 4. `exit` in a fresh float closes it (pane-exit-keep lets floats go).
bash "$SCRATCH" "$RIGHT_PANE"
FLOAT="$(scratch_pane)"
tmux send-keys -t "$FLOAT" 'exit' Enter
for _ in $(seq 1 60); do
  [[ -z "$(scratch_pane)" ]] && break
  sleep 0.05
done
tmux_test_assert_eq "" "$(scratch_pane)" "exit must close the scratch float"

printf 'PASS scratch-float-toggle\n'
