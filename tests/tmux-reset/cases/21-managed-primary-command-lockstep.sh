#!/usr/bin/env bash
# Lockstep: resolve_managed_primary_command is the single shell resolver
# for resume + bare COMMAND + ${WEZTERM_REPO} expansion. Cold-spawn and
# Alt+g / refresh all source resume-command.sh; this case pins the
# preference order and placeholder expansion so a future re-fork cannot
# silently diverge.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

REAL_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
STAGED_REPO="$TEST_ROOT/staged-repo"
mkdir -p "$STAGED_REPO/wezterm-x/local" "$STAGED_REPO/config"

# shellcheck disable=SC1091
source "$REAL_REPO/scripts/runtime/worktree/lib/resume-command.sh"

# --- 1. RESUME preferred over bare COMMAND; ${WEZTERM_REPO} expands ---
cat > "$STAGED_REPO/wezterm-x/local/shared.env" <<'EOF'
MANAGED_AGENT_PROFILE='codex'
EOF

cat > "$STAGED_REPO/config/worktree-task.env" <<'EOF'
WT_PROVIDER_AGENT_PROFILE_CODEX_COMMAND=/bin/codex-bare
WT_PROVIDER_AGENT_PROFILE_CODEX_RESUME_COMMAND=${WEZTERM_REPO}/scripts/runtime/agent-launcher.sh codex
WT_PROVIDER_AGENT_PROFILE_CLAUDE_RESUME_COMMAND=/bin/claude-resume
EOF

unset MANAGED_AGENT_PROFILE
resolved="$(resolve_managed_primary_command "$STAGED_REPO")"
expected="$STAGED_REPO/scripts/runtime/agent-launcher.sh codex"
tmux_test_assert_eq "$expected" "$resolved" \
  "managed primary should prefer RESUME and expand \${WEZTERM_REPO}"

profile="$(resume_command_active_profile "$STAGED_REPO")"
tmux_test_assert_eq "codex" "$profile" \
  "active profile should come from shared.env MANAGED_AGENT_PROFILE"

# --- 2. Fall back to bare COMMAND when RESUME is empty ---
cat > "$STAGED_REPO/config/worktree-task.env" <<'EOF'
WT_PROVIDER_AGENT_PROFILE_CODEX_COMMAND=/bin/codex-bare
WT_PROVIDER_AGENT_PROFILE_CODEX_RESUME_COMMAND=
EOF

resolved="$(resolve_managed_primary_command "$STAGED_REPO")"
tmux_test_assert_eq "/bin/codex-bare" "$resolved" \
  "managed primary should fall back to bare COMMAND when RESUME is empty"

# --- 3. argv split keeps multi-word launcher intact ---
mapfile -t tokens < <(resume_command_split_argv "$expected")
tmux_test_assert_eq "2" "${#tokens[@]}" \
  "split of resume launcher should yield path + profile"
tmux_test_assert_eq "$STAGED_REPO/scripts/runtime/agent-launcher.sh" "${tokens[0]}" \
  "split token 0 is agent-launcher path"
tmux_test_assert_eq "codex" "${tokens[1]}" \
  "split token 1 is agent profile"

printf 'PASS managed-primary-command-lockstep\n'
