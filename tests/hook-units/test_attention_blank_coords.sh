#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/wezdeck-attention-coords.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT
export HOME="$TEST_ROOT/home"
export XDG_STATE_HOME="$TEST_ROOT/state"
export WEZDECK_ATTENTION_STATE_PATH="$TEST_ROOT/attention.json"
export WEZTERM_ATTENTION_LOCK_FILE="$TEST_ROOT/attention.lock"
# shellcheck disable=SC1091
source "$ROOT/scripts/runtime/attention-state-lib.sh"

attention_state_upsert sid-test 0 /tmp/tmux-test work @2 %7 running first main '' '' codex task
attention_state_upsert sid-test '' '' '' '' '' done finished main '' '' codex task
jq -e '.entries["sid-test"] | .status == "done" and .tmux_socket == "/tmp/tmux-test"
  and .tmux_session == "work" and .tmux_window == "@2"
  and .tmux_pane == "%7" and .wezterm_pane_id == "0"' "$WEZDECK_ATTENTION_STATE_PATH" >/dev/null
printf 'PASS attention-blank-coords\n'
