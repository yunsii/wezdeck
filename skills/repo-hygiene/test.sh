#!/usr/bin/env bash
# Fixture tests for repo-hygiene (no network).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
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
mkdir -p "$fx/docs" "$fx/skills/repo-hygiene" "$fx/scripts/dev"
# copy hygiene tree
cp -a "$here/." "$fx/skills/repo-hygiene/"
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
cat >"$fx/skills/repo-hygiene/budgets.conf" <<'EOF'
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
runner="$fx/skills/repo-hygiene/run.sh"
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

# 8) bilingual README parity — matching pair passes
cat >"$fx/README.md" <<'EOF'
<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

## Design stance

See [docs](docs/ok.md) and [AGENTS.md](AGENTS.md). Tokens: attention.json agent-launcher.sh.

## Highlights

- Alt+j Alt+k Alt+l Alt+v Alt+b
- CDP· D· M· SB· hybrid-wsl posix-local worktree-recycle
- wezterm-x/commands/manifest.json wezterm-x/local/keybindings.lua
- scripts/dev/workflow-timeline.sh scripts/dev/habit-report.sh habit-weekly
- docs/diagnostics.md docs/guest-oom.md docs/host-disk.md docs/logging-conventions.md
- docs/agent-attention.md docs/browser-debug.md

```text
loop
```

```bash
echo hi
```

| A | B |
|---|---|
| 1 | 2 |
EOF
cat >"$fx/README.zh-CN.md" <<'EOF'
<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

## 设计立场

见 [docs](docs/ok.md) 与 [AGENTS.md](AGENTS.md)。Tokens: attention.json agent-launcher.sh。

## 亮点

- Alt+j Alt+k Alt+l Alt+v Alt+b
- CDP· D· M· SB· hybrid-wsl posix-local worktree-recycle
- wezterm-x/commands/manifest.json wezterm-x/local/keybindings.lua
- scripts/dev/workflow-timeline.sh scripts/dev/habit-report.sh habit-weekly
- docs/diagnostics.md docs/guest-oom.md docs/host-disk.md docs/logging-conventions.md
- docs/agent-attention.md docs/browser-debug.md

```text
loop
```

```bash
echo hi
```

| A | B |
|---|---|
| 1 | 2 |
EOF
# AGENTS stub so relative link resolves in other checks if needed
echo '# AGENTS' >"$fx/AGENTS.md"
git -C "$fx" add README.md README.zh-CN.md AGENTS.md
assert_exit 0 "readme parity ok" env HYGIENE_REPO_ROOT="$fx" "$runner" pre-commit

# 9) heading outline drift → fail
cat >"$fx/README.zh-CN.md" <<'EOF'
<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

## 设计立场

见 [docs](docs/ok.md)。

```text
loop
```
EOF
git -C "$fx" add README.zh-CN.md
assert_exit 1 "readme parity heading drift" env HYGIENE_REPO_ROOT="$fx" "$runner" pre-commit
assert_grep "heading level outline" "$tmp/out" "heading drift message"
# restore matching zh for later
git -C "$fx" checkout -q -- README.zh-CN.md 2>/dev/null || true
# re-write good zh (checkout may restore seed absence; force good copy)
cat >"$fx/README.zh-CN.md" <<'EOF'
<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

## 设计立场

见 [docs](docs/ok.md) 与 [AGENTS.md](AGENTS.md)。Tokens: attention.json agent-launcher.sh。

## 亮点

- Alt+j Alt+k Alt+l Alt+v Alt+b
- CDP· D· M· SB· hybrid-wsl posix-local worktree-recycle
- wezterm-x/commands/manifest.json wezterm-x/local/keybindings.lua
- scripts/dev/workflow-timeline.sh scripts/dev/habit-report.sh habit-weekly
- docs/diagnostics.md docs/guest-oom.md docs/host-disk.md docs/logging-conventions.md
- docs/agent-attention.md docs/browser-debug.md

```text
loop
```

```bash
echo hi
```

| A | B |
|---|---|
| 1 | 2 |
EOF
git -C "$fx" add README.md README.zh-CN.md

# 10) link only on English side → fail
cat >"$fx/README.md" <<'EOF'
<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

## Design stance

See [docs](docs/ok.md) [extra](docs/other.md) and [AGENTS.md](AGENTS.md). Tokens: attention.json agent-launcher.sh.

## Highlights

- Alt+j Alt+k Alt+l Alt+v Alt+b
- CDP· D· M· SB· hybrid-wsl posix-local worktree-recycle
- wezterm-x/commands/manifest.json wezterm-x/local/keybindings.lua
- scripts/dev/workflow-timeline.sh scripts/dev/habit-report.sh habit-weekly
- docs/diagnostics.md docs/guest-oom.md docs/host-disk.md docs/logging-conventions.md
- docs/agent-attention.md docs/browser-debug.md

```text
loop
```

```bash
echo hi
```

| A | B |
|---|---|
| 1 | 2 |
EOF
git -C "$fx" add README.md
assert_exit 1 "readme parity link drift" env HYGIENE_REPO_ROOT="$fx" "$runner" pre-commit
assert_grep "relative links only in README.md" "$tmp/out" "link drift message"

# Live-repo structural check for diagnostics domain split (skips if absent).
if [[ -f "$root/docs/guest-oom.md" && -f "$root/skills/repo-hygiene/test-diagnostics-split.sh" ]]; then
  if bash "$root/skills/repo-hygiene/test-diagnostics-split.sh" >"$tmp/split.out" 2>"$tmp/split.err"; then
    echo "ok diagnostics-split invariants"
  else
    echo "FAIL diagnostics-split invariants" >&2
    cat "$tmp/split.out" "$tmp/split.err" >&2 || true
    fail=$((fail + 1))
  fi
fi

# Live-repo bilingual README parity (skips if Chinese twin absent).
if [[ -f "$root/README.md" && -f "$root/README.zh-CN.md" ]]; then
  if python3 "$root/skills/repo-hygiene/lib/readme-parity.py" "$root" \
      "$root/skills/repo-hygiene/readme-parity.conf" >"$tmp/live-readme.out" 2>"$tmp/live-readme.err"; then
    echo "ok live README en/zh parity"
  else
    echo "FAIL live README en/zh parity" >&2
    cat "$tmp/live-readme.out" "$tmp/live-readme.err" >&2 || true
    fail=$((fail + 1))
  fi
fi

if (( fail > 0 )); then
  echo "$fail test(s) failed" >&2
  exit 1
fi
echo "all repo-hygiene tests passed"
