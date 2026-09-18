#!/usr/bin/env bash
# Record the active tmux pane for a (socket, session) so attention.lua
# can require tmux-pane-level focus, not just WezTerm pane focus, before
# auto-acking a `done` entry whose wezterm_pane_id matches.
#
# Invoked from tmux hooks in tmux.conf:
#   set-hook -g  after-select-pane "run-shell -b 'bash .../tmux-focus-emit.sh \
#     #{q:socket_path} #{q:session_name} #{q:pane_id}'"
#   set-hook -ga client-focus-in   "run-shell -b 'bash .../tmux-focus-emit.sh \
#     #{q:socket_path} #{q:session_name} #{q:pane_id}'"
#
# after-select-pane covers in-tmux pane switches. client-focus-in covers
# wezterm-side tab / workspace switches: when wezterm gives a tab focus
# it sends OSC focus-in (CSI I) to that pane's tmux client, which fires
# client-focus-in with #{pane_id} resolving to the client's currently-
# active pane — exactly the value the focus file should hold.
#
# Why not pane-focus-in: tmux 3.4 silently ignores `set-hook -g
# pane-focus-in` because the hook only exists in pane scope, so a global
# binding never lands on the server. We rely on after-select-pane plus
# client-focus-in to cover both axes (intra-tmux and wezterm-side).
#
# `session_name` (not `session_id`) is intentional: state entries written
# by emit-agent-status.sh record `tmux_session` from `#{session_name}`,
# and attention.lua's is_entry_focused resolves the focus file path from
# that same value. Using `#{session_id}` here would produce a filename
# like `..._default__1.txt` that Lua never looks up, breaking click-to-
# ack — the keyboard jump path still works because it bypasses the
# focus-file lookup entirely.
#
# State layout (one small file per tmux session, no flock needed since
# each hook writes its own path and Lua only reads):
#   <state>/agent-attention/tmux-focus/<safe_socket>__<safe_session>.txt
#     -> single line containing the active tmux pane id (e.g. "%12").
#
# Also attributes user input (tmux client_activity) to the window that
# held focus when the input happened — see tmux-user-interact-lib.sh.
# Alt+g ranks worktrees by that stamp so agent pane *output* no longer
# reshuffles the picker.
#
# Habit join: on focus *change*, append one JSONL row to
#   <runtime>/state/wezterm-pane-focus.jsonl
# (pane / kind / agent / cmd basename / role only — no titles). Used by
# habit_report/rime_commits.py to split wezterm → wezterm.agent.* / .shell.
#
# Fails open: any step that fails is silently skipped so the tmux hook
# never observes an error.

set -u

socket="${1:-}"
session="${2:-}"
pane="${3:-}"

if [[ -z "$socket" || -z "$session" || -z "$pane" ]]; then
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$script_dir/attention-state-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/runtime-log-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/tmux-user-interact-lib.sh"

# User-interact MRU is independent of the attention focus-file store:
# even if attention_state_path is unavailable we still want Alt+g order.
window_id="$(tmux display-message -p -t "$pane" '#{window_id}' 2>/dev/null || true)"
if [[ -n "$window_id" ]]; then
  tmux_user_interact_note_focus "$session" "$window_id" || true
fi

# attention_state_path resolves to .../agent-attention/attention.json; peel
# off the filename to co-locate the per-session focus files under the
# same feature directory.
state_path="$(attention_state_path 2>/dev/null || true)"
write_ok=0
file=""
if [[ -n "$state_path" ]]; then
  focus_dir="${state_path%/*}/tmux-focus"
  if mkdir -p "$focus_dir" 2>/dev/null; then
    # Filename-safe key. Socket paths contain slashes; session names are
    # already safe characters in this repo (workspaces.lua enforces it), but
    # we keep the legacy `$`-strip in case a caller ever passes a raw id.
    # The Lua reader applies the same transform so both sides agree on the
    # path without having to parse the full socket string.
    safe_socket="${socket//\//_}"
    safe_session="${session#\$}"
    file="$focus_dir/${safe_socket}__${safe_session}.txt"
    tmp="${file}.tmp.$$"

    if printf '%s\n' "$pane" > "$tmp" 2>/dev/null && mv "$tmp" "$file" 2>/dev/null; then
      write_ok=1
    fi
  fi
fi

if command -v runtime_log_info >/dev/null 2>&1; then
  runtime_log_info attention "tmux focus hook fired" \
    "socket=$socket" \
    "session=$session" \
    "pane=$pane" \
    "window_id=${window_id:-}" \
    "file=$file" \
    "write_ok=$write_ok"
fi

# --- Habit: pane-focus timeline for Rime commit × agent-pane join ----------
# Privacy: no titles / cwd / text — only pane id, role tag, command basename,
# and derived agent label. Append on *change* only (same posture as
# host.foreground process-name gating).
if [[ -n "$state_path" ]]; then
  # attention.json lives at <runtime>/state/agent-attention/attention.json
  state_root="$(dirname "$(dirname "$state_path")")"
  pane_jsonl="${state_root}/wezterm-pane-focus.jsonl"
  pane_last="${state_root}/wezterm-pane-focus.last"
  role="$(tmux show-options -p -t "$pane" -v -q @wezterm_pane_role 2>/dev/null || true)"
  cmd="$(tmux display-message -p -t "$pane" '#{pane_current_command}' 2>/dev/null || true)"
  cmd_base="${cmd##*/}"

  agent=""
  if [[ "$role" == agent-cli:* ]]; then
    agent="${role#agent-cli:}"
  fi
  case "$cmd_base" in
    claude|claude-*|Claude) agent="${agent:-claude}" ;;
    codex|codex-*|Codex) agent="${agent:-codex}" ;;
    grok|grok-*|Grok) agent="${agent:-grok}" ;;
  esac
  # Plain shell without intent tag → not an agent pane (resume wrappers keep the tag).
  case "$cmd_base" in
    bash|zsh|fish|sh|sudo)
      if [[ "$role" != agent-cli:* ]]; then
        agent=""
      fi
      ;;
  esac

  kind="shell"
  if [[ -n "$agent" ]]; then
    kind="agent"
  fi

  fingerprint="${pane}|${kind}|${agent}|${cmd_base}|${role}"
  prev=""
  if [[ -f "$pane_last" ]]; then
    prev="$(cat "$pane_last" 2>/dev/null || true)"
  fi
  if [[ "$fingerprint" != "$prev" ]]; then
    ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || true)"
    if [[ -n "$ts" ]]; then
      # Hand-built JSON (no jq dependency on the hook path).
      line=$(printf '{"ts":"%s","pane":"%s","kind":"%s","agent":"%s","cmd":"%s","role":"%s","source":"tmux_focus"}\n' \
        "$ts" "$pane" "$kind" "$agent" "$cmd_base" "$role")
      if printf '%s' "$line" >>"$pane_jsonl" 2>/dev/null; then
        printf '%s\n' "$fingerprint" >"$pane_last" 2>/dev/null || true
      fi
    fi
  fi
fi

exit 0
