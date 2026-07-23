#!/usr/bin/env bash
# Agent-pane detection: process (FG/tree) + cmd name only. No title heuristics.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/lib.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/host-snapshot.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/watch.sh"

assert_eq() {
  local want="$1" got="$2" label="$3"
  if [[ "$want" != "$got" ]]; then
    printf 'FAIL: %s want=%q got=%q\n' "$label" "$want" "$got" >&2
    exit 1
  fi
}

assert_ok() {
  local label="$1"
  shift
  if ! "$@"; then
    printf 'FAIL: %s (expected success)\n' "$label" >&2
    exit 1
  fi
}

assert_fail() {
  local label="$1"
  shift
  if "$@"; then
    printf 'FAIL: %s (expected failure)\n' "$label" >&2
    exit 1
  fi
}

# --- name → kind ---
assert_eq "claude-tui" "$(sb_name_to_agent_kind claude)" "comm claude"
assert_eq "claude-tui" "$(sb_name_to_agent_kind /usr/bin/claude)" "path claude"
assert_eq "grok-tui" "$(sb_name_to_agent_kind grok)" "comm grok"
assert_fail "zsh not agent" sb_name_to_agent_kind zsh
assert_fail "sh not agent" sb_name_to_agent_kind sh

# --- cmd only; title ignored even when it looks agent-ish ---
assert_eq "claude-tui" "$(sb_infer_kind_from_cmd claude)" "cmd claude"
assert_eq "shell" "$(sb_infer_kind_from_cmd sh)" "cmd sh"
assert_eq "shell" "$(sb_infer_kind_from_cmd zsh)" "cmd zsh"
assert_eq "shell" "$(sb_infer_kind sh $'✳ Claude Code')" "title ignored → still shell"
assert_eq "shell" "$(sb_infer_kind sh $'⠐ Node 路径错误调试')" "braille title ignored → shell"
assert_eq "claude-tui" "$(sb_infer_kind claude 'anything')" "cmd agent wins"

# --- without pane_id: title must NOT grant agent ---
assert_fail "title braille not enough" sb_watch_is_agent_pane shell sh $'⠐ Node 路径错误调试' ''
assert_fail "title star not enough" sb_watch_is_agent_pane shell sh $'✳ Claude Code' ''
assert_fail "title keyword not enough" sb_watch_is_agent_pane shell sh 'working on claude task' ''
assert_ok "kind already agent" sb_watch_is_agent_pane grok-tui grok 'x' ''
assert_ok "cmd name agent" sb_watch_is_agent_pane shell claude 'x' ''
assert_fail "plain shell" sb_watch_is_agent_pane shell sh 'plain shell' ''
assert_fail "plain zsh" sb_watch_is_agent_pane shell zsh nut ''

# --- live process checks (optional env) ---
# SB_TEST_AGENT_PANE=%N  → must detect agent via FG/tree even if cmd/title look like shell
# SB_TEST_SHELL_PANE=%N  → must NOT detect agent
if [[ -n "${SB_TEST_AGENT_PANE:-}" ]]; then
  k="$(sb_pane_agent_kind_from_process "$SB_TEST_AGENT_PANE" || true)"
  if [[ -z "$k" ]]; then
    printf 'FAIL: process detect on agent pane %s yielded empty\n' "$SB_TEST_AGENT_PANE" >&2
    exit 1
  fi
  assert_eq "$k" "$(sb_resolve_pane_kind "$SB_TEST_AGENT_PANE" sh)" \
    "resolve_pane_kind prefers process over cmd=sh"
  assert_ok "is_agent via process w/ shell disguise" \
    sb_watch_is_agent_pane shell sh 'no marker no keyword' "$SB_TEST_AGENT_PANE"
  echo "PASS: live agent pane=$SB_TEST_AGENT_PANE kind=$k"
fi

if [[ -n "${SB_TEST_SHELL_PANE:-}" ]]; then
  k="$(sb_pane_agent_kind_from_process "$SB_TEST_SHELL_PANE" || true)"
  if [[ -n "$k" ]]; then
    printf 'FAIL: shell pane %s wrongly kind=%s\n' "$SB_TEST_SHELL_PANE" "$k" >&2
    exit 1
  fi
  assert_fail "shell pane not agent" \
    sb_watch_is_agent_pane shell zsh nut "$SB_TEST_SHELL_PANE"
  echo "PASS: live shell pane=$SB_TEST_SHELL_PANE refused"
fi

echo "PASS: agent pane detect"
