#!/usr/bin/env bash
# smoke.sh — end-to-end regression test for worktree-task CLI engine.
#
# Runs in an isolated /tmp git repo, exercises launch + reclaim through
# the `none` provider (no tmux/agent dependencies). Sandboxes HOME so the
# transcript-archive path can be exercised without touching the real
# user's ~/.claude/projects/.
#
# Cases:
#   1. happy-path: launch + reclaim creates and removes worktree, branch,
#      and metadata; no phantom worktree entry afterward.
#   2. dev-* prefix refusal: reclaim of a dev-* worktree refuses by default
#      with a clear error and leaves the worktree in place.
#   3. dev-* explicit allow: reclaim of a dev-* worktree succeeds when
#      --allow-long-lived is passed.
#   4. create-prompt preview: lifecycle prompt computes final title, slug,
#      worktree path, and branch before launch.
#   5. open-task-window lifecycle names: quick-create uses lifecycle only
#      for the local worktree slug and keeps branch names type-scoped.
#   6. origin-default-branch launch: branch starts from origin/HEAD but
#      does not track the default branch as upstream.
#
# Exit non-zero on any failure with a short trace.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKTREE_TASK="$REPO_ROOT/scripts/runtime/worktree/worktree-task"
CREATE_PROMPT="$REPO_ROOT/scripts/runtime/worktree/create-prompt"
OPEN_TASK_WINDOW="$REPO_ROOT/scripts/runtime/worktree/open-task-window"

[[ -x "$WORKTREE_TASK" ]] || {
  printf 'FAIL: worktree-task CLI not found or not executable: %s\n' "$WORKTREE_TASK" >&2
  exit 1
}
[[ -x "$CREATE_PROMPT" ]] || {
  printf 'FAIL: create-prompt not found or not executable: %s\n' "$CREATE_PROMPT" >&2
  exit 1
}
[[ -x "$OPEN_TASK_WINDOW" ]] || {
  printf 'FAIL: open-task-window not found or not executable: %s\n' "$OPEN_TASK_WINDOW" >&2
  exit 1
}

WORK_DIR="$(mktemp -d -t wt-smoke.XXXXXX)"
SANDBOX_HOME="$WORK_DIR/home"
mkdir -p "$SANDBOX_HOME"

# Persist the original HOME so we can hand it to subprocess git commands
# that need user identity (or anything else that legitimately reads the
# real HOME). The runtime under test uses $HOME for transcript paths only.
ORIGINAL_HOME="$HOME"

cleanup() {
  local rc=$?
  # Best-effort cleanup of any leftover worktrees in the throwaway repos.
  if [[ -d "$WORK_DIR" ]]; then
    find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d -name 'origin*' 2>/dev/null | while read -r repo; do
      git -C "$repo" worktree list --porcelain 2>/dev/null \
        | awk '/^worktree / {print $2}' \
        | grep -v "^$repo$" \
        | while read -r wt; do
            git -C "$repo" worktree remove -f "$wt" >/dev/null 2>&1 || true
          done || true
    done
  fi
  rm -rf "$WORK_DIR"
  return $rc
}
trap cleanup EXIT

setup_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.email "smoke@example.invalid"
  git -C "$repo" config user.name "Smoke Test"
  echo init > "$repo/README.md"
  git -C "$repo" add -A
  git -C "$repo" commit -q -m init
}

PASS=0
FAIL=0

assert_pass() {
  printf '[ok ] %s\n' "$1"
  PASS=$((PASS + 1))
}

assert_fail() {
  printf '[FAIL] %s\n' "$1" >&2
  FAIL=$((FAIL + 1))
}

# ---------- case 1: happy path ----------
case1_happy_path() {
  printf '\n=== case 1: happy path ===\n'

  local repo="$WORK_DIR/origin1"
  setup_repo "$repo"
  local slug="smoke-pr2-happy"
  local expect_wt="$WORK_DIR/.worktrees/origin1/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title "$slug" \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch returned non-zero"; return 1; }

  [[ -d "$expect_wt" ]] && assert_pass "worktree dir present" \
    || { assert_fail "worktree dir missing: $expect_wt"; return 1; }

  git -C "$repo" branch --list "task/$slug" | grep -q "task/$slug" \
    && assert_pass "branch present" \
    || { assert_fail "branch task/$slug missing"; return 1; }

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" reclaim \
    --cwd "$repo" \
    --task-slug "$slug" \
    --provider none >/dev/null \
    || { assert_fail "reclaim returned non-zero"; return 1; }

  [[ ! -d "$expect_wt" ]] && assert_pass "worktree dir gone" \
    || { assert_fail "worktree dir still present after reclaim"; return 1; }

  if git -C "$repo" branch --list "task/$slug" | grep -q "task/$slug"; then
    assert_fail "branch task/$slug still present after reclaim"
    return 1
  fi
  assert_pass "branch gone"

  if git -C "$repo" worktree list --porcelain | grep -q "$expect_wt"; then
    assert_fail "phantom worktree entry remains"
    return 1
  fi
  assert_pass "no phantom worktree entry"
}

# ---------- case 2: dev-* default refusal ----------
case2_dev_refusal() {
  printf '\n=== case 2: dev-* prefix refusal ===\n'

  local repo="$WORK_DIR/origin2"
  setup_repo "$repo"
  local slug="dev-billing"
  local expect_wt="$WORK_DIR/.worktrees/origin2/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title "$slug" \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch returned non-zero for dev-* slug"; return 1; }

  [[ -d "$expect_wt" ]] || { assert_fail "dev-* worktree not created"; return 1; }
  assert_pass "dev-* worktree created (launch is allowed)"

  # Reclaim must refuse with a recognizable message.
  local stderr_file="$WORK_DIR/case2-stderr"
  if HOME="$SANDBOX_HOME" \
     WEZDECK_REPO="$REPO_ROOT" \
     "$WORKTREE_TASK" reclaim \
       --cwd "$repo" \
       --task-slug "$slug" \
       --provider none >/dev/null 2>"$stderr_file"; then
    assert_fail "reclaim of $slug should have failed but succeeded"
    return 1
  fi
  assert_pass "reclaim of dev-* refused (non-zero exit)"

  if grep -qiE "long-lived|dev-billing" "$stderr_file"; then
    assert_pass "refusal message mentions long-lived/dev-billing"
  else
    assert_fail "refusal message unclear: $(cat "$stderr_file")"
    return 1
  fi

  [[ -d "$expect_wt" ]] && assert_pass "dev-* worktree still present after refused reclaim" \
    || { assert_fail "dev-* worktree was removed despite refusal"; return 1; }

  # Manual cleanup so case 3 starts clean.
  git -C "$repo" worktree remove -f "$expect_wt" >/dev/null 2>&1 || true
}

# ---------- case 3: dev-* explicit allow ----------
case3_dev_allow_long_lived() {
  printf '\n=== case 3: dev-* explicit allow ===\n'

  local repo="$WORK_DIR/origin3"
  setup_repo "$repo"
  local slug="dev-ci-fix"
  local expect_wt="$WORK_DIR/.worktrees/origin3/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title "$slug" \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch returned non-zero for dev-* slug"; return 1; }

  [[ -d "$expect_wt" ]] || { assert_fail "dev-* worktree not created"; return 1; }
  assert_pass "dev-* worktree created for explicit allow"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" reclaim \
    --cwd "$repo" \
    --task-slug "$slug" \
    --allow-long-lived \
    --provider none >/dev/null \
    || { assert_fail "reclaim with --allow-long-lived failed"; return 1; }

  [[ ! -d "$expect_wt" ]] && assert_pass "dev-* worktree gone after explicit allow" \
    || { assert_fail "dev-* worktree still present after explicit allow"; return 1; }
}

# ---------- case 4: create-prompt preview ----------
case4_create_prompt_preview() {
  printf '\n=== case 4: create-prompt preview ===\n'

  local repo="$WORK_DIR/origin4"
  setup_repo "$repo"
  local preview

  preview="$(
    cd "$repo"
    HOME="$SANDBOX_HOME" \
    WEZDECK_REPO="$REPO_ROOT" \
    "$CREATE_PROMPT" --type dev --preview "ci fix"
  )"

  grep -qx 'subject=ci fix' <<<"$preview" \
    && assert_pass "preview preserves subject title" \
    || { assert_fail "preview subject mismatch: $preview"; return 1; }
  grep -qx 'subject_slug=ci-fix' <<<"$preview" \
    && assert_pass "preview slugifies subject" \
    || { assert_fail "preview subject slug mismatch: $preview"; return 1; }
  grep -qx 'worktree_slug=dev-ci-fix' <<<"$preview" \
    && assert_pass "preview applies dev lifecycle to worktree slug" \
    || { assert_fail "preview title mismatch: $preview"; return 1; }
  grep -qx "worktree=$WORK_DIR/.worktrees/origin4/dev-ci-fix" <<<"$preview" \
    && assert_pass "preview shows final worktree path" \
    || { assert_fail "preview worktree mismatch: $preview"; return 1; }
  grep -qx 'branch=dev/ci-fix' <<<"$preview" \
    && assert_pass "preview shows final branch" \
    || { assert_fail "preview branch mismatch: $preview"; return 1; }

  git -C "$repo" branch dev/ci-fix
  preview="$(
    cd "$repo"
    HOME="$SANDBOX_HOME" \
    WEZDECK_REPO="$REPO_ROOT" \
    "$CREATE_PROMPT" --type dev --preview "ci fix"
  )"
  grep -qx 'worktree_slug=dev-ci-fix-2' <<<"$preview" \
    && assert_pass "preview bumps colliding worktree slug" \
    || { assert_fail "preview did not bump collision: $preview"; return 1; }
  grep -qx 'branch=dev/ci-fix-2' <<<"$preview" \
    && assert_pass "preview bumps colliding branch" \
    || { assert_fail "preview did not bump branch: $preview"; return 1; }
}

# ---------- case 5: open-task-window lifecycle names ----------
case5_open_task_window_lifecycle_names() {
  printf '\n=== case 5: open-task-window lifecycle names ===\n'

  local repo="$WORK_DIR/origin5"
  setup_repo "$repo"
  local expect_wt="$WORK_DIR/.worktrees/origin5/task-ci-fix"

  (
    cd "$repo"
    HOME="$SANDBOX_HOME" \
    WEZDECK_REPO="$REPO_ROOT" \
    MANAGED_AGENT_PROFILE=claude \
    WT_QUICK_CREATE_BASE_REF=HEAD \
    WT_QUICK_CREATE_PROVIDER=none \
    WT_QUICK_CREATE_PROVIDER_MODE=off \
    "$OPEN_TASK_WINDOW" --type task -- "ci fix" >/dev/null
  ) || { assert_fail "open-task-window task quick-create failed"; return 1; }

  [[ -d "$expect_wt" ]] && assert_pass "quick-create worktree uses lifecycle slug" \
    || { assert_fail "quick-create worktree missing: $expect_wt"; return 1; }
  git -C "$repo" branch --list "task/ci-fix" | grep -q "task/ci-fix" \
    && assert_pass "quick-create branch uses type prefix plus subject" \
    || { assert_fail "branch task/ci-fix missing"; return 1; }
  if git -C "$repo" branch --list "task/task-ci-fix" | grep -q "task/task-ci-fix"; then
    assert_fail "legacy duplicated branch task/task-ci-fix was created"
    return 1
  fi
  assert_pass "quick-create avoids duplicated branch prefix"
}

# ---------- case 6: origin default does not become upstream ----------
case6_origin_default_no_tracking() {
  printf '\n=== case 6: origin default no tracking ===\n'

  local remote="$WORK_DIR/remote6.git"
  local repo="$WORK_DIR/origin6"
  git init -q --bare "$remote"
  setup_repo "$repo"
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push -q -u origin main
  git -C "$remote" symbolic-ref HEAD refs/heads/main
  git -C "$repo" remote set-head origin -a >/dev/null

  local slug="remote-base"
  local expect_wt="$WORK_DIR/.worktrees/origin6/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title "$slug" \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch from origin/HEAD failed"; return 1; }

  [[ -d "$expect_wt" ]] && assert_pass "origin-default launch creates worktree" \
    || { assert_fail "origin-default worktree missing: $expect_wt"; return 1; }

  if git -C "$expect_wt" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
    assert_fail "new task branch unexpectedly tracks an upstream: $(git -C "$expect_wt" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')"
    return 1
  fi
  assert_pass "new task branch has no upstream"

  local branch_remote
  branch_remote="$(git -C "$repo" config --get "branch.task/$slug.remote" || true)"
  [[ -z "$branch_remote" ]] && assert_pass "branch config has no remote" \
    || { assert_fail "branch.task/$slug.remote should be empty, got: $branch_remote"; return 1; }
}

# ---------- case 6: transcript preservation ----------
# Reclaim intentionally leaves ~/.claude/projects/<escaped>/ in place so a
# later same-named worktree (rare but legitimate when reusing task types)
# can resume the prior conversation via `claude --continue`. /clear is the
# escape hatch when the resumed context isn't wanted.
case7_transcript_preserved() {
  printf '\n=== case 7: transcript preserved across reclaim ===\n'

  local repo="$WORK_DIR/origin7"
  setup_repo "$repo"
  local slug="task-resume"
  local expect_wt="$WORK_DIR/.worktrees/origin7/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title "$slug" \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch failed"; return 1; }

  local escaped="${expect_wt//\//-}"
  local transcript_src="$SANDBOX_HOME/.claude/projects/$escaped"
  mkdir -p "$transcript_src"
  echo '{"role":"user","content":"hello"}' > "$transcript_src/dummy.jsonl"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" reclaim \
    --cwd "$repo" \
    --task-slug "$slug" \
    --provider none >/dev/null \
    || { assert_fail "reclaim failed"; return 1; }

  [[ -f "$transcript_src/dummy.jsonl" ]] && assert_pass "transcript file preserved at original path" \
    || { assert_fail "transcript dir/file disappeared after reclaim"; return 1; }

  [[ ! -d "$SANDBOX_HOME/.claude/projects/.archive" ]] && assert_pass "no .archive/ side-effect created" \
    || { assert_fail ".archive/ unexpectedly created — archive code may not be fully removed"; return 1; }
}

# ---------- run ----------
case1_happy_path
case2_dev_refusal
case3_dev_allow_long_lived
case4_create_prompt_preview
case5_open_task_window_lifecycle_names
case6_origin_default_no_tracking
case7_transcript_preserved

printf '\n=== summary ===\n'
printf 'pass=%d fail=%d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
echo PASS smoke
