#!/usr/bin/env bash
# Per-repo launcher: when workspace-agent-map.tsv maps a cwd to codex,
# shell resolvers must prefer that over shared.env's global claude — for
# exact cwd, path-under prefix, and same-git-common-dir family matches.
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

cat > "$STAGED_REPO/wezterm-x/local/shared.env" <<'EOF'
MANAGED_AGENT_PROFILE='claude'
EOF

cat > "$STAGED_REPO/config/worktree-task.env" <<'EOF'
WT_PROVIDER_AGENT_PROFILE_CLAUDE_RESUME_COMMAND=${WEZTERM_REPO}/scripts/runtime/agent-launcher.sh claude
WT_PROVIDER_AGENT_PROFILE_CODEX_RESUME_COMMAND=${WEZTERM_REPO}/scripts/runtime/agent-launcher.sh codex
EOF

MAPPED_ROOT="$TEST_ROOT/mapped-repo"
mkdir -p "$MAPPED_ROOT"
git -C "$MAPPED_ROOT" init -q
git -C "$MAPPED_ROOT" config user.email 'test@example.com'
git -C "$MAPPED_ROOT" config user.name 'test'
printf 'x\n' > "$MAPPED_ROOT/README"
git -C "$MAPPED_ROOT" add README
git -C "$MAPPED_ROOT" commit -qm 'init'

# Linked worktree outside the main path (mirrors .worktrees/<repo>/ layout).
LINKED_ROOT="$TEST_ROOT/mapped-linked"
git -C "$MAPPED_ROOT" branch -q linked-branch
git -C "$MAPPED_ROOT" worktree add -q "$LINKED_ROOT" linked-branch

cat > "$STAGED_REPO/wezterm-x/local/workspace-agent-map.tsv" <<EOF
# generated for test
$MAPPED_ROOT	codex
/nonexistent/other-path	claude
EOF

unset MANAGED_AGENT_PROFILE

# --- 1. No cwd → global shared.env (claude) ---
profile="$(resume_command_active_profile "$STAGED_REPO")"
tmux_test_assert_eq "claude" "$profile" \
  "without cwd, active profile stays on shared.env claude"

resolved="$(resolve_resume_primary_command "$STAGED_REPO")"
tmux_test_assert_eq "$STAGED_REPO/scripts/runtime/agent-launcher.sh claude" "$resolved" \
  "without cwd, resume command stays on claude"

# --- 2. Exact map hit → codex ---
profile="$(resume_command_active_profile "$STAGED_REPO" "$MAPPED_ROOT")"
tmux_test_assert_eq "codex" "$profile" \
  "exact map cwd should select codex over shared.env claude"

resolved="$(resolve_managed_primary_command "$STAGED_REPO" "$MAPPED_ROOT")"
tmux_test_assert_eq "$STAGED_REPO/scripts/runtime/agent-launcher.sh codex" "$resolved" \
  "exact map cwd should resolve managed primary to codex launcher"

# --- 3. Path under mapped cwd (subdir) → codex via longest prefix ---
subdir="$MAPPED_ROOT/src/pkg"
mkdir -p "$subdir"
profile="$(resume_command_active_profile "$STAGED_REPO" "$subdir")"
tmux_test_assert_eq "codex" "$profile" \
  "subdir under mapped cwd should inherit codex via prefix match"

# --- 4. Linked worktree (same common-dir, not path-under) → family match ---
profile="$(resume_command_active_profile "$STAGED_REPO" "$LINKED_ROOT")"
tmux_test_assert_eq "codex" "$profile" \
  "linked worktree sharing git common-dir should inherit codex"

# --- 5. Unmapped path → global fallback ---
other="$TEST_ROOT/unmapped"
mkdir -p "$other"
profile="$(resume_command_active_profile "$STAGED_REPO" "$other")"
tmux_test_assert_eq "claude" "$profile" \
  "unmapped cwd should fall back to shared.env claude"

printf 'PASS resume-command-respects-workspace-agent-map\n'
