#!/usr/bin/env bash
# resolvers/grep.sh — text-symbol reference resolver (always-available fallback).
#
# Resolver plugin interface (mirrors lib/provider.sh; impact.sh loads every
# resolvers/*.sh and dispatches by name — no resolver names in the core):
#     <name>__available    can it run here? (grep: always yes)
#     <name>__confidence    default confidence label for its hits
#     <name>__resolve       stdin = symbols (one/line); stdout = JSON array of
#                           {file,line,symbol,why,confidence,resolver}
#
# grep is the language-agnostic floor: word-boundary git-grep over tracked files.
# It cannot tell a real reference from a same-named token or a string literal, so
# its hits are labeled `same-name` (low) — the impact orchestrator surfaces them
# as lightweight pointers, not full file bodies. Language-aware resolvers
# (ts/js dependency graph, LSP) plug in above this and emit higher-confidence
# `module-ref` / `exact-ref` hits; this floor always runs so nothing is missed.
#
# Reads these globals (set by impact.sh):
#   IMPACT_REPO                  git repo root (required)
#   IMPACT_EXCLUDE_PATHSPEC[]    pathspecs to exclude (the changed files themselves)
#   IMPACT_MAX_HITS_PER_SYMBOL   cap per symbol   (default 20)
#   IMPACT_MAX_FILES             global hit cap   (default 40)
#
# shellcheck shell=bash

grep__available()  { return 0; }
grep__confidence() { printf 'same-name'; }

grep__resolve() {
  local repo="${IMPACT_REPO:?IMPACT_REPO not set}"
  local max_per="${IMPACT_MAX_HITS_PER_SYMBOL:-20}"
  local max_files="${IMPACT_MAX_FILES:-40}"
  local -a exclude=("${IMPACT_EXCLUDE_PATHSPEC[@]+"${IMPACT_EXCLUDE_PATHSPEC[@]}"}")

  local sym file line rest count=0 truncated=0
  while IFS= read -r sym; do
    [ -z "$sym" ] && continue
    (( count >= max_files )) && { truncated=1; break; }
    # -n line numbers, -w word boundary, -I skip binary; tracked files only.
    # pathspec excludes the changed files (the diff already carries those).
    while IFS=: read -r file line rest; do
      [ -z "$file" ] && continue
      (( count >= max_files )) && { truncated=1; break; }
      count=$((count + 1))
      jq -cn \
        --arg f "$file" --argjson l "${line:-0}" --arg s "$sym" \
        --arg why "references '$sym' (git grep -w)" \
        '{file:$f, line:$l, symbol:$s, why:$why, confidence:"same-name", resolver:"grep"}'
    done < <(
      git -C "$repo" grep -nwI -e "$sym" -- . "${exclude[@]}" 2>/dev/null \
        | head -n "$max_per" || true
    )
  done
  if [ "$truncated" = 1 ]; then
    jq -cn --argjson n "$max_files" \
      '{note:("grep hits capped at max_files="+($n|tostring)), truncated:true, resolver:"grep"}' >&2
  fi
}
