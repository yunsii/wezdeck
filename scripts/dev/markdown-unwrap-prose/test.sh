#!/usr/bin/env bash
# Offline unit checks for unwrap.py (no network, no ~/.agent).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNWRAP=(python3 "$ROOT/unwrap.py")
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

assert_eq() {
  local name=$1 expected=$2 actual=$3
  if [[ "$expected" == "$actual" ]]; then
    printf 'ok  %s\n' "$name"
    pass=$((pass + 1))
  else
    printf 'FAIL %s\n expected:\n%s\n actual:\n%s\n' "$name" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

run_case() {
  local name=$1
  local input=$2
  local expected=$3
  local actual_file expected_file
  actual_file="$TMP/${name}.actual"
  expected_file="$TMP/${name}.expected"
  # Avoid $(…) — it strips trailing newlines and false-fails equal outputs.
  printf '%s' "$input" | "${UNWRAP[@]}" >"$actual_file"
  printf '%s' "$expected" >"$expected_file"
  if cmp -s "$expected_file" "$actual_file"; then
    printf 'ok  %s\n' "$name"
    pass=$((pass + 1))
  else
    printf 'FAIL %s\n expected:\n%s\n actual:\n%s\n' \
      "$name" "$(cat "$expected_file")" "$(cat "$actual_file")"
    fail=$((fail + 1))
  fi
}

# English paragraph soft-wrap → one line with spaces
run_case en-paragraph \
  $'Hello world this is a\nsoft wrapped paragraph.\n' \
  $'Hello world this is a soft wrapped paragraph.\n'

# Chinese paragraph → join without spaces
run_case zh-paragraph \
  $'给 cnb.cool 提工单时，正文直接复用了本仓\n.md 源码的排版习惯。\n' \
  $'给 cnb.cool 提工单时，正文直接复用了本仓.md 源码的排版习惯。\n'

# Mixed: Latin→CJK no space at junction when CJK side present
run_case mixed-latin-cjk \
  $'hello\n世界\n' \
  $'hello世界\n'

# Code fence preserved
run_case fence \
  $'Before the block.\nStill before.\n\n```bash\necho one\necho two\n```\n\nAfter the\nblock.\n' \
  $'Before the block. Still before.\n\n```bash\necho one\necho two\n```\n\nAfter the block.\n'

# Table rows stay separate
run_case table \
  $'| a | b |\n| --- | --- |\n| 1 | 2 |\n' \
  $'| a | b |\n| --- | --- |\n| 1 | 2 |\n'

# List item + soft-wrapped continuation
run_case list-continue \
  $'- first item that wraps\nacross lines here\n- second\n' \
  $'- first item that wraps across lines here\n- second\n'

# Blockquote merge
run_case blockquote \
  $'> quoted line one\n> quoted line two\n' \
  $'> quoted line one quoted line two\n'

# Blank line separates paragraphs
run_case two-paras \
  $'Para one\nline two.\n\nPara two\nline two.\n' \
  $'Para one line two.\n\nPara two line two.\n'

# --check exits 1 when change needed
printf '%s' $'a\nb\n' >"$TMP/dirty.md"
printf '%s' $'already one line\n' >"$TMP/clean.md"
set +e
"${UNWRAP[@]}" --check "$TMP/dirty.md" >/dev/null
rc_dirty=$?
"${UNWRAP[@]}" --check "$TMP/clean.md" >/dev/null
rc_clean=$?
set -e
assert_eq "check-dirty-rc" "1" "$rc_dirty"
assert_eq "check-clean-rc" "0" "$rc_clean"

# in-place rewrite
printf '%s' $'alpha\nbeta\n' >"$TMP/edit.md"
"${UNWRAP[@]}" "$TMP/edit.md" >/dev/null
printf '%s' $'alpha beta\n' >"$TMP/edit.expected"
if cmp -s "$TMP/edit.expected" "$TMP/edit.md"; then
  printf 'ok  inplace\n'
  pass=$((pass + 1))
else
  printf 'FAIL inplace\n'
  fail=$((fail + 1))
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
if ((fail)); then
  exit 1
fi
