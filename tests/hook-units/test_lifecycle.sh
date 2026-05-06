#!/usr/bin/env bash
# Full-lifecycle coverage for attention state transitions. Sister to
# tests/hook-units/test_focus_skip_upsert.sh (focus-skip path) and
# tests/hook-units/test_pane_scoped_eviction.sh (pane-scoped eviction
# key). This suite exercises every status transition documented in
# docs/agent-attention.md "Hook → status map" against the hook layer
# and the lib helpers, and asserts the recent[] cap / TTL bookkeeping.
#
# Drive: scripts/dev/test-lua-units.sh (or run this file directly).
set -u

guard_sandbox_paths() {
  local p="$1"
  if [[ -z "$p" || "$p" == /mnt/c/* ]]; then
    echo "SAFETY ABORT: sandbox path resolves to live state ($p)" >&2
    exit 99
  fi
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hook="$repo_root/scripts/claude-hooks/emit-agent-status.sh"
lib="$repo_root/scripts/runtime/attention-state-lib.sh"

pass=0
fail=0

# Run the hook with a per-test sandbox. Mocks tmux so the hook reads
# our supplied (socket, session, window, pane) instead of whatever
# host tmux session this test runs inside.
run_hook_in_sandbox() {
  local sandbox="$1" status="$2" notification_type="$3"
  local wezterm_pane="$4" tmux_socket="$5" tmux_session="$6" tmux_pane="$7"
  local tmux_window="${TMUX_WINDOW_OVERRIDE:-@1}"

  guard_sandbox_paths "$sandbox/wezterm-runtime"
  mkdir -p "$sandbox/wezterm-runtime/state/agent-attention" "$sandbox/bin"
  cat > "$sandbox/bin/tmux" <<TMUX_EOF
#!/usr/bin/env bash
case "\${1:-}" in
  display-message)
    fmt=""; want_fmt=0
    for arg in "\$@"; do
      if (( want_fmt == 1 )); then fmt="\$arg"; want_fmt=0
      elif [[ "\$arg" == "-F" ]]; then want_fmt=1
      fi
    done
    out="\$fmt"
    out="\${out//#\\{socket_path\\}/${tmux_socket}}"
    out="\${out//#\\{session_name\\}/${tmux_session}}"
    out="\${out//#\\{window_id\\}/${tmux_window}}"
    out="\${out//#\\{pane_id\\}/${tmux_pane}}"
    out="\${out//#\\{pane_current_path\\}/\$HOME}"
    printf '%s\n' "\$out"
    ;;
  *) exit 0 ;;
esac
TMUX_EOF
  chmod +x "$sandbox/bin/tmux"

  env \
    HOME="$HOME" USER="$USER" SHELL="$SHELL" LANG="${LANG:-C}" \
    PATH="$sandbox/bin:$PATH" \
    TMUX="dummy" \
    WINDOWS_RUNTIME_STATE_WSL="$sandbox/wezterm-runtime" \
    WINDOWS_LOCALAPPDATA_WSL="$sandbox" \
    WINDOWS_USERPROFILE_WSL="$sandbox" \
    WEZTERM_NO_PATH_CACHE=1 \
    WEZTERM_PANE="$wezterm_pane" \
    TMUX_PANE="$tmux_pane" \
    NOTIFICATION_TYPE="$notification_type" \
    bash "$hook" "$status" <<<"${MOCK_HOOK_STDIN:-}" >/dev/null 2>&1 || true
}

# Direct lib invocation — used for transitions the hook layer wraps
# (transition_to_running, prune, evict_session, etc.) so each branch
# can be exercised without first staging full hook env.
run_in_sandbox_lib() {
  local sandbox="$1"; shift
  guard_sandbox_paths "$sandbox/wezterm-runtime"
  mkdir -p "$sandbox/wezterm-runtime/state/agent-attention"
  env \
    HOME="$sandbox" XDG_STATE_HOME="$sandbox/.local/state" \
    WINDOWS_RUNTIME_STATE_WSL="$sandbox/wezterm-runtime" \
    WINDOWS_LOCALAPPDATA_WSL="$sandbox" \
    WINDOWS_USERPROFILE_WSL="$sandbox" \
    WEZTERM_NO_PATH_CACHE=1 \
    bash -c '. "$1"; shift; "$@"' _ "$lib" "$@"
}

state_file_in() {
  printf '%s/wezterm-runtime/state/agent-attention/attention.json' "$1"
}

seed_state() {
  local sandbox="$1" payload="$2"
  guard_sandbox_paths "$sandbox/wezterm-runtime"
  mkdir -p "$sandbox/wezterm-runtime/state/agent-attention"
  printf '%s\n' "$payload" \
    > "$sandbox/wezterm-runtime/state/agent-attention/attention.json"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  ✓ $label"; pass=$((pass+1))
  else
    echo "  ✗ $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail=$((fail+1))
  fi
}

# Read a single field from entries[<sid>]. Returns "" when missing.
field_for() {
  local sandbox="$1" sid="$2" field="$3"
  jq -r --arg s "$sid" --arg f "$field" \
    '.entries[$s][$f] // ""' "$(state_file_in "$sandbox")" 2>/dev/null \
    || printf ''
}

recent_count_for_sid() {
  local sandbox="$1" sid="$2"
  jq --arg s "$sid" '[.recent // [] | .[] | select(.session_id == $s)] | length' \
    "$(state_file_in "$sandbox")" 2>/dev/null || printf 0
}

socket="/tmp/tmux-1000/default"
session="wezterm_test_x_aaaaaaaaaa"

# Seeded entries need a fresh ts so the hook's `attention_state_prune
# 1800000` (30 min TTL) does not archive them out from under the
# transition we are testing.
existing_ts="$(date +%s%3N)"

echo "▸ entries lifecycle: UserPromptSubmit / Stop / Notification"

# Case 1 — UserPromptSubmit on a fresh sandbox creates a running entry.
sandbox="$(mktemp -d)"
MOCK_HOOK_STDIN='{"session_id":"sid-life-1","prompt":"hello world\nsecond line"}' \
  run_hook_in_sandbox "$sandbox" "running" "" "1" "$socket" "$session" "%5"
assert_eq "UserPromptSubmit upserts running" "running" "$(field_for "$sandbox" "sid-life-1" "status")"
assert_eq "reason captures prompt's first line" "hello world" "$(field_for "$sandbox" "sid-life-1" "reason")"
rm -rf "$sandbox"

# Case 2 — Notification permission_prompt → waiting.
sandbox="$(mktemp -d)"
MOCK_HOOK_STDIN='{"session_id":"sid-life-2","message":"needs permission to use Bash"}' \
  run_hook_in_sandbox "$sandbox" "waiting" "permission_prompt" "1" "$socket" "$session" "%5"
assert_eq "permission_prompt → waiting" "waiting" "$(field_for "$sandbox" "sid-life-2" "status")"
rm -rf "$sandbox"

# Case 3 — Notification idle_prompt is ignored (does not flip running → waiting).
# notification_type travels through stdin JSON, not env, so it has to be
# in the MOCK_HOOK_STDIN payload to actually exercise the branch.
sandbox="$(mktemp -d)"
MOCK_HOOK_STDIN='{"session_id":"sid-life-3","prompt":"first"}' \
  run_hook_in_sandbox "$sandbox" "running" "" "1" "$socket" "$session" "%5"
MOCK_HOOK_STDIN='{"session_id":"sid-life-3","notification_type":"idle_prompt"}' \
  run_hook_in_sandbox "$sandbox" "waiting" "idle_prompt" "1" "$socket" "$session" "%5"
assert_eq "idle_prompt does not touch state" "running" "$(field_for "$sandbox" "sid-life-3" "status")"
rm -rf "$sandbox"

# Case 4 — Notification auth_success is ignored.
sandbox="$(mktemp -d)"
MOCK_HOOK_STDIN='{"session_id":"sid-life-4","prompt":"first"}' \
  run_hook_in_sandbox "$sandbox" "running" "" "1" "$socket" "$session" "%5"
MOCK_HOOK_STDIN='{"session_id":"sid-life-4","notification_type":"auth_success"}' \
  run_hook_in_sandbox "$sandbox" "waiting" "auth_success" "1" "$socket" "$session" "%5"
assert_eq "auth_success does not touch state" "running" "$(field_for "$sandbox" "sid-life-4" "status")"
rm -rf "$sandbox"

# Case 5 — Stop → done (user not focused on this pane, so focus-skip
# does not eat the upsert; we drive that by leaving the focus file
# absent so the wezterm-side check fails closed).
sandbox="$(mktemp -d)"
MOCK_HOOK_STDIN='{"session_id":"sid-life-5","prompt":"first"}' \
  run_hook_in_sandbox "$sandbox" "running" "" "9" "$socket" "$session" "%5"
MOCK_HOOK_STDIN='{"session_id":"sid-life-5","stop_reason":"finished"}' \
  run_hook_in_sandbox "$sandbox" "done" "" "9" "$socket" "$session" "%5"
assert_eq "Stop flips running → done" "done" "$(field_for "$sandbox" "sid-life-5" "status")"
assert_eq "Stop's reason is captured" "finished" "$(field_for "$sandbox" "sid-life-5" "reason")"
rm -rf "$sandbox"

echo
echo "▸ resolved transitions (PreToolUse / PostToolUse)"

# Case 6 — waiting → running via resolved (PostToolUse after permission).
sandbox="$(mktemp -d)"
seed_state "$sandbox" '{
  "version":1,
  "entries":{
    "sid-life-6":{"session_id":"sid-life-6","wezterm_pane_id":"1","tmux_socket":"'"$socket"'","tmux_session":"'"$session"'","tmux_window":"@1","tmux_pane":"%5","status":"waiting","reason":"perm","ts":'"$(date +%s%3N)"'}
  },
  "recent":[]
}'
MOCK_HOOK_STDIN='{"session_id":"sid-life-6"}' \
  run_hook_in_sandbox "$sandbox" "resolved" "" "1" "$socket" "$session" "%5"
assert_eq "resolved flips waiting → running" "running" "$(field_for "$sandbox" "sid-life-6" "status")"
assert_eq "resolved clears the stale reason" "" "$(field_for "$sandbox" "sid-life-6" "reason")"
rm -rf "$sandbox"

# Case 7 — done → running via resolved (Monitor wake-up).
sandbox="$(mktemp -d)"
seed_state "$sandbox" '{
  "version":1,
  "entries":{
    "sid-life-7":{"session_id":"sid-life-7","wezterm_pane_id":"1","tmux_socket":"'"$socket"'","tmux_session":"'"$session"'","tmux_window":"@1","tmux_pane":"%5","status":"done","reason":"task done","ts":'"$(date +%s%3N)"'}
  },
  "recent":[]
}'
MOCK_HOOK_STDIN='{"session_id":"sid-life-7"}' \
  run_hook_in_sandbox "$sandbox" "resolved" "" "1" "$socket" "$session" "%5"
assert_eq "resolved flips done → running (Monitor wake-up)" "running" "$(field_for "$sandbox" "sid-life-7" "status")"
rm -rf "$sandbox"

# Case 8 — missing entry: resolved upserts a fresh running.
sandbox="$(mktemp -d)"
MOCK_HOOK_STDIN='{"session_id":"sid-life-8"}' \
  run_hook_in_sandbox "$sandbox" "resolved" "" "1" "$socket" "$session" "%5"
assert_eq "resolved on missing entry upserts running" "running" "$(field_for "$sandbox" "sid-life-8" "status")"
rm -rf "$sandbox"

# Case 9 — running entry: resolved is a no-op (does not bump ts/reason).
sandbox="$(mktemp -d)"
seed_state "$sandbox" '{
  "version":1,
  "entries":{
    "sid-life-9":{"session_id":"sid-life-9","wezterm_pane_id":"1","tmux_socket":"'"$socket"'","tmux_session":"'"$session"'","tmux_window":"@1","tmux_pane":"%5","status":"running","reason":"existing","ts":'"$existing_ts"'}
  },
  "recent":[]
}'
MOCK_HOOK_STDIN='{"session_id":"sid-life-9"}' \
  run_hook_in_sandbox "$sandbox" "resolved" "" "1" "$socket" "$session" "%5"
assert_eq "resolved on running keeps reason intact (no-op)" "existing" "$(field_for "$sandbox" "sid-life-9" "reason")"
assert_eq "resolved on running keeps ts intact (no-op)" "$existing_ts" "$(field_for "$sandbox" "sid-life-9" "ts")"
rm -rf "$sandbox"

echo
echo "▸ waiting is sticky"

# Case 10 — second waiting on an existing waiting must NOT bump ts/reason.
# Earlier code rewrote the entry on every waiting hook so a second
# permission_prompt mid-turn re-set the TTL clock and overwrote the
# original prompt-anchor reason.
sandbox="$(mktemp -d)"
seed_state "$sandbox" '{
  "version":1,
  "entries":{
    "sid-life-10":{"session_id":"sid-life-10","wezterm_pane_id":"1","tmux_socket":"'"$socket"'","tmux_session":"'"$session"'","tmux_window":"@1","tmux_pane":"%5","status":"waiting","reason":"original perm","ts":'"$existing_ts"'}
  },
  "recent":[]
}'
MOCK_HOOK_STDIN='{"session_id":"sid-life-10","message":"second perm","notification_type":"permission_prompt"}' \
  run_hook_in_sandbox "$sandbox" "waiting" "permission_prompt" "1" "$socket" "$session" "%5"
assert_eq "second waiting keeps original reason" "original perm" "$(field_for "$sandbox" "sid-life-10" "reason")"
assert_eq "second waiting keeps original ts" "$existing_ts" "$(field_for "$sandbox" "sid-life-10" "ts")"
rm -rf "$sandbox"

echo
echo "▸ TTL prune"

# Case 11 — entries older than ttl are archived to recent[].
sandbox="$(mktemp -d)"
old_ts=$(( $(date +%s%3N) - 1000000 ))      # > 30 min in the past
fresh_ts=$(( $(date +%s%3N) - 60000 ))      # 1 min ago
seed_state "$sandbox" '{
  "version":1,
  "entries":{
    "sid-stale":{"session_id":"sid-stale","wezterm_pane_id":"1","tmux_socket":"'"$socket"'","tmux_session":"'"$session"'","tmux_window":"@1","tmux_pane":"%5","status":"running","reason":"old","ts":'"$old_ts"'},
    "sid-fresh":{"session_id":"sid-fresh","wezterm_pane_id":"1","tmux_socket":"'"$socket"'","tmux_session":"'"$session"'","tmux_window":"@1","tmux_pane":"%6","status":"running","reason":"new","ts":'"$fresh_ts"'}
  },
  "recent":[]
}'
run_in_sandbox_lib "$sandbox" attention_state_prune 600000
assert_eq "stale entry pruned" "" "$(field_for "$sandbox" "sid-stale" "status")"
assert_eq "fresh entry kept" "running" "$(field_for "$sandbox" "sid-fresh" "status")"
assert_eq "stale archived to recent" "1" "$(recent_count_for_sid "$sandbox" "sid-stale")"
rm -rf "$sandbox"

echo
echo "▸ reachability prune"

# Case 12 — alive map shows pane %5 alive on socket; pane %6 missing →
# entry on %6 is archived, entry on %5 kept.
sandbox="$(mktemp -d)"
fresh_ts=$(( $(date +%s%3N) - 60000 ))
seed_state "$sandbox" '{
  "version":1,
  "entries":{
    "sid-alive":{"session_id":"sid-alive","wezterm_pane_id":"1","tmux_socket":"'"$socket"'","tmux_session":"'"$session"'","tmux_window":"@1","tmux_pane":"%5","status":"running","reason":"alive","ts":'"$fresh_ts"'},
    "sid-dead":{"session_id":"sid-dead","wezterm_pane_id":"1","tmux_socket":"'"$socket"'","tmux_session":"'"$session"'","tmux_window":"@1","tmux_pane":"%6","status":"running","reason":"dead","ts":'"$fresh_ts"'}
  },
  "recent":[]
}'
alive='{"'"$socket"'": ["%5"]}'
run_in_sandbox_lib "$sandbox" attention_state_prune 1800000 "$alive"
assert_eq "alive pane kept" "running" "$(field_for "$sandbox" "sid-alive" "status")"
assert_eq "dead pane archived from entries[]" "" "$(field_for "$sandbox" "sid-dead" "status")"
assert_eq "dead pane lands in recent[]" "1" "$(recent_count_for_sid "$sandbox" "sid-dead")"
rm -rf "$sandbox"

# Case 13 — socket NOT in alive map (e.g. tmux server unreachable):
# entries on it must be kept, not archived. Conservative — we only
# archive on positive evidence of pane death.
sandbox="$(mktemp -d)"
fresh_ts=$(( $(date +%s%3N) - 60000 ))
seed_state "$sandbox" '{
  "version":1,
  "entries":{
    "sid-unknown":{"session_id":"sid-unknown","wezterm_pane_id":"1","tmux_socket":"/tmp/some/other-socket","tmux_session":"'"$session"'","tmux_window":"@1","tmux_pane":"%5","status":"running","reason":"unknown","ts":'"$fresh_ts"'}
  },
  "recent":[]
}'
alive='{"'"$socket"'": ["%5"]}'    # other-socket NOT in map
run_in_sandbox_lib "$sandbox" attention_state_prune 1800000 "$alive"
assert_eq "unknown-socket entry kept (no false-positive archive)" "running" "$(field_for "$sandbox" "sid-unknown" "status")"
rm -rf "$sandbox"

# Case 14 — empty alive map ({}) skips the reachability sweep entirely
# (back-compat: emit-agent-status.sh's hot-path call must not archive
# anything based on reachability, only TTL).
sandbox="$(mktemp -d)"
fresh_ts=$(( $(date +%s%3N) - 60000 ))
seed_state "$sandbox" '{
  "version":1,
  "entries":{
    "sid-keep":{"session_id":"sid-keep","wezterm_pane_id":"1","tmux_socket":"'"$socket"'","tmux_session":"'"$session"'","tmux_window":"@1","tmux_pane":"%5","status":"running","reason":"keep","ts":'"$fresh_ts"'}
  },
  "recent":[]
}'
run_in_sandbox_lib "$sandbox" attention_state_prune 1800000 '{}'
assert_eq "empty alive map: no reachability sweep" "running" "$(field_for "$sandbox" "sid-keep" "status")"
rm -rf "$sandbox"

# Case 15 — entry without tmux coords (non-tmux context): reachability
# sweep must NOT touch it, regardless of alive map content.
sandbox="$(mktemp -d)"
fresh_ts=$(( $(date +%s%3N) - 60000 ))
seed_state "$sandbox" '{
  "version":1,
  "entries":{
    "sid-no-tmux":{"session_id":"sid-no-tmux","wezterm_pane_id":"1","tmux_socket":"","tmux_session":"","tmux_window":"","tmux_pane":"","status":"running","reason":"no tmux","ts":'"$fresh_ts"'}
  },
  "recent":[]
}'
alive='{"'"$socket"'": ["%5"]}'
run_in_sandbox_lib "$sandbox" attention_state_prune 1800000 "$alive"
assert_eq "no-tmux entry kept by reachability sweep" "running" "$(field_for "$sandbox" "sid-no-tmux" "status")"
rm -rf "$sandbox"

echo
echo "▸ recent[] cap and TTL"

# Case 16 — recent[] is capped at ATTENTION_RECENT_CAP=50; pushing a
# 51st archive overwrites the oldest. Use distinct (socket, session,
# pane) tuples per archive so the dedup key doesn't collapse them.
sandbox="$(mktemp -d)"
seed_state "$sandbox" '{"version":1,"entries":{},"recent":[]}'
# Use lib's evict_session helper as the archive driver. Each call
# archives one synthetic entry with a unique tmux_pane.
inject_archive() {
  local sb="$1" sid="$2" sock="$3" sess="$4" pane="$5"
  local now="$6"
  jq --arg s "$sid" --arg sock "$sock" --arg sess "$sess" --arg pane "$pane" --argjson now "$now" \
    '.entries[$s] = {session_id:$s, wezterm_pane_id:"1", tmux_socket:$sock, tmux_session:$sess, tmux_window:"@1", tmux_pane:$pane, status:"running", reason:"r", ts:$now}' \
    "$(state_file_in "$sb")" > "$(state_file_in "$sb").tmp" \
    && mv "$(state_file_in "$sb").tmp" "$(state_file_in "$sb")"
  run_in_sandbox_lib "$sb" attention_state_evict_session "$sock" "$sess" "" "$pane"
}
ts0=$(date +%s%3N)
for i in $(seq 1 55); do
  inject_archive "$sandbox" "sid-cap-$i" "$socket-$i" "session-$i" "%$i" "$((ts0 + i))"
done
recent_total="$(jq '.recent | length' "$(state_file_in "$sandbox")" 2>/dev/null)"
assert_eq "recent[] is capped at 50 after 55 archives" "50" "$recent_total"
# Newest should be present, oldest should be gone.
assert_eq "newest archive (55) survived" "1" "$(recent_count_for_sid "$sandbox" "sid-cap-55")"
assert_eq "oldest archive (1) evicted by cap" "0" "$(recent_count_for_sid "$sandbox" "sid-cap-1")"
rm -rf "$sandbox"

# Case 17 — recent[] entries older than the 7-day TTL are dropped on
# the next archive. We seed an "ancient" recent and trigger any
# archive — the prune inside archive_into_recent's TTL filter wipes
# stale tombstones regardless of whether the new archive collides.
sandbox="$(mktemp -d)"
ancient_ts=$(( $(date +%s%3N) - 7 * 86400 * 1000 - 60000 ))   # > 7 days
seed_state "$sandbox" '{
  "version":1,
  "entries":{
    "sid-trigger":{"session_id":"sid-trigger","wezterm_pane_id":"1","tmux_socket":"'"$socket"'","tmux_session":"'"$session"'","tmux_window":"@1","tmux_pane":"%5","status":"running","reason":"r","ts":'"$(date +%s%3N)"'}
  },
  "recent":[
    {"session_id":"sid-ancient","wezterm_pane_id":"1","tmux_socket":"'"$socket"'","tmux_session":"sess-old","tmux_window":"@1","tmux_pane":"%99","git_branch":"","last_status":"done","last_reason":"old","live_ts":'"$ancient_ts"',"archived_ts":'"$ancient_ts"'}
  ]
}'
run_in_sandbox_lib "$sandbox" attention_state_evict_session "$socket" "$session" "" "%5"
assert_eq "ancient recent (>7d) evicted by TTL on next archive" "0" "$(recent_count_for_sid "$sandbox" "sid-ancient")"
rm -rf "$sandbox"

echo
echo "▸ tmux race guard (regression — hook must skip when pane id is empty)"

# Case 18 — explicit cross-status check that the race guard catches
# every status mutation. test_focus_skip_upsert.sh covers this for
# new sandboxes; here we additionally assert the hook does not stomp
# an *existing* well-formed entry when a transient empty-pane race
# fires for the same session_id.
for skip_status in running waiting done; do
  sandbox="$(mktemp -d)"
  seed_state "$sandbox" '{
    "version":1,
    "entries":{
      "sid-race":{"session_id":"sid-race","wezterm_pane_id":"1","tmux_socket":"'"$socket"'","tmux_session":"'"$session"'","tmux_window":"@1","tmux_pane":"%5","status":"running","reason":"good","ts":'"$existing_ts"'}
    },
    "recent":[]
  }'
  notif=""
  [[ "$skip_status" == "waiting" ]] && notif="permission_prompt"
  MOCK_HOOK_STDIN='{"session_id":"sid-race"}' \
    run_hook_in_sandbox "$sandbox" "$skip_status" "$notif" "1" "$socket" "$session" ""
  assert_eq "race-guard preserves $skip_status entry on empty pane race" "running" "$(field_for "$sandbox" "sid-race" "status")"
  assert_eq "race-guard preserves reason ($skip_status)" "good" "$(field_for "$sandbox" "sid-race" "reason")"
  rm -rf "$sandbox"
done

echo
echo "▸ end-to-end happy path"

# Case 19 — full natural lifecycle: UserPromptSubmit → resolved (no-op
# while running) → Stop → done → next UserPromptSubmit reuses sid →
# running, reason refreshed, no archived double.
sandbox="$(mktemp -d)"
MOCK_HOOK_STDIN='{"session_id":"sid-e2e","prompt":"first turn"}' \
  run_hook_in_sandbox "$sandbox" "running" "" "9" "$socket" "$session" "%5"
MOCK_HOOK_STDIN='{"session_id":"sid-e2e"}' \
  run_hook_in_sandbox "$sandbox" "resolved" "" "9" "$socket" "$session" "%5"
assert_eq "happy path: still running after resolved no-op" "running" "$(field_for "$sandbox" "sid-e2e" "status")"
assert_eq "happy path: reason kept" "first turn" "$(field_for "$sandbox" "sid-e2e" "reason")"
MOCK_HOOK_STDIN='{"session_id":"sid-e2e","stop_reason":"finished"}' \
  run_hook_in_sandbox "$sandbox" "done" "" "9" "$socket" "$session" "%5"
assert_eq "happy path: Stop → done" "done" "$(field_for "$sandbox" "sid-e2e" "status")"
MOCK_HOOK_STDIN='{"session_id":"sid-e2e","prompt":"second turn"}' \
  run_hook_in_sandbox "$sandbox" "running" "" "9" "$socket" "$session" "%5"
assert_eq "happy path: next prompt → running again" "running" "$(field_for "$sandbox" "sid-e2e" "status")"
assert_eq "happy path: reason refreshed" "second turn" "$(field_for "$sandbox" "sid-e2e" "reason")"
assert_eq "happy path: same-sid replacement is not an exit (recent stays empty)" "0" "$(recent_count_for_sid "$sandbox" "sid-e2e")"
rm -rf "$sandbox"

echo
echo "▸ self-healing read (corrupt state file recovers on next write)"

# Case 20 — file truncated to 1 byte (the exact regression from the
# `${2:-{\}}` prune bug + empty-payload write before guards landed).
# attention_state_read MUST parse-check first and fall back to the
# default empty state, so the next jq pipeline gets valid input.
sandbox="$(mktemp -d)"
mkdir -p "$sandbox/wezterm-runtime/state/agent-attention"
printf '\n' > "$sandbox/wezterm-runtime/state/agent-attention/attention.json"
fresh_ts="$(date +%s%3N)"
MOCK_HOOK_STDIN='{"session_id":"sid-heal","prompt":"after corruption"}' \
  run_hook_in_sandbox "$sandbox" "running" "" "1" "$socket" "$session" "%5"
assert_eq "self-healing: hook upserts running on top of corrupt file" "running" "$(field_for "$sandbox" "sid-heal" "status")"
assert_eq "self-healing: state file is valid JSON post-recovery" "0" "$(jq -e . "$(state_file_in "$sandbox")" >/dev/null 2>&1; echo $?)"
rm -rf "$sandbox"

# Case 21 — file containing garbage / partial JSON. Same path as Case
# 20 but with a non-empty unparseable buffer to make sure the parse
# check (not just the empty-string check) is what protects us.
sandbox="$(mktemp -d)"
mkdir -p "$sandbox/wezterm-runtime/state/agent-attention"
printf '{"version":1,"entries":{"sid-X":{"sess' > "$sandbox/wezterm-runtime/state/agent-attention/attention.json"   # truncated mid-object
MOCK_HOOK_STDIN='{"session_id":"sid-heal-2","prompt":"after garbage"}' \
  run_hook_in_sandbox "$sandbox" "running" "" "1" "$socket" "$session" "%5"
assert_eq "self-healing: garbage state file recovers" "running" "$(field_for "$sandbox" "sid-heal-2" "status")"
assert_eq "self-healing: garbage discards the broken half" "" "$(field_for "$sandbox" "sid-X" "status")"
rm -rf "$sandbox"

# Case 22 — direct attention_state_read call on a corrupt file must
# return the default empty state, not the corrupt content.
sandbox="$(mktemp -d)"
mkdir -p "$sandbox/wezterm-runtime/state/agent-attention"
printf '\n' > "$sandbox/wezterm-runtime/state/agent-attention/attention.json"
read_out="$(run_in_sandbox_lib "$sandbox" attention_state_read 2>/dev/null || printf '')"
echo "$read_out" | jq -e '.entries == {} and .recent == []' >/dev/null 2>&1
rc=$?
if (( rc == 0 )); then
  echo "  ✓ direct read on corrupt file returns default empty state"
  pass=$((pass+1))
else
  echo "  ✗ direct read on corrupt file returns default empty state"
  echo "    actual: $read_out"
  fail=$((fail+1))
fi
rm -rf "$sandbox"

echo
if (( fail > 0 )); then
  echo "$pass passed, $fail failed"
  exit 1
fi
echo "$pass passed, $fail failed"
