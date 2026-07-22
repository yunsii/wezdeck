#!/usr/bin/env bash
# extract-symbols.sh — pull "changed symbols" out of a unified diff.
#
# Language-agnostic first cut: identifier tokens on added/removed lines, minus a
# small cross-language keyword stoplist. This is a *seed* for reference lookup —
# deliberately over-inclusive; the resolver layer bounds cost and the `same-name`
# confidence label admits it is heuristic. Language-aware symbol extraction
# (ts/js dependency graph, LSP references) is a future resolver plugin; see
# docs/adversarial-review.md "Context pack" / PROJECT_SLICE.
#
# Usage (standalone or sourced):
#   extract_changed_symbols < unified.diff      # one symbol per line, sorted -u
#
# shellcheck shell=bash

# Common keywords across bash/lua/go/ts/js/python/json — dropped as noise.
# Heuristic, not exhaustive: a real identifier that collides with a keyword is
# lost, which is acceptable for a same-name seed (grep would flood on it anyway).
_IMPACT_STOPWORDS='
and are async await break case catch class const continue def default defer
delete do done elif else elseif end esac export extends false fi final finally
finally for from func function goto if implements import in instanceof interface
let local map new nil none not null or package pass private protected public
range return select self set static struct super switch then this throw true try
type typeof unset var void while with yield
echo printf print return true false local export set unset then fi done esac
'

extract_changed_symbols() {
  # 1. keep only hunk +/- body lines (drop ---/+++ file headers and @@ markers)
  # 2. strip the leading +/- marker
  # 3. tokenize into identifiers (>=3 chars to skip i/x/ok noise)
  # 4. drop stopwords, dedup
  awk '
    /^\+\+\+/ || /^---/ || /^@@/ { next }
    /^[+-]/ { print substr($0, 2) }
  ' \
    | grep -oE '[A-Za-z_][A-Za-z0-9_]{2,}' \
    | sort -u \
    | grep -vxF -f <(printf '%s\n' $_IMPACT_STOPWORDS | sort -u) \
    || true
}

# Standalone entry
if [ "${BASH_SOURCE[0]:-}" = "${0:-}" ]; then
  extract_changed_symbols
fi
