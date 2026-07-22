#!/usr/bin/env bash
# Host view: tmux panes → SessionCard[] (not a second source of truth).
# shellcheck source=lib.sh
set -euo pipefail

_SB_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/lib.sh"

sb_host_tmux_ok() {
  sb_tmux list-sessions >/dev/null 2>&1
}

# Best-effort attention.json path (WezDeck). Missing file → empty object.
sb_attention_state_path() {
  if [[ -n "${SB_ATTENTION_PATH:-}" && -f "${SB_ATTENTION_PATH}" ]]; then
    printf '%s\n' "$SB_ATTENTION_PATH"
    return 0
  fi
  local cand
  for cand in \
    "${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/state/agent-attention/attention.json" \
    "$HOME/.local/state/wezterm-runtime/state/agent-attention/attention.json"; do
    if [[ -f "$cand" ]]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  # Optional windows runtime via env if already exported by host
  if [[ -n "${WINDOWS_RUNTIME_STATE_WSL:-}" && -f "$WINDOWS_RUNTIME_STATE_WSL/state/agent-attention/attention.json" ]]; then
    printf '%s\n' "$WINDOWS_RUNTIME_STATE_WSL/state/agent-attention/attention.json"
    return 0
  fi
  printf '%s\n' ""
}

# stdout: JSON object map "tmux_pane" (pane_id, e.g. "%1") -> {status, reason, ...}
# Keyed by pane, not session: attention is per pane, and keying by session name
# smeared one status across every pane in the session (adversarial-review
# host-snapshot.sh:120). Entries without a pane id are skipped, not smeared.
sb_attention_index_json() {
  local path
  path="$(sb_attention_state_path)"
  if [[ -z "$path" || ! -f "$path" ]]; then
    printf '%s\n' '{}'
    return 0
  fi
  jq -c '
    (.entries // {})
    | to_entries
    | map(
        .value as $e
        | select(($e.tmux_pane // "") != "")
        | {
            key: $e.tmux_pane,
            value: {
              status: ($e.status // "unknown"),
              reason: ($e.reason // ""),
              tmux_session: ($e.tmux_session // null),
              tmux_window: ($e.tmux_window // null),
              session_id: ($e.session_id // null),
              ts: ($e.ts // null)
            }
          }
      )
    | from_entries
  ' "$path" 2>/dev/null || printf '%s\n' '{}'
}

sb_host_list_cards() {
  local lines=()
  local fmt='#{pane_id}|#{session_name}|#{window_index}|#{pane_index}|#{pane_current_command}|#{pane_current_path}|#{pane_title}|#{pane_active}|#{pane_dead}'
  local raw
  if ! sb_host_tmux_ok; then
    local tried bin_hint
    tried="$(sb_tmux_candidates 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
    bin_hint="$(sb_tmux_bin 2>/dev/null || true)"
    jq -nc \
      --arg tried "$tried" \
      --arg bin "$bin_hint" \
      --arg sock "$(sb_tmux_socket)" \
      '{
        ok: false,
        side: "host",
        error: "tmux server unavailable or client/server binary mismatch",
        cards: [],
        degraded: true,
        hint: "WezDeck often runs ~/.local/bin/tmux (3.7+); /usr/bin/tmux (3.4) side-load fails with server exited unexpectedly",
        socket: $sock,
        tried_bins: $tried,
        resolved_bin: (if $bin == "" then null else $bin end)
      }'
    return 0
  fi
  raw="$(sb_tmux list-panes -a -F "$fmt" 2>/dev/null || true)"
  if [[ -z "$raw" ]]; then
    jq -nc '{ok:true, side:"host", cards:[], degraded:false}'
    return 0
  fi

  local attn_idx
  attn_idx="$(sb_attention_index_json)"

  local cards='[]'
  while IFS='|' read -r paneid sess win pane cmd cwd title active dead; do
    [[ -z "${sess:-}" ]] && continue
    local id kind status attn_status attn_reason
    id="tmux:${sess}:${win}.${pane}"
    kind="$(sb_infer_kind "${cmd:-}" "${title:-}")"
    if [[ "${dead:-0}" == "1" ]]; then
      status="done"
    elif [[ "${active:-0}" == "1" ]]; then
      status="running"
    else
      status="idle"
    fi
    # attention is inferred; may upgrade card status when waiting/running/done known
    attn_status="$(jq -r --arg p "$paneid" '.[$p].status // empty' <<<"$attn_idx" 2>/dev/null || true)"
    attn_reason="$(jq -r --arg p "$paneid" '.[$p].reason // empty' <<<"$attn_idx" 2>/dev/null || true)"
    if [[ -n "$attn_status" ]]; then
      case "$attn_status" in
        waiting|running|done) status="$attn_status" ;;
      esac
    fi
    cards="$(jq -c \
      --arg id "$id" \
      --arg kind "$kind" \
      --arg status "$status" \
      --arg cwd "${cwd:-}" \
      --arg cmd "${cmd:-}" \
      --arg title "${title:-}" \
      --arg sess "$sess" \
      --arg win "$win" \
      --arg pane "$pane" \
      --arg active "${active:-0}" \
      --arg attn "${attn_status:-unknown}" \
      --arg attn_reason "${attn_reason:-}" \
      --arg updated "$(sb_now_iso)" \
      '. + [{
        side: "host",
        id: $id,
        alias: null,
        kind: $kind,
        status: $status,
        cwd: (if $cwd == "" then null else $cwd end),
        task_id: null,
        updated_at: $updated,
        preview: ($cmd + (if $title == "" then "" else (" · " + $title) end) + (if $attn_reason == "" then "" else (" · " + $attn_reason) end)),
        control: {read: true, write: "deny"},
        identity_hint: null,
        facts: {
          session: $sess,
          window: ($win|tonumber),
          pane: ($pane|tonumber),
          current_command: $cmd,
          title: $title,
          active: ($active == "1")
        },
        inferred: {
          kind: $kind,
          attention: (if $attn == "" then "unknown" else $attn end),
          attention_reason: (if $attn_reason == "" then null else $attn_reason end)
        }
      }]' <<<"$cards")"
  done <<<"$raw"

  local bin sock ver attn_path
  bin="$(sb_tmux_bin)"
  sock="$(sb_tmux_socket)"
  ver="$("$bin" -V 2>/dev/null || true)"
  attn_path="$(sb_attention_state_path)"
  jq -nc \
    --argjson cards "$cards" \
    --arg bin "$bin" \
    --arg sock "$sock" \
    --arg ver "$ver" \
    --arg attn_path "${attn_path:-}" \
    '{ok:true, side:"host", cards:$cards, degraded:false,
      tmux:{bin:$bin, version:$ver, socket:$sock},
      attention:{path:(if $attn_path=="" then null else $attn_path end),
                 loaded:($attn_path != "")}}'
}

sb_host_capture() {
  local target="$1"
  local lines="${2:-}"
  if [[ -z "$lines" ]]; then
    lines="$(sb_default_capture_lines)"
  fi
  if ! sb_host_tmux_ok; then
    local bin
    bin="$(sb_tmux_bin 2>/dev/null || echo '?')"
    sb_die 2 "tmux server unavailable；无法 capture（bin=$bin）。若 WezDeck 用 ~/.local/bin/tmux，勿用 /usr/bin/tmux 侧载。"
  fi

  # Accept: tmux:sess:w.p | sess:w.p | sess:w.p style
  local tmux_target="$target"
  tmux_target="${tmux_target#tmux:}"
  # if form sess:win.pane already ok for tmux -t

  local text
  if ! text="$(sb_tmux capture-pane -t "$tmux_target" -p 2>/dev/null)"; then
    sb_die 2 "capture 失败：target=$tmux_target（检查 session:window.pane）"
  fi
  local snippet
  snippet="$(printf '%s\n' "$text" | tail -n "$lines")"
  jq -nc \
    --arg target "$target" \
    --arg tmux_target "$tmux_target" \
    --argjson lines "$lines" \
    --arg text "$snippet" \
    --arg note "可能含秘密；默认 tail；勿把 token 贴回飞书" \
    '{
      ok: true,
      side: "host",
      target: $target,
      tmux_target: $tmux_target,
      lines: $lines,
      text: $text,
      warning: $note
    }'
}

sb_host_status() {
  sb_host_list_cards
}
