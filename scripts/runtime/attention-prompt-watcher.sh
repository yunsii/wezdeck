#!/usr/bin/env bash
# Watchdog spawned by emit.sh on user-action waiting upserts:
#   Notification(permission_prompt | elicitation_dialog | approval_required).
# Polls `tmux capture-pane` for Claude / Grok prompt anchors; when the
# anchor disappears, flips the entry from `waiting` to `running`.
#
# Two upstream gaps this closes:
#   1. Claude permission_prompt — no hook on Yes/No; PostToolUse only
#      fires when the tool *exits*, so without the watcher the badge
#      sits on ⚠ for the whole tool-execution window (especially if the
#      user backgrounds the tool with ctrl+b ctrl+b).
#   2. Grok elicitation_dialog (Ask) — PostToolUse fires ~200 ms after
#      Notification while the dialog is still on screen, so the state
#      machine refuses to clear elicitation waiting via resolved; the
#      watcher is the path that flips once the dialog actually leaves.
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
#     waiting, flips waiting → running via
#     attention_state_transition_to_running … force=1 and exits. force=1
#     is required so elicitation_dialog waiting (sticky against ordinary
#     PostToolUse) can clear. Approve vs answer: running is correct (Stop
#     or the next tool follows). Grok Ctrl+C / mid-turn abort is different:
#     updates.jsonl gets turn_completed stop_reason=cancelled and the TUI
#     returns to Ready, but Stop often never fires — flipping only to
#     running left the web console on Working… until the next prompt. When
#     the newest Grok updates signal is that cancelled turn_completed, the
#     watcher upserts done instead.
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
#   - User picks "No" / Esc-cancels (Claude) → prompt vanishes, watcher
#     flips to running, Stop fires moments later with done. One transient
#     running blip. Grok Ctrl+C → turn_completed cancelled; watcher flips
#     to done directly when that is the newest updates signal.
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
# 0 = persistent while status=waiting and pane is alive (attention entries no
# longer expire on a 30-min TTL); positive value caps lifetime for tests.
MAX_DURATION_S="${WEZTERM_ATTENTION_WATCHER_MAX_S:-0}"
# Number of consecutive missing-anchor polls required before flipping
# waiting → running. A single miss is too aggressive — TUI partial
# redraws (Claude refreshing the Bash preview, user navigating options,
# terminal resize echoes) can drop the footer from one capture even
# though the prompt is still on screen. Two consecutive misses give a
# ≈ 2 s minimum stable absence at the default 1 s poll interval, which
# keeps detection fast after a real approve while filtering one-frame
# redraw artifacts.
CONSECUTIVE_MISS_THRESHOLD="${WEZTERM_ATTENTION_WATCHER_MISS_THRESHOLD:-2}"

# Anchor regex. Any pattern matching means "a user-action prompt is on
# screen". Patterns are footer / chrome strings the TUIs only emit inside
# the prompt UI itself — not ordinary chat — so chat that discusses the
# feature does not false-positive (the original `Do you want to proceed\?`
# anchor did, and was abandoned).
#
# Claude permission / elicitation:
#   `Esc to cancel`              — leftmost footer; primary Claude signal.
#   `Tab to amend`               — bash-style permission_prompt middle.
#   `Yes, and don.t ask again`   — default option #2 (`.` = apostrophe).
#
# Grok Ask / elicitation_dialog (fullscreen TUI):
#   `Waiting on answers for`     — status line while Ask is open.
#   `Enter:submit`               — Ask footer submit affordance.
#   `Tab:next answer`            — Ask footer (multi-question).
#   `Shift\+x:dismiss`           — Ask dismiss chrome.
#
# Grok plan review / approval_required (exit_plan_mode):
#   `Waiting for approval`       — status while plan review is open.
#   Keep this alongside Ask anchors so Ctrl+C / quit clears waiting after
#   the dialog leaves (without it, approval_required stuck until Stop/TTL).
#
# Agy permission prompt (detected via screen probe in attention-jump --prune):
#   `tab Amend` / `ctrl\+g edit/expand command` — Agy prompt footer chrome.
#   `Yes, run command` / `Yes, allow tool call` / `Yes, allow access` /
#   `Yes, accept this change` — Agy confirmation menu options.
PROMPT_ANCHOR='(Esc to cancel|Tab to amend|Yes, and don.t ask again|Waiting on answers for|Enter:submit|Tab:next answer|Shift\+x:dismiss|Waiting for approval|tab Amend|ctrl\+g edit/expand command|Yes, run command|Yes, allow tool call|Yes, allow access|Yes, accept this change)'

# True when Grok's updates.jsonl newest turn/ask signal is a cancelled
# turn_completed (Ctrl+C mid-turn abort). A later Ask / tool_call / user
# chunk after that cancel means a new turn started — not cancelled-idle.
grok_mid_turn_cancelled() {
  local sid="$1"
  local root="${HOME}/.grok/sessions"
  [[ -n "$sid" && -d "$root" ]] || return 1
  local dir updates
  dir="$(find "$root" -mindepth 2 -maxdepth 2 -type d -name "$sid" 2>/dev/null | head -n 1)"
  updates="${dir:+$dir/updates.jsonl}"
  [[ -n "$updates" && -f "$updates" ]] || return 1
  # Tail only: updates.jsonl can be multi-MB.
  python3 - "$updates" <<'PY'
import json, os, sys
path = sys.argv[1]
try:
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        if size > 524288:
            f.seek(size - 524288)
            f.readline()  # drop partial first line
        data = f.read()
except OSError:
    sys.exit(1)
last = None  # "cancel" | "open" | "activity"
for line in data.splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        row = json.loads(line)
    except Exception:
        continue
    u = (row.get("params") or {}).get("update") or {}
    su = u.get("sessionUpdate") or ""
    title = u.get("title") or ""
    status = (u.get("status") or "").lower()
    meta = (row.get("params") or {}).get("_meta") or {}
    if su == "turn_completed":
        reason = (u.get("stop_reason") or "").lower()
        cat = str(meta.get("cancellationCategory") or "").lower().replace("_", "")
        if reason in ("cancelled", "canceled") or meta.get("cancelTrigger") or cat == "midturnabort":
            last = "cancel"
        else:
            last = "activity"
    elif su == "tool_call" and title in ("ask_user_question", "exit_plan_mode"):
        last = "open"
    elif su in ("user_message_chunk", "tool_call"):
        last = "activity"
    elif su == "tool_call_update" and status in (
        "completed", "failed", "cancelled", "canceled", "error", "rejected",
    ):
        # Settled call after an open Ask = answered path, not cancel-idle.
        if last == "open":
            last = "activity"
sys.exit(0 if last == "cancel" else 1)
PY
}

state_path="$(attention_state_path)"
start_ts="$(date +%s 2>/dev/null || printf '0')"

runtime_log_info attention "watcher started" \
  "session_id=$session_id" \
  "tmux_pane=$tmux_pane" \
  "tmux_socket=$tmux_socket" \
  "wezterm_pane=$wezterm_pane" \
  "poll_s=$POLL_INTERVAL_S" \
  "miss_threshold=$CONSECUTIVE_MISS_THRESHOLD" \
  "max_s=$MAX_DURATION_S" 2>/dev/null || true

consecutive_misses=0
# Have we observed the anchor at least once since spawn? Notification
# fires before the TUI finishes painting the prompt footer, so the first
# few captures may legitimately miss the anchor even though the prompt
# is "really" on screen. Until we see it once, we know the prompt has
# not yet rendered and we cannot interpret a miss as "user resolved" —
# any flip would be premature. Once seen, subsequent misses count toward
# the debounce normally. A prompt that vanishes before the TUI ever
# painted (impossible in practice — would require the user to approve
# faster than ~1 s after Notification, before the TUI has finished
# laying out the modal) safely falls through to PostToolUse, which is
# the upstream-only behaviour and matches WEZTERM_ATTENTION_WATCHER_DISABLED=1.
anchor_ever_seen=0

while :; do
  sleep "$POLL_INTERVAL_S"

  now_ts="$(date +%s 2>/dev/null || printf '0')"
  if (( MAX_DURATION_S > 0 && now_ts - start_ts >= MAX_DURATION_S )); then
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
    # Prompt still up: user has not acted yet. Keep polling, mark the
    # anchor as seen so future misses count toward debounce, and clear
    # any miss streak so prior transient drops don't accumulate.
    anchor_ever_seen=1
    consecutive_misses=0
    continue
  fi

  # Anchor missing. Two reasons not to flip yet:
  #   (a) startup paint window — until we have observed the anchor at
  #       least once, the TUI hasn't finished painting the prompt yet;
  #       a "miss" here is meaningless because we don't know if a prompt
  #       was ever drawn. Avoid the time-based grace by tying this gate
  #       to an actual sighting of the prompt, which keeps post-approve
  #       detection as fast as the debounce alone allows.
  #   (b) consecutive-miss debounce — TUI partial redraws (Bash preview
  #       refresh, option-cycle keystrokes, terminal resize echoes) can
  #       drop the footer from a single capture. Require N misses in a
  #       row before believing the prompt is gone.
  if (( anchor_ever_seen == 0 )); then
    continue
  fi
  consecutive_misses=$(( consecutive_misses + 1 ))
  if (( consecutive_misses < CONSECUTIVE_MISS_THRESHOLD )); then
    continue
  fi

  # Prompt anchor stably gone.
  # Grok Ctrl+C: dialog left + turn_completed cancelled, but Stop may never
  # fire — prefer done so the web console drops Working… immediately.
  if grok_mid_turn_cancelled "$session_id"; then
    if attention_state_upsert \
         "$session_id" \
         "$wezterm_pane" \
         "$tmux_socket" \
         "$tmux_session" \
         "$tmux_window" \
         "$tmux_pane" \
         "done" \
         "turn cancelled (ctrl_c)" \
         "$git_branch" \
         2>/dev/null; then
      runtime_log_info attention "watcher flipped waiting to done" \
        "session_id=$session_id" "tmux_pane=$tmux_pane" \
        "reason=grok_turn_cancelled" \
        "elapsed_s=$((now_ts - start_ts))" \
        "consecutive_misses=$consecutive_misses" 2>/dev/null || true
    else
      runtime_log_info attention "watcher done upsert noop" \
        "session_id=$session_id" "tmux_pane=$tmux_pane" \
        "elapsed_s=$((now_ts - start_ts))" 2>/dev/null || true
    fi
    exit 0
  fi

  # Flip waiting → running with force=1 so elicitation_dialog waiting
  # (sticky against ordinary PostToolUse) can clear. The helper re-checks
  # under flock.
  if attention_state_transition_to_running \
       "$session_id" \
       "$wezterm_pane" \
       "$tmux_socket" \
       "$tmux_session" \
       "$tmux_window" \
       "$tmux_pane" \
       "$git_branch" \
       "1" \
       2>/dev/null; then
    runtime_log_info attention "watcher flipped waiting to running" \
      "session_id=$session_id" "tmux_pane=$tmux_pane" \
      "elapsed_s=$((now_ts - start_ts))" \
      "consecutive_misses=$consecutive_misses" 2>/dev/null || true
  else
    # Helper returned no-op (status already left waiting via Stop /
    # UserPromptSubmit / Alt+/ clear, etc.). Log and exit.
    runtime_log_info attention "watcher flip noop" \
      "session_id=$session_id" "tmux_pane=$tmux_pane" \
      "elapsed_s=$((now_ts - start_ts))" \
      "consecutive_misses=$consecutive_misses" 2>/dev/null || true
  fi
  exit 0
done
