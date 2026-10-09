#!/usr/bin/env bash
# Resolve / pin the agent conversation id for a managed pane (primary or secondary).
#
# Preference order for id (first usable wins):
#   1. WEZDECK_RESUME_SESSION_ID (caller injection, e.g. F5 pre-respawn)
#   2. tmux pane option @wezterm_agent_session_id (survives respawn-pane; dies with pane)
#   3. durable pin file keyed by worktree cwd + slot (survives kill-server; cwd-isolated)
#   4. attention.json live / recent[] for (socket, session, pane) ONLY when the
#      entry's tmux_window_name matches the current window_name — pane ids are
#      recycled inside one tmux server, so a bare pane match can steal another
#      worktree's conversation (e.g. Alt+g create of dev-investigation
#      reusing %N that previously hosted dev-infra).
#   5. window option @wezterm_primary_agent_session_id (legacy primary compat)
#
# When nothing usable remains, callers fall through to cwd-scoped CLI continue
# (`claude --continue` / `codex resume --last` / `grok --continue`), which is
# the agent CLI's native project/cwd isolation.
#
# Rejects attention fallback keys (`pane:<N>`) — those are not CLI resume ids.
# Sourced by agent-resume.sh / agent-launcher.sh / tmux-reset F5 / ensure_window_panes.

set -u

__AGENT_SESSION_RESOLVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

agent_session_id_usable() {
  local sid="${1:-}"
  [[ -n "$sid" ]] || return 1
  case "$sid" in
    pane:*) return 1 ;;
  esac
  return 0
}

agent_session_normalize_agent() {
  local raw="${1:-}"
  case "$raw" in
    claude|claude-sub2api|claude_sub2api) printf 'claude\n' ;;
    codex) printf 'codex\n' ;;
    grok) printf 'grok\n' ;;
    *) return 1 ;;
  esac
}

agent_session_pins_path() {
  if [[ -n "${WEZDECK_AGENT_SESSION_PINS_PATH:-}" ]]; then
    printf '%s' "$WEZDECK_AGENT_SESSION_PINS_PATH"
    return 0
  fi
  # shellcheck disable=SC1091
  . "$__AGENT_SESSION_RESOLVE_DIR/wsl-runtime-paths-lib.sh" 2>/dev/null || true
  if [[ -n "${WSL_AGENT_SESSION_PINS_FILE:-}" ]]; then
    printf '%s' "$WSL_AGENT_SESSION_PINS_FILE"
    return 0
  fi
  printf '%s' "${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/state/agent-session-pins.json"
}

agent_session_canonicalize_cwd() {
  local cwd="${1:-}"
  local abs=""
  [[ -n "$cwd" ]] || return 1
  if [[ -d "$cwd" ]]; then
    abs="$(cd "$cwd" 2>/dev/null && pwd -P || true)"
  fi
  [[ -n "$abs" ]] || abs="$cwd"
  printf '%s' "$abs"
}

# primary | secondary — based on window primary marker / leftmost pane.
agent_session_slot_for_pane() {
  local pane_id="${1:-}"
  local window_id="" primary=""
  [[ -n "$pane_id" ]] || return 1
  window_id="$(tmux display-message -p -t "$pane_id" '#{window_id}' 2>/dev/null || true)"
  [[ -n "$window_id" ]] || return 1
  primary="$(tmux show-window-options -t "$window_id" -v @wezterm_window_primary_pane 2>/dev/null || true)"
  if [[ -n "$primary" ]] \
    && ! tmux list-panes -t "$window_id" -F '#{pane_id}' 2>/dev/null | grep -Fxq "$primary"; then
    primary=""
  fi
  if [[ -z "$primary" ]]; then
    primary="$(tmux list-panes -t "$window_id" -F '#{pane_id}|#{pane_left}' 2>/dev/null \
      | sort -t '|' -k2,2n | head -n 1 | cut -d '|' -f1)"
  fi
  if [[ -n "$primary" && "$pane_id" == "$primary" ]]; then
    printf 'primary\n'
  else
    printf 'secondary\n'
  fi
}

agent_session_pin_key() {
  local cwd="${1:-}" slot="${2:-}"
  local abs=""
  abs="$(agent_session_canonicalize_cwd "$cwd" 2>/dev/null || true)"
  [[ -n "$abs" && -n "$slot" ]] || return 1
  printf '%s\t%s' "$abs" "$slot"
}

# Print "session_id<TAB>agent" or empty.
agent_session_pin_get() {
  local cwd="${1:-}" slot="${2:-}"
  local path key=""
  path="$(agent_session_pins_path)"
  [[ -f "$path" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  key="$(agent_session_pin_key "$cwd" "$slot" 2>/dev/null || true)"
  [[ -n "$key" ]] || return 0
  jq -r --arg k "$key" '
    ((.pins // {})[$k] // empty) as $p
    | if ($p|type) == "object"
        and (($p.session_id // "") != "")
        and (($p.session_id // "") | startswith("pane:") | not)
        and (($p.agent // "") != "")
      then "\($p.session_id)\t\($p.agent)"
      else empty end
  ' "$path" 2>/dev/null || true
}

agent_session_pin_put() {
  local cwd="${1:-}" slot="${2:-}" sid="${3:-}" agent="${4:-}"
  local path dir key="" tmp="" normalized="" now_ms=""
  agent_session_id_usable "$sid" || return 0
  normalized="$(agent_session_normalize_agent "$agent" 2>/dev/null || true)"
  [[ -n "$normalized" ]] || return 0
  key="$(agent_session_pin_key "$cwd" "$slot" 2>/dev/null || true)"
  [[ -n "$key" ]] || return 0
  path="$(agent_session_pins_path)"
  dir="${path%/*}"
  mkdir -p "$dir" 2>/dev/null || true
  now_ms="$(date +%s%3N 2>/dev/null || date +%s)"
  command -v jq >/dev/null 2>&1 || return 0
  (
    flock -w 2 9 || exit 0
    if [[ -f "$path" ]] && jq -e . "$path" >/dev/null 2>&1; then
      :
    else
      printf '%s\n' '{"version":1,"pins":{}}' > "$path"
    fi
    tmp="${path}.tmp.$$"
    jq --arg k "$key" --arg sid "$sid" --arg agent "$normalized" \
      --argjson ts "$now_ms" --arg slot "$slot" --arg cwd "$cwd" '
      .version = 1
      | .pins = (.pins // {})
      | .pins[$k] = {
          session_id: $sid,
          agent: $agent,
          slot: $slot,
          cwd: $cwd,
          updated_ts: $ts
        }
    ' "$path" > "$tmp" 2>/dev/null && mv -f "$tmp" "$path"
    rm -f "$tmp" 2>/dev/null || true
  ) 9>"${path}.lock"
}

agent_session_pin_clear() {
  local cwd="${1:-}" slot="${2:-}"
  local path key="" tmp=""
  path="$(agent_session_pins_path)"
  [[ -f "$path" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  key="$(agent_session_pin_key "$cwd" "$slot" 2>/dev/null || true)"
  [[ -n "$key" ]] || return 0
  (
    flock -w 2 9 || exit 0
    tmp="${path}.tmp.$$"
    jq --arg k "$key" 'del(.pins[$k])' "$path" > "$tmp" 2>/dev/null && mv -f "$tmp" "$path"
    rm -f "$tmp" 2>/dev/null || true
  ) 9>"${path}.lock"
}

# Persist on the live pane (survives respawn-pane) + durable file (survives kill-server).
agent_session_pin_pane() {
  local pane_id="${1:-}" sid="${2:-}" agent="${3:-}" cwd="${4:-}"
  local slot="" normalized=""
  agent_session_id_usable "$sid" || return 0
  [[ -n "$pane_id" ]] || return 0
  normalized="$(agent_session_normalize_agent "${agent:-}" 2>/dev/null || true)"
  tmux set-option -p -t "$pane_id" -q @wezterm_agent_session_id "$sid" 2>/dev/null || true
  if [[ -n "$normalized" ]]; then
    tmux set-option -p -t "$pane_id" -q @wezterm_agent_profile "$normalized" 2>/dev/null || true
  fi
  # Compat: keep window pin for primary so older readers still work.
  slot="$(agent_session_slot_for_pane "$pane_id" 2>/dev/null || true)"
  if [[ "$slot" == "primary" ]]; then
    tmux set-window-option -t "$pane_id" -q @wezterm_primary_agent_session_id "$sid" 2>/dev/null || true
  fi
  if [[ -z "$cwd" ]]; then
    cwd="$(tmux display-message -p -t "$pane_id" '#{pane_current_path}' 2>/dev/null || true)"
  fi
  if [[ -n "$cwd" && -n "$slot" && -n "$normalized" ]]; then
    agent_session_pin_put "$cwd" "$slot" "$sid" "$normalized"
  fi
}

# Back-compat alias used by earlier primary-only callers.
agent_session_pin_window() {
  local window_or_pane="${1:-}" sid="${2:-}"
  agent_session_pin_pane "$window_or_pane" "$sid" "${3:-}" "${4:-}"
}

# Print session id for a concrete tmux pane target (e.g. %12), or empty.
agent_session_resolve_for_pane() {
  local pane_id="${1:-}"
  local tmux_meta="" tmux_socket="" tmux_session="" tmux_window="" tmux_pane=""
  local tmux_window_name="" sid="" cwd="" slot="" pin=""

  [[ -n "$pane_id" ]] || return 0

  tmux_meta="$(tmux display-message -p -t "$pane_id" \
    -F '#{socket_path}|#{session_name}|#{window_id}|#{pane_id}|#{window_name}' 2>/dev/null || true)"
  if [[ -n "$tmux_meta" ]]; then
    IFS='|' read -r tmux_socket tmux_session tmux_window tmux_pane tmux_window_name <<<"$tmux_meta"
  fi
  [[ -n "$tmux_pane" ]] || tmux_pane="$pane_id"

  # Same-pane respawn (F5): pane option survives and is authoritative for this pane.
  sid="$(tmux show-options -p -t "$pane_id" -v -q @wezterm_agent_session_id 2>/dev/null || true)"
  if agent_session_id_usable "$sid"; then
    printf '%s\n' "$sid"
    return 0
  fi

  # Worktree cwd pin: survives kill-server; isolates linked worktrees of one repo family.
  cwd="$(tmux display-message -p -t "$pane_id" '#{pane_current_path}' 2>/dev/null || true)"
  slot="$(agent_session_slot_for_pane "$pane_id" 2>/dev/null || true)"
  if [[ -n "$cwd" && -n "$slot" ]]; then
    pin="$(agent_session_pin_get "$cwd" "$slot" || true)"
    sid="${pin%%$'\t'*}"
    if agent_session_id_usable "$sid"; then
      printf '%s\n' "$sid"
      return 0
    fi
  fi

  # Attention is pane-keyed; require window_name match so recycled pane ids
  # cannot pull another worktree's conversation into a newly created window.
  sid="$(agent_session_resolve_from_attention \
    "$tmux_socket" "$tmux_session" "$tmux_pane" "$tmux_window_name" || true)"
  if agent_session_id_usable "$sid"; then
    printf '%s\n' "$sid"
    return 0
  fi

  sid="$(tmux show-options -w -t "$pane_id" -v -q @wezterm_primary_agent_session_id 2>/dev/null || true)"
  if agent_session_id_usable "$sid"; then
    printf '%s\n' "$sid"
  fi
}

# Print agent profile (claude|codex|grok) for a pane, or empty.
agent_session_agent_for_pane() {
  local pane_id="${1:-}"
  local role="" cmd="" detected="" cwd="" slot="" pin="" agent=""
  [[ -n "$pane_id" ]] || return 0

  role="$(tmux show-options -p -t "$pane_id" -v -q @wezterm_pane_role 2>/dev/null || true)"
  case "$role" in
    agent-cli:*)
      agent_session_normalize_agent "${role#agent-cli:}" 2>/dev/null && return 0
      ;;
  esac

  agent="$(tmux show-options -p -t "$pane_id" -v -q @wezterm_agent_profile 2>/dev/null || true)"
  if agent_session_normalize_agent "$agent" 2>/dev/null; then
    return 0
  fi

  cmd="$(tmux display-message -p -t "$pane_id" '#{pane_current_command}' 2>/dev/null || true)"
  case "$cmd" in
    claude*) agent_session_normalize_agent claude && return 0 ;;
    codex*) agent_session_normalize_agent codex && return 0 ;;
    grok*) agent_session_normalize_agent grok && return 0 ;;
  esac

  detected="$(agent_session_detect_agent_from_cmdline "$pane_id" || true)"
  if agent_session_normalize_agent "$detected" 2>/dev/null; then
    return 0
  fi

  cwd="$(tmux display-message -p -t "$pane_id" '#{pane_current_path}' 2>/dev/null || true)"
  slot="$(agent_session_slot_for_pane "$pane_id" 2>/dev/null || true)"
  if [[ -n "$cwd" && -n "$slot" ]]; then
    pin="$(agent_session_pin_get "$cwd" "$slot" || true)"
    agent="${pin#*$'\t'}"
    agent_session_normalize_agent "$agent" 2>/dev/null && return 0
  fi
}

# Walk pane_pid + descendants; print grok|claude|codex on first hit.
# Same contract as agent-ctrl-n.sh (hand-started secondary panes).
agent_session_detect_agent_from_cmdline() {
  local pane_id="${1:-}"
  local root_pid="" pid="" cmdline="" child=""
  local -a queue=()
  local -A seen=()

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
    case "$cmdline" in
      *grok-focus-filter*|*grok.real*|*/bin/grok*|*/grok[[:space:]]*|*/grok|*" grok "*|*" grok")
        printf 'grok\n'; return 0 ;;
      */bin/claude*|*/claude[[:space:]]*|*/claude|*" claude "*|*" claude")
        printf 'claude\n'; return 0 ;;
      *codex.js*|*/@openai/codex*|*/bin/codex*|*/codex[[:space:]]*|*/codex|*" codex "*|*" codex")
        printf 'codex\n'; return 0 ;;
    esac
    while IFS= read -r child; do
      [[ "$child" =~ ^[0-9]+$ ]] || continue
      queue+=("$child")
    done < <(pgrep -P "$pid" 2>/dev/null || true)
  done
  return 1
}

# Resolve for the pane that is about to exec the agent (current process).
agent_session_resolve_current() {
  local pane_id="${TMUX_PANE:-}"
  local sid=""

  if [[ -n "${WEZDECK_RESUME_SESSION_ID:-}" ]] \
    && agent_session_id_usable "${WEZDECK_RESUME_SESSION_ID:-}"; then
    printf '%s\n' "$WEZDECK_RESUME_SESSION_ID"
    return 0
  fi

  if [[ -n "$pane_id" ]]; then
    sid="$(agent_session_resolve_for_pane "$pane_id" || true)"
    if agent_session_id_usable "$sid"; then
      printf '%s\n' "$sid"
      return 0
    fi
  fi
}

# Optional $4 = current tmux window_name. When non-empty, the attention entry
# must carry the same tmux_window_name (fail closed if the entry lacks one).
agent_session_resolve_from_attention() {
  local tmux_socket="${1:-}"
  local tmux_session="${2:-}"
  local tmux_pane="${3:-}"
  local tmux_window_name="${4:-}"
  local path="" sid=""

  [[ -n "$tmux_pane" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  if [[ -n "${WEZDECK_ATTENTION_STATE_PATH:-}" ]]; then
    path="$WEZDECK_ATTENTION_STATE_PATH"
  else
    # shellcheck disable=SC1091
    . "$__AGENT_SESSION_RESOLVE_DIR/attention-state-lib.sh" 2>/dev/null || return 0
    path="$(attention_state_path 2>/dev/null || true)"
  fi
  [[ -n "$path" && -f "$path" ]] || return 0

  sid="$(jq -r \
    --arg sock "$tmux_socket" \
    --arg sess "$tmux_session" \
    --arg pane "$tmux_pane" \
    --arg wname "$tmux_window_name" '
      def usable:
        (.session_id // "") as $id
        | ($id != "" and ($id | startswith("pane:") | not));
      def pane_match:
        (.tmux_pane // "") == $pane
        and ($sess == "" or (.tmux_session // "") == $sess)
        and ($sock == "" or (.tmux_socket // "") == $sock);
      # Pane ids recycle inside one tmux server. When the caller knows the
      # current window_name, require an exact match so a new worktree window
      # that reused %N cannot resume another worktree conversation. Entries
      # missing tmux_window_name fail closed under that gate.
      def window_match:
        ($wname == "")
        or (
          ((.tmux_window_name // "") != "")
          and (.tmux_window_name // "") == $wname
        );
      ((.entries // {})
        | to_entries
        | map(.value)
        | map(select(pane_match and window_match and usable))
        | .[0].session_id // empty)
      // ((.recent // [])
        | map(select(pane_match and window_match and usable))
        | sort_by(-(.archived_ts // 0))
        | .[0].session_id // empty)
    ' "$path" 2>/dev/null || true)"

  if agent_session_id_usable "$sid"; then
    printf '%s\n' "$sid"
  fi
}

# Build a keep-alive wrapped agent-launcher resume command with typed id.
# Prints one shell command string suitable for tmux respawn-pane / split-window.
agent_session_build_typed_resume_command() {
  local repo="${1:-}"
  local agent="${2:-}"
  local sid="${3:-}"
  local launcher="" wrapper="" normalized=""
  normalized="$(agent_session_normalize_agent "$agent" 2>/dev/null || true)"
  agent_session_id_usable "$sid" || return 1
  [[ -n "$repo" && -n "$normalized" ]] || return 1
  launcher="$repo/scripts/runtime/agent-launcher.sh"
  wrapper="$repo/scripts/runtime/primary-pane-wrapper.sh"
  [[ -x "$launcher" ]] || return 1
  if [[ -x "$wrapper" ]]; then
    printf 'env WEZDECK_RESUME_SESSION_ID=%q bash %q bash %q %q\n' \
      "$sid" "$wrapper" "$launcher" "$normalized"
  else
    printf 'env WEZDECK_RESUME_SESSION_ID=%q bash %q %q\n' \
      "$sid" "$launcher" "$normalized"
  fi
}
