#!/usr/bin/env bash
# open-task-window run outside tmux (the web console's 新开会话 via the relay)
# must put the new window in the repo's workspace session WezTerm already
# shows (wezterm_<ws>_<label>_<hash>), not a detached worktree_task_* one:
# no WezTerm tab shows the latter, so the attention jump (Alt+/ Enter, the
# page's `o`) had nowhere to land. Real tmux on a private TMUX_TMPDIR.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
provider_dir="$repo_root/scripts/runtime/worktree/providers"

command -v tmux >/dev/null 2>&1 || { printf 'SKIP tmux not installed\n'; exit 0; }

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

sandbox="$(mktemp -d -t wezterm-wt-join.XXXXXX)"
client_pid=""
cleanup() {
  [[ -n "$client_pid" ]] && kill "$client_pid" 2>/dev/null
  tmux kill-server 2>/dev/null || true
  rm -rf "$sandbox"
}
trap cleanup EXIT

export TMUX_TMPDIR="$sandbox/tmux"
mkdir -p "$TMUX_TMPDIR" "$sandbox/main" "$sandbox/other"
unset TMUX TMUX_PANE
export WEZTERM_RUNTIME_LOG_FILE="$sandbox/runtime.log"

for dir in main other; do
  git -C "$sandbox/$dir" init -q -b master
  git -C "$sandbox/$dir" -c user.email=t@e -c user.name=t commit -q --allow-empty -m init
done
main_root="$(cd "$sandbox/main" && pwd -P)"
other_root="$(cd "$sandbox/other" && pwd -P)"

# the provider's functions without its verb dispatch
# shellcheck disable=SC1090
source <(sed -e '/^verb="\${1:-}"$/,$d' \
  -e "s|^SCRIPT_DIR=.*|SCRIPT_DIR='$provider_dir'|" "$provider_dir/tmux-agent.sh")

WT_REPO_LABEL="main"
WT_REPO_COMMON_DIR="$(git -C "$main_root" rev-parse --path-format=absolute --git-common-dir)"
hash="$(wt_hash "$WT_REPO_COMMON_DIR")"

# a detached session of the repo family, and the attached workspace one
tmux new-session -d -s "wezterm_work_main_$hash" -c "$main_root" "sleep 600"
tmux new-session -d -s "worktree_task_task_main_$hash" -c "$main_root" "sleep 600"
tmux new-session -d -s "wezterm_work_other_$(wt_hash "$other_root/.git")" -c "$other_root" "sleep 600"

got="$(provider_attached_family_session || printf 'none')"
assert_eq "no client attached: no session to join" "$got" "none"

# a control-mode client stands in for WezTerm's tmux client
mkfifo "$sandbox/client.in"
tmux -C attach -t "wezterm_work_main_$hash" <"$sandbox/client.in" >/dev/null 2>&1 &
client_pid=$!
exec 3>"$sandbox/client.in"
for _ in $(seq 50); do
  [[ "$(tmux display-message -p -t "=wezterm_work_main_$hash:" '#{session_attached}')" != "0" ]] && break
  sleep 0.1
done

got="$(provider_attached_family_session || printf 'none')"
assert_eq "joins the attached workspace session" "$got" "wezterm_work_main_$hash"

WT_REPO_COMMON_DIR="$other_root/.git"
got="$(provider_attached_family_session || printf 'none')"
assert_eq "another repo's attached session is not joined" "$got" "none"
exec 3>&-

printf '%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
