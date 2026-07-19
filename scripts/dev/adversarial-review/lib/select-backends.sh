#!/usr/bin/env bash
# select-backends.sh — pick reviewer/refuter given who wrote the code.
#
# Policy (strategy B, host headless only):
#   1. Prefer cross-family pairs; avoid writer family when possible.
#   2. writer=codex → reviewer must be claude; refuter may be the *other* codex model.
#   3. Prefer codex-gpt over codex-grok when gpt headless probe passes.
#   4. Same-agent multi-role only when availability forces it (SINGLE-MODEL).
#
# Usage:
#   source lib/select-backends.sh
#   select_review_backends <writer>   # sets: SEL_REVIEWER SEL_REFUTER SEL_FORM SEL_DEGRADED SEL_REASON
#   select-backends.sh --writer claude-acp [--json]
#
set -euo pipefail

_sel_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_sel_dir/provider.sh"

# Optional live probe (short). Set ADV_REVIEW_PROBE=0 to skip (PATH-only).
ADV_REVIEW_PROBE="${ADV_REVIEW_PROBE:-1}"
ADV_REVIEW_PROBE_TIMEOUT="${ADV_REVIEW_PROBE_TIMEOUT:-45}"

_writer_family() {
  case "$1" in
    claude|claude-tui|claude-acp|claude_host|Claude-TUI|Claude-ACP) echo claude ;;
    codex|codex-gpt|codex-grok|codex-tui|codex-acp|Codex-TUI|Codex-ACP|Codex-Grok-profile|gpt|grok)
      echo codex ;;
    main|main-grok|Main-Grok|c1) echo main ;;
    human|h1|none|"") echo human ;;
    *) echo "$1" ;;
  esac
}

_backend_family() {
  case "$(_provider_canonical "$1")" in
    claude) echo claude ;;
    codex-gpt|codex-grok) echo codex ;;
    *) echo "$1" ;;
  esac
}

# Live ping: 0 = usable for review headless
_probe_backend() {
  local p canon bin
  p="$1"
  canon="$(_provider_canonical "$p")"
  provider_available "$canon" || return 1
  [ "$ADV_REVIEW_PROBE" = "0" ] && return 0
  case "$canon" in
    claude)
      timeout "$ADV_REVIEW_PROBE_TIMEOUT" claude -p "Reply with exactly: ping-ok" >/dev/null 2>&1
      ;;
    codex-gpt)
      bin="$(_codex_bin)" || return 1
      timeout "$ADV_REVIEW_PROBE_TIMEOUT" env -u CODEX_HOME "$bin" exec --sandbox read-only \
        "Reply with exactly: ping-ok" >/dev/null 2>&1
      ;;
    codex-grok)
      bin="$(_codex_bin)" || return 1
      timeout "$ADV_REVIEW_PROBE_TIMEOUT" env -u CODEX_HOME "$bin" exec --sandbox read-only \
        -p grok -m grok-4.5 "Reply with exactly: ping-ok" >/dev/null 2>&1
      ;;
    *) return 1 ;;
  esac
}

_avail() {
  _probe_backend "$1"
}

# Ordered ideal pairs (reviewer, refuter)
# Prefer gpt over grok when both work.
_emit_pair() {
  SEL_REVIEWER="$1"
  SEL_REFUTER="$2"
  SEL_FORM="$3"
  SEL_DEGRADED="$4"
  SEL_REASON="$5"
}

select_review_backends() {
  local writer="${1:-human}"
  local W
  W="$(_writer_family "$writer")"

  local claude_ok=0 gpt_ok=0 grok_ok=0
  _avail claude && claude_ok=1
  _avail codex-gpt && gpt_ok=1
  _avail codex-grok && grok_ok=1

  # --- prefer: both sides avoid writer family ---
  if [ "$W" = "claude" ]; then
    # avoid claude: use codex vs codex cross-model if possible
    if [ "$gpt_ok" -eq 1 ] && [ "$grok_ok" -eq 1 ]; then
      _emit_pair codex-gpt codex-grok "cross-model-codex" "false" "writer=claude; avoid claude family"
      return 0
    fi
    if [ "$gpt_ok" -eq 1 ]; then
      _emit_pair codex-gpt codex-gpt "single-model-multi-role" "true" "writer=claude; only codex-gpt"
      return 0
    fi
    if [ "$grok_ok" -eq 1 ]; then
      _emit_pair codex-grok codex-grok "single-model-multi-role" "true" "writer=claude; only codex-grok"
      return 0
    fi
    if [ "$claude_ok" -eq 1 ]; then
      _emit_pair claude claude "single-model-multi-role" "true" "writer_reuse=claude; no other backend"
      return 0
    fi
  fi

  if [ "$W" = "codex" ]; then
    # strategy B: reviewer must be claude; refuter = other codex model when possible
    if [ "$claude_ok" -eq 1 ] && [ "$gpt_ok" -eq 1 ]; then
      _emit_pair claude codex-gpt "cross-family" "false" "writer=codex; reviewer=claude refuter=gpt"
      return 0
    fi
    if [ "$claude_ok" -eq 1 ] && [ "$grok_ok" -eq 1 ]; then
      _emit_pair claude codex-grok "cross-family" "false" "writer=codex; reviewer=claude refuter=grok"
      return 0
    fi
    if [ "$claude_ok" -eq 1 ]; then
      _emit_pair claude claude "single-model-multi-role" "true" "writer=codex; only claude for multi-role"
      return 0
    fi
    # no claude: partial — still try cross-model codex (degraded: same family as writer)
    if [ "$gpt_ok" -eq 1 ] && [ "$grok_ok" -eq 1 ]; then
      _emit_pair codex-gpt codex-grok "partial-avoidance" "true" "writer=codex; no claude; codex cross-model"
      return 0
    fi
    if [ "$gpt_ok" -eq 1 ]; then
      _emit_pair codex-gpt codex-gpt "single-model-multi-role" "true" "writer_reuse=codex-gpt"
      return 0
    fi
    if [ "$grok_ok" -eq 1 ]; then
      _emit_pair codex-grok codex-grok "single-model-multi-role" "true" "writer_reuse=codex-grok"
      return 0
    fi
  fi

  # main or human or unknown: global best pair
  if [ "$claude_ok" -eq 1 ] && [ "$gpt_ok" -eq 1 ]; then
    _emit_pair claude codex-gpt "cross-family" "false" "default; gpt preferred"
    return 0
  fi
  if [ "$claude_ok" -eq 1 ] && [ "$grok_ok" -eq 1 ]; then
    _emit_pair claude codex-grok "cross-family" "false" "default; gpt unavailable use grok"
    return 0
  fi
  if [ "$gpt_ok" -eq 1 ] && [ "$grok_ok" -eq 1 ]; then
    _emit_pair codex-gpt codex-grok "cross-model-codex" "true" "no claude"
    return 0
  fi
  if [ "$claude_ok" -eq 1 ]; then
    _emit_pair claude claude "single-model-multi-role" "true" "only claude"
    return 0
  fi
  if [ "$gpt_ok" -eq 1 ]; then
    _emit_pair codex-gpt codex-gpt "single-model-multi-role" "true" "only codex-gpt"
    return 0
  fi
  if [ "$grok_ok" -eq 1 ]; then
    _emit_pair codex-grok codex-grok "single-model-multi-role" "true" "only codex-grok"
    return 0
  fi

  _emit_pair "" "" "unavailable" "true" "no review backends available"
  return 1
}

# CLI entry
if [ "${BASH_SOURCE[0]:-}" = "${0:-}" ]; then
  writer="human"
  want_json=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --writer) writer="$2"; shift 2 ;;
      --json) want_json=1; shift ;;
      --no-probe) ADV_REVIEW_PROBE=0; shift ;;
      -h|--help)
        echo "Usage: select-backends.sh --writer claude|codex|codex-gpt|codex-grok|main|human [--json] [--no-probe]"
        exit 0
        ;;
      *) echo "unknown: $1" >&2; exit 1 ;;
    esac
  done
  if select_review_backends "$writer"; then
    :
  else
    true
  fi
  if [ "$want_json" -eq 1 ]; then
    jq -nc \
      --arg writer "$writer" \
      --arg reviewer "${SEL_REVIEWER:-}" \
      --arg refuter "${SEL_REFUTER:-}" \
      --arg form "${SEL_FORM:-}" \
      --argjson degraded "${SEL_DEGRADED:-true}" \
      --arg reason "${SEL_REASON:-}" \
      '{writer:$writer,reviewer:$reviewer,refuter:$refuter,form:$form,degraded:$degraded,reason:$reason}'
  else
    echo "writer=$writer"
    echo "reviewer=${SEL_REVIEWER:-}"
    echo "refuter=${SEL_REFUTER:-}"
    echo "form=${SEL_FORM:-}"
    echo "degraded=${SEL_DEGRADED:-}"
    echo "reason=${SEL_REASON:-}"
  fi
  [ -n "${SEL_REVIEWER:-}" ] && [ -n "${SEL_REFUTER:-}" ]
fi
