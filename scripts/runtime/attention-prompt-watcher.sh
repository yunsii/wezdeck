#!/usr/bin/env bash
# Watchdog spawned by emit-agent-status.sh on every
# `Notification(permission_prompt)` upsert. Polls `tmux capture-pane` for
# the Claude TUI's prompt anchor; when the anchor disappears, flips the
# entry from `waiting` to `running` so the badge does not lag the
# user-visible state until PostToolUse fires (which can be many minutes
# later for long-running approved tools, especially if the user pushes
# the tool to background with ctrl+b ctrl+b).
#
# This is the local mitigation for the upstream limitation documented in
# docs/agent-attention.md "Limitation: no signal for permission
# approval" — Claude Code does not expose any hook event when the user
# clicks Yes/No on a permission_prompt, and the only state-changing
# signal we get on the approve→completion window is PostToolUse, which
# fires when the tool *actually exits*.
#
# Args (all positional):
#   $1  session_id
#   $2  wezterm_pane_id      (may be empty)
#   $3  tmux_socket          (required)
#   $4  tmux_session
#   $5  tmux_window
#   $6  tmux_pane            (required, e.g. %12)
#   $7  git_branch           (may be empty)
#   $8  safe_key             (sha-derived per-pane key for the lockfile)
#
# Behaviour:
#   - Holds a non-blocking flock on a per-pane lockfile, so a second spawn
#     for the same pane while we are alive exits immediately.
#   - Polls every $POLL_INTERVAL_S seconds (default 1s).
#   - Hard-caps total lifetime at $MAX_DURATION_S seconds (default 1800s
#     == 30 min, matches attention TTL).
#   - Self-exits when:
#       * status for this session_id is no longer `waiting` (PostToolUse,
#         Stop, TTL prune, /clear pane-evict, Alt+/ clear-all)
#       * tmux pane is gone (agent / pane killed)
#       * the hard cap fires
#   - When the prompt anchor is no longer on screen AND status is still
#     waiting, flips waiting → running via attention_state_transition_to_running
#     and exits. We do NOT try to distinguish approve-vs-cancel — either
#     way the agent is no longer blocked on user input; a cancel will be
#     followed shortly by `Stop` which transitions running → done.
#
# Opt-out:
#   Set WEZTERM_ATTENTION_WATCHER_DISABLED=1 in the env that hooks read
#   (e.g. via wezterm-x/local/runtime-logging.sh siblings, or an export
#   in your shell rc) to suppress watcher spawn entirely.
#
# Failure modes (also documented in agent-attention.md):
#   - Claude TUI changes the prompt's question wording → anchor stops
#     matching → watcher flips to running on the very next poll. Slightly
#     premature but not catastrophic — Stop will overwrite to done if no
#     tool actually ran.
#   - User picks "No" / Esc-cancels → prompt vanishes, watcher flips to
#     running, Stop fires moments later with done. One transient running
#     blip.
#   - Tool runs synchronously and PostToolUse beats the watcher to the
#     state file → attention_state_transition_to_running sees `running`
#     under the lock and short-circuits. No-op.

set -u

session_id="${1:-}"
wezterm_pane="${2:-}"
tmux_socket="${3:-}"
tmux_session="${4:-}"
tmux_window="${5:-}"
tmux_pane="${6:-}"
git_branch="${7:-}"
safe_key="${8:-}"

if [[ -z "$session_id" || -z "$tmux_socket" || -z "$tmux_pane" || -z "$safe_key" ]]; then
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/attention-state-lib.sh"
# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/runtime-log-lib.sh"
WEZTERM_RUNTIME_LOG_SOURCE="attention-prompt-watcher.sh"

# Per-pane single-watcher lock. Held for the entire watcher lifetime;
# any second spawn that beats us to flock will exit silently.
lock_dir="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/wezterm-attention-watcher"
mkdir -p "$lock_dir" 2>/dev/null || true
lock_file="$lock_dir/$safe_key.lock"

exec 9>"$lock_file" 2>/dev/null || exit 0
if ! flock -n 9 2>/dev/null; then
  exit 0
fi

POLL_INTERVAL_S="${WEZTERM_ATTENTION_WATCHER_POLL_S:-1}"
MAX_DURATION_S="${WEZTERM_ATTENTION_WATCHER_MAX_S:-1800}"

# Anchor regex. Either pattern matching means "permission_prompt is on
# screen". Both are footer / option-list strings that the Claude TUI
# only emits inside the prompt UI itself; neither appears in the
# agent's conversational text, so the watcher does not get fooled by a
# pane whose chat history happens to mention the words "Do you want to
# proceed?" (which is why the original `Do you want to proceed\?`
# anchor was abandoned — it false-positived on chat content discussing
# the very feature this watcher implements).
#
#   `Tab to amend`               — bottom footer of bash permission_prompt
#                                  ("Esc to cancel · Tab to amend · ctrl+e
#                                  to explain"). Unique to bash-style
#                                  prompts.
#   `Yes, and don.t ask again`   — option #2 row, present in every
#                                  permission_prompt regardless of tool
#                                  type. The `.` matches the apostrophe
#                                  byte tolerantly across encodings.
#
# Elicitation dialogs use a different footer, so they fall through to
# the "anchor missing → flip to running" branch — also fine because the
# user has acted in either case.
PROMPT_ANCHOR='(Tab to amend|Yes, and don.t ask again)'

state_path="$(attention_state_path)"
start_ts="$(date +%s 2>/dev/null || printf '0')"

runtime_log_info attention "watcher started" \
  "session_id=$session_id" \
  "tmux_pane=$tmux_pane" \
  "tmux_socket=$tmux_socket" \
  "wezterm_pane=$wezterm_pane" \
  "poll_s=$POLL_INTERVAL_S" \
  "max_s=$MAX_DURATION_S" 2>/dev/null || true

while :; do
  sleep "$POLL_INTERVAL_S"

  now_ts="$(date +%s 2>/dev/null || printf '0')"
  if (( now_ts - start_ts >= MAX_DURATION_S )); then
    runtime_log_info attention "watcher exit timeout" \
      "session_id=$session_id" "tmux_pane=$tmux_pane" \
      "elapsed_s=$((now_ts - start_ts))" 2>/dev/null || true
    exit 0
  fi

  # Status check: if entry left waiting through any other path, exit.
  if [[ ! -f "$state_path" ]]; then
    exit 0
  fi
  current_status="$(jq -r --arg sid "$session_id" \
    '.entries[$sid].status // "missing"' "$state_path" 2>/dev/null)"
  if [[ "$current_status" != "waiting" ]]; then
    runtime_log_info attention "watcher exit status changed" \
      "session_id=$session_id" "current_status=$current_status" \
      "elapsed_s=$((now_ts - start_ts))" 2>/dev/null || true
    exit 0
  fi

  # Pane existence check. tmux returns no row for dead panes.
  if ! tmux -S "$tmux_socket" list-panes -a -F '#{pane_id}' 2>/dev/null \
       | grep -qx "$tmux_pane"; then
    runtime_log_info attention "watcher exit pane gone" \
      "session_id=$session_id" "tmux_pane=$tmux_pane" 2>/dev/null || true
    exit 0
  fi

  # Capture the visible pane area. -p without -S limits to the on-screen
  # window, which is what the user is actually looking at. The Claude
  # prompt sits at the bottom and is always within the visible region.
  # Capture exit-code is checked separately — an empty (whitespace-only)
  # capture is a *valid* result meaning "no anchor on screen" (would
  # arise legitimately for a blank pane, which never happens for a real
  # Claude session but can in smoke tests). A capture failure (pane
  # vanished mid-poll, transient tmux hiccup) is distinguished by
  # non-zero exit and skips the iteration.
  if ! content="$(tmux -S "$tmux_socket" capture-pane -t "$tmux_pane" -p 2>/dev/null)"; then
    continue
  fi

  if [[ -n "$content" ]] && grep -qE "$PROMPT_ANCHOR" <<<"$content"; then
    # Prompt still up: user has not acted yet. Keep polling.
    continue
  fi

  # Prompt anchor gone. Flip waiting → running. The transition helper
  # re-checks status under flock, so a concurrent PostToolUse that beat
  # us to it will short-circuit cleanly.
  if attention_state_transition_to_running \
       "$session_id" \
       "$wezterm_pane" \
       "$tmux_socket" \
       "$tmux_session" \
       "$tmux_window" \
       "$tmux_pane" \
       "$git_branch" \
       2>/dev/null; then
    runtime_log_info attention "watcher flipped waiting to running" \
      "session_id=$session_id" "tmux_pane=$tmux_pane" \
      "elapsed_s=$((now_ts - start_ts))" 2>/dev/null || true
  else
    # Helper returned no-op (the lock-protected re-check saw something
    # other than waiting/done/missing — almost certainly running already
    # via PostToolUse winning the race). Log and exit; nothing to do.
    runtime_log_info attention "watcher flip noop" \
      "session_id=$session_id" "tmux_pane=$tmux_pane" \
      "elapsed_s=$((now_ts - start_ts))" 2>/dev/null || true
  fi
  exit 0
done
