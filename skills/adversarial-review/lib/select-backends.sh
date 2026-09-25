#!/usr/bin/env bash
# select-backends.sh — pick reviewer/refuter for the adversarial gates.
#
# Standard-driven (see roles.conf): reviewer uses the `find` candidate sequence,
# refuter the `refute` sequence. Layered:
#   L1 agent isolation — always two roles (multi-role), enforced by run.sh.
#   L2 model isolation — prefer cross-family and avoid the writer's family;
#      degrade (partial-avoidance → single-model) only when backends are scarce.
# Adding a backend needs no edit here — it flows in via roles.conf + its plugin.
#
# Usage:
#   source lib/select-backends.sh
#   select_review_backends <writer>   # sets SEL_REVIEWER SEL_REFUTER SEL_FORM SEL_DEGRADED SEL_REASON
#   select-backends.sh --writer claude-acp [--json] [--no-probe]
set -euo pipefail

_sel_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_sel_dir/provider.sh"
# shellcheck source=/dev/null
. "$_sel_dir/roles-lib.sh"

ADV_REVIEW_PROBE="${ADV_REVIEW_PROBE:-1}"
ADV_REVIEW_PROBE_TIMEOUT="${ADV_REVIEW_PROBE_TIMEOUT:-45}"

# Writer identity (various aliases) → family, matching backend families.
_writer_family() {
  case "$1" in
    claude|claude-tui|claude-acp|claude_host|Claude-TUI|Claude-ACP) echo claude ;;
    codex|codex-tui|codex-acp|Codex-TUI|Codex-ACP|gpt) echo codex ;;
    grok|Grok|Codex-Grok-profile) echo grok ;;
    main|main-grok|Main-Grok|c1) echo main ;;
    human|h1|none|"") echo human ;;
    *) echo "$1" ;;
  esac
}

# Backend → family (delegates to the plugin via provider.sh).
_backend_family() { _provider_family "$1"; }

# Live ping (0 = usable headless). PATH-only when ADV_REVIEW_PROBE=0.
_probe_backend() {
  local p; p="$(_provider_canonical "$1")"
  provider_available "$p" || return 1
  [ "$ADV_REVIEW_PROBE" = "0" ] && return 0
  timeout "$ADV_REVIEW_PROBE_TIMEOUT" "$_sel_dir/provider.sh" probe "$p" >/dev/null 2>&1
}
_avail() { _probe_backend "$1"; }

_emit_pair() {
  SEL_REVIEWER="$1"; SEL_REFUTER="$2"; SEL_FORM="$3"; SEL_DEGRADED="$4"; SEL_REASON="$5"
}

# Pick reviewer from the `find` sequence and refuter from the `refute` sequence
# (roles.conf), honouring: avoid writer family, then reviewer≠refuter family.
select_review_backends() {
  local writer="${1:-human}" W
  W="$(_writer_family "$writer")"

  local rev_cands ref_cands c cf
  rev_cands="$(role_candidates adversarial find)"
  ref_cands="$(role_candidates adversarial refute)"

  # reviewer: first available candidate outside the writer's family …
  local reviewer=""
  for c in $rev_cands; do
    _avail "$c" || continue
    [ "$(_backend_family "$c")" = "$W" ] && continue
    reviewer="$c"; break
  done
  # … else any available (writer family allowed; flagged degraded below)
  if [ -z "$reviewer" ]; then
    for c in $rev_cands; do _avail "$c" && { reviewer="$c"; break; }; done
  fi
  if [ -z "$reviewer" ]; then
    _emit_pair "" "" "unavailable" "true" "no review backends available"; return 1
  fi
  local rev_fam; rev_fam="$(_backend_family "$reviewer")"

  # refuter: available, family ≠ reviewer, prefer also ≠ writer …
  local refuter=""
  for c in $ref_cands; do
    _avail "$c" || continue
    cf="$(_backend_family "$c")"
    [ "$cf" = "$rev_fam" ] && continue
    [ "$cf" = "$W" ] && continue
    refuter="$c"; break
  done
  # … relax writer-avoidance, still ≠ reviewer …
  if [ -z "$refuter" ]; then
    for c in $ref_cands; do
      _avail "$c" || continue
      [ "$(_backend_family "$c")" = "$rev_fam" ] && continue
      refuter="$c"; break
    done
  fi
  # … last resort: reuse reviewer (single-model, two roles)
  [ -z "$refuter" ] && refuter="$reviewer"

  local ref_fam form degraded reason
  ref_fam="$(_backend_family "$refuter")"
  if [ "$reviewer" = "$refuter" ] || [ "$rev_fam" = "$ref_fam" ]; then
    form="single-model-multi-role"; degraded="true"; reason="only one distinct family available"
  elif [ "$rev_fam" = "$W" ] || [ "$ref_fam" = "$W" ]; then
    form="partial-avoidance"; degraded="true"; reason="a role shares the writer's family ($W)"
  else
    form="cross-family"; degraded="false"; reason="reviewer=$reviewer refuter=$refuter, both != writer($W)"
  fi
  _emit_pair "$reviewer" "$refuter" "$form" "$degraded" "$reason"
}

# CLI entry
if [ "${BASH_SOURCE[0]:-}" = "${0:-}" ]; then
  writer="human"; want_json=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --writer) writer="$2"; shift 2 ;;
      --json) want_json=1; shift ;;
      --no-probe) ADV_REVIEW_PROBE=0; shift ;;
      -h|--help) echo "Usage: select-backends.sh --writer NAME [--json] [--no-probe]"; exit 0 ;;
      *) echo "unknown: $1" >&2; exit 1 ;;
    esac
  done
  select_review_backends "$writer" || true
  if [ "$want_json" -eq 1 ]; then
    jq -nc --arg writer "$writer" --arg reviewer "${SEL_REVIEWER:-}" \
      --arg refuter "${SEL_REFUTER:-}" --arg form "${SEL_FORM:-}" \
      --argjson degraded "${SEL_DEGRADED:-true}" --arg reason "${SEL_REASON:-}" \
      '{writer:$writer,reviewer:$reviewer,refuter:$refuter,form:$form,degraded:$degraded,reason:$reason}'
  else
    echo "writer=$writer"; echo "reviewer=${SEL_REVIEWER:-}"; echo "refuter=${SEL_REFUTER:-}"
    echo "form=${SEL_FORM:-}"; echo "degraded=${SEL_DEGRADED:-}"; echo "reason=${SEL_REASON:-}"
  fi
  [ -n "${SEL_REVIEWER:-}" ] && [ -n "${SEL_REFUTER:-}" ]
fi
