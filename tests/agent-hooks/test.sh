#!/usr/bin/env bash
# Offline smoke test for scripts/dev/agent-hooks.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CHECKER="$REPO_ROOT/scripts/dev/agent-hooks.sh"
TEST_HOME="$(mktemp -d /tmp/wezterm-agent-hooks.XXXXXX)"
trap 'rm -rf "$TEST_HOME"' EXIT
export AGENT_HOOKS_HOME="$TEST_HOME"

assert_check_fails() {
  local output rc=0
  output="$("$CHECKER" check --provider "$1" 2>&1)" || rc=$?
  [[ "$rc" -ne 0 ]] || {
    printf 'expected check failure for %s\n%s\n' "$1" "$output" >&2
    exit 1
  }
}

assert_check_passes() {
  "$CHECKER" check --provider "$1" >/dev/null
}

assert_check_fails codex
"$CHECKER" install --provider codex >/dev/null
assert_check_passes codex
before="$(sha256sum "$TEST_HOME/.codex/hooks.json" | awk '{print $1}')"
"$CHECKER" install --provider codex >/dev/null
after="$(sha256sum "$TEST_HOME/.codex/hooks.json" | awk '{print $1}')"
[[ "$before" == "$after" ]] || { printf 'codex install is not idempotent\n' >&2; exit 1; }

"$CHECKER" install --provider claude >/dev/null
assert_check_passes claude
# a settings file from before the compaction hooks (PreCompact,
# SessionStart compact) is reported, not healthy; reinstall fixes it
claude_file="$TEST_HOME/.claude/settings.json"
jq 'del(.hooks.PreCompact) | .hooks.SessionStart |= map(select(.matcher != "compact"))' \
  "$claude_file" >"$claude_file.old" && mv "$claude_file.old" "$claude_file"
out="$("$CHECKER" check --provider claude 2>&1 || true)"
[[ "$out" == *"status=partial"* && "$out" == *"missing=PreCompact,SessionStart:compact"* ]] || {
  printf 'pre-compaction claude hooks not reported:\n%s\n' "$out" >&2; exit 1
}
"$CHECKER" install --provider claude >/dev/null
assert_check_passes claude
jq 'del(.hooks.Stop)' "$TEST_HOME/.codex/hooks.json" >"$TEST_HOME/.codex/broken.json"
mv "$TEST_HOME/.codex/broken.json" "$TEST_HOME/.codex/hooks.json"
assert_check_fails codex

printf 'PASS agent-hooks checker/install smoke\n'
