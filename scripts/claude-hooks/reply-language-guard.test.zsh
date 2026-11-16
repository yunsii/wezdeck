#!/bin/zsh
# Tests for reply-language-guard.py
# Run: zsh scripts/claude-hooks/reply-language-guard.test.zsh

set -u
script_dir="${0:A:h}"
hook="${script_dir}/reply-language-guard.py"
fail() { print -u2 -- "FAIL: $1"; exit 1 }
assert_equal() { [[ "$2" == "$1" ]] || fail "$3 (expected=$1 actual=$2)" }

[[ -x $hook ]] || chmod +x "$hook"
[[ -x $hook ]] || fail "missing executable $hook"

work=$(mktemp -d "${TMPDIR:-/tmp}/reply-language-guard-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
export REPLY_LANGUAGE_GUARD_STATE="$work/state"
export REPLY_LANGUAGE_GUARD_LANG="简体中文"
unset REPLY_LANGUAGE_GUARD_MODE
export REPLY_LANGUAGE_GUARD=1

run() {
  local msg=$1 active=${2:-false}
  local payload out rc
  payload=$(jq -nc --arg m "$msg" --argjson a "$active" \
    '{hook_event_name:"Stop",session_id:"s-test",last_assistant_message:$m,stop_hook_active:$a}')
  out=$(print -rn -- "$payload" | "$hook"); rc=$?
  assert_equal 0 $rc "hook exit code"
  print -rn -- "$out"
}
blocks() { [[ "$(run "$@" | jq -r '.decision' 2>/dev/null)" == block ]] }

english='All four automations are now fixed, and the projects page has buttons to deal with runs that need review. The one part still pending is a review of the new page code.'
chinese_terms='复审已通过：api 仓 NO_FINDINGS，web 仓 PASS。toast 改动晚于复审，web 仓的 evidence 指纹变了，要补一轮 review。'
chinese_code='已改好，跑了下面的命令：
```bash
python3 -m unittest discover -s ./tests --verbose and some long english output here
```
改动在 `app/automations.py` 和 ~/work/demo-app/web/index.html，见 https://example.com/some/long/english/path。'

blocks "$english" || fail "English reply must block under 简体中文"
sysmsg=$(jq -nc --arg m "$english" '{last_assistant_message:$m,session_id:"s-sys"}' | "$hook" | jq -r .systemMessage)
[[ $sysmsg == *习惯语言* ]] || fail "systemMessage must mention 习惯语言"
reason=$(jq -nc --arg m "$english" '{last_assistant_message:$m,session_id:"s-reason"}' | "$hook" | jq -r .reason)
[[ $reason == *习惯语言* ]] || fail "block reason must mention 习惯语言"

# own-block retry: marker must still be present (do this before any allow that clears it)
jq -nc --arg m "$english" '{last_assistant_message:$m,session_id:"s-retry"}' | "$hook" >/dev/null
assert_equal '' "$(jq -nc --arg m "$english" '{last_assistant_message:$m,session_id:"s-retry",stop_hook_active:true}' | "$hook")" \
  "stop_hook_active after our block allows"

assert_equal '' "$(run "$chinese_terms")" "Chinese with English terms allows"
assert_equal '' "$(run "$chinese_code")" "Chinese with code allows"
assert_equal '' "$(run 'OK, done. Tests pass.')" "short English allows"

# collect mode: would not print block, but logs would_block
export REPLY_LANGUAGE_GUARD_MODE=collect
assert_equal '' "$(jq -nc --arg m "$english" '{last_assistant_message:$m,session_id:"s-collect"}' | "$hook")" "collect mode silent"
unset REPLY_LANGUAGE_GUARD_MODE

# latin preferred → no enforce
export REPLY_LANGUAGE_GUARD_LANG=English
assert_equal '' "$(jq -nc --arg m "$english" '{last_assistant_message:$m,session_id:"s-en"}' | "$hook")" "English preferred does not block"
export REPLY_LANGUAGE_GUARD_LANG="简体中文"

# PostToolUse remind once
transcript="$work/transcript.jsonl"
line() { jq -nc --arg id "$1" --argjson block "$2" '{type:"assistant",message:{id:$id,content:[$block]}}' >> "$transcript" }
text() { line "$1" "$(jq -nc --arg t "$2" '{type:"text",text:$t}')" }
call() { line "$1" "$(jq -nc --arg id "$2" '{type:"tool_use",id:$id,name:"Bash",input:{}}')" }
note() {
  local out rc
  out=$(jq -nc --arg p "$1" '{hook_event_name:"PostToolUse",transcript_path:$p,tool_use_id:"x"}' | "$hook" --event post-tool-use); rc=$?
  assert_equal 0 $rc "post-tool-use exit"
  print -rn -- "$out"
}
text m1 "I am checking the log first, then I will rerun the tests on the new branch."; call m1 t1
[[ "$(note "$transcript" | jq -r .hookSpecificOutput.additionalContext 2>/dev/null)" == *习惯语言* ]] || fail "English note must remind"
assert_equal '' "$(note "$transcript")" "same reply judged once"

# telemetry file exists and report works
[[ -f $REPLY_LANGUAGE_GUARD_STATE/events.ndjson ]] || fail "events.ndjson missing"
"$hook" --report >/dev/null || fail "report failed"

# off switch
out=$(jq -nc --arg m "$english" '{last_assistant_message:$m}' | REPLY_LANGUAGE_GUARD=0 "$hook")
assert_equal '' "$out" "REPLY_LANGUAGE_GUARD=0 disables"

print "reply-language-guard: all tests passed"
