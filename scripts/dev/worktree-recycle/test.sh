#!/usr/bin/env bash
# Offline smoke for worktree-recycle skill runner (no LLM).
set -euo pipefail

TOOL_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/dev/worktree-recycle → repo root is ../../..
REPO_ROOT="$(cd "$TOOL_HOME/../../.." && pwd)"
RUN="$TOOL_HOME/run.sh"
WORKTREE_TASK="$REPO_ROOT/scripts/runtime/worktree/worktree-task"

[[ -x "$RUN" ]] || chmod +x "$RUN"
[[ -x "$WORKTREE_TASK" ]] || {
  printf 'FAIL: worktree-task missing at %s\n' "$WORKTREE_TASK" >&2
  exit 1
}

WORK_DIR="$(mktemp -d -t wr-smoke.XXXXXX)"
SANDBOX_HOME="$WORK_DIR/home"
mkdir -p "$SANDBOX_HOME"
trap 'rm -rf "$WORK_DIR"' EXIT

PASS=0
FAIL=0
assert_pass() { printf '[ok ] %s\n' "$1"; PASS=$((PASS + 1)); }
assert_fail() { printf '[FAIL] %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

setup_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.email "smoke@example.invalid"
  git -C "$repo" config user.name "Smoke Test"
  echo init >"$repo/README.md"
  git -C "$repo" add -A
  git -C "$repo" commit -q -m init
}

echo "=== selfcheck ==="
if HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" "$RUN" selfcheck >/dev/null; then
  assert_pass "selfcheck"
else
  assert_fail "selfcheck"
fi

echo "=== preflight refuses task-* ==="
repo="$WORK_DIR/origin-task"
setup_repo "$repo"
slug="task-no-recycle"
expect_wt="$WORK_DIR/.worktrees/origin-task/$slug"
HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title no-recycle \
    --task-slug "$slug" \
    --branch "task/no-recycle" \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null

if HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
  "$RUN" preflight --cwd "$expect_wt" >/dev/null 2>&1; then
  assert_fail "preflight should refuse task-*"
else
  assert_pass "preflight refuses task-*"
fi

echo "=== recycle + init happy path ==="
remote="$WORK_DIR/remote-ok.git"
repo="$WORK_DIR/origin-ok"
git init -q --bare "$remote"
setup_repo "$repo"
git -C "$repo" remote add origin "$remote"
git -C "$repo" push -q -u origin main
git -C "$remote" symbolic-ref HEAD refs/heads/main
git -C "$repo" remote set-head origin -a >/dev/null

# Fingerprint as wezdeck so init recipe is deterministic in smoke.
# wezterm-x must contain a file — git does not track empty directories.
mkdir -p "$repo/wezterm-x"
touch "$repo/wezterm.lua" "$repo/wezterm-x/.keep"
git -C "$repo" add wezterm.lua wezterm-x/.keep
git -C "$repo" commit -q -m "wezdeck fingerprint"
git -C "$repo" push -q origin main

slug="dev-wr-ok"
expect_wt="$WORK_DIR/.worktrees/origin-ok/$slug"
HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title wr-ok \
    --task-slug "$slug" \
    --branch "dev/wr-ok" \
    --provider none \
    --no-attach >/dev/null

echo feature >"$expect_wt/feature.txt"
git -C "$expect_wt" add feature.txt
git -C "$expect_wt" commit -q -m feature
git -C "$repo" checkout -q main
git -C "$repo" merge -q --no-ff "dev/wr-ok" -m "merge feature"
echo later >"$repo/later.txt"
git -C "$repo" add later.txt
git -C "$repo" commit -q -m later
git -C "$repo" push -q origin main

# Project hook should run during init.
mkdir -p "$expect_wt/.worktree-recycle"
cat >"$expect_wt/.worktree-recycle/post-recycle.sh" <<'EOF'
#!/usr/bin/env bash
printf 'hook-ran cwd=%s\n' "$1" >"$1/.worktree-recycle/hook.out"
EOF
chmod +x "$expect_wt/.worktree-recycle/post-recycle.sh"
# Keep hook across recycle clean (not in default allowlist).

out="$WORK_DIR/recycle.out"
HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
  "$RUN" recycle --cwd "$expect_wt" -y --task "next from skill" \
  >"$out" 2>&1 \
  || { assert_fail "recycle orchestration failed"; cat "$out" >&2; exit 1; }

origin_tip="$(git -C "$repo" rev-parse origin/HEAD)"
[[ "$(git -C "$expect_wt" rev-parse HEAD)" == "$origin_tip" ]] \
  && assert_pass "HEAD aligned via skill recycle" \
  || assert_fail "HEAD not aligned"

[[ -f "$expect_wt/.task-brief.md" ]] \
  && grep -q "next from skill" "$expect_wt/.task-brief.md" \
  && assert_pass "brief written" \
  || assert_fail "brief missing"

[[ -f "$expect_wt/.worktree-recycle/hook.out" ]] \
  && grep -q "hook-ran" "$expect_wt/.worktree-recycle/hook.out" \
  && assert_pass "project post-recycle hook ran" \
  || assert_fail "project hook did not run"

grep -q "init recipe: wezdeck" "$out" \
  && assert_pass "wezdeck init recipe printed" \
  || assert_fail "wezdeck init recipe missing"

printf '\n=== summary ===\npass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
