#!/usr/bin/env bash
# Fixture tests for repo-hygiene (no network).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail=0
assert_exit() {
  local want="$1" label="$2"
  shift 2
  set +e
  "$@" >"$tmp/out" 2>"$tmp/err"
  local got=$?
  set -e
  if [[ "$got" -ne "$want" ]]; then
    echo "FAIL $label: exit $got want $want" >&2
    echo "--- stdout ---"; cat "$tmp/out" >&2
    echo "--- stderr ---"; cat "$tmp/err" >&2
    fail=$((fail + 1))
  else
    echo "ok $label"
  fi
}

assert_grep() {
  local pat="$1" file="$2" label="$3"
  if ! grep -qE "$pat" "$file"; then
    echo "FAIL $label: pattern /$pat/ not in $file" >&2
    cat "$file" >&2
    fail=$((fail + 1))
  else
    echo "ok $label"
  fi
}

# --- fixture repo ---
fx="$tmp/repo"
mkdir -p "$fx/docs" "$fx/scripts/dev/repo-hygiene" "$fx/scripts/dev"
# copy hygiene tree
cp -a "$here/." "$fx/scripts/dev/repo-hygiene/"
# stub mermaid checker (always ok) and popup guard
cat >"$fx/scripts/dev/check-mermaid.sh" <<'EOF'
#!/usr/bin/env bash
echo "✓ mermaid: stub ok"
exit 0
EOF
chmod +x "$fx/scripts/dev/check-mermaid.sh"
cat >"$fx/scripts/dev/check-display-popup-guard.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$fx/scripts/dev/check-display-popup-guard.sh"

# minimal budgets for fixture
cat >"$fx/scripts/dev/repo-hygiene/budgets.conf" <<'EOF'
docs/* 20 30
*.sh 50 80
EOF

git -C "$fx" init -q
git -C "$fx" config user.email "test@example.com"
git -C "$fx" config user.name "test"
# existing ok doc
cat >"$fx/docs/ok.md" <<'EOF'
# Ok

See [other](./other.md#section-one).
EOF
cat >"$fx/docs/other.md" <<'EOF'
# Other

## Section one

Body.
EOF
# under-budget shell
cat >"$fx/scripts/ok.sh" <<'EOF'
#!/usr/bin/env bash
echo hi
EOF
git -C "$fx" add docs/ok.md docs/other.md scripts/ok.sh
git -C "$fx" commit -q -m "seed"

export HYGIENE_REPO_ROOT="$fx"
runner="$fx/scripts/dev/repo-hygiene/run.sh"
chmod +x "$runner"

# 1) broken file link on staged md → fail
cat >"$fx/docs/ok.md" <<'EOF'
# Ok

See [missing](./nope.md).
EOF
git -C "$fx" add docs/ok.md
assert_exit 1 "broken file link" env HYGIENE_REPO_ROOT="$fx" "$runner" pre-commit
assert_grep "missing file" "$tmp/out" "broken link message"

# 2) fix link → ok
cat >"$fx/docs/ok.md" <<'EOF'
# Ok

See [other](./other.md).
EOF
git -C "$fx" add docs/ok.md
assert_exit 0 "fixed link" env HYGIENE_REPO_ROOT="$fx" "$runner" pre-commit

# 3) bash -n fail
cat >"$fx/scripts/bad.sh" <<'EOF'
#!/usr/bin/env bash
if true
  echo missing fi
EOF
git -C "$fx" add scripts/bad.sh
assert_exit 1 "bash -n" env HYGIENE_REPO_ROOT="$fx" "$runner" pre-commit
git -C "$fx" reset -q HEAD -- scripts/bad.sh
rm -f "$fx/scripts/bad.sh"

# 4) new file over hard budget → fail
python3 - <<PY
from pathlib import Path
p = Path("$fx/docs/huge.md")
p.write_text("# Huge\n\n" + ("line\n" * 40))
PY
git -C "$fx" add docs/huge.md
assert_exit 1 "new over hard" env HYGIENE_REPO_ROOT="$fx" "$runner" pre-commit
git -C "$fx" reset -q HEAD -- docs/huge.md
rm -f "$fx/docs/huge.md"

# 5) skip bypass
cat >"$fx/docs/ok.md" <<'EOF'
# Ok
See [missing](./nope.md).
EOF
git -C "$fx" add docs/ok.md
assert_exit 0 "skip env" env HYGIENE_REPO_ROOT="$fx" WEZTERM_HYGIENE_SKIP=1 "$runner" pre-commit
# restore
git -C "$fx" checkout -q -- docs/ok.md

# 6) audit reports broken link in tree
cat >"$fx/docs/broken.md" <<'EOF'
# Broken
[x](./absent.md)
EOF
git -C "$fx" add docs/broken.md
git -C "$fx" commit -q -m "add broken"
assert_exit 1 "audit finds broken" env HYGIENE_REPO_ROOT="$fx" "$runner" audit --soft-anchors
assert_grep "summary" "$tmp/out" "audit has summary"
assert_grep "FAIL file" "$tmp/out" "audit summary counts FAIL"

# 7) GFM double-hyphen anchors resolve (Hook → status → hook--status)
cat >"$fx/docs/other.md" <<'EOF'
# Other

## Hook → status map

Body.
EOF
cat >"$fx/docs/ok.md" <<'EOF'
# Ok

See [hook](./other.md#hook--status-map).
EOF
git -C "$fx" add docs/ok.md docs/other.md
# remove broken.md from tree for a clean link pass on these two
git -C "$fx" rm -q docs/broken.md
assert_exit 0 "gfm double-hyphen anchor" env HYGIENE_REPO_ROOT="$fx" "$runner" pre-commit

# Live-repo structural check for diagnostics domain split (skips if absent).
if [[ -f "$root/docs/guest-oom.md" && -f "$root/scripts/dev/repo-hygiene/test-diagnostics-split.sh" ]]; then
  if bash "$root/scripts/dev/repo-hygiene/test-diagnostics-split.sh" >"$tmp/split.out" 2>"$tmp/split.err"; then
    echo "ok diagnostics-split invariants"
  else
    echo "FAIL diagnostics-split invariants" >&2
    cat "$tmp/split.out" "$tmp/split.err" >&2 || true
    fail=$((fail + 1))
  fi
fi

if (( fail > 0 )); then
  echo "$fail test(s) failed" >&2
  exit 1
fi
echo "all repo-hygiene tests passed"
