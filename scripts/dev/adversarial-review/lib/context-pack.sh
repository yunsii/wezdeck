#!/usr/bin/env bash
# context-pack.sh — build adversarial-review Context Pack v1
#
# Produces a single markdown pack (find/refute share the same bytes).
# Sourced by run.sh; not usually invoked alone.
#
# Required globals (set by caller):
#   repo_root, base, head_ref, writer, mode
# Optional globals:
#   intent_text, intent_file
#   max_files (default 10), max_file_bytes (default 40960), context_window (default 200)
#   path_filter (bash array; empty = all changed paths)
#   keep_pack_dir (if set, write pack there; else mktemp -d)
#
# Outputs (globals set):
#   PACK_DIR, PACK_FILE, PACK_ID, PACK_HASH
#   PACK_CHANGED (newline paths), PACK_DIFF (unified diff string)
#   PACK_DIRTY (0|1), PACK_HAS_RUNTIME (0|1)
#   PACK_TRUNCATED (human notes, newline)

# shellcheck shell=bash

# Impact resolver (blast-radius): fills the reserved PROJECT_SLICE with downstream
# references to changed symbols. Optional — a failure here must never break pack
# construction. Toggle with impact_enable (default 1) / run.sh --no-impact.
_CP_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$_CP_LIB_DIR/impact/impact.sh" ] && . "$_CP_LIB_DIR/impact/impact.sh"

_cp_log() { printf '\033[2m[adv-pack]\033[0m %s\n' "$*" >&2; }

_cp_is_probably_binary() {
  local f="$1"
  # empty or missing
  [ -f "$f" ] || return 0
  # extension heuristics
  case "$f" in
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.pdf|*.zip|*.gz|*.tgz|*.xz|*.7z|*.woff|*.woff2|*.ttf|*.eot|*.mp4|*.mp3|*.wasm|*.lock)
      return 0 ;;
  esac
  # NUL in first 8k → binary.
  # Do NOT use `grep -q $'\0'`: in bash that is an empty pattern and matches every non-empty input.
  # Compare byte counts with/without NULs instead (portable, no false positives on text).
  local raw stripped
  raw="$(head -c 8192 "$f" 2>/dev/null | wc -c | tr -d ' ')"
  stripped="$(head -c 8192 "$f" 2>/dev/null | tr -d '\000' | wc -c | tr -d ' ')"
  if [ -n "$raw" ] && [ "$raw" != "$stripped" ]; then
    return 0
  fi
  return 1
}

_cp_lang_of() {
  case "$1" in
    *.sh|*.bash|*.zsh) echo shell ;;
    *.ts|*.tsx) echo typescript ;;
    *.js|*.jsx|*.mjs|*.cjs) echo javascript ;;
    *.py) echo python ;;
    *.go) echo go ;;
    *.rs) echo rust ;;
    *.md) echo markdown ;;
    *.json) echo json ;;
    *.yml|*.yaml) echo yaml ;;
    *.toml) echo toml ;;
    *) echo text ;;
  esac
}

_cp_file_status() {
  # M|A|D|? relative to base when possible
  local f="$1"
  if [ "$head_ref" = "WORKTREE" ]; then
    if ! git -C "$repo_root" cat-file -e "$base:$f" 2>/dev/null; then
      if [ -e "$repo_root/$f" ]; then echo A; else echo '?'; fi
      return
    fi
    if [ ! -e "$repo_root/$f" ]; then echo D; return; fi
    echo M
  else
    # from name-status if available in caller; fallback M
    echo M
  fi
}

# Collect changed paths + unified diff into PACK_CHANGED / PACK_DIFF
_cp_collect_diff() {
  local paths=()
  local f

  if [ "$head_ref" = "WORKTREE" ]; then
    if ((${#path_filter[@]})); then
      PACK_CHANGED="$(
        {
          git -C "$repo_root" diff --name-only "$base" -- "${path_filter[@]}" 2>/dev/null || true
          git -C "$repo_root" ls-files --others --exclude-standard -- "${path_filter[@]}" 2>/dev/null || true
        } | sort -u
      )"
      PACK_DIFF="$(
        {
          git -C "$repo_root" diff "$base" -- "${path_filter[@]}" 2>/dev/null || true
          while IFS= read -r f; do
            [ -z "$f" ] && continue
            [ -f "$repo_root/$f" ] || continue
            # only untracked
            if git -C "$repo_root" ls-files --error-unmatch "$f" >/dev/null 2>&1; then
              continue
            fi
            git -C "$repo_root" diff --no-index -- /dev/null "$f" 2>/dev/null || true
          done <<< "$(git -C "$repo_root" ls-files --others --exclude-standard -- "${path_filter[@]}" 2>/dev/null || true)"
        }
      )"
    else
      PACK_CHANGED="$(
        {
          git -C "$repo_root" diff --name-only "$base" 2>/dev/null || true
          git -C "$repo_root" ls-files --others --exclude-standard 2>/dev/null || true
        } | sort -u
      )"
      PACK_DIFF="$(
        {
          git -C "$repo_root" diff "$base" 2>/dev/null || true
          while IFS= read -r f; do
            [ -z "$f" ] && continue
            [ -f "$repo_root/$f" ] || continue
            git -C "$repo_root" diff --no-index -- /dev/null "$f" 2>/dev/null || true
          done <<< "$(git -C "$repo_root" ls-files --others --exclude-standard 2>/dev/null || true)"
        }
      )"
    fi
    PACK_DIRTY=1
  else
    if ((${#path_filter[@]})); then
      PACK_CHANGED="$(git -C "$repo_root" diff --name-only "$base" "$head_ref" -- "${path_filter[@]}" 2>/dev/null | sort -u || true)"
      PACK_DIFF="$(git -C "$repo_root" diff "$base" "$head_ref" -- "${path_filter[@]}" 2>/dev/null || true)"
    else
      PACK_CHANGED="$(git -C "$repo_root" diff --name-only "$base" "$head_ref" 2>/dev/null | sort -u || true)"
      PACK_DIFF="$(git -C "$repo_root" diff "$base" "$head_ref" 2>/dev/null || true)"
    fi
    PACK_DIRTY=0
    # dirty working tree relative to head_ref is not included; note only
    if [ -n "$(git -C "$repo_root" status --porcelain 2>/dev/null || true)" ]; then
      PACK_TRUNCATED+=$'working tree dirty but head!=WORKTREE — uncommitted changes not in pack\n'
    fi
  fi
}

_cp_has_runtime() {
  local f has=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      *.md|docs/*|*/testdata/*|*_test.*|*.test.*|test/*|tests/*) : ;;
      *) has=1; break ;;
    esac
  done <<< "$PACK_CHANGED"
  PACK_HAS_RUNTIME=$has
}

_cp_resolve_intent() {
  local t=""
  if [ -n "${intent_text:-}" ]; then
    t="$intent_text"
  elif [ -n "${intent_file:-}" ]; then
    [ -f "$intent_file" ] || { echo "intent file not found: $intent_file" >&2; return 1; }
    t="$(cat "$intent_file")"
  elif [ "$head_ref" != "WORKTREE" ]; then
    t="$(git -C "$repo_root" log --format='%s%n%n%b' -1 "$head_ref" 2>/dev/null || true)"
    if [ -n "$t" ]; then
      t="(from commit $head_ref message)"$'\n'"$t"
    fi
  elif [ "$head_ref" = "WORKTREE" ]; then
    t="$(git -C "$repo_root" log --format='%s%n%n%b' -1 "$base" 2>/dev/null || true)"
    if [ -n "$t" ]; then
      t="(from base $base message; reviewing dirty worktree)"$'\n'"$t"
    fi
  fi
  if [ -z "${t//[$' \t\n']/}" ]; then
    t="(none — review diff only; intent not provided)"
    PACK_TRUNCATED+=$'intent missing — degraded semantic context\n'
  fi
  # cap intent ~2KB
  if [ "${#t}" -gt 2048 ]; then
    t="${t:0:2048}"$'\n… [intent truncated]'
    PACK_TRUNCATED+=$'intent truncated to 2KB\n'
  fi
  PACK_INTENT="$t"
}

# Pick up to max_files paths for FILES section (runtime first)
_cp_select_files() {
  local f rank runtime=() other=()
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      *.md|docs/*|*/testdata/*|*_test.*|*.test.*|test/*|tests/*|*.lock|pnpm-lock.yaml|package-lock.json|yarn.lock)
        other+=("$f") ;;
      *)
        runtime+=("$f") ;;
    esac
  done <<< "$PACK_CHANGED"

  PACK_FILE_LIST=()
  for f in "${runtime[@]}" "${other[@]}"; do
    ((${#PACK_FILE_LIST[@]} >= max_files)) && {
      PACK_TRUNCATED+="omitted_files cap max_files=$max_files"$'\n'
      break
    }
    PACK_FILE_LIST+=("$f")
  done
  # record omitted
  local total=0
  while IFS= read -r f; do [ -n "$f" ] && total=$((total + 1)); done <<< "$PACK_CHANGED"
  if (( total > ${#PACK_FILE_LIST[@]} )); then
    PACK_TRUNCATED+="files_in_diff=$total files_in_pack=${#PACK_FILE_LIST[@]}"$'\n'
  fi
}

# Extract content for one path: prefer full file if small, else window around hunks
_cp_file_body() {
  local f="$1"
  local abs="$repo_root/$f"
  local body="" size=0

  if [ ! -e "$abs" ]; then
    # deleted in worktree / head — show base version if any
    if git -C "$repo_root" cat-file -e "$base:$f" 2>/dev/null; then
      body="$(git -C "$repo_root" show "$base:$f" 2>/dev/null || true)"
      printf '%s' "$body" | head -c "$max_file_bytes"
      if [ "${#body}" -gt "$max_file_bytes" ]; then
        printf '\n… [base file truncated at %s bytes]\n' "$max_file_bytes"
        PACK_TRUNCATED+="truncated base:$f"$'\n'
      fi
      return
    fi
    echo "(file missing in target and base)"
    return
  fi

  if _cp_is_probably_binary "$abs"; then
    echo "(binary or non-text omitted)"
    PACK_TRUNCATED+="binary omitted: $f"$'\n'
    return
  fi

  size="$(wc -c < "$abs" | tr -d ' ')"
  if [ "$size" -le "$max_file_bytes" ]; then
    cat "$abs"
    return
  fi

  # Large file: try to window around diff hunks for this path
  local lines hunk_lines
  hunk_lines="$(printf '%s\n' "$PACK_DIFF" | awk -v f="$f" '
    BEGIN { show=0 }
    /^\+\+\+ b\// {
      path=$0; sub(/^\+\+\+ b\//,"",path)
      show = (path==f)
    }
    show && /^@@/ {
      # portable: @@ -a,b +c,d @@ → print c (only the +side after second @@ field)
      # Avoid greedy /^.*\+/ which can eat trailing function-context that contains +.
      if (match($0, /^@@[ \t]+-[0-9]+(,[0-9]+)?[ \t]+\+([0-9]+)/)) {
        line = substr($0, RSTART, RLENGTH)
        sub(/^.*\+/, "", line)
        if (line ~ /^[0-9]+$/) print line
      }
    }
  ')"
  if [ -z "$hunk_lines" ]; then
    head -c "$max_file_bytes" "$abs"
    printf '\n… [file truncated at %s bytes; no hunk anchors]\n' "$max_file_bytes"
    PACK_TRUNCATED+="truncated $f (no hunk anchors)"$'\n'
    return
  fi

  # Build line ranges ± context_window
  local start end ln total_lines
  total_lines="$(wc -l < "$abs" | tr -d ' ')"
  {
    echo "… [windowed extract; file has $total_lines lines, cap ${max_file_bytes}B] …"
    while IFS= read -r ln; do
      [ -z "$ln" ] && continue
      start=$((ln - context_window))
      end=$((ln + context_window))
      ((start < 1)) && start=1
      ((end > total_lines)) && end=$total_lines
      echo "----- lines $start-$end (around +$ln) -----"
      sed -n "${start},${end}p" "$abs"
    done <<< "$hunk_lines"
  } | head -c "$max_file_bytes"
  printf '\n… [window extract capped at %s bytes]\n' "$max_file_bytes"
  PACK_TRUNCATED+="windowed $f"$'\n'
}

# Resolve downstream references (PROJECT_SLICE) by reusing the ALREADY-computed
# diff — never recompute. Sets PACK_IMPACT_JSON (array) + PACK_IMPACT_N (count).
# Any failure degrades to an empty slice with a NOTES entry; pack build proceeds.
_cp_resolve_impact() {
  PACK_IMPACT_JSON='[]'
  PACK_IMPACT_N=0
  if [ "${impact_enable:-1}" != 1 ]; then
    PACK_TRUNCATED+=$'impact: disabled (--no-impact) — PROJECT_SLICE empty\n'
    return
  fi
  if ! declare -F impact_resolve >/dev/null 2>&1; then
    PACK_TRUNCATED+=$'impact: resolver unit not loaded — PROJECT_SLICE empty\n'
    return
  fi
  if ! command -v jq >/dev/null 2>&1; then
    PACK_TRUNCATED+=$'impact: jq missing — PROJECT_SLICE empty\n'
    return
  fi
  local out
  IMPACT_REPO="$repo_root"
  IMPACT_DIFF="$PACK_DIFF"
  IMPACT_CHANGED="$PACK_CHANGED"
  # Collect a truthful count (ceiling well above the 40-line display cap) so the
  # PROJECT_SLICE "N total" note distinguishes "exactly 40" from "capped" — no
  # silent truncation. Per-symbol flood is still bounded by the resolver default.
  IMPACT_MAX_FILES="${IMPACT_MAX_FILES:-200}"
  if out="$(impact_resolve 2>/dev/null)" && [ -n "$out" ]; then
    PACK_IMPACT_JSON="$out"
    PACK_IMPACT_N="$(printf '%s' "$out" | jq 'length' 2>/dev/null || echo 0)"
  else
    PACK_TRUNCATED+=$'impact: resolver produced nothing — PROJECT_SLICE empty\n'
  fi
}

_cp_write_pack() {
  local out="$1"
  local f st lang
  {
    echo "# adversarial-review context pack v1"
    echo
    echo "## META"
    echo "- pack_id: $PACK_ID"
    echo "- target: $repo_root"
    echo "- base: $base"
    echo "- head: $head_ref"
    echo "- writer: $writer"
    echo "- mode: $mode"
    echo "- dirty_worktree_included: $PACK_DIRTY"
    echo "- context: pack-v1"
    echo
    echo "## INTENT"
    echo "$PACK_INTENT"
    echo
    echo "## CHANGESET"
    if [ -z "$PACK_CHANGED" ]; then
      echo "(no changed files)"
    else
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        st="$(_cp_file_status "$f")"
        lang="$(_cp_lang_of "$f")"
        echo "- $st $f ($lang)"
      done <<< "$PACK_CHANGED"
    fi
    echo
    echo "## DIFF"
    echo '```diff'
    if [ -n "$PACK_DIFF" ]; then
      printf '%s\n' "$PACK_DIFF"
    else
      echo "(empty diff)"
    fi
    echo '```'
    echo
    echo "## FILES"
    if ((${#PACK_FILE_LIST[@]} == 0)); then
      echo "(none selected)"
    else
      for f in "${PACK_FILE_LIST[@]}"; do
        st="$(_cp_file_status "$f")"
        lang="$(_cp_lang_of "$f")"
        echo "### $f (status=$st lang=$lang)"
        echo '```'"$lang"
        _cp_file_body "$f"
        echo
        echo '```'
        echo
        # base snippet for modified files when useful and small
        if [ "$st" = "M" ] && git -C "$repo_root" cat-file -e "$base:$f" 2>/dev/null; then
          baselen="$(git -C "$repo_root" show "$base:$f" 2>/dev/null | wc -c | tr -d ' ')"
          if [ "${baselen:-0}" -gt 0 ] && [ "$baselen" -le "$max_file_bytes" ]; then
            echo "### $f (base $base)"
            echo '```'"$lang"
            git -C "$repo_root" show "$base:$f" 2>/dev/null || true
            echo
            echo '```'
            echo
          fi
        fi
      done
    fi
    echo "## PROJECT_SLICE"
    echo "(downstream references to changed symbols — file:line pointers, not bodies."
    echo " Confidence: exact-ref > module-ref > same-name; same-name is a heuristic grep hit.)"
    if [ "${PACK_IMPACT_N:-0}" -eq 0 ]; then
      echo "(no downstream references found — see NOTES)"
    else
      printf '%s' "$PACK_IMPACT_JSON" | jq -r '
        def tier: if .confidence=="exact-ref" then 0 elif .confidence=="module-ref" then 1 else 2 end;
        sort_by(tier, .file, .line)
        | .[:40][]
        | "- \(.file):\(.line) — \(.why) [\(.confidence)/\(.resolver)]"'
      if [ "${PACK_IMPACT_N:-0}" -gt 40 ]; then
        echo "- … ($PACK_IMPACT_N total downstream refs; showing 40 — narrow the diff or add a language-aware resolver)"
        PACK_TRUNCATED+="project_slice capped: shown=40 total=$PACK_IMPACT_N"$'\n'
      fi
    fi
    echo
    echo "## NOTES"
    if [ -z "${PACK_TRUNCATED//[$' \t\n']/}" ]; then
      echo "- truncated: (none)"
    else
      echo "- truncated:"
      printf '%s' "$PACK_TRUNCATED" | sed 's/^/  - /'
    fi
  } > "$out"
}

# Main entry: build_context_pack
# shellcheck disable=SC2034
build_context_pack() {
  max_files="${max_files:-10}"
  max_file_bytes="${max_file_bytes:-40960}"
  context_window="${context_window:-200}"
  path_filter=("${path_filter[@]+"${path_filter[@]}"}")
  PACK_TRUNCATED=""
  PACK_INTENT=""
  PACK_CHANGED=""
  PACK_DIFF=""
  PACK_DIRTY=0
  PACK_HAS_RUNTIME=0
  PACK_FILE_LIST=()
  PACK_IMPACT_JSON='[]'
  PACK_IMPACT_N=0

  PACK_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  if [ -n "${keep_pack_dir:-}" ]; then
    PACK_DIR="$keep_pack_dir"
    mkdir -p "$PACK_DIR"
  else
    PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/adv-review-pack.XXXXXX")"
  fi
  PACK_FILE="$PACK_DIR/pack.md"

  _cp_collect_diff
  _cp_has_runtime
  _cp_resolve_intent
  _cp_select_files
  _cp_resolve_impact
  _cp_write_pack "$PACK_FILE"

  if command -v sha256sum >/dev/null 2>&1; then
    PACK_HASH="$(sha256sum "$PACK_FILE" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    PACK_HASH="$(shasum -a 256 "$PACK_FILE" | awk '{print $1}')"
  else
    PACK_HASH="unknown"
  fi

  _cp_log "pack_id=$PACK_ID hash=${PACK_HASH:0:12}… files=${#PACK_FILE_LIST[@]} dirty=$PACK_DIRTY runtime=$PACK_HAS_RUNTIME"
  _cp_log "pack_file=$PACK_FILE"
}
