#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMUX_CONF="$SCRIPT_DIR/../../tmux.conf"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <workspace> <cwd> [command...]" >&2
  exit 1
fi

workspace="$1"
cwd="$2"
shift 2
runtime_log_info workspace "open-project-session invoked" "workspace=$workspace" "cwd=$cwd" "arg_count=$#"

project_name="$(basename "$cwd")"
session_name="$(printf 'wezterm_%s_%s' "$workspace" "$project_name" | tr '/ .:' '____')"

tmux_version() {
  tmux -V 2>/dev/null | awk '{print $2}' | sed 's/[^0-9.]//g'
}

tmux_version_at_least() {
  local version
  version=$(tmux_version)
  local target_major=$1
  local target_minor=$2
  local major minor
  IFS='.' read -r major minor _ <<< "$version"
  major=${major:-0}
  minor=${minor:-0}
  (( major > target_major )) && return 0
  (( major == target_major && minor >= target_minor )) && return 0
  return 1
}

ensure_tmux_support() {
  if ! tmux_version_at_least 3 3; then
    local installed
    installed=$(tmux_version)
    runtime_log_warn workspace "tmux version lacks allow-passthrough support" "tmux_version=${installed:-unknown}"
    cat <<EOF >&2
Warning: tmux ${installed:-} lacks allow-passthrough support.
Managed tmux workspaces work best with tmux 3.3 or newer.
EOF
  fi
}

ensure_tmux_support

ensure_workspace_panes() {
  local pane_count
  pane_count=$(tmux list-panes -t "${session_name}:0" 2>/dev/null | wc -l)
  if [[ $pane_count -lt 2 ]]; then
    runtime_log_info workspace "adding missing secondary pane" "session_name=$session_name" "cwd=$cwd" "pane_count=$pane_count"
    tmux split-window -h -t "${session_name}:0.0" -c "$cwd"
    tmux select-pane -t "${session_name}:0.0"
  fi
}

build_primary_shell_command() {
  local command_string=""

  if [[ $# -gt 0 ]]; then
    printf -v command_string '%q ' "$@"
    command_string="${command_string% }"
    command_string="$command_string; exec /bin/zsh -l"
    printf '/bin/zsh -lc %q' "$command_string"
    return
  fi

  printf '/bin/zsh -l'
}

if ! tmux has-session -t "$session_name" 2>/dev/null; then
  primary_shell_command="$(build_primary_shell_command "$@")"
  runtime_log_info workspace "creating tmux session" "session_name=$session_name" "cwd=$cwd"

  tmux new-session -d -s "$session_name" -c "$cwd" "$primary_shell_command"
  tmux set-option -g @wezterm_repo_root "$(realpath "$SCRIPT_DIR/../..")"
  tmux source-file "$TMUX_CONF"
  tmux rename-window -t "${session_name}:0" "$project_name"
  tmux split-window -h -t "${session_name}:0.0" -c "$cwd"
  tmux select-pane -t "${session_name}:0.0"
else
  runtime_log_info workspace "reusing existing tmux session" "session_name=$session_name" "cwd=$cwd"
  tmux set-option -g @wezterm_repo_root "$(realpath "$SCRIPT_DIR/../..")"
  tmux source-file "$TMUX_CONF"
fi

ensure_workspace_panes

runtime_log_info workspace "attaching tmux session" "session_name=$session_name"
exec tmux attach-session -t "$session_name"
