#!/usr/bin/env bash
# Offline unit test for attention rev / journal / desensitized snapshots.
# Does not need a WezTerm pane (unlike test-agent-attention.sh).

set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export WEZTERM_ATTENTION_JOURNAL_FILE="$tmp/attention-transitions.jsonl"
export WEZTERM_ATTENTION_SNAPSHOTS_DIR="$tmp/snapshots"
export WEZTERM_ATTENTION_SNAPSHOT=always
# Point state at a local file (bypass windows path detection via override).
# attention_state_path caches; force via monkey by setting the cache after source.
# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/attention-state-lib.sh"

__ATTENTION_STATE_PATH_CACHED="$tmp/attention.json"
mkdir -p "$tmp/snapshots"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

# --- write 1: empty → one running ---
export AGENT_ATTENTION_AUDIT_OP=upsert
export AGENT_ATTENTION_AUDIT_SESSION_ID=sess-a
export AGENT_ATTENTION_AUDIT_PREV_STATUS=""
export AGENT_ATTENTION_AUDIT_STATUS=running
export AGENT_ATTENTION_AUDIT_OP_DETAIL=""
export AGENT_ATTENTION_AUDIT_FOCUS_SKIPPED=0
export AGENT_ATTENTION_PROVIDER=test
export AGENT_ATTENTION_RAW_EVENT=UserPromptSubmit

payload1='{"version":1,"entries":{"sess-a":{"session_id":"sess-a","status":"running","ts":1,"last_user_prompt":"SECRET_PROMPT","reason":"hello world"}},"recent":[]}'
attention_state_write "$payload1" || fail "write1"

rev1="$(jq -r '.rev' "$tmp/attention.json")"
[[ "$rev1" == "1" ]] || fail "rev1=$rev1 want 1"
pass "rev bumped to 1"

[[ -f "$WEZTERM_ATTENTION_JOURNAL_FILE" ]] || fail "journal missing"
lines1="$(wc -l < "$WEZTERM_ATTENTION_JOURNAL_FILE" | tr -d ' ')"
[[ "$lines1" == "1" ]] || fail "journal lines=$lines1 want 1"
j1="$(tail -n1 "$WEZTERM_ATTENTION_JOURNAL_FILE")"
echo "$j1" | jq -e '.rev==1 and .status=="running" and .counts.running==1' >/dev/null \
  || fail "journal row1 bad: $j1"
echo "$j1" | jq -e 'has("last_user_prompt")|not' >/dev/null || fail "journal leaked prompt"
pass "journal row1"

# snapshot desensitized
snap="$(ls "$tmp/snapshots"/*.json | head -1)"
[[ -n "$snap" ]] || fail "no snapshot"
jq -e '.entries["sess-a"].last_user_prompt|not' "$snap" >/dev/null \
  || fail "snapshot kept last_user_prompt"
grep -q SECRET_PROMPT "$snap" && fail "SECRET_PROMPT in snapshot" || true
pass "snapshot desensitized"

# --- write 2: waiting ---
export AGENT_ATTENTION_AUDIT_PREV_STATUS=running
export AGENT_ATTENTION_AUDIT_STATUS=waiting
payload2="$(jq -c '
  .entries["sess-a"].status="waiting"
  | .entries["sess-a"].reason="needs permission"
  | .entries["sess-a"].last_user_prompt="SECRET2"
' "$tmp/attention.json")"
# strip rev so write bumps from current on-disk... write bumps whatever is in payload.
# Payload from jq still has rev=1; write will make rev=2.
attention_state_write "$payload2" || fail "write2"
rev2="$(jq -r '.rev' "$tmp/attention.json")"
[[ "$rev2" == "2" ]] || fail "rev2=$rev2 want 2"
j2="$(tail -n1 "$WEZTERM_ATTENTION_JOURNAL_FILE")"
echo "$j2" | jq -e '.rev==2 and .prev_status=="running" and .status=="waiting" and .counts.waiting==1 and .counts.running==0' >/dev/null \
  || fail "journal row2 bad: $j2"
pass "running→waiting journal"

# --- write 3: add second running + bg ---
export AGENT_ATTENTION_AUDIT_SESSION_ID=sess-b
export AGENT_ATTENTION_AUDIT_PREV_STATUS=""
export AGENT_ATTENTION_AUDIT_STATUS=running
export AGENT_ATTENTION_RUNNING_KIND=background
export AGENT_ATTENTION_AUDIT_OP_DETAIL=bg_defer
payload3="$(jq -c '
  .entries["sess-a"].status="running"
  | .entries["sess-a"].running_kind="background"
  | .entries["sess-b"]={"session_id":"sess-b","status":"running","ts":3}
' "$tmp/attention.json")"
attention_state_write "$payload3" || fail "write3"
rev3="$(jq -r '.rev' "$tmp/attention.json")"
[[ "$rev3" == "3" ]] || fail "rev3=$rev3 want 3"
j3="$(tail -n1 "$WEZTERM_ATTENTION_JOURNAL_FILE")"
echo "$j3" | jq -e '.counts.running==2 and (.roster|length)==2' >/dev/null \
  || fail "journal row3 bad: $j3"
echo "$j3" | jq -e '.roster|index("sess-a:running:background")' >/dev/null \
  || fail "roster missing bg marker: $j3"
pass "bg roster + counts.running==2"

# forensics --paths should see our journal
out="$("$repo_root/scripts/dev/attention-forensics.sh" --paths)"
echo "$out" | grep -q "$WEZTERM_ATTENTION_JOURNAL_FILE" || fail "forensics paths miss journal"
pass "forensics --paths"

# --- refuse-to-clobber: empty-heal payload must not wipe a richer disk ---
# Regression 2026-10-16: attention_state_read returned the empty default
# while DrvFS still held rev≫0; the next write published rev=1 and wiped
# every sibling entry (including bg-running).
rich="$(jq -c '
  .rev = 59835
  | .entries = {
      "sess-a": {"session_id":"sess-a","status":"running","running_kind":"background","ts":1},
      "sess-b": {"session_id":"sess-b","status":"running","ts":2},
      "sess-c": {"session_id":"sess-c","status":"done","ts":3}
    }
' "$tmp/attention.json")"
printf '%s\n' "$rich" > "$tmp/attention.json"
stale_heal='{"version":1,"rev":0,"entries":{"sess-x":{"session_id":"sess-x","status":"running","ts":9}},"recent":[]}'
if attention_state_write "$stale_heal"; then
  fail "stale heal write should have been refused"
fi
after_rev="$(jq -r '.rev' "$tmp/attention.json")"
after_n="$(jq -r '.entries | length' "$tmp/attention.json")"
[[ "$after_rev" == "59835" ]] || fail "disk rev clobbered: $after_rev"
[[ "$after_n" == "3" ]] || fail "disk entries clobbered: $after_n"
jq -e '.entries["sess-a"].running_kind=="background"' "$tmp/attention.json" >/dev/null \
  || fail "bg-running entry lost after refused write"
pass "refuse-to-clobber newer on-disk rev"

# --- true corruption still heals (guard skipped when disk unparseable) ---
printf '{"version":1,"entries":{"sess-X":{"sess' > "$tmp/attention.json"
heal_payload='{"version":1,"rev":0,"entries":{"sess-heal":{"session_id":"sess-heal","status":"running","ts":1}},"recent":[]}'
attention_state_write "$heal_payload" || fail "corrupt heal write"
jq -e '.rev==1 and .entries["sess-heal"].status=="running"' "$tmp/attention.json" >/dev/null \
  || fail "corrupt file did not heal"
pass "unparseable disk still self-heals"

# --- bg_bump forensics fields + AUDIT_SKIP ---
# Reset to a known rev so writes advance cleanly.
printf '%s\n' '{"version":1,"rev":10,"entries":{"bg-a":{"session_id":"bg-a","status":"running","running_kind":"background","ts":1}},"recent":[]}' \
  > "$tmp/attention.json"
: > "$WEZTERM_ATTENTION_JOURNAL_FILE"

export AGENT_ATTENTION_AUDIT_OP=write
export AGENT_ATTENTION_AUDIT_SESSION_ID=bg-a
export AGENT_ATTENTION_AUDIT_PREV_STATUS=running
export AGENT_ATTENTION_AUDIT_STATUS=done
export AGENT_ATTENTION_AUDIT_OP_DETAIL=bg_bump_demote
export AGENT_ATTENTION_AUDIT_TRIGGER_SESSION_ID=trigger-sess
export AGENT_ATTENTION_AUDIT_TOUCHED_SESSION_IDS='["bg-a"]'
export AGENT_ATTENTION_AUDIT_BG_BUMP_ACTIONS='["demote:bg-a"]'
unset AGENT_ATTENTION_AUDIT_SKIP || true
unset AGENT_ATTENTION_RUNNING_KIND || true

payload_demote="$(jq -c '
  .entries["bg-a"].status="done"
  | .entries["bg-a"].done_kind="bg_finished"
  | del(.entries["bg-a"].running_kind)
' "$tmp/attention.json")"
attention_state_write "$payload_demote" || fail "bg_bump demote write"
j_demote="$(tail -n1 "$WEZTERM_ATTENTION_JOURNAL_FILE")"
echo "$j_demote" | jq -e '
  .op_detail=="bg_bump_demote"
  and .trigger_session_id=="trigger-sess"
  and (.touched_session_ids|index("bg-a"))
  and (.bg_bump_actions|index("demote:bg-a"))
  and .status=="done"
' >/dev/null || fail "bg_bump demote journal missing fields: $j_demote"
pass "bg_bump demote journal fields"

# Keep-only path: AUDIT_SKIP=1 must not append a journal row.
lines_before="$(wc -l < "$WEZTERM_ATTENTION_JOURNAL_FILE" | tr -d ' ')"
export AGENT_ATTENTION_AUDIT_SKIP=1
export AGENT_ATTENTION_AUDIT_OP_DETAIL=bg_bump_keep
payload_keep="$(jq -c '.entries["bg-a"].ts=99' "$tmp/attention.json")"
attention_state_write "$payload_keep" || fail "bg_bump keep write"
lines_after="$(wc -l < "$WEZTERM_ATTENTION_JOURNAL_FILE" | tr -d ' ')"
[[ "$lines_after" == "$lines_before" ]] || fail "AUDIT_SKIP still journaled ($lines_before → $lines_after)"
jq -e '.rev==12 and .entries["bg-a"].ts==99' "$tmp/attention.json" >/dev/null \
  || fail "keep write did not advance state under AUDIT_SKIP"
unset AGENT_ATTENTION_AUDIT_SKIP || true
pass "AUDIT_SKIP skips journal but writes state"

echo "ALL PASSED"
