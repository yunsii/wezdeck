#!/usr/bin/env bash
# Shared helpers for session-bridge (P0/P1).
# shellcheck disable=SC2034

set -euo pipefail

sb_repo_root() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  printf '%s\n' "$here"
}

sb_openclaw_home() {
  printf '%s\n' "${OPENCLAW_HOME:-$HOME/.openclaw}"
}

sb_state_dir() {
  local d
  d="$(sb_openclaw_home)/state"
  mkdir -p "$d" "$d/session-bridge-leases"
  printf '%s\n' "$d"
}

sb_log_dir() {
  local d
  d="$(sb_openclaw_home)/logs"
  mkdir -p "$d"
  printf '%s\n' "$d"
}

sb_panic_path() {
  local from_cfg=""
  if [[ -n "${SB_PANIC_PATH:-}" ]]; then
    printf '%s\n' "$SB_PANIC_PATH"
    return 0
  fi
  from_cfg="$(sb_cfg_get '.defaults.panic_path' 2>/dev/null || true)"
  if [[ -n "$from_cfg" && "$from_cfg" != "null" ]]; then
    # expand ~
    from_cfg="${from_cfg/#\~/$HOME}"
    printf '%s\n' "$from_cfg"
    return 0
  fi
  printf '%s\n' "$(sb_state_dir)/session-bridge.panic"
}

sb_audit_path() {
  printf '%s\n' "$(sb_log_dir)/session-bridge-audit.jsonl"
}

sb_config_path() {
  if [[ -n "${SB_CONFIG:-}" ]]; then
    printf '%s\n' "$SB_CONFIG"
    return 0
  fi
  printf '%s\n' "$(sb_openclaw_home)/session-bridge.json"
}

sb_cfg_get() {
  local expr="$1"
  local cfg
  cfg="$(sb_config_path)"
  if [[ ! -f "$cfg" ]]; then
    return 1
  fi
  jq -er "$expr // empty" "$cfg" 2>/dev/null
}

sb_now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

sb_json_escape() {
  # stdin -> JSON string
  jq -Rs .
}

sb_die() {
  local code="$1"
  shift
  local msg="$*"
  if [[ "${SB_JSON:-0}" == "1" ]]; then
    jq -nc --arg msg "$msg" --argjson code "$code" \
      '{ok:false, error:$msg, exit_code:$code}'
  else
    printf 'session-bridge: %s\n' "$msg" >&2
  fi
  exit "$code"
}

sb_ok_json() {
  # merge extra object from stdin or arg
  if [[ $# -gt 0 ]]; then
    jq -nc --argjson extra "$1" '{ok:true} + $extra'
  else
    jq -nc '{ok:true} + input'
  fi
}

sb_panic_active() {
  local p
  p="$(sb_panic_path)"
  [[ -e "$p" ]]
}

sb_require_no_panic() {
  if sb_panic_active; then
    sb_die 75 "panic 已开启（$(sb_panic_path)）：所有写路径冻结。用 panic off 解除（不自动恢复）。"
  fi
}

sb_audit() {
  # sb_audit <action> <identity> <target> <ok|deny> <reason> [preview]
  local action="$1" identity="$2" target="$3" result="$4" reason="$5"
  local preview="${6:-}"
  local text_hash=""
  if [[ -n "$preview" ]]; then
    text_hash="$(printf '%s' "$preview" | sha256sum | awk '{print $1}')"
  fi
  local line
  line="$(jq -nc \
    --arg ts "$(sb_now_iso)" \
    --arg action "$action" \
    --arg identity "$identity" \
    --arg target "$target" \
    --arg result "$result" \
    --arg reason "$reason" \
    --arg preview "${preview:0:80}" \
    --arg text_hash "$text_hash" \
    '{ts:$ts, action:$action, identity:$identity, target:$target,
      result:$result, reason:$reason, preview:$preview, text_hash:$text_hash}')"
  printf '%s\n' "$line" >>"$(sb_audit_path)"
}

sb_resolve_alias() {
  local key="$1"
  local cfg resolved
  cfg="$(sb_config_path)"
  if [[ ! -f "$cfg" ]]; then
    printf '%s\n' "$key"
    return 0
  fi
  resolved="$(jq -er --arg k "$key" '.aliases[$k] // empty' "$cfg" 2>/dev/null || true)"
  if [[ -n "$resolved" ]]; then
    printf '%s\n' "$resolved"
  else
    printf '%s\n' "$key"
  fi
}

sb_default_capture_lines() {
  local n
  n="$(sb_cfg_get '.defaults.capture_lines' 2>/dev/null || true)"
  if [[ -z "$n" || "$n" == "null" ]]; then
    n=40
  fi
  printf '%s\n' "$n"
}

# Map a process name (comm or argv0 basename) → agent kind. Empty + exit 1 if not agent.
sb_name_to_agent_kind() {
  local raw="${1:-}" base
  [[ -n "$raw" ]] || return 1
  base="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  base="${base##*/}"          # basename
  base="${base%%[[:space:]]*}" # first token only
  case "$base" in
    claude|claude-*) printf 'claude-tui\n'; return 0 ;;
    codex|codex-*) printf 'codex-tui\n'; return 0 ;;
    grok|grok-*) printf 'grok-tui\n'; return 0 ;;
    opencode|opencode-*) printf 'claude-tui\n'; return 0 ;;
  esac
  return 1
}

# cmd-only kind. Title is never consulted (task titles are noise: "Node …", "…ship…").
sb_infer_kind_from_cmd() {
  local cmd_l k=""
  cmd_l="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  k="$(sb_name_to_agent_kind "$cmd_l" 2>/dev/null || true)"
  if [[ -n "$k" ]]; then
    printf '%s\n' "$k"
    return 0
  fi
  case "$cmd_l" in
    node|nodejs|python|python3|zsh|bash|fish|sh|dash|sudo) printf 'shell\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

# API kept as (cmd, title?) for call-site compat; title is ignored.
sb_infer_kind() {
  local cmd="$1"
  # "$2" title intentionally unused — process/cmd only.
  sb_infer_kind_from_cmd "$cmd"
}

# pane_id → pane_pid (tmux).
sb_pane_pid() {
  local pane_id="${1:-}"
  [[ -n "$pane_id" ]] || return 1
  if ! declare -F sb_tmux >/dev/null 2>&1; then
    return 1
  fi
  local pid
  pid="$(sb_tmux display-message -t "$pane_id" -p '#{pane_pid}' 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$pid"
}

# Resolve agent kind from one pid's comm + argv0.
sb_pid_agent_kind() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  local comm args0 k
  comm="$(ps -o comm= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  args0="$(ps -o args= -p "$pid" 2>/dev/null | awk '{print $1}')"
  k="$(sb_name_to_agent_kind "$comm" 2>/dev/null || true)"
  [[ -n "$k" ]] && { printf '%s\n' "$k"; return 0; }
  k="$(sb_name_to_agent_kind "$args0" 2>/dev/null || true)"
  [[ -n "$k" ]] && { printf '%s\n' "$k"; return 0; }
  return 1
}

# Primary signal: processes in the foreground process group of the pane tty
# (ps STAT contains '+'). This is the real interactive job — not the idle
# shell left as pane_pid / pane_current_command after `claude` is spawned
# under `sh -c` or as a child of zsh.
sb_pane_fg_agent_kind() {
  local pane_id="${1:-}"
  local pid tty st spid k
  pid="$(sb_pane_pid "$pane_id" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  tty="$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ -n "$tty" && "$tty" != "?" ]] || return 1

  # ps -o stat=,pid= → "Sl+  500974" (spacing varies)
  while read -r st spid; do
    [[ -n "${st:-}" && -n "${spid:-}" ]] || continue
    [[ "$st" == *'+'* ]] || continue
    [[ "$spid" =~ ^[0-9]+$ ]] || continue
    k="$(sb_pid_agent_kind "$spid" 2>/dev/null || true)"
    if [[ -n "$k" ]]; then
      printf '%s\n' "$k"
      return 0
    fi
  done < <(ps -o stat=,pid= -t "$tty" 2>/dev/null || true)
  return 1
}

# Fallback: walk pane_pid descendants (depth-limited) when FG scan misses
# (spawn race, agent briefly not in FG group).
sb_pane_tree_agent_kind() {
  local pane_id="${1:-}"
  local root
  root="$(sb_pane_pid "$pane_id" 2>/dev/null || true)"
  [[ -n "$root" ]] || return 1

  local -a queue=("$root")
  local -A seen=()
  local depth=0 pid cpid k
  while ((${#queue[@]} > 0)) && ((depth < 6)); do
    local -a next=()
    for pid in "${queue[@]}"; do
      [[ -n "${seen[$pid]:-}" ]] && continue
      seen[$pid]=1
      k="$(sb_pid_agent_kind "$pid" 2>/dev/null || true)"
      if [[ -n "$k" ]]; then
        printf '%s\n' "$k"
        return 0
      fi
      while read -r cpid; do
        [[ "$cpid" =~ ^[0-9]+$ ]] || continue
        next+=("$cpid")
      done < <(ps -o pid= --ppid "$pid" 2>/dev/null || true)
    done
    queue=("${next[@]}")
    depth=$((depth + 1))
  done
  return 1
}

# Canonical process-based kind: FG first, then descendant tree.
sb_pane_agent_kind_from_process() {
  local pane_id="${1:-}"
  local k=""
  [[ -n "$pane_id" ]] || return 1
  k="$(sb_pane_fg_agent_kind "$pane_id" 2>/dev/null || true)"
  if [[ -n "$k" ]]; then
    printf '%s\n' "$k"
    return 0
  fi
  k="$(sb_pane_tree_agent_kind "$pane_id" 2>/dev/null || true)"
  if [[ -n "$k" ]]; then
    printf '%s\n' "$k"
    return 0
  fi
  return 1
}

sb_pane_has_agent_process() {
  sb_pane_agent_kind_from_process "${1:-}" >/dev/null 2>&1
}

# Resolve kind for a pane: **process first**, then pane_current_command name.
# Title is never used. Call sites: take / host-status.
sb_resolve_pane_kind() {
  local pane_id="${1:-}" cmd="${2:-}"
  # optional 3rd arg (title) ignored if present
  local k=""
  if [[ -n "$pane_id" ]]; then
    k="$(sb_pane_agent_kind_from_process "$pane_id" 2>/dev/null || true)"
    if [[ -n "$k" ]]; then
      printf '%s\n' "$k"
      return 0
    fi
  fi
  sb_infer_kind_from_cmd "$cmd"
}

# --- tmux binary resolution (side-load safety) ---
# Accident: WezDeck server often runs ~/.local/bin/tmux (e.g. 3.7b) while
# non-interactive PATH hits /usr/bin/tmux (3.4). Mixing client/server
# versions yields "server exited unexpectedly" even though the server lives.

sb_tmux_socket() {
  if [[ -n "${SB_TMUX_SOCKET:-}" ]]; then
    printf '%s\n' "$SB_TMUX_SOCKET"
    return 0
  fi
  if [[ -n "${TMUX:-}" ]]; then
    # TMUX=/tmp/tmux-1000/default,1234,0
    local sock="${TMUX%%,*}"
    if [[ -S "$sock" ]]; then
      printf '%s\n' "$sock"
      return 0
    fi
  fi
  local uid
  uid="$(id -u)"
  if [[ -S "/tmp/tmux-${uid}/default" ]]; then
    printf '%s\n' "/tmp/tmux-${uid}/default"
    return 0
  fi
  printf '%s\n' ""
}

sb_tmux_candidates() {
  local seen="|" c
  # explicit overrides first
  for c in "${SB_TMUX_BIN:-}" "$(sb_cfg_get '.defaults.tmux_bin' 2>/dev/null || true)"; do
    [[ -z "$c" || "$c" == "null" ]] && continue
    c="${c/#\~/$HOME}"
    if [[ -x "$c" && "$seen" != *"|$c|"* ]]; then
      printf '%s\n' "$c"
      seen+="$c|"
    fi
  done
  # prefer user-local build (WezDeck managed), then PATH order
  for c in \
    "${HOME}/.local/bin/tmux" \
    "/usr/local/bin/tmux" \
    "$(command -v tmux 2>/dev/null || true)" \
    "/usr/bin/tmux" \
    "/bin/tmux"; do
    [[ -z "$c" ]] && continue
    if [[ -x "$c" && "$seen" != *"|$c|"* ]]; then
      printf '%s\n' "$c"
      seen+="$c|"
    fi
  done
}

# Resolve a tmux client that can talk to the live server on socket.
# Caches in SB_TMUX_BIN_RESOLVED for the process.
sb_tmux_bin() {
  if [[ -n "${SB_TMUX_BIN_RESOLVED:-}" && -x "${SB_TMUX_BIN_RESOLVED}" ]]; then
    printf '%s\n' "$SB_TMUX_BIN_RESOLVED"
    return 0
  fi
  local sock cand
  sock="$(sb_tmux_socket)"
  while IFS= read -r cand; do
    [[ -z "$cand" || ! -x "$cand" ]] && continue
    if [[ -n "$sock" ]]; then
      if "$cand" -S "$sock" list-sessions >/dev/null 2>&1; then
        SB_TMUX_BIN_RESOLVED="$cand"
        export SB_TMUX_BIN_RESOLVED
        printf '%s\n' "$cand"
        return 0
      fi
    else
      # no socket yet — accept first executable
      SB_TMUX_BIN_RESOLVED="$cand"
      export SB_TMUX_BIN_RESOLVED
      printf '%s\n' "$cand"
      return 0
    fi
  done < <(sb_tmux_candidates)

  # last resort: whatever is on PATH (may still mismatch)
  if command -v tmux >/dev/null 2>&1; then
    SB_TMUX_BIN_RESOLVED="$(command -v tmux)"
    export SB_TMUX_BIN_RESOLVED
    printf '%s\n' "$SB_TMUX_BIN_RESOLVED"
    return 0
  fi
  return 1
}

# Run tmux with resolved binary + default socket when not already specified.
# Usage: sb_tmux <tmux-args…>
sb_tmux() {
  local bin sock
  bin="$(sb_tmux_bin)" || sb_die 2 "找不到可用的 tmux 二进制"
  sock="$(sb_tmux_socket)"
  if [[ -n "$sock" ]]; then
    # If caller already passed -S/-L, do not double-inject.
    local has_sock=0 arg
    for arg in "$@"; do
      case "$arg" in
        -S|-L|--socket) has_sock=1; break ;;
      esac
    done
    if [[ $has_sock -eq 0 ]]; then
      "$bin" -S "$sock" "$@"
      return $?
    fi
  fi
  "$bin" "$@"
}
