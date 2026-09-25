#!/usr/bin/env bash
# repo-hygiene — L0 pre-commit gate + L1 full-repo audit.
#
# Usage:
#   run.sh pre-commit [--soft-anchors]
#   run.sh audit [--strict] [--soft-anchors]
#   run.sh install
#
# Env:
#   WEZTERM_HYGIENE_SKIP=1     emergency bypass (prints warning; exit 0)
#   HYGIENE_STAGED_FILES=...   newline-separated paths (tests)
#   HYGIENE_REPO_ROOT=...      override repo root
set -euo pipefail

HYGIENE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HYGIENE_REPO_ROOT="${HYGIENE_REPO_ROOT:-$(cd "$HYGIENE_HOME/../.." && pwd)}"
export HYGIENE_HOME HYGIENE_REPO_ROOT

# shellcheck source=lib/common.sh
source "$HYGIENE_HOME/lib/common.sh"
# shellcheck source=lib/staged.sh
source "$HYGIENE_HOME/lib/staged.sh"
# shellcheck source=lib/links.sh
source "$HYGIENE_HOME/lib/links.sh"
# shellcheck source=lib/sizes.sh
source "$HYGIENE_HOME/lib/sizes.sh"
# shellcheck source=lib/shell-syntax.sh
source "$HYGIENE_HOME/lib/shell-syntax.sh"
# shellcheck source=lib/secrets-heuristics.sh
source "$HYGIENE_HOME/lib/secrets-heuristics.sh"
# shellcheck source=lib/readme-parity.sh
source "$HYGIENE_HOME/lib/readme-parity.sh"

SOFT_ANCHORS=0
STRICT=0
VERBOSE=0
BACKTICKS=0
MODE=""

usage() {
  cat <<'EOF'
Usage: run.sh <pre-commit|audit|install> [options]

  pre-commit   Fast checks on staged files (hard fail). For git hook.
               Also en/zh README parity when README.md or README.zh-CN.md staged.
  audit        Full-repo report (summary first; fail on broken file links /
               README parity).
  install      Install shared pre-commit hook into git common dir.

Options:
  --soft-anchors   Missing heading anchors are advisory (not fail).
                   Audit already treats anchors as advisory by default.
  --strict         audit: also fail when any non-allowlisted OVER-HARD file exists.
  --verbose        audit: print every advisory line (default: summary + samples).
  --backticks      audit: enable basename/path backtick heuristics (off by default).
EOF
}

parse_args() {
  [[ $# -ge 1 ]] || { usage >&2; exit 2; }
  MODE="$1"
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --soft-anchors) SOFT_ANCHORS=1 ;;
      --strict) STRICT=1 ;;
      --verbose|-v) VERBOSE=1 ;;
      --backticks) BACKTICKS=1 ;;
      -h|--help) usage; exit 0 ;;
      *) hygiene_err "unknown arg: $1"; usage >&2; exit 2 ;;
    esac
    shift
  done
  if [[ "${WEZTERM_HYGIENE_SOFT_ANCHORS:-}" == "1" ]]; then
    SOFT_ANCHORS=1
  fi
}

run_mermaid_if_needed() {
  local root="$1"
  shift
  local mds=()
  local f
  for f in "$@"; do
    [[ "$f" == *.md ]] || continue
    mds+=("$root/$f")
  done
  [[ ${#mds[@]} -gt 0 ]] || return 0
  local checker="$root/scripts/dev/check-mermaid.sh"
  if [[ ! -x "$checker" ]]; then
    hygiene_err "check-mermaid.sh missing; skip mermaid"
    return 0
  fi
  if ! "$checker" "${mds[@]}"; then
    return 1
  fi
  return 0
}

run_popup_guard_if_needed() {
  local root="$1"
  shift
  local need=0 f
  for f in "$@"; do
    if [[ "$f" == scripts/* && "$f" == *.sh ]]; then
      need=1
      break
    fi
  done
  (( need )) || return 0
  local guard="$root/scripts/dev/check-display-popup-guard.sh"
  [[ -x "$guard" ]] || return 0
  "$guard"
}

cmd_pre_commit() {
  local root="$HYGIENE_REPO_ROOT"
  if [[ "${WEZTERM_HYGIENE_SKIP:-}" == "1" ]]; then
    hygiene_err "WEZTERM_HYGIENE_SKIP=1 — bypassing pre-commit checks (emergency only)"
    exit 0
  fi

  mapfile -t targets < <(hygiene_list_targets pre-commit "$root")
  if [[ ${#targets[@]} -eq 0 ]]; then
    hygiene_log "pre-commit: no staged files"
    exit 0
  fi

  hygiene_log "pre-commit: ${#targets[@]} staged file(s)"
  hygiene_load_budgets "$HYGIENE_HOME/budgets.conf"

  local fails=0
  local md_files=() sh_files=()
  local t
  for t in "${targets[@]}"; do
    case "$t" in
      *.md|*.mdx) md_files+=("$t") ;;
      *.sh) sh_files+=("$t") ;;
    esac
  done

  if [[ ${#md_files[@]} -gt 0 ]]; then
    hygiene_check_md_links "$root" "$SOFT_ANCHORS" "${md_files[@]}"
    fails=$((fails + HYGIENE_LINK_FAILS))
  fi

  if [[ ${#sh_files[@]} -gt 0 ]]; then
    hygiene_check_shell_syntax "$root" "${sh_files[@]}"
    fails=$((fails + HYGIENE_SHELL_FAILS))
  fi

  hygiene_check_secrets "$root" "${targets[@]}"
  fails=$((fails + HYGIENE_SECRET_FAILS))

  hygiene_check_sizes "$root" pre-commit "${targets[@]}"
  fails=$((fails + HYGIENE_SIZE_FAILS))

  if [[ ${#md_files[@]} -gt 0 ]]; then
    if ! run_mermaid_if_needed "$root" "${md_files[@]}"; then
      fails=$((fails + 1))
    fi
  fi

  if ! run_popup_guard_if_needed "$root" "${targets[@]}"; then
    fails=$((fails + 1))
  fi

  hygiene_check_readme_parity "$root" pre-commit "${targets[@]}" || true
  fails=$((fails + HYGIENE_README_FAILS))

  if (( fails > 0 )); then
    hygiene_err "pre-commit failed ($fails finding(s)). Fix or (emergency) WEZTERM_HYGIENE_SKIP=1"
    exit 1
  fi
  hygiene_log "pre-commit: ok"
}

# Print up to N lines; if more, say how many were omitted.
hygiene_print_sample() {
  local n="$1"
  local label="$2"
  local file="$3"
  local total
  total="$(wc -l <"$file" | tr -d '[:space:]')"
  if (( total == 0 )); then
    return 0
  fi
  if (( VERBOSE )); then
    cat "$file"
    return 0
  fi
  head -n "$n" "$file"
  if (( total > n )); then
    echo "... ($((total - n)) more $label; pass --verbose to show all)"
  fi
}

cmd_audit() {
  local root="$HYGIENE_REPO_ROOT"
  local tmp
  tmp="$(mktemp -d)"
  # Clean up explicitly (RETURN trap + local + set -u races on some bash).
  hygiene_load_budgets "$HYGIENE_HOME/budgets.conf"

  mapfile -t md_all < <(
    git -C "$root" ls-files -z -- '*.md' 'AGENTS.md' 'CLAUDE.md' 'README.md' \
      | tr '\0' '\n' | sed '/^$/d'
  )
  mapfile -t code_all < <(
    git -C "$root" ls-files -z -- '*.lua' '*.sh' \
      | tr '\0' '\n' | sed '/^$/d'
  )

  echo "=== repo-hygiene audit ==="
  echo "root: $root"
  echo

  # --- links (anchors advisory in audit) ---
  local soft=1
  (( SOFT_ANCHORS )) || soft=1
  hygiene_check_md_links "$root" "$soft" "${md_all[@]}" >"$tmp/links.raw" || true
  local link_fails=$HYGIENE_LINK_FAILS
  grep -E '^FAIL ' "$tmp/links.raw" >"$tmp/links.fail" || true
  grep -E '^ADVISORY ' "$tmp/links.raw" >"$tmp/links.adv" || true

  # --- sizes ---
  hygiene_check_sizes "$root" audit "${md_all[@]}" "${code_all[@]}" >"$tmp/sizes.raw" || true
  grep -E '^OVER-HARD ' "$tmp/sizes.raw" | grep -v '\[allowlisted\]' >"$tmp/sizes.over" || true
  grep -E '^OVER-HARD ' "$tmp/sizes.raw" | grep '\[allowlisted\]' >"$tmp/sizes.over.allow" || true
  grep -E '^ADVISORY ' "$tmp/sizes.raw" >"$tmp/sizes.adv" || true

  # --- backticks (opt-in) ---
  local bt_count=0
  : >"$tmp/bt.raw"
  if (( BACKTICKS )); then
    hygiene_check_backtick_paths "$root" "${md_all[@]}" >"$tmp/bt.raw" || true
    bt_count="$(grep -cE '^ADVISORY ' "$tmp/bt.raw" || true)"
  fi

  # --- bilingual README parity ---
  : >"$tmp/readme.raw"
  hygiene_check_readme_parity "$root" audit >"$tmp/readme.raw" 2>&1 || true
  local readme_fails=$HYGIENE_README_FAILS
  grep -E '^FAIL ' "$tmp/readme.raw" >"$tmp/readme.fail" || true
  grep -E '^ADVISORY ' "$tmp/readme.raw" >"$tmp/readme.adv" || true

  local fail_n adv_anchor_n over_n over_allow_n soft_n readme_fail_n readme_adv_n
  fail_n="$(wc -l <"$tmp/links.fail" | tr -d '[:space:]')"
  adv_anchor_n="$(wc -l <"$tmp/links.adv" | tr -d '[:space:]')"
  over_n="$(wc -l <"$tmp/sizes.over" | tr -d '[:space:]')"
  over_allow_n="$(wc -l <"$tmp/sizes.over.allow" | tr -d '[:space:]')"
  soft_n="$(wc -l <"$tmp/sizes.adv" | tr -d '[:space:]')"
  readme_fail_n="$(wc -l <"$tmp/readme.fail" | tr -d '[:space:]')"
  readme_adv_n="$(wc -l <"$tmp/readme.adv" | tr -d '[:space:]')"

  echo "--- summary ---"
  printf 'FAIL file/anchor links:     %s\n' "$fail_n"
  printf 'ADVISORY missing anchors:   %s\n' "$adv_anchor_n"
  printf 'OVER-HARD (actionable):     %s\n' "$over_n"
  printf 'OVER-HARD (allowlisted):    %s\n' "$over_allow_n"
  printf 'ADVISORY soft budgets:      %s\n' "$soft_n"
  printf 'FAIL README en/zh parity:   %s\n' "$readme_fail_n"
  printf 'ADVISORY README parity:     %s\n' "$readme_adv_n"
  if (( BACKTICKS )); then
    printf 'ADVISORY backticks:         %s\n' "$bt_count"
  else
    echo 'ADVISORY backticks:         (skipped; pass --backticks)'
  fi
  echo

  if [[ -s "$tmp/links.fail" ]]; then
    echo "--- FAIL links ---"
    hygiene_print_sample 30 "FAIL links" "$tmp/links.fail"
    echo
  fi
  if [[ -s "$tmp/links.adv" ]]; then
    echo "--- ADVISORY anchors (sample) ---"
    hygiene_print_sample 15 "anchor advisories" "$tmp/links.adv"
    echo
  fi
  if [[ -s "$tmp/sizes.over" ]]; then
    echo "--- OVER-HARD actionable ---"
    hygiene_print_sample 30 "OVER-HARD" "$tmp/sizes.over"
    echo
  fi
  if [[ -s "$tmp/sizes.over.allow" ]]; then
    echo "--- OVER-HARD allowlisted (debt queue) ---"
    hygiene_print_sample 15 "allowlisted OVER-HARD" "$tmp/sizes.over.allow"
    echo
  fi
  if (( VERBOSE )) && [[ -s "$tmp/sizes.adv" ]]; then
    echo "--- ADVISORY soft budgets ---"
    cat "$tmp/sizes.adv"
    echo
  elif [[ -s "$tmp/sizes.adv" ]]; then
    echo "--- ADVISORY soft budgets (sample) ---"
    hygiene_print_sample 10 "soft-budget advisories" "$tmp/sizes.adv"
    echo
  fi
  if (( BACKTICKS )) && [[ -s "$tmp/bt.raw" ]]; then
    echo "--- ADVISORY backticks (sample) ---"
    grep -E '^ADVISORY ' "$tmp/bt.raw" >"$tmp/bt.adv" || true
    hygiene_print_sample 15 "backtick advisories" "$tmp/bt.adv"
    echo
  fi
  if [[ -s "$tmp/readme.fail" || -s "$tmp/readme.adv" ]]; then
    echo "--- README en/zh parity ---"
    hygiene_print_sample 40 "README parity" "$tmp/readme.raw"
    echo
  elif [[ -s "$tmp/readme.raw" ]]; then
    echo "--- README en/zh parity ---"
    cat "$tmp/readme.raw"
    echo
  fi

  echo "--- top markdown by lines ---"
  python3 - "$root" "${md_all[@]}" <<'PY' | tail -n 15
import sys
from pathlib import Path
root = Path(sys.argv[1])
rows = []
for rel in sys.argv[2:]:
    p = root / rel
    if p.is_file():
        rows.append((sum(1 for _ in p.open("rb")), rel))
for n, rel in sorted(rows)[-15:]:
    print(f"{n} {rel}")
PY
  echo

  echo "--- top lua/sh by lines ---"
  python3 - "$root" "${code_all[@]}" <<'PY' | tail -n 15
import sys
from pathlib import Path
root = Path(sys.argv[1])
rows = []
for rel in sys.argv[2:]:
    p = root / rel
    if p.is_file():
        rows.append((sum(1 for _ in p.open("rb")), rel))
for n, rel in sorted(rows)[-15:]:
    print(f"{n} {rel}")
PY
  echo

  local fails=$link_fails
  fails=$((fails + readme_fails))
  if (( STRICT )); then
    fails=$((fails + over_n))
    if (( over_n > 0 )); then
      echo "--- STRICT non-allowlisted OVER-HARD ---"
      cat "$tmp/sizes.over"
      echo
    fi
  fi

  if (( fails > 0 )); then
    rm -rf "$tmp"
    hygiene_err "audit failed ($fails fail-class finding(s))"
    exit 1
  fi
  rm -rf "$tmp"
  hygiene_log "audit: ok (advisory findings above are non-blocking)"
}

cmd_install() {
  exec "$HYGIENE_HOME/install-hooks.sh"
}

main() {
  parse_args "$@"
  case "$MODE" in
    pre-commit) cmd_pre_commit ;;
    audit) cmd_audit ;;
    install) cmd_install ;;
    *) usage >&2; exit 2 ;;
  esac
}

main "$@"
