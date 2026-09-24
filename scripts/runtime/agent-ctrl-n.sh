#!/usr/bin/env bash
# Ctrl+n decision point for tmux-backed panes.
#
# WezTerm always forwards \x0e here (see manifest `agent.new-conversation`).
# This script evaluates @agent_pane_match, logs the decision, then either
# stages `/new`+Enter (agent) or injects `clear`+Enter (non-agent). Without
# this log, a missing @wezterm_pane_role on a resume-wrapper pane
# (leaf=sh/node) silently falls through and is indistinguishable from
# "user pressed Ctrl+n in a shell" after the fact.
#
# Hand-started Grok often shows as `python3` (grok-focus-filter / grok.real),
# so leaf-name match alone misses it. After @agent_pane_match fails we probe
# the pane process tree cmdlines before injecting clear.
#
# Outcome contract (log-only, no toast — keystrokes are the user-visible
# effect): invoked is implicit in the decision row; each path ends with
# `Ctrl+n completed` + duration_ms + outcome=.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
export WEZTERM_RUNTIME_LOG_SOURCE="agent-ctrl-n.sh"

usage() {
  echo "usage: $0 <pane-or-window-target>" >&2
  exit 2
}

# Walk pane_pid + descendants; print grok|claude|codex on first hit.
# Covers hand-started secondary panes where leaf is python3/node/sh.
agent_ctrl_n_detect_from_cmdline() {
  local pane_id="${1:-}"
  local root_pid=""
  local pid=""
  local cmdline=""
  local -a queue=()
  local -A seen=()
  local child=""

  root_pid="$(tmux display-message -p -t "$pane_id" '#{pane_pid}' 2>/dev/null || true)"
  [[ "$root_pid" =~ ^[0-9]+$ ]] || return 1
  queue=("$root_pid")

  while ((${#queue[@]} > 0)); do
    pid="${queue[0]}"
    queue=("${queue[@]:1}")
    [[ -n "${seen[$pid]+x}" ]] && continue
    seen[$pid]=1
    [[ -r "/proc/$pid/cmdline" ]] || continue
    cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
    # Match path basenames and wrapper argv. Grok often hides behind
    # python3 + grok-focus-filter / grok.real; Codex behind node + codex.js;
    # Claude is usually an ELF named claude (leaf match already works) but
    # still detect from cmdline for resume wrappers / odd installs.
    # Trailing space from tr '\0' ' ' is common — prefer prefix globs
    # (*claude*) over exact suffix. Avoid matching only ".claude/" config
    # paths: require bin/claude, an argv token, or codex.js / @openai/codex.
    case "$cmdline" in
      *grok-focus-filter*|*grok.real*|*/bin/grok*|*/grok[[:space:]]*|*/grok|*" grok "*|*" grok")
        printf 'grok\n'
        return 0
        ;;
      */bin/claude*|*/claude[[:space:]]*|*/claude|*" claude "*|*" claude")
        printf 'claude\n'
        return 0
        ;;
      *codex.js*|*/@openai/codex*|*/bin/codex*|*/codex[[:space:]]*|*/codex|*" codex "*|*" codex")
        printf 'codex\n'
        return 0
        ;;
    esac
    while IFS= read -r child; do
      [[ "$child" =~ ^[0-9]+$ ]] || continue
      queue+=("$child")
    done < <(pgrep -P "$pid" 2>/dev/null || true)
  done
  return 1
}

target="${1-}"
[[ -n "$target" ]] || usage

start_ms="$(runtime_log_now_ms)"

# Resolve to a concrete pane id so logs stay comparable across calls
# (window targets would otherwise bounce between active panes).
pane_id="$(tmux display-message -p -t "$target" '#{pane_id}' 2>/dev/null || true)"
if [[ -z "$pane_id" ]]; then
  runtime_log_warn agent_cli "Ctrl+n aborted: target pane unavailable" \
    "target=$target" \
    "duration_ms=$(runtime_log_duration_ms "$start_ms")" \
    "outcome=aborted"
  exit 0
fi

match="$(tmux display-message -p -t "$pane_id" '#{E:#{@agent_pane_match}}' 2>/dev/null || true)"
cmd="$(tmux display-message -p -t "$pane_id" '#{pane_current_command}' 2>/dev/null || true)"
role="$(tmux show-options -p -t "$pane_id" -v -q @wezterm_pane_role 2>/dev/null || true)"
cwd="$(tmux display-message -p -t "$pane_id" '#{pane_current_path}' 2>/dev/null || true)"
session_name="$(tmux display-message -p -t "$pane_id" '#{session_name}' 2>/dev/null || true)"
window_id="$(tmux display-message -p -t "$pane_id" '#{window_id}' 2>/dev/null || true)"
primary_meta=""
if [[ -n "$window_id" ]]; then
  # Decode via the same helper open/refresh paths use, when available.
  if [[ -f "$SCRIPT_DIR/tmux-worktree/metadata.sh" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/tmux-worktree/metadata.sh"
    if declare -F tmux_worktree_window_metadata >/dev/null 2>&1; then
      primary_meta="$(tmux_worktree_window_metadata "$window_id" @wezterm_window_primary_command 2>/dev/null || true)"
    fi
  fi
  if [[ -z "$primary_meta" ]]; then
    primary_meta="$(tmux show-options -w -t "$window_id" -v -q @wezterm_window_primary_command 2>/dev/null || true)"
  fi
fi

common_fields=(
  "pane_id=$pane_id"
  "session_name=$session_name"
  "window_id=$window_id"
  "cwd=$cwd"
  "pane_current_command=$cmd"
  "pane_role=${role:-}"
  "agent_pane_match=${match:-0}"
  "primary_command=${primary_meta:-}"
  "hotkey_id=agent.new-conversation"
)

complete() {
  local outcome="$1"
  runtime_log_info agent_cli "Ctrl+n completed" \
    "${common_fields[@]}" \
    "duration_ms=$(runtime_log_duration_ms "$start_ms")" \
    "outcome=$outcome"
}

# Tests may override the /new injector via AGENT_NEW_INTO_PANE_SH.
new_into_sh="${AGENT_NEW_INTO_PANE_SH:-$SCRIPT_DIR/agent-new-into-pane.sh}"
codex_selector_sh="${CODEX_NEW_CURRENT_CHECKOUT_SH:-$SCRIPT_DIR/codex-new-current-checkout.sh}"

stage_agent_new() {
  local agent_kind="${1:-}"

  bash "$new_into_sh" "$pane_id"
  [[ "$agent_kind" == "codex" ]] || return 0

  if bash "$codex_selector_sh" "$pane_id"; then
    runtime_log_info agent_cli \
      "Codex new conversation selected current checkout" \
      "${common_fields[@]}" \
      "selection=current_checkout"
  else
    runtime_log_warn agent_cli \
      "Codex current checkout selector timed out" \
      "${common_fields[@]}" \
      "selection=manual_required"
  fi
}

agent_kind_from_role=""
case "$role" in
  agent-cli:*) agent_kind_from_role="${role#agent-cli:}" ;;
esac

if [[ "$match" == "1" ]]; then
  runtime_log_info agent_cli "Ctrl+n matched agent pane; staging /new" "${common_fields[@]}"
  stage_agent_new "$agent_kind_from_role"
  complete "new"
  exit 0
fi

# Hand-started Grok (and similar) often leaves pane_current_command as
# python3 / node while the real agent is in the process tree.
detected_agent=""
detected_agent="$(agent_ctrl_n_detect_from_cmdline "$pane_id" || true)"
if [[ -n "$detected_agent" ]]; then
  runtime_log_info agent_cli "Ctrl+n detected agent via process cmdline; staging /new" \
    "${common_fields[@]}" \
    "detected_agent=$detected_agent"
  stage_agent_new "$detected_agent"
  complete "new_cmdline"
  exit 0
fi

# Suspected miss: resume wrapper leaf (sh/node) + managed primary metadata
# but no role tag → exactly the Alt+g tagging gap. Do NOT inject `clear`
# into a likely agent composer; keep C-n pass-through and warn so a later
# "Ctrl+n did nothing" report is greppable without turning on debug.
cmd_base="${cmd##*/}"
suspected_miss=0
case "$cmd_base" in
  sh|node|ash|dash|python|python3)
    if [[ -z "$role" && -n "$primary_meta" ]]; then
      suspected_miss=1
    fi
    ;;
esac

if [[ "$suspected_miss" == "1" ]]; then
  runtime_log_warn agent_cli \
    "Ctrl+n pass-through on suspected agent pane (missing @wezterm_pane_role?)" \
    "${common_fields[@]}" \
    "hint=tag_or_refresh"
  tmux send-keys -t "$pane_id" C-n
  complete "pass_through_suspected"
  exit 0
fi

runtime_log_info agent_cli "Ctrl+n non-agent pane; injecting clear" "${common_fields[@]}"
tmux send-keys -t "$pane_id" 'clear' Enter
complete "clear"
