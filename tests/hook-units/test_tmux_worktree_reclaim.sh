#!/usr/bin/env bash
# Unit tests for scripts/runtime/tmux-worktree-reclaim.sh (Alt+g Ctrl+d).
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/scripts/runtime/tmux-worktree-reclaim.sh"

pass=0
fail=0

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s\n    got:  %q\n    want: %q\n' "$name" "$got" "$want"
  fi
}

assert_ok() {
  local name="$1"
  shift
  if "$@"; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s\n' "$name"
  fi
}

sandbox="$(mktemp -d -t wezterm-wt-reclaim.XXXXXX)"
cleanup() {
  git -C "$sandbox/demo" worktree prune >/dev/null 2>&1 || true
  rm -rf "$sandbox"
}
trap cleanup EXIT

mkdir -p "$sandbox/bin" "$sandbox/demo" "$sandbox/.worktrees/demo"

# Mock tmux: enough for find_window / list-windows / select / kill / status.
cat >"$sandbox/bin/tmux" <<'TMUX_EOF'
#!/usr/bin/env bash
cmd="${1:-}"
shift || true
case "$cmd" in
  has-session) exit 0 ;;
  list-windows|list-panes|list-clients) exit 0 ;;
  display-message) printf 'sess\n'; exit 0 ;;
  select-window|kill-window|set-option|show-options|refresh-client|run-shell) exit 0 ;;
  *) exit 0 ;;
esac
TMUX_EOF
chmod +x "$sandbox/bin/tmux"
export PATH="$sandbox/bin:$PATH"
export TMUX="/tmp/fake-tmux"

# Real git family under the managed layout:
#   $sandbox/demo                         primary
#   $sandbox/.worktrees/demo/task-clean   delivered linked
#   $sandbox/.worktrees/demo/task-dirty   dirty linked
git -C "$sandbox/demo" init -q -b master
git -C "$sandbox/demo" config user.email "test@example.com"
git -C "$sandbox/demo" config user.name "test"
printf 'ok\n' >"$sandbox/demo/README"
git -C "$sandbox/demo" add README
git -C "$sandbox/demo" commit -q -m init
tip="$(git -C "$sandbox/demo" rev-parse HEAD)"
git -C "$sandbox/demo" update-ref refs/remotes/origin/master "$tip"
git -C "$sandbox/demo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master

git -C "$sandbox/demo" worktree add -q -b task/clean "$sandbox/.worktrees/demo/task-clean" >/dev/null
# Delivery: branch tip is ancestor of origin/HEAD (same commit here).
git -C "$sandbox/demo" update-ref refs/remotes/origin/master \
  "$(git -C "$sandbox/.worktrees/demo/task-clean" rev-parse HEAD)"
git -C "$sandbox/demo" update-ref refs/remotes/origin/HEAD \
  "$(git -C "$sandbox/.worktrees/demo/task-clean" rev-parse HEAD)"

git -C "$sandbox/demo" worktree add -q -b task/dirty "$sandbox/.worktrees/demo/task-dirty" >/dev/null
printf 'dirty\n' >"$sandbox/.worktrees/demo/task-dirty/EXTRA"

main_root="$(cd "$sandbox/demo" && pwd -P)"
clean_root="$(cd "$sandbox/.worktrees/demo/task-clean" && pwd -P)"
dirty_root="$(cd "$sandbox/.worktrees/demo/task-dirty" && pwd -P)"

# Refuse primary.
out="$("$helper" "sess" "$main_root" "@1" "$main_root" || true)"
status="${out%%$'\t'*}"
detail="${out#*$'\t'}"
assert_eq "primary status" "$status" "REFUSE"
assert_ok "primary mentions primary" grep -qi 'primary' <<<"$detail"

# Refuse dirty.
out="$("$helper" "sess" "$dirty_root" "@1" "$main_root" || true)"
status="${out%%$'\t'*}"
detail="${out#*$'\t'}"
assert_eq "dirty status" "$status" "REFUSE"
assert_ok "dirty mentions uncommitted" grep -qi 'uncommitted' <<<"$detail"

# OK path: clean + delivered under managed .worktrees layout.
out="$("$helper" "sess" "$clean_root" "@1" "$main_root" || true)"
status="${out%%$'\t'*}"
detail="${out#*$'\t'}"
assert_eq "clean delivered status" "$status" "OK"
assert_eq "clean delivered slug" "$detail" "task-clean"
assert_ok "clean tree removed" test ! -d "$clean_root"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
if (( fail > 0 )); then
  exit 1
fi
exit 0
