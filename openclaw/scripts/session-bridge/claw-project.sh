#!/usr/bin/env bash
# Claw truth projection: wrap openclaw sessions* → SessionCard / summaries.
# shellcheck source=lib.sh
set -euo pipefail

_SB_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/lib.sh"

sb_openclaw_bin() {
  if command -v openclaw >/dev/null 2>&1; then
    command -v openclaw
  else
    sb_die 3 "openclaw 不在 PATH"
  fi
}

sb_claw_sessions_raw() {
  local active="${1:-}"
  local args=(sessions --all-agents --json)
  if [[ -n "$active" ]]; then
    args+=(--active "$active")
  fi
  "$(sb_openclaw_bin)" "${args[@]}"
}

sb_infer_claw_kind() {
  local key="$1" model="$2" agent="$3"
  if [[ "$key" == *":acp:"* ]]; then
    if [[ "$agent" == "claude" ]]; then
      printf 'acp-claude\n'
    elif [[ "$agent" == "codex" ]]; then
      printf 'acp-codex\n'
    else
      printf 'acp-%s\n' "$agent"
    fi
    return 0
  fi
  case "$agent" in
    main) printf 'main-grok\n' ;;
    pm) printf 'pm-grok\n' ;;
    radar) printf 'radar-grok\n' ;;
    *) printf '%s\n' "${agent:-unknown}" ;;
  esac
}

sb_claw_list_cards() {
  local active="${1:-180}"
  local raw cards
  if ! raw="$(sb_claw_sessions_raw "$active" 2>/dev/null)"; then
    sb_die 2 "openclaw sessions 失败"
  fi

  # Build reverse alias map from config if present
  local alias_json='{}'
  local cfg
  cfg="$(sb_config_path)"
  if [[ -f "$cfg" ]]; then
    alias_json="$(jq -c '.aliases // {} | to_entries | map({(.value): .key}) | add // {}' "$cfg")"
  fi

  cards="$(jq -c --argjson aliases "$alias_json" '
    (.sessions // []) | map(
      . as $s |
      {
        side: "claw",
        id: $s.key,
        alias: ($aliases[$s.key] // null),
        kind: (
          if ($s.key | contains(":acp:")) then
            (if $s.agentId == "claude" then "acp-claude"
             elif $s.agentId == "codex" then "acp-codex"
             else ("acp-" + ($s.agentId // "unknown")) end)
          else
            (if $s.agentId == "main" then "main-grok"
             elif $s.agentId == "pm" then "pm-grok"
             elif $s.agentId == "radar" then "radar-grok"
             else ($s.agentId // "unknown") end)
          end
        ),
        status: ($s.status // "unknown"),
        cwd: null,
        task_id: null,
        updated_at: (if $s.updatedAt then (($s.updatedAt / 1000) | floor | todate) else null end),
        preview: (
          [
            ($s.model // null),
            (if $s.ageMs then (("age=" + (($s.ageMs/1000|floor|tostring) + "s"))) else null end),
            ($s.displayName // null)
          ] | map(select(. != null)) | join(" · ")
        ),
        control: {read: true, write: "ask"},
        identity_hint: "agent-poke",
        facts: {
          sessionId: $s.sessionId,
          agentId: $s.agentId,
          model: $s.model,
          modelProvider: $s.modelProvider,
          kind: $s.kind,
          channel: ($s.channel // $s.lastChannel // null)
        }
      }
    )
  ' <<<"$raw")"

  jq -nc --argjson cards "$cards" --argjson active "$active" \
    '{ok:true, side:"claw", active_minutes:$active, cards:$cards}'
}

sb_claw_show() {
  local id="$1"
  local resolved
  resolved="$(sb_resolve_alias "$id")"
  local listing
  listing="$(sb_claw_list_cards 10080)"
  local card
  card="$(jq -c --arg id "$resolved" '
    .cards | map(select(.id == $id or .alias == $id)) | .[0] // null
  ' <<<"$listing")"
  if [[ "$card" == "null" || -z "$card" ]]; then
    sb_die 2 "找不到 claw 会话：$id（解析后：$resolved）"
  fi

  # Light summary from sessions store if file present
  local store session_file preview=""
  store="$(jq -r --arg k "$resolved" '
    # not available in listing; leave empty
    empty
  ' <<<"$listing" 2>/dev/null || true)"

  # Best-effort last human/assistant from jsonl via openclaw sessions tail (short)
  local tail_out=""
  if tail_out="$("$(sb_openclaw_bin)" sessions tail --session-key "$resolved" --tail 12 2>/dev/null || true)"; then
    preview="$(printf '%s\n' "$tail_out" | tail -n 12)"
  fi

  jq -nc \
    --argjson card "$card" \
    --arg preview "$preview" \
    --arg resolved "$resolved" \
    '{
      ok: true,
      side: "claw",
      resolved_id: $resolved,
      card: $card,
      summary: $preview,
      note: "默认 L0–L1；全量 transcript 请用 claw-tail / sessions tail"
    }'
}

sb_claw_tail() {
  local id="$1"
  local n="${2:-40}"
  local resolved
  resolved="$(sb_resolve_alias "$id")"
  local out
  if ! out="$("$(sb_openclaw_bin)" sessions tail --session-key "$resolved" --tail "$n" 2>&1)"; then
    sb_die 2 "sessions tail 失败：$out"
  fi
  jq -nc \
    --arg id "$resolved" \
    --argjson n "$n" \
    --arg text "$out" \
    '{ok:true, side:"claw", id:$id, tail:$n, text:$text}'
}

sb_claw_poke_cmd() {
  local id="$1"
  local message="$2"
  local dry="${3:-0}"
  local agent="${4:-}"
  local resolved
  resolved="$(sb_resolve_alias "$id")"

  local -a cmd
  cmd=(openclaw agent --session-key "$resolved" -m "$message")
  if [[ -n "$agent" ]]; then
    cmd=(openclaw agent --agent "$agent" --session-key "$resolved" -m "$message")
  fi

  # panic freezes all write surfaces (including dry-run) so operators can trust the switch
  sb_require_no_panic

  if [[ "$dry" == "1" ]]; then
    jq -nc \
      --arg identity "agent-poke" \
      --arg target "$resolved" \
      --arg message "$message" \
      --argjson argv "$(printf '%s\0' "${cmd[@]}" | jq -Rs 'split("\u0000")|map(select(length>0))')" \
      '{
        ok: true,
        dry_run: true,
        identity: $identity,
        target: $target,
        message: $message,
        would_run: $argv,
        note: "身份=agent-poke（会话注入），不是飞书本人，也不是 bot 投递"
      }'
    sb_audit "poke" "agent-poke" "$resolved" "ok" "dry-run" "$message"
    return 0
  fi

  sb_audit "poke" "agent-poke" "$resolved" "ok" "execute" "$message"
  # Execute for real
  local out ec=0
  out="$("${cmd[@]}" 2>&1)" || ec=$?
  if [[ $ec -ne 0 ]]; then
    sb_audit "poke" "agent-poke" "$resolved" "deny" "exit=$ec" "$message"
    sb_die "$ec" "poke 失败 (exit $ec): $out"
  fi
  jq -nc \
    --arg target "$resolved" \
    --arg identity "agent-poke" \
    --arg out "$out" \
    '{ok:true, dry_run:false, identity:$identity, target:$target, output:$out}'
}
