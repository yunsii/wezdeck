#!/usr/bin/env bash
# OSC 133 attention pilot: gated hook maps started→running for grok panes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$ROOT/scripts/runtime/agent-attention/osc133-tmux-hook.sh"
# shellcheck disable=SC1091
source "$ROOT/tests/tmux-reset/lib.sh" 2>/dev/null || {
  # Minimal fallback if lib path differs
  :
}

export PATH="${HOME}/.local/bin:${PATH}"

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/osc133-attn.XXXXXX")"
cleanup() {
  tmux -L osc133-attn kill-server 2>/dev/null || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

export WEZDECK_ATTENTION_STATE_PATH="$TEST_ROOT/attention.json"
export WEZTERM_RUNTIME_LOG_FILE="$TEST_ROOT/runtime.log"
export WEZTERM_RUNTIME_LOG_ENABLED=1
export WEZTERM_RUNTIME_LOG_LEVEL=info
mkdir -p "$TEST_ROOT"
printf '%s\n' '{"version":1,"rev":0,"entries":{},"recent":[]}' > "$WEZDECK_ATTENTION_STATE_PATH"

tmux -L osc133-attn -f /dev/null new-session -d -s s -c "$TEST_ROOT" 'exec sleep 300'
PANE="$(tmux -L osc133-attn display-message -p '#{pane_id}')"
SOCK="$(tmux -L osc133-attn display-message -p '#{socket_path}')"

tmux -L osc133-attn set-option -p -t "$PANE" @wezterm_pane_role 'agent-cli:grok'
tmux -L osc133-attn set-option -p -t "$PANE" -q @wezterm_agent_session_id 'grok-sid-osc133'

# Gate off → no-op
bash "$HOOK" started "$PANE" "$SOCK"
entries="$(jq -r '.entries | keys | length' "$WEZDECK_ATTENTION_STATE_PATH")"
[[ "$entries" == "0" ]] || {
  printf 'expected no entries with gate off, got %s\n' "$entries" >&2
  exit 1
}

# Gate on → running
tmux -L osc133-attn set -g @wezdeck_osc133_attention 1
bash "$HOOK" started "$PANE" "$SOCK"
status="$(jq -r '.entries["grok-sid-osc133"].status // empty' "$WEZDECK_ATTENTION_STATE_PATH")"
[[ "$status" == "running" ]] || {
  printf 'expected running after started, got %s\n' "$status" >&2
  cat "$WEZDECK_ATTENTION_STATE_PATH" >&2 || true
  exit 1
}

bash "$HOOK" finished "$PANE" "$SOCK"
status="$(jq -r '.entries["grok-sid-osc133"].status // empty' "$WEZDECK_ATTENTION_STATE_PATH")"
[[ "$status" == "done" ]] || {
  printf 'expected done after finished, got %s\n' "$status" >&2
  exit 1
}

# Claude role must be ignored
tmux -L osc133-attn set-option -p -t "$PANE" @wezterm_pane_role 'agent-cli:claude'
tmux -L osc133-attn set-option -p -t "$PANE" -q @wezterm_agent_session_id 'claude-sid-skip'
bash "$HOOK" started "$PANE" "$SOCK"
claude_st="$(jq -r '.entries["claude-sid-skip"].status // empty' "$WEZDECK_ATTENTION_STATE_PATH")"
[[ -z "$claude_st" ]] || {
  printf 'claude role must not be handled by osc133 pilot\n' >&2
  exit 1
}

# End-to-end: real OSC 133 into pane tty fires hook → emit (gate on, role grok)
tmux -L osc133-attn set-option -p -t "$PANE" @wezterm_pane_role 'agent-cli:grok'
tmux -L osc133-attn set-option -p -t "$PANE" -q @wezterm_agent_session_id 'grok-sid-e2e'
tmux -L osc133-attn set-hook -g pane-command-started \
  "run-shell -b \"bash $(printf %q "$HOOK") started #{q:hook_pane} #{q:socket_path} >/dev/null 2>&1\""
tty="$(tmux -L osc133-attn display-message -p -t "$PANE" '#{pane_tty}')"
printf '\033]133;C\007' > "$tty"
ok=""
for _ in $(seq 1 40); do
  st="$(jq -r '.entries["grok-sid-e2e"].status // empty' "$WEZDECK_ATTENTION_STATE_PATH" 2>/dev/null || true)"
  if [[ "$st" == "running" ]]; then
    ok=1
    break
  fi
  sleep 0.05
done
[[ -n "$ok" ]] || {
  printf 'OSC 133 C did not produce running entry\n' >&2
  cat "$WEZDECK_ATTENTION_STATE_PATH" >&2 || true
  cat "$WEZTERM_RUNTIME_LOG_FILE" >&2 || true
  exit 1
}

printf 'PASS osc133-tmux-hook\n'
