#!/usr/bin/env bash
# Regression for the Alt+g / Alt+Shift+g → @wezterm_pane_role tagging gap.
#
# tmux-worktree-open.sh creates on-demand worktree windows under the
# resume wrapper (`sh -c 'claude --continue || …'`). While that wrapper
# is the leaf, pane_current_command is `sh` / `node`, so tmux.conf's
# @agent_pane_match needs the intent tag @wezterm_pane_role=agent-cli:<base>
# or Ctrl+N silently falls through to plain pass-through on a live agent
# pane — exactly the symptom seen on
# `.worktrees/<repo>/dev-investigation` before this fix.
#
# open-project-session / tmux-reset / cold-spawn already tagged; the
# worktree-open create+reselect path was the remaining gap.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

REAL_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"

STAGED_REPO="$TEST_ROOT/staged-repo"
mkdir -p "$STAGED_REPO/scripts" "$STAGED_REPO/wezterm-x/local" "$STAGED_REPO/config"
ln -s "$REAL_REPO/scripts/runtime" "$STAGED_REPO/scripts/runtime"

cat > "$STAGED_REPO/wezterm-x/local/shared.env" <<'EOF'
MANAGED_AGENT_PROFILE='mockagent'
EOF

cat > "$STAGED_REPO/config/worktree-task.env" <<'EOF'
WT_PROVIDER_AGENT_PROFILE_MOCKAGENT_COMMAND=/bin/sleep 300
WT_PROVIDER_AGENT_PROFILE_MOCKAGENT_RESUME_COMMAND=/bin/sleep 300
EOF

# Real linked worktree so tmux_worktree_* git helpers agree on common-dir.
MAIN_ROOT="$TEST_ROOT/repo-main"
mkdir -p "$MAIN_ROOT"
git -C "$MAIN_ROOT" init -q
git -C "$MAIN_ROOT" config user.email 'test@example.com'
git -C "$MAIN_ROOT" config user.name 'test'
git -C "$MAIN_ROOT" commit --allow-empty -qm 'init'
WORKTREE_ROOT="$TEST_ROOT/.worktrees/repo-main/dev-investigation"
mkdir -p "$(dirname "$WORKTREE_ROOT")"
git -C "$MAIN_ROOT" worktree add -b dev/investigation "$WORKTREE_ROOT" >/dev/null

WORKSPACE="work"
SESSION_NAME="$(tmux_worktree_session_name_for_path "$WORKSPACE" "$MAIN_ROOT")"

# Seed a managed two-pane template window (agent + shell) so create-from-
# template has something to clone. Primary command metadata marks it as
# an agent-launcher window the way open-project-session would.
tmux new-session -d -s "$SESSION_NAME" -c "$MAIN_ROOT" /bin/sleep 300
TEMPLATE_WINDOW="$(tmux list-windows -t "$SESSION_NAME" -F '#{window_id}' | head -n 1)"
tmux rename-window -t "$TEMPLATE_WINDOW" "$(basename "$MAIN_ROOT")"
tmux set-window-option -t "$TEMPLATE_WINDOW" -q @wezterm_window_primary_command \
  "$(tmux_worktree_metadata_encode_primary_command "$STAGED_REPO/scripts/runtime/agent-launcher.sh mockagent")"
tmux split-window -d -t "$TEMPLATE_WINDOW" -c "$MAIN_ROOT" /bin/sleep 300

# Force staged config so resolve_resume_* launches /bin/sleep, not a real agent.
export WEZTERM_CONFIG_REPO="$STAGED_REPO"

OPEN_SCRIPT="$STAGED_REPO/scripts/runtime/tmux-worktree-open.sh"
bash "$OPEN_SCRIPT" "$SESSION_NAME" "$WORKTREE_ROOT" "$TEMPLATE_WINDOW" "$MAIN_ROOT"

WINDOW_ID="$(tmux_worktree_find_window "$SESSION_NAME" "$WORKTREE_ROOT" || true)"
[[ -n "$WINDOW_ID" ]] || {
  printf 'worktree-open did not create a window for %s\n' "$WORKTREE_ROOT" >&2
  exit 1
}

PRIMARY_PANE_ID="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"
role="$(tmux show-options -p -t "$PRIMARY_PANE_ID" -v -q @wezterm_pane_role 2>/dev/null || true)"

tmux_test_assert_eq "agent-cli:mockagent" "$role" \
  "worktree-open create must tag primary pane so @agent_pane_match (Ctrl+N) sees through resume-wrapper boot transient"

# Clear the tag and re-select the existing window — reselect must heal.
tmux set-option -p -t "$PRIMARY_PANE_ID" -u @wezterm_pane_role
bash "$OPEN_SCRIPT" "$SESSION_NAME" "$WORKTREE_ROOT" "$TEMPLATE_WINDOW" "$MAIN_ROOT"
role="$(tmux show-options -p -t "$PRIMARY_PANE_ID" -v -q @wezterm_pane_role 2>/dev/null || true)"

tmux_test_assert_eq "agent-cli:mockagent" "$role" \
  "worktree-open reselect must re-tag primary pane when @wezterm_window_primary_command marks a managed agent"

printf 'PASS worktree-open-tags-primary-pane\n'
