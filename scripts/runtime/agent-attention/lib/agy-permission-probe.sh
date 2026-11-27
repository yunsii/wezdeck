#!/usr/bin/env bash
# Screen-based permission prompt detector for Agy sessions.
#
# Agy exposes no PermissionRequest / Notification lifecycle hook, so a blocked
# command/tool confirmation dialog stays on status=running in attention.json.
# The periodic reachability pass (`attention-jump.sh --prune`) invokes
# `agy_reconcile_permission_prompts` to escalate unfocused running Agy panes
# displaying a live confirmation menu to status=waiting (waiting_kind=
# permission_prompt) and spawns attention-prompt-watcher.sh to flip back to
# running once the user responds.
#
# Requires attention-state-lib.sh already sourced.

set -u

# Return 0 when the tail of an Agy tmux pane shows a tool/command permission
# confirmation menu (mirrors native/wezdeck-wsl/agent_agy_state.go::agyPermissionOptions).
# Rejects workspace trust dialogs and ordinary assistant prose.
agy_screen_has_permission_prompt() {
  local screen="${1:-}"
  [[ -n "$screen" ]] || return 1
  python3 - "$screen" <<'PY'
import sys

screen = sys.argv[1].rstrip("\n \t\r")
if not screen:
    sys.exit(1)
lines = screen.splitlines()
if len(lines) > 18:
    lines = lines[-18:]
tail = "\n".join(lines)
if "Do you trust the contents of this project?" in tail or "Yes, I trust this folder" in tail:
    sys.exit(1)

has_yes = False
has_no = False
has_header = False

for raw in lines:
    s = raw.strip()
    while True:
        trimmed = s.lstrip("│┃| ")
        if trimmed == s:
            break
        s = trimmed
    while True:
        trimmed = s.lstrip(">❯▸›●•*-")
        if trimmed == s:
            break
        s = trimmed.strip()
    numbered = False
    if len(s) >= 3 and "1" <= s[0] <= "9" and s[1] == "." and s[2] == " ":
        s = s[3:].strip()
        numbered = True
    if not s:
        continue
    if s.startswith((
        "Yes, and always allow",
        "Yes, always allow",
        "Always allow",
        "Yes, run command",
        "Yes, accept this change",
        "Yes, allow access",
        "Yes, allow creation",
        "Yes, allow tool call",
    )) or (numbered and s == "Yes"):
        has_yes = True
    elif s.startswith(("No, and always deny", "No, deny", "No, cancel")) or (numbered and s == "No"):
        has_no = True
    elif s in (
        "Run this command?",
        "Allow access to this URL?",
        "Allow calling this tool?",
        "Do you want to proceed?",
    ):
        has_header = True

sys.exit(0 if (has_yes and (has_no or has_header)) else 1)
PY
}

# True when both tmux-focus and WezTerm live-panes agree the user is looking at
# this pane right now (matches emit.sh focus-skip rules so we never escalate a
# focused pane to waiting and let focus-ack forget its running row).
agy_probe_pane_is_focused() {
  local sock="$1" sess="$2" pane="$3" wp="$4"
  [[ -n "$sock" && -n "$sess" && -n "$pane" && -n "$wp" ]] || return 1
  local state_path base_dir safe_socket safe_session focus_file live_panes
  state_path="$(attention_state_path)"
  base_dir="${state_path%/*}"
  safe_socket="${sock//\//_}"
  safe_session="${sess#\$}"
  focus_file="$base_dir/tmux-focus/${safe_socket}__${safe_session}.txt"
  live_panes="$base_dir/live-panes.json"
  local tmux_focused="" wez_focused=""
  [[ -f "$focus_file" ]] && tmux_focused="$(tr -d ' \n\r\t' <"$focus_file" 2>/dev/null || printf '')"
  [[ -s "$live_panes" ]] && wez_focused="$(jq -r '.focused_wezterm_pane_id // "" | tostring' "$live_panes" 2>/dev/null || printf '')"
  [[ -n "$tmux_focused" && "$tmux_focused" == "$pane" && -n "$wez_focused" && "$wez_focused" == "$wp" ]]
}

# Scan live running Agy entries and escalate unfocused panes showing a
# confirmation menu to waiting/permission_prompt.
agy_reconcile_permission_prompts() {
  local repo_root="${1:-}"
  command -v jq >/dev/null 2>&1 || return 0
  command -v tmux >/dev/null 2>&1 || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  local state_json
  state_json="$(attention_state_read)"
  local rows
  rows="$(jq -r '
    (.entries // {}) | to_entries[] | .value
    | select(
        (.status // "") == "running"
        and ((.agent_name // "") | ascii_downcase) == "agy"
        and (.tmux_socket // "") != ""
        and (.tmux_pane // "") != ""
      )
    | [
        (.session_id // ""),
        (.wezterm_pane_id // ""),
        (.tmux_socket // ""),
        (.tmux_session // ""),
        (.tmux_window // ""),
        (.tmux_pane // ""),
        (.git_branch // ""),
        (.tmux_window_name // "")
      ] | join("\u001f")
  ' <<<"$state_json" 2>/dev/null || true)"
  [[ -n "$rows" ]] || return 0

  local sid wp sock sess win pane branch win_name screen watcher watcher_safe
  while IFS=$'\x1f' read -r sid wp sock sess win pane branch win_name; do
    [[ -n "$sid" && -n "$sock" && -n "$pane" ]] || continue
    if agy_probe_pane_is_focused "$sock" "$sess" "$pane" "$wp"; then
      continue
    fi
    screen="$(tmux -S "$sock" capture-pane -p -J -t "$pane" -S -30 2>/dev/null || true)"
    [[ -n "$screen" ]] || continue
    if ! agy_screen_has_permission_prompt "$screen"; then
      continue
    fi

    export AGENT_ATTENTION_AUDIT_OP="upsert"
    export AGENT_ATTENTION_AUDIT_OP_DETAIL="agy_screen_permission"
    export AGENT_ATTENTION_PROVIDER="agy"
    export AGENT_ATTENTION_RAW_EVENT="ScreenProbe"
    export AGENT_ATTENTION_AUDIT_SESSION_ID="$sid"
    export AGENT_ATTENTION_AUDIT_PREV_STATUS="running"
    export AGENT_ATTENTION_AUDIT_STATUS="waiting"
    export AGENT_ATTENTION_AUDIT_FOCUS_SKIPPED="0"
    export AGENT_ATTENTION_AUDIT_TMUX_PANE="$pane"
    export AGENT_ATTENTION_AUDIT_WEZTERM_PANE="$wp"

    attention_state_upsert \
      "$sid" "$wp" "$sock" "$sess" "$win" "$pane" \
      "waiting" "Agy permission prompt" "$branch" "permission_prompt" \
      "" "agy" "$win_name" 2>/dev/null || true

    unset AGENT_ATTENTION_AUDIT_OP AGENT_ATTENTION_AUDIT_OP_DETAIL \
      AGENT_ATTENTION_PROVIDER AGENT_ATTENTION_RAW_EVENT \
      AGENT_ATTENTION_AUDIT_SESSION_ID AGENT_ATTENTION_AUDIT_PREV_STATUS \
      AGENT_ATTENTION_AUDIT_STATUS AGENT_ATTENTION_AUDIT_FOCUS_SKIPPED \
      AGENT_ATTENTION_AUDIT_TMUX_PANE AGENT_ATTENTION_AUDIT_WEZTERM_PANE || true

    if declare -F runtime_log_info >/dev/null 2>&1; then
      runtime_log_info attention "agy permission prompt detected" \
        "provider=agy" "session_id=$sid" "tmux_pane=$pane" \
        "wezterm_pane=$wp" "waiting_kind=permission_prompt" 2>/dev/null || true
    fi

    if [[ -n "$repo_root" && "${WEZTERM_ATTENTION_WATCHER_DISABLED:-0}" != "1" ]]; then
      watcher="$repo_root/scripts/runtime/attention-prompt-watcher.sh"
      if [[ -x "$watcher" ]] && command -v setsid >/dev/null 2>&1; then
        watcher_safe="$(printf '%s|%s' "$sock" "$pane" | sha1sum 2>/dev/null | cut -c1-16)"
        if [[ -n "$watcher_safe" ]]; then
          setsid bash "$watcher" \
            "$sid" "$wp" "$sock" "$sess" "$win" "$pane" "$branch" "$watcher_safe" \
            </dev/null >/dev/null 2>&1 &
          disown 2>/dev/null || true
        fi
      fi
    fi
  done <<<"$rows"
}
