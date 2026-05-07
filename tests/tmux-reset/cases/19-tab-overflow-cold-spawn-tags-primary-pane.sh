#!/usr/bin/env bash
# Regression for the cold-spawn → @wezterm_pane_role tagging gap.
#
# tab-overflow-cold-spawn.sh is the bash entry point for the Alt+t
# overflow picker's `○` cold rows: it resolves the managed agent argv
# from worktree-task.env / shared.env and shells out to
# open-project-session.sh. open-project-session.sh tags the primary pane
# with @wezterm_pane_role=agent-cli:<base> only when invoked with
# --agent-profile <base>; without that tag, tmux.conf's
# @agent_pane_match cannot see through the resume wrapper's
# `pane_current_command=sh`/`node` boot transient and Ctrl+N / Ctrl+P
# fall through to plain pass-through on a freshly opened cold tab. A
# subsequent refresh-session re-tags the pane and the bindings start
# working — exactly the symptom the bug report described.
#
# The lua-side path (workspace/runtime.lua:project_session_args)
# already passes --agent-profile; the shell cold-spawn path was the
# drift.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

REAL_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Stage a fake repo root so we control which `wezterm-x/local/shared.env`
# and `config/worktree-task.env` the cold-spawn script reads. Symlinking
# `scripts/runtime/` lets the real cold-spawn (and its dependencies —
# open-project-session.sh, primary-pane-wrapper.sh, …) execute, while
# the staged env files isolate the test from the developer's local
# `MANAGED_AGENT_PROFILE` and from the repo's real agent profiles
# (which would otherwise launch claude / codex via agent-launcher.sh).
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

# Use a workspace name that's very unlikely to collide with a developer's
# real /tmp/wezterm-overflow-<slug>-tty.txt — see the attach.sh comment
# below.
WORKSPACE="coldspawntest"
PROJECT_ROOT="$TEST_ROOT/cold-spawn-root"
mkdir -p "$PROJECT_ROOT"

SESSION_NAME="$(tmux_worktree_session_name_for_path "$WORKSPACE" "$PROJECT_ROOT")"
COLD_SPAWN_SCRIPT="$STAGED_REPO/scripts/runtime/tab-overflow-cold-spawn.sh"

# tab-overflow-attach.sh reads its target tty from the global path
# /tmp/wezterm-overflow-<slug>-tty.txt. Remove any leftover from a real
# overflow tab in this workspace name so the test sees a deterministic
# attach failure rather than a tty pointing into another tmux server.
rm -f "/tmp/wezterm-overflow-${WORKSPACE}-tty.txt"

# The cold-spawn script always tries to switch-client into the new
# session via tab-overflow-attach.sh, which needs the tty state file
# above (normally written by spawn_overflow_tab() in lua at overflow-
# tab open time). With no overflow tab in the test, the attach call
# exits 3 and the cold-spawn script propagates that. The exit happens
# AFTER the detached open-project-session.sh has already created the
# session and tagged the primary pane, so we accept the non-zero rc and
# assert on the side effect we care about.
set +e
bash "$COLD_SPAWN_SCRIPT" "$WORKSPACE" "$PROJECT_ROOT"
set -e

# Wait for the detached open-project-session.sh to bring up the tmux
# session. Same poll budget as the cold-spawn script's own internal
# wait (~5s) — generous enough for slow disks, well below the case's
# implicit timeout.
for _ in $(seq 1 100); do
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    break
  fi
  sleep 0.05
done
tmux has-session -t "$SESSION_NAME"

WINDOW_ID="$(tmux list-windows -t "$SESSION_NAME" -F '#{window_id}' | head -n 1)"
PRIMARY_PANE_ID="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"

# Poll for the @wezterm_pane_role tag. open-project-session.sh sets it
# after `tmux new-session` returns, but the call is in a backgrounded
# subshell so we may observe a brief gap.
role=""
for _ in $(seq 1 100); do
  role="$(tmux show-options -p -t "$PRIMARY_PANE_ID" -v -q @wezterm_pane_role 2>/dev/null || true)"
  if [[ -n "$role" ]]; then break; fi
  sleep 0.05
done

tmux_test_assert_eq "agent-cli:mockagent" "$role" \
  "cold-spawn must tag primary pane so @agent_pane_match (Ctrl+N / Ctrl+P) sees through resume-wrapper boot transient"

printf 'PASS tab-overflow-cold-spawn-tags-primary-pane\n'
