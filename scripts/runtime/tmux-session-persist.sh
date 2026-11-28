#!/usr/bin/env bash
# Save managed tmux windows and rebuild them after a WSL restart.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${WEZDECK_REPO:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/wsl-runtime-paths-lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/tmux-worktree-lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/agent-session-resolve.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/worktree/lib/resume-command.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/attention-state-lib.sh"

SNAPSHOT="${WEZDECK_TMUX_SESSIONS_FILE:-$WSL_TMUX_SESSIONS_FILE}"
LOCK="${SNAPSHOT}.lock"
resolve_attention_file() {
  local preferred candidate
  preferred="$(attention_state_path)"
  if [[ -n "${WEZDECK_ATTENTION_STATE_PATH:-}" || "$preferred" == /mnt/* ]]; then
    printf '%s' "$preferred"
    return 0
  fi
  # A systemd user unit has no Windows interop, and the path cache may be
  # expired after a long shutdown. The relay uses this same mounted-file
  # fallback before its WSL-local attention path.
  for candidate in /mnt/c/Users/*/AppData/Local/wezterm-runtime/state/agent-attention/attention.json; do
    if [[ -f "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  printf '%s' "$preferred"
}
ATTENTION_FILE="$(resolve_attention_file)"
MODE="${1:-}"
case "$MODE" in
  save|restore|status) ;;
  *) printf 'usage: %s save|restore|status\n' "$0" >&2; exit 2 ;;
esac
command -v jq >/dev/null || { printf 'jq is required\n' >&2; exit 1; }

agent_for_pane() {
  local pane="$1" command role profile
  command="$(tmux display-message -p -t "$pane" '#{pane_current_command}')"
  role="$(tmux show-options -p -v -t "$pane" @wezterm_pane_role 2>/dev/null || true)"
  case "$command" in
    claude*|codex|grok|agy)
      profile="${command%%-*}"
      [[ "$role" == agent-cli:* ]] && profile="${role#agent-cli:}"
      ;;
    python3)
      [[ "$role" == agent-cli:grok ]] && profile=grok || profile=""
      ;;
    *) profile="" ;;
  esac
  printf '%s' "$profile"
}

snapshot_pane() {
  local pane="$1" root="$2" slot="$3" profile pin sid="" attention="" status="" started="" active=""
  profile="$(agent_for_pane "$pane")"
  active="$(tmux display-message -p -t "$pane" '#{pane_active}')"
  pin="$(agent_session_pin_get "$root" "$slot" 2>/dev/null || true)"
  if [[ "$pin" == *$'\t'* ]]; then
    sid="${pin%%$'\t'*}"
    [[ -n "$profile" ]] || sid=""
  fi
  if [[ -n "$sid" && -f "$ATTENTION_FILE" ]]; then
    attention="$(jq -r --arg sid "$sid" '(.entries[$sid] // {}) | [(.status // ""), ((.turn_started // .ts // 0) | tostring)] | @tsv' "$ATTENTION_FILE" 2>/dev/null || true)"
    IFS=$'\t' read -r status started <<< "$attention"
  fi
  jq -nc --arg kind "$([[ -n "$profile" ]] && printf agent || printf shell)" \
    --arg profile "$profile" --arg sid "$sid" --arg status "$status" \
    --arg started "$started" --arg active "$active" \
    '{kind:$kind,profile:$profile,sid:$sid,status:$status,turn_started:$started,active:($active == "1")}'
}

save_snapshot() {
  local sessions session workspace role window index name active root panes pane slot pane_count
  local window_rows="" pane_rows="" window_json="" session_json=""
  local -a saved=()
  if ! sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null)"; then
    runtime_log_warn tmux_persist 'save skipped: tmux server unavailable'
    return 0
  fi
  while IFS= read -r session; do
    [[ -n "$session" ]] || continue
    role="$(tmux show-options -v -t "$session" @wezterm_session_role 2>/dev/null || true)"
    if [[ "$role" != managed ]]; then
      case "$session" in
        wezterm_*|wezdeck_recovered_*) ;;
        *) continue ;;
      esac
    fi
    workspace="$(tmux show-options -v -t "$session" @wezterm_workspace 2>/dev/null || true)"
    window_rows=""
    while IFS=$'\t' read -r window index name active; do
      [[ -n "$window" ]] || continue
      root="$(tmux_worktree_window_metadata "$window" @wezterm_window_root)"
      [[ -n "$root" ]] || root="$(tmux display-message -p -t "$window" '#{pane_current_path}')"
      [[ "$root" == /* && -d "$root" ]] || continue
      if [[ "$role" != managed ]] && ! tmux_worktree_in_git_repo "$root"; then
        continue
      fi
      pane_rows=""
      pane_count=0
      while IFS= read -r pane; do
        [[ -n "$pane" ]] || continue
        ((pane_count += 1))
        slot=primary
        (( pane_count > 1 )) && slot=secondary
        pane_rows+="$(snapshot_pane "$pane" "$root" "$slot")"$'\n'
      done < <(tmux list-panes -t "$window" -F '#{pane_id}')
      [[ -n "$pane_rows" ]] || continue
      panes="$(jq -sc . <<< "$pane_rows")"
      window_json="$(jq -nc --arg name "$name" --arg root "$root" \
        --argjson index "$index" --argjson active "$active" --argjson panes "$panes" \
        '{index:$index,name:$name,root:$root,active:($active == 1),panes:$panes}')"
      window_rows+="$window_json"$'\n'
    done < <(tmux list-windows -t "$session" -F '#{window_id}'$'\t''#{window_index}'$'\t''#{window_name}'$'\t''#{window_active}')
    [[ -n "$window_rows" ]] || continue
    session_json="$(jq -nc --arg name "$session" --arg workspace "$workspace" \
      --argjson windows "$(jq -sc 'sort_by(.index)' <<< "$window_rows")" \
      '{name:$name,workspace:$workspace,windows:$windows}')"
    saved+=("$session_json")
  done <<< "$sessions"
  mkdir -p "$(dirname "$SNAPSHOT")"
  local tmp="${SNAPSHOT}.tmp.$$"
  printf '%s\n' "${saved[@]}" | jq -sc --argjson ts "$(date +%s%3N)" \
    '{version:1,saved_at:$ts,sessions:map(select(.name != null))}' > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$SNAPSHOT"
  runtime_log_info tmux_persist 'saved managed sessions' "sessions=${#saved[@]}" "file=$SNAPSHOT"
}

pane_command() {
  local root="$1" kind="$2" profile="$3" resolved="" quoted=""
  if [[ "$kind" == agent && -n "$profile" ]]; then
    resolved="$(resolve_profile_resume_command "$REPO_ROOT" "$profile" "$root" 2>/dev/null || true)"
  fi
  if [[ -n "$resolved" ]]; then
    printf -v quoted 'bash -lc %q' "$resolved"
  else
    printf -v quoted '%q -l' "$(resolve_login_shell)"
  fi
  printf '%s' "$quoted"
}

snapshot_window_exists() {
  local session="$1" name="$2" root="$3" candidate current_name current_root
  while IFS=$'\t' read -r candidate current_name; do
    [[ "$current_name" == "$name" ]] || continue
    current_root="$(tmux_worktree_window_metadata "$candidate" @wezterm_window_root)"
    [[ -n "$current_root" ]] || current_root="$(tmux display-message -p -t "$candidate" '#{pane_current_path}')"
    [[ "$current_root" == "$root" ]] && { printf '%s' "$candidate"; return 0; }
  done < <(tmux list-windows -t "$session" -F '#{window_id}'$'\t''#{window_name}' 2>/dev/null || true)
  return 1
}

restore_snapshot() {
  [[ -s "$SNAPSHOT" ]] || { runtime_log_info tmux_persist 'restore skipped: no snapshot'; return 0; }
  jq -e '.version == 1 and (.sessions | type == "array")' "$SNAPSHOT" >/dev/null || {
    runtime_log_error tmux_persist 'restore refused invalid snapshot' "file=$SNAPSHOT"
    return 1
  }
  local row session workspace windows window root name index window_id command pane kind profile
  local pane_id first_pane active_window="" active_pane=""
  local created=0 skipped=0
  while IFS= read -r row; do
    session="$(jq -r '.name' <<< "$row")"
    workspace="$(jq -r '.workspace' <<< "$row")"
    [[ "$session" =~ ^[A-Za-z0-9_-]+$ ]] || { ((skipped += 1)); continue; }
    if tmux has-session -t "=$session" 2>/dev/null; then
      if [[ "$(tmux_worktree_session_metadata "$session" @wezterm_session_role)" != managed ]]; then
        case "$session" in
          wezterm_*|wezdeck_recovered_*) tmux_worktree_set_session_metadata "$session" "$workspace" managed ;;
          *)
            runtime_log_warn tmux_persist 'session name occupied by unmanaged session' "session_name=$session"
            ((skipped += 1))
            continue
            ;;
        esac
      fi
    fi
    windows="$(jq -c '.windows[]' <<< "$row")"
    [[ -n "$windows" ]] || continue
    active_window=""
    while IFS= read -r window; do
      root="$(jq -r '.root' <<< "$window")"
      name="$(jq -r '.name' <<< "$window")"
      index="$(jq -r '.index' <<< "$window")"
      [[ "$root" == /* && -d "$root" && "$index" =~ ^[0-9]+$ ]] || { ((skipped += 1)); continue; }
      window_id="$(snapshot_window_exists "$session" "$name" "$root" 2>/dev/null || true)"
      if [[ -n "$window_id" ]]; then
        ((skipped += 1))
        continue
      fi
      pane="$(jq -c '.panes[0]' <<< "$window")"
      kind="$(jq -r '.kind' <<< "$pane")"
      profile="$(jq -r '.profile' <<< "$pane")"
      command="$(pane_command "$root" "$kind" "$profile")"
      if [[ "$kind" == agent && -n "$profile" ]]; then
        printf -v command 'bash %q %s' "$SCRIPT_DIR/primary-pane-wrapper.sh" "$command"
      fi
      if tmux has-session -t "=$session" 2>/dev/null; then
        if tmux list-windows -t "$session" -F '#{window_index}' | grep -Fxq "$index"; then
          window_id="$(tmux new-window -d -P -F '#{window_id}' -t "$session:" -n "$name" -c "$root" "$command")"
        else
          window_id="$(tmux new-window -d -P -F '#{window_id}' -t "$session:$index" -n "$name" -c "$root" "$command")"
        fi
      else
        window_id="$(tmux new-session -d -P -F '#{window_id}' -s "$session" -n "$name" -c "$root" "$command")"
        tmux_worktree_set_session_metadata "$session" "$workspace" managed
        if [[ -f "$REPO_ROOT/tmux.conf" ]]; then
          tmux_worktree_ensure_tmux_config_loaded "$REPO_ROOT/tmux.conf" "$REPO_ROOT"
        fi
      fi
      tmux_worktree_set_window_metadata "$window_id" managed_primary "$root" "$name" "$command" managed_two_pane
      first_pane="$(tmux list-panes -t "$window_id" -F '#{pane_id}' | head -n 1)"
      tmux set-window-option -t "$window_id" -q @wezterm_window_primary_pane "$first_pane"
      if [[ "$kind" == agent && -n "$profile" ]]; then
        tmux set-option -p -t "$first_pane" -q @wezterm_pane_role "agent-cli:$profile"
      fi
      restore_pane_state "$pane" "$root" primary "$session" "$window_id" "$name" "$first_pane"
      active_pane="$first_pane"
      pane="$(jq -c '.panes[1] // empty' <<< "$window")"
      if [[ -n "$pane" ]]; then
        kind="$(jq -r '.kind' <<< "$pane")"
        profile="$(jq -r '.profile' <<< "$pane")"
        command="$(pane_command "$root" "$kind" "$profile")"
        pane_id="$(tmux split-window -d -h -P -F '#{pane_id}' -t "$first_pane" -c "$root" "$command")"
        if [[ "$kind" == agent && -n "$profile" ]]; then
          tmux set-option -p -t "$pane_id" -q @wezterm_pane_role "agent-cli:$profile"
        fi
        restore_pane_state "$pane" "$root" secondary "$session" "$window_id" "$name" "$pane_id"
        [[ "$(jq -r '.active' <<< "$pane")" == true ]] && active_pane="$pane_id"
      fi
      tmux select-pane -t "$active_pane"
      ((created += 1))
      if [[ "$(jq -r '.active' <<< "$window")" == true ]]; then
        active_window="$window_id"
      fi
    done <<< "$windows"
    [[ -n "$active_window" ]] && tmux select-window -t "$active_window"
  done < <(jq -c '.sessions[]' "$SNAPSHOT")
  runtime_log_info tmux_persist 'restored managed sessions' "created=$created" "skipped=$skipped" "file=$SNAPSHOT"
  printf 'created=%s skipped=%s\n' "$created" "$skipped"
}

restore_pane_state() {
  local pane="$1" root="$2" slot="$3" session="$4" window="$5" name="$6" pane_id="$7"
  local sid profile status started pin current_sid
  sid="$(jq -r '.sid' <<< "$pane")"
  profile="$(jq -r '.profile' <<< "$pane")"
  status="$(jq -r '.status' <<< "$pane")"
  started="$(jq -r '.turn_started' <<< "$pane")"
  [[ -n "$sid" && "$sid" != null ]] || return 0
  pin="$(agent_session_pin_get "$root" "$slot" 2>/dev/null || true)"
  current_sid="${pin%%$'\t'*}"
  [[ "$current_sid" == "$sid" ]] || return 0
  tmux set-option -p -t "$pane_id" -q @wezterm_agent_session_id "$sid"
  if [[ "$status" == running || "$status" == waiting ]] && [[ "$started" =~ ^[0-9]+$ ]]; then
    tmux set-option -p -t "$pane_id" -q @wezdeck_interrupted_turn "$sid/$started"
    rebind_interrupted "$sid" "$session" "$window" "$name" "$pane_id" "$started" || true
  fi
}

rebind_interrupted() {
  local sid="$1" session="$2" window="$3" name="$4" pane="$5" started="$6"
  local lock current next socket
  [[ -f "$ATTENTION_FILE" ]] || return 0
  socket="$(tmux display-message -p -t "$pane" '#{socket_path}' 2>/dev/null || true)"
  [[ -n "$socket" ]] || return 0
  lock="$(attention_state_lock_path)"
  (
    flock -x 8
    current="$(attention_state_read)"
    next="$(jq -c --arg sid "$sid" --arg session "$session" \
      --arg window "$window" --arg name "$name" --arg pane "$pane" \
      --arg socket "$socket" --arg started "$started" '
      if ((.entries[$sid].status // "") == "running" or (.entries[$sid].status // "") == "waiting")
        and ((.entries[$sid].turn_started // .entries[$sid].ts // 0 | tostring) == $started)
      then .entries[$sid] |= (.tmux_session = $session | .tmux_window = $window
        | .tmux_window_name = $name | .tmux_pane = $pane | .tmux_socket = $socket
        | .wezterm_pane_id = "")
      else . end
    ' <<< "$current")" || return 0
    [[ "$next" != "$current" ]] || return 0
    AGENT_ATTENTION_AUDIT_OP=crash_restore \
      AGENT_ATTENTION_AUDIT_SESSION_ID="$sid" \
      AGENT_ATTENTION_AUDIT_STATUS=interrupted \
      attention_state_write "$next"
    runtime_log_info tmux_persist 'rebound interrupted turn' "session_id=$sid" "pane=$pane"
  ) 8>"$lock"
}

if [[ "${2:-}" != --locked ]]; then
  mkdir -p "$(dirname "$LOCK")"
  # flock owns the lock in its parent; -o keeps the fd out of the tmux
  # server and its long-lived panes.
  exec flock -x -o "$LOCK" bash "$0" "$MODE" --locked
fi
case "$MODE" in
  save) save_snapshot ;;
  restore) restore_snapshot ;;
  status) if [[ -f "$SNAPSHOT" ]]; then jq '{saved_at,sessions:(.sessions|length),windows:([.sessions[].windows[]]|length)}' "$SNAPSHOT"; else printf 'no snapshot\n'; fi ;;
esac
