#!/usr/bin/env bash
# Cross-agent session handoff (replace in place): switch this pane's agent
# to --to, stick that choice on the window for later F5, cold-respawn a
# blank process. The relay pastes the continuation brief afterwards
# (native/wezdeck-wsl/session_handoff.go).
#
# Does NOT recycle the worktree and does NOT resume the source session id
# (different backends cannot share a transcript). Source conversation stays
# on disk; the brief points at it.
#
#   session-handoff.sh --pane %N --to grok|codex|claude [--from claude]
#
# stdout: key=value lines — outcome=respawned, agent=<to>, and for a Claude
# target session_id=<uuid> so the old attention entry can be cleared_to it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
export WEZTERM_RUNTIME_LOG_SOURCE="session-handoff.sh"

pane=""
to=""
from=""
while (($#)); do
  case "$1" in
    --pane) pane="${2-}"; shift ;;
    --to) to="${2-}"; shift ;;
    --from) from="${2-}"; shift ;;
    *) echo "usage: $0 --pane %N --to grok|codex|claude [--from NAME]" >&2; exit 2 ;;
  esac
  shift
done

[[ "$pane" =~ ^%[0-9]+$ ]] || { echo "session-handoff: bad pane '$pane'" >&2; exit 2; }
case "$to" in
  claude|claude_*|codex|grok) ;;
  *) echo "session-handoff: unsupported --to '$to' (claude|codex|grok)" >&2; exit 2 ;;
esac
# Normalize profile base for role tags / sticky window option
to_base="${to%-resume}"
to_base="${to_base%_resume}"
case "$to_base" in
  claude*) to_base=claude ;;
esac

read -r session_name window_id socket cwd < <(tmux display-message -p -t "$pane" \
  '#{session_name} #{window_id} #{socket_path} #{pane_current_path}' 2>/dev/null) || true
if [[ -z "${window_id:-}" ]]; then
  echo "session-handoff: pane $pane is gone" >&2
  exit 1
fi

repo="${WEZDECK_REPO:-}"
if [[ -z "$repo" || ! -x "$repo/scripts/runtime/agent-launcher.sh" ]]; then
  repo="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi
if [[ ! -x "$repo/scripts/runtime/agent-launcher.sh" ]]; then
  echo "session-handoff: agent-launcher missing under $repo" >&2
  exit 1
fi

start_ms="$(runtime_log_now_ms)"
fields=(
  "pane=$pane"
  "session_name=$session_name"
  "window_id=$window_id"
  "cwd=${cwd:-}"
  "from=${from:-}"
  "to=$to_base"
)
runtime_log_info workspace "web session handoff invoked" "${fields[@]}"

finish() {
  local outcome="$1" level="${2:-info}"
  "runtime_log_$level" workspace "web session handoff completed" "${fields[@]}" \
    "duration_ms=$(runtime_log_duration_ms "$start_ms")" "outcome=$outcome"
  printf 'outcome=%s\n' "$outcome"
  printf 'agent=%s\n' "$to_base"
}

# shellcheck disable=SC1091
source "$SCRIPT_DIR/agent-session-resolve.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/worktree/lib/resume-command.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/tmux-worktree/metadata.sh" 2>/dev/null || true

tmux select-pane -t "$pane" 2>/dev/null || true

# Drop typed resume so the new agent cannot --continue the source id.
if declare -F agent_session_unpin_pane >/dev/null 2>&1; then
  agent_session_unpin_pane "$pane" "${cwd:-}" || true
fi
prev_sid=""
if declare -F agent_session_resolve_for_pane >/dev/null 2>&1; then
  prev_sid="$(agent_session_resolve_for_pane "$pane" 2>/dev/null || true)"
fi
if [[ -n "$prev_sid" ]]; then
  tmux set-option -p -t "$pane" -q @wezterm_agent_discarded_session_id "$prev_sid" 2>/dev/null || true
fi
# shellcheck disable=SC1091
source "$SCRIPT_DIR/attention-state-lib.sh" 2>/dev/null || true
if declare -F attention_state_evict_session >/dev/null 2>&1; then
  attention_state_evict_session "$socket" "$session_name" "" "$pane" 2>/dev/null || true
fi

# Stick the target agent on this window so later F5 / refresh keep it.
tmux set-window-option -t "$window_id" -q @wezterm_window_agent_profile "$to_base"
tmux set-option -p -t "$pane" -q @wezterm_pane_role "agent-cli:$to_base"
tmux set-option -p -t "$pane" -q @wezterm_agent_profile "$to_base"

resume_cmd=""
if declare -F resolve_profile_resume_command >/dev/null 2>&1; then
  resume_cmd="$(resolve_profile_resume_command "$repo" "$to_base" "${cwd:-}" 2>/dev/null || true)"
fi
if [[ -z "$resume_cmd" ]]; then
  resume_cmd="bash $(printf '%q' "$repo/scripts/runtime/agent-launcher.sh") $(printf '%q' "$to_base")"
fi
if declare -F tmux_worktree_set_window_metadata >/dev/null 2>&1; then
  # Keep role/root/label/layout; only rewrite primary_command.
  role="$(tmux_worktree_window_metadata "$window_id" @wezterm_window_role 2>/dev/null || true)"
  root="$(tmux_worktree_window_metadata "$window_id" @wezterm_window_root 2>/dev/null || true)"
  label="$(tmux_worktree_window_metadata "$window_id" @wezterm_window_label 2>/dev/null || true)"
  layout="$(tmux_worktree_window_metadata "$window_id" @wezterm_window_layout 2>/dev/null || true)"
  [[ -n "$root" ]] || root="${cwd:-}"
  tmux_worktree_set_window_metadata "$window_id" "${role:-managed}" "$root" "$label" \
    "$resume_cmd" "$layout"
else
  encoded="$resume_cmd"
  if declare -F tmux_worktree_metadata_encode_primary_command >/dev/null 2>&1; then
    encoded="$(tmux_worktree_metadata_encode_primary_command "$resume_cmd")"
  fi
  tmux set-window-option -t "$window_id" -q @wezterm_window_primary_command "$encoded"
fi

fresh_cmd=""
if declare -F agent_session_build_fresh_command >/dev/null 2>&1; then
  fresh_cmd="$(agent_session_build_fresh_command "$repo" "$to_base" || true)"
fi
if [[ -z "$fresh_cmd" ]]; then
  wrapper="$repo/scripts/runtime/primary-pane-wrapper.sh"
  launcher="$repo/scripts/runtime/agent-launcher.sh"
  if [[ -x "$wrapper" ]]; then
    fresh_cmd="env WEZDECK_FORCE_FRESH_SESSION=1 bash $(printf '%q' "$wrapper") bash $(printf '%q' "$launcher") $(printf '%q' "$to_base")"
  else
    fresh_cmd="env WEZDECK_FORCE_FRESH_SESSION=1 bash $(printf '%q' "$launcher") $(printf '%q' "$to_base")"
  fi
fi

new_id=""
if [[ "$to_base" == "claude" ]]; then
  new_id="$(cat /proc/sys/kernel/random/uuid)"
  tmux set-option -p -t "$pane" @wezdeck_fresh_session_id "$new_id"
fi

work_cwd="${cwd:-$HOME}"
# One argv: tmux runs it through the default shell (same as F5 refresh).
if ! tmux respawn-pane -k -t "$pane" -c "$work_cwd" "$fresh_cmd" 2>/dev/null; then
  tmux set-option -p -u -t "$pane" @wezdeck_fresh_session_id 2>/dev/null || true
  finish "failed:respawn" warn
  exit 1
fi

tmux set-option -p -t "$pane" -q @wezterm_pane_role "agent-cli:$to_base" 2>/dev/null || true
tmux set-option -p -t "$pane" -q @wezterm_agent_profile "$to_base" 2>/dev/null || true

if [[ -n "$new_id" ]]; then
  if declare -F attention_state_evict_session >/dev/null 2>&1; then
    attention_state_evict_session "$socket" "$session_name" "$new_id" "$pane" 2>/dev/null || true
  fi
  if declare -F attention_mark_cleared >/dev/null 2>&1; then
    attention_mark_cleared "$socket" "$pane" "$new_id" 2>/dev/null || true
  fi
  printf 'session_id=%s\n' "$new_id"
fi

finish respawned
exit 0
