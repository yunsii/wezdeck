#!/usr/bin/env bash
set -u

guard_sandbox_paths() {
  local p="$1"
  if [[ -z "$p" || "$p" == /mnt/c/* ]]; then
    echo "SAFETY ABORT: sandbox path resolves to live state ($p)" >&2
    exit 99
  fi
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/runtime/tab-activity-sample.sh"
session_script="$repo_root/scripts/runtime/tmux-worktree/print-session-names.sh"

pass=0
fail=0
ok() { pass=$((pass+1)); printf '  \xe2\x9c\x93 %s\n' "$1"; }
no() { fail=$((fail+1)); printf '  \xe2\x9c\x97 %s\n' "$1"; }

sandbox="$(mktemp -d -t wezterm-tab-activity-XXXXXX)"
guard_sandbox_paths "$sandbox/wezterm-runtime"
mkdir -p "$sandbox/wezterm-runtime/state/tab-stats"
workdir="$sandbox/repo"

git init -q "$workdir"
git -C "$workdir" config user.email test@example.com
git -C "$workdir" config user.name Test
printf 'one\n' > "$workdir/file.txt"
git -C "$workdir" add file.txt
git -C "$workdir" commit -q -m initial

session="$(bash "$session_script" work "$workdir" | awk -F '\t' 'NR == 1 { print $2 }')"
snapshot="$sandbox/wezterm-runtime/state/tab-stats/work-items.json"
cat > "$snapshot" <<JSON
{
  "version": 1,
  "workspace": "work",
  "items": [
    { "cwd": "$workdir", "label": "repo", "has_tab": true }
  ]
}
JSON

run_sample() {
  env \
    WINDOWS_RUNTIME_STATE_WSL="$sandbox/wezterm-runtime" \
    WINDOWS_LOCALAPPDATA_WSL="$sandbox" \
    WINDOWS_USERPROFILE_WSL="$sandbox" \
    XDG_STATE_HOME="$sandbox" \
    WEZTERM_NO_PATH_CACHE=1 \
    bash "$script" work
}

printf '\xe2\x96\xb8 %s\n' 'tab activity sampler'

run_sample >/dev/null
score=$(jq -r --arg s "$session" '.sessions[$s].activity_score // "MISS"' "$sandbox/wezterm-runtime/state/tab-stats/work.json")
count=$(jq -r --arg s "$session" '.sessions[$s].activity_count // "MISS"' "$sandbox/wezterm-runtime/state/tab-stats/work.json")
fp=$(jq -r --arg s "$session" '.sessions[$s].last_git_fingerprint // ""' "$sandbox/wezterm-runtime/state/tab-stats/work.json")
[[ "$score" == "0" ]] && ok "first sample writes baseline without score" \
  || no "baseline activity_score expected 0, got $score"
[[ "$count" == "0" ]] && ok "first sample does not increment activity_count" \
  || no "baseline activity_count expected 0, got $count"
[[ -n "$fp" ]] && ok "first sample stores git fingerprint" \
  || no "baseline fingerprint missing"

printf 'two\n' >> "$workdir/file.txt"
run_sample >/dev/null
score=$(jq -r --arg s "$session" '.sessions[$s].activity_score // 0' "$sandbox/wezterm-runtime/state/tab-stats/work.json")
count=$(jq -r --arg s "$session" '.sessions[$s].activity_count // 0' "$sandbox/wezterm-runtime/state/tab-stats/work.json")
score_ok=$(awk -v s="$score" 'BEGIN { print (s >= 19 && s <= 21) ? 1 : 0 }')
[[ "$score_ok" == "1" ]] && ok "worktree diff adds activity score" \
  || no "worktree diff score expected about 20, got $score"
[[ "$count" == "1" ]] && ok "worktree diff increments activity_count" \
  || no "activity_count expected 1, got $count"

git -C "$workdir" add file.txt
run_sample >/dev/null
score=$(jq -r --arg s "$session" '.sessions[$s].activity_score // 0' "$sandbox/wezterm-runtime/state/tab-stats/work.json")
count=$(jq -r --arg s "$session" '.sessions[$s].activity_count // 0' "$sandbox/wezterm-runtime/state/tab-stats/work.json")
score_ok=$(awk -v s="$score" 'BEGIN { print (s >= 79 && s <= 81) ? 1 : 0 }')
[[ "$score_ok" == "1" ]] && ok "index transition adds index + worktree score" \
  || no "index transition score expected about 80, got $score"
[[ "$count" == "2" ]] && ok "index transition increments activity_count" \
  || no "activity_count expected 2, got $count"

git -C "$workdir" commit -q -m update
run_sample >/dev/null
score=$(jq -r --arg s "$session" '.sessions[$s].activity_score // 0' "$sandbox/wezterm-runtime/state/tab-stats/work.json")
count=$(jq -r --arg s "$session" '.sessions[$s].activity_count // 0' "$sandbox/wezterm-runtime/state/tab-stats/work.json")
score_ok=$(awk -v s="$score" 'BEGIN { print (s >= 219 && s <= 221) ? 1 : 0 }')
[[ "$score_ok" == "1" ]] && ok "commit adds head + index transition score" \
  || no "commit score expected about 220, got $score"
[[ "$count" == "3" ]] && ok "commit increments activity_count" \
  || no "activity_count expected 3, got $count"

printf 'tab-activity sampler suite: %d passed, %d failed\n' "$pass" "$fail"
exit "$fail"
