#!/usr/bin/env bash
# Regression: Alt+g / refresh shell paths may run from an old tmux server
# environment that does not carry the current MANAGED_AGENT_PROFILE. The
# resolver must read wezterm-x/local/shared.env before falling back to claude.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

REAL_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
STAGED_REPO="$TEST_ROOT/staged-repo"
mkdir -p "$STAGED_REPO/wezterm-x/local" "$STAGED_REPO/config"

cat > "$STAGED_REPO/wezterm-x/local/shared.env" <<'EOF'
MANAGED_AGENT_PROFILE='codex'
EOF

cat > "$STAGED_REPO/config/worktree-task.env" <<'EOF'
WT_PROVIDER_AGENT_PROFILE_CLAUDE_RESUME_COMMAND=/bin/claude-resume
WT_PROVIDER_AGENT_PROFILE_CODEX_RESUME_COMMAND=${WEZTERM_REPO}/scripts/runtime/agent-launcher.sh codex
EOF

# shellcheck disable=SC1091
source "$REAL_REPO/scripts/runtime/worktree/lib/resume-command.sh"

unset MANAGED_AGENT_PROFILE
resolved="$(resolve_resume_primary_command "$STAGED_REPO")"
expected="$STAGED_REPO/scripts/runtime/agent-launcher.sh codex"

tmux_test_assert_eq "$expected" "$resolved" \
  "resume resolver should use shared.env MANAGED_AGENT_PROFILE when tmux environment is unset"

printf 'PASS resume-command-reads-shared-env-profile\n'
