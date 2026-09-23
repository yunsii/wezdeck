#!/usr/bin/env bash
# Unit tests for tmux-worktree context resolution after reclaim-self:
# focused pane cwd is gone ("PATH (deleted)"), Alt+g must still recover
# the repo family from a live sibling window in the same session.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/tmux-worktree-lib.sh"

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
    printf '  FAIL  %s (command failed)\n' "$name"
  fi
}

sandbox="$(mktemp -d -t wezterm-wt-context.XXXXXX)"
cleanup() {
  # linked may already be force-removed mid-test
  git -C "$sandbox/main" worktree prune >/dev/null 2>&1 || true
  rm -rf "$sandbox"
}
trap cleanup EXIT

mkdir -p "$sandbox/bin" "$sandbox/state" "$sandbox/main" "$sandbox/linked"

# Real git primary + linked worktree so context_for_path is honest.
git -C "$sandbox/main" init -q -b master
git -C "$sandbox/main" config user.email "test@example.com"
git -C "$sandbox/main" config user.name "test"
printf 'ok\n' >"$sandbox/main/README"
git -C "$sandbox/main" add README
git -C "$sandbox/main" commit -q -m init
git -C "$sandbox/main" worktree add -q -b task/demo "$sandbox/linked" >/dev/null

main_root="$(cd "$sandbox/main" && pwd -P)"
linked_root="$(cd "$sandbox/linked" && pwd -P)"
deleted_cwd="$linked_root (deleted)"

# ---------- normalize ----------
got="$(tmux_worktree_normalize_pane_path "$deleted_cwd")"
assert_eq "normalize strips (deleted)" "$got" "$linked_root"
got="$(tmux_worktree_normalize_pane_path "$main_root")"
assert_eq "normalize leaves live path" "$got" "$main_root"

# ---------- mock tmux: only main pane is live; "current" window is zombie ----------
cat >"$sandbox/bin/tmux" <<'TMUX_EOF'
#!/usr/bin/env bash
cmd="${1:-}"
shift || true
case "$cmd" in
  list-panes)
    session_scope=0
    want_t=0
    for arg in "$@"; do
      if (( want_t )); then want_t=0
      elif [[ "$arg" == "-s" ]]; then session_scope=1
      elif [[ "$arg" == "-t" ]]; then want_t=1
      fi
    done
    if (( session_scope )); then
      printf '%s\n' "${MOCK_DELETED_CWD:?}"
      printf '%s\n' "${MOCK_MAIN_ROOT:?}"
    else
      printf '%s\n' "${MOCK_DELETED_CWD:?}"
    fi
    ;;
  *)
    printf 'mock tmux: unsupported %s\n' "$cmd" >&2
    exit 1
    ;;
esac
TMUX_EOF
chmod +x "$sandbox/bin/tmux"
export PATH="$sandbox/bin:$PATH"
export MOCK_DELETED_CWD="$deleted_cwd"
export MOCK_MAIN_ROOT="$main_root"

# Physically remove the linked tree (reclaim-self). Keep the "(deleted)"
# string as the focused cwd; normalize must not resurrect a missing dir.
rm -rf "$linked_root"
git -C "$main_root" worktree prune >/dev/null 2>&1 || true

# Local path/window fail; session peer recovers main.
context="$(tmux_worktree_context_for_context "@zombie" "$deleted_cwd" "sess-demo" || true)"
assert_ok "session fallback returns context" test -n "$context"
IFS=$'\t' read -r got_root got_common got_main got_label got_origin <<< "$context"
assert_eq "session fallback origin" "$got_origin" "session"
assert_eq "session fallback prefers main root" "$got_root" "$main_root"
assert_eq "session fallback main_root field" "$got_main" "$main_root"
assert_ok "session fallback common dir" test -n "$got_common"
assert_ok "session fallback label" test -n "$got_label"

# Without session name, same zombie inputs must fail (no peer scan).
context="$(tmux_worktree_context_for_context "@zombie" "$deleted_cwd" || true)"
assert_eq "no session → empty context" "$context" ""

# current_root helper must NOT peer-scan (would mis-label sibling as current).
got="$(tmux_worktree_current_root_for_context "@zombie" "$deleted_cwd")"
assert_eq "current_root ignores session peers" "$got" ""

# Live cwd still wins over session.
context="$(tmux_worktree_context_for_context "@ok" "$main_root" "sess-demo" || true)"
IFS=$'\t' read -r got_root _ _ _ got_origin <<< "$context"
assert_eq "live cwd origin" "$got_origin" "cwd"
assert_eq "live cwd root" "$got_root" "$main_root"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
if (( fail > 0 )); then
  exit 1
fi
exit 0
