#!/usr/bin/env bash
# impact.sh — blast-radius resolver orchestrator for adversarial-review.
#
# Given a diff, extract the changed symbols and ask each available resolver who
# references them, so the review surface can grow *past the changed lines* — the
# defects that hurt reach downstream (API contracts, consumers). Output feeds the
# context pack's reserved PROJECT_SLICE section. See docs/adversarial-review.md.
#
# Plugin architecture (same shape as lib/provider.sh): every resolvers/*.sh is a
# self-contained plugin; the core holds NO resolver names. Adding a
# language-aware resolver (ts/js dependency graph, LSP references) = drop
# resolvers/<name>.sh implementing __available/__confidence/__resolve. grep is
# the always-available floor; higher-confidence resolvers layer above it.
#
# This unit is standalone and does NOT touch run.sh yet — wire it into stage 0
# once pointer quality is validated.
#
#   impact.sh scan <BASE> [--head REF|WORKTREE] [--repo PATH]   # JSON dependents
#   impact.sh resolvers                                          # list plugins
#
# Confidence tiers (driving progressive disclosure downstream):
#   exact-ref  -> full line window in PROJECT_SLICE   (language-aware, future)
#   module-ref -> file-level pointer                  (ts/js dep graph, future)
#   same-name  -> lightweight pointer only            (grep, this cut)

set -euo pipefail

_IMPACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_IMPACT_DIR/extract-symbols.sh"

_impact_log() { printf '\033[2m[impact]\033[0m %s\n' "$*" >&2; }

# --- load resolver plugins ---------------------------------------------------
_IMPACT_RESOLVERS=()
_impact_load_resolvers() {
  local f name
  for f in "$_IMPACT_DIR/resolvers/"*.sh; do
    [ -e "$f" ] || continue
    # shellcheck source=/dev/null
    . "$f"
    name="$(basename "$f" .sh)"
    _IMPACT_RESOLVERS+=("$name")
  done
}
_impact_load_resolvers

resolver_available() {
  local r="$1"
  declare -F "${r}__available" >/dev/null 2>&1 && "${r}__available"
}

# --- diff → changed files -----------------------------------------------------
# Sets IMPACT_CHANGED (newline paths), IMPACT_DIFF (unified diff string).
_impact_collect_diff() {
  local repo="$1" base="$2" head="$3"
  if [ "$head" = "WORKTREE" ]; then
    IMPACT_CHANGED="$(git -C "$repo" diff --name-only "$base" 2>/dev/null | sort -u || true)"
    IMPACT_DIFF="$(git -C "$repo" diff "$base" 2>/dev/null || true)"
  else
    IMPACT_CHANGED="$(git -C "$repo" diff --name-only "$base" "$head" 2>/dev/null | sort -u || true)"
    IMPACT_DIFF="$(git -C "$repo" diff "$base" "$head" 2>/dev/null || true)"
  fi
}

# Build git pathspecs that EXCLUDE the changed files (the diff already carries
# them; we only want *downstream* references).
_impact_build_excludes() {
  IMPACT_EXCLUDE_PATHSPEC=()
  local f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    IMPACT_EXCLUDE_PATHSPEC+=(":(exclude)$f")
  done <<< "$IMPACT_CHANGED"
}

# Resolve downstream references for an already-computed diff. Reuses these
# globals (set by impact_scan, or by a caller that already has the diff — e.g.
# context-pack.sh, which must NOT recompute it):
#   IMPACT_REPO, IMPACT_DIFF, IMPACT_CHANGED
# Emits a JSON array of hits on stdout.
impact_resolve() {
  export IMPACT_REPO="${IMPACT_REPO:?IMPACT_REPO not set}"
  _impact_build_excludes

  local symbols
  symbols="$(printf '%s' "$IMPACT_DIFF" | extract_changed_symbols)"
  local sym_count=0
  [ -n "$symbols" ] && sym_count="$(printf '%s\n' "$symbols" | grep -c . || true)"
  _impact_log "changed_files=$(printf '%s\n' "$IMPACT_CHANGED" | grep -c . || true) symbols=$sym_count resolvers=${_IMPACT_RESOLVERS[*]}"

  # Collect hits from every available resolver into one JSON array.
  # Each resolver emits JSON objects (one per line) on stdout.
  local r
  {
    for r in "${_IMPACT_RESOLVERS[@]}"; do
      if resolver_available "$r"; then
        # trailing newline is required: `while read` drops an unterminated last line
        printf '%s\n' "$symbols" | "${r}__resolve" || true
      else
        _impact_log "resolver $r unavailable — skipped"
      fi
    done
  } | jq -s 'unique_by([.file, .line, .symbol, .resolver])'
}

impact_scan() {
  local repo="$1" base="$2" head="$3"
  export IMPACT_REPO="$repo"
  _impact_collect_diff "$repo" "$base" "$head"
  impact_resolve
}

# --- CLI ----------------------------------------------------------------------
if [ "${BASH_SOURCE[0]:-}" = "${0:-}" ]; then
  case "${1:-}" in
    resolvers)
      printf '%s\n' "${_IMPACT_RESOLVERS[@]}"
      ;;
    scan)
      shift
      base="${1:-}"; shift || true
      repo="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
      head="HEAD"
      while [ $# -gt 0 ]; do
        case "$1" in
          --head) head="$2"; shift 2 ;;
          --repo) repo="$2"; shift 2 ;;
          *) echo "unknown arg: $1" >&2; exit 1 ;;
        esac
      done
      [ -n "$base" ] || { echo "usage: impact.sh scan <BASE> [--head REF|WORKTREE] [--repo PATH]" >&2; exit 1; }
      impact_scan "$repo" "$base" "$head"
      ;;
    *)
      echo "usage: impact.sh {scan <BASE> [--head REF|WORKTREE] [--repo PATH] | resolvers}" >&2
      exit 1
      ;;
  esac
fi
