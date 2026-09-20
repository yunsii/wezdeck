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

echo "=== recycle happy path (no init by default) ==="
remote="$WORK_DIR/remote-ok.git"
repo="$WORK_DIR/origin-ok"
git init -q --bare "$remote"
setup_repo "$repo"
git -C "$repo" remote add origin "$remote"
git -C "$repo" push -q -u origin main
git -C "$remote" symbolic-ref HEAD refs/heads/main
git -C "$repo" remote set-head origin -a >/dev/null

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
# Intentionally leave unique commits undelivered — fast path must still reset.
echo later >"$repo/later.txt"
git -C "$repo" add later.txt
git -C "$repo" commit -q -m later
git -C "$repo" push -q origin main

out="$WORK_DIR/recycle.out"
HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
  "$RUN" recycle --cwd "$expect_wt" -y --task "next from skill" \
  >"$out" 2>&1 \
  || { assert_fail "recycle orchestration failed"; cat "$out" >&2; exit 1; }

origin_tip="$(git -C "$repo" rev-parse origin/HEAD)"
[[ "$(git -C "$expect_wt" rev-parse HEAD)" == "$origin_tip" ]] \
  && assert_pass "HEAD aligned via skill recycle" \
  || assert_fail "HEAD not aligned"

[[ "$(git -C "$expect_wt" symbolic-ref --short HEAD)" == "dev/wr-ok" ]] \
  && assert_pass "branch kept slug mapping" \
  || assert_fail "branch not aligned to slug"

[[ -f "$expect_wt/.task-brief.md" ]] \
  && grep -q "next from skill" "$expect_wt/.task-brief.md" \
  && assert_pass "brief written" \
  || assert_fail "brief missing"

if grep -q "init recipe:" "$out"; then
  assert_fail "init should be skipped by default"
else
  assert_pass "init skipped by default"
fi

remote_dev_tip="$(git -C "$repo" rev-parse refs/remotes/origin/dev/wr-ok 2>/dev/null || true)"
[[ "$remote_dev_tip" == "$origin_tip" ]] \
  && assert_pass "origin/dev/wr-ok synced to base" \
  || assert_fail "origin/dev/wr-ok not synced"

echo "=== branch align to slug ==="
remote2="$WORK_DIR/remote-align.git"
repo2="$WORK_DIR/origin-align"
git init -q --bare "$remote2"
setup_repo "$repo2"
git -C "$repo2" remote add origin "$remote2"
git -C "$repo2" push -q -u origin main
git -C "$remote2" symbolic-ref HEAD refs/heads/main
git -C "$repo2" remote set-head origin -a >/dev/null

slug2="dev-align-me"
expect_wt2="$WORK_DIR/.worktrees/origin-align/$slug2"
HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo2" \
    --title align-me \
    --task-slug "$slug2" \
    --branch "wip/wrong-name" \
    --provider none \
    --no-attach >/dev/null

HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
  "$RUN" recycle --cwd "$expect_wt2" -y >"$WORK_DIR/align.out" 2>&1 \
  || { assert_fail "align recycle failed"; cat "$WORK_DIR/align.out" >&2; exit 1; }

[[ "$(git -C "$expect_wt2" symbolic-ref --short HEAD)" == "dev/align-me" ]] \
  && assert_pass "branch renamed to slug mapping" \
  || assert_fail "branch align failed: $(git -C "$expect_wt2" symbolic-ref --short HEAD)"

[[ "$(git -C "$expect_wt2" rev-parse HEAD)" == "$(git -C "$repo2" rev-parse origin/HEAD)" ]] \
  && assert_pass "aligned branch on origin/HEAD" \
  || assert_fail "aligned branch not on origin/HEAD"

echo "=== primary recycle ==="
remote3="$WORK_DIR/remote-primary.git"
repo3="$WORK_DIR/origin-primary"
git init -q --bare "$remote3"
setup_repo "$repo3"
git -C "$repo3" remote add origin "$remote3"
git -C "$repo3" push -q -u origin main
git -C "$remote3" symbolic-ref HEAD refs/heads/main
git -C "$repo3" remote set-head origin -a >/dev/null

# Remote advances, then local diverges — recycle must take origin/HEAD.
echo remote-ahead >"$repo3/remote-ahead.txt"
git -C "$repo3" add remote-ahead.txt
git -C "$repo3" commit -q -m "remote ahead"
git -C "$repo3" push -q origin main
git -C "$repo3" reset --hard HEAD~1 >/dev/null
echo local-only >"$repo3/local-only.txt"
git -C "$repo3" add local-only.txt
git -C "$repo3" commit -q -m "local only"
git -C "$repo3" fetch -q origin

if HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
  "$RUN" preflight --cwd "$repo3" >/dev/null 2>&1; then
  assert_pass "preflight accepts primary"
else
  assert_fail "preflight should accept primary"
fi

HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
  "$RUN" recycle --cwd "$repo3" -y >"$WORK_DIR/primary.out" 2>&1 \
  || { assert_fail "primary recycle failed"; cat "$WORK_DIR/primary.out" >&2; exit 1; }

[[ "$(git -C "$repo3" rev-parse HEAD)" == "$(git -C "$repo3" rev-parse origin/HEAD)" ]] \
  && assert_pass "primary HEAD == origin/HEAD" \
  || assert_fail "primary HEAD not aligned"

[[ "$(git -C "$repo3" symbolic-ref --short HEAD)" == "main" ]] \
  && assert_pass "primary on default branch" \
  || assert_fail "primary not on default branch"

[[ ! -f "$repo3/local-only.txt" && -f "$repo3/remote-ahead.txt" ]] \
  && assert_pass "primary discarded local-only, took remote tip" \
  || assert_fail "primary tree content unexpected"

echo "=== --with-init still works ==="
mkdir -p "$expect_wt/.worktree-recycle"
cat >"$expect_wt/.worktree-recycle/post-recycle.sh" <<'EOF'
#!/usr/bin/env bash
printf 'hook-ran cwd=%s\n' "$1" >"$1/.worktree-recycle/hook.out"
EOF
chmod +x "$expect_wt/.worktree-recycle/post-recycle.sh"

HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
  "$RUN" recycle --cwd "$expect_wt" -y --with-init >"$WORK_DIR/init.out" 2>&1 \
  || { assert_fail "recycle --with-init failed"; cat "$WORK_DIR/init.out" >&2; exit 1; }

grep -q "init recipe:" "$WORK_DIR/init.out" \
  && assert_pass "init recipe printed with --with-init" \
  || assert_fail "init recipe missing with --with-init"

[[ -f "$expect_wt/.worktree-recycle/hook.out" ]] \
  && grep -q "hook-ran" "$expect_wt/.worktree-recycle/hook.out" \
  && assert_pass "project post-recycle hook ran with --with-init" \
  || assert_fail "project hook did not run with --with-init"

printf '\n=== summary ===\npass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
