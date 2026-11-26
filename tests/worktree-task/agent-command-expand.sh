#!/usr/bin/env bash
# Regression: web session.new left panes as a login shell because
# WT_PROVIDER_AGENT_COMMAND still held the literal ${WEZDECK_REPO}/… placeholder;
# tmux-agent printf-%q'd it into zsh -ilc, the agent exited, pane-exit-keep
# respawned zsh. Expand the placeholder in wt_config_resolve_agent_profile.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/runtime/worktree/lib/helpers.sh"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/runtime/worktree/lib/config.sh"

WT_MAIN_WORKTREE_ROOT="$REPO_ROOT"
WT_REPO_COMMON_DIR="$REPO_ROOT/.git"
WT_REPO_LABEL="wezterm-config"
WEZDECK_REPO_ROOT="$REPO_ROOT"
WEZDECK_REPO="$REPO_ROOT"
WEZTERM_CONFIG_REPO="$REPO_ROOT"
export WEZDECK_REPO WEZTERM_CONFIG_REPO

WT_PROVIDER_AGENT_COMMAND=
WT_PROVIDER_AGENT_COMMAND_LIGHT=
WT_PROVIDER_AGENT_COMMAND_DARK=
WT_PROVIDER_AGENT_PROFILE=claude_kimi-resume
wt_config_load_file "$REPO_ROOT/config/worktree-task.env"
wt_config_resolve_agent_profile

case "$WT_PROVIDER_AGENT_COMMAND" in
  *'${WEZDECK_REPO}'*)
    printf 'FAIL COMMAND still has placeholder: %s\n' "$WT_PROVIDER_AGENT_COMMAND" >&2
    exit 1
    ;;
  "$REPO_ROOT"/scripts/runtime/agent-launcher.sh\ claude-kimi)
    printf 'PASS kimi resume COMMAND expands WEZDECK_REPO\n'
    ;;
  *)
    printf 'FAIL unexpected COMMAND: %s\n' "$WT_PROVIDER_AGENT_COMMAND" >&2
    exit 1
    ;;
esac

WT_PROVIDER_AGENT_COMMAND=
WT_PROVIDER_AGENT_PROFILE=grok-resume
wt_config_resolve_agent_profile
case "$WT_PROVIDER_AGENT_COMMAND" in
  "$REPO_ROOT"/scripts/runtime/agent-launcher.sh\ grok)
    printf 'PASS grok resume COMMAND expands WEZDECK_REPO\n'
    ;;
  *)
    printf 'FAIL unexpected grok COMMAND: %s\n' "$WT_PROVIDER_AGENT_COMMAND" >&2
    exit 1
    ;;
esac

# %q must not leave a non-existent \${WEZDECK_REPO} path
quoted="$(printf '%q' "$WT_PROVIDER_AGENT_COMMAND")"
case "$quoted" in
  *'${WEZDECK_REPO}'*|*'\$\{WEZDECK_REPO\}'*)
    printf 'FAIL quoted COMMAND still has placeholder: %s\n' "$quoted" >&2
    exit 1
    ;;
esac
printf 'PASS quoted COMMAND is a real path\n'
