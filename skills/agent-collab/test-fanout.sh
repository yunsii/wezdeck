#!/usr/bin/env bash
# test-fanout.sh — offline checks for `ticket collab` (parent/child scheduler).
# No LLM: children run through TICKET_COLLAB_RUN_CMD (a fake that sleeps and
# sets the ticket status); integration uses real git repos in a temp dir.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
run="$here/run.sh"
pass=0
fail=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }

echo "ticket collab test (offline)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ticket-collab-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
export TICKETS_ROOT="$tmp/tickets" TICKET_RUNTIME_LOG=0 TICKET_COLLAB_TICK=0.2
export TICKET_MEMINFO_PATH="$tmp/meminfo"
printf 'MemAvailable:   16000000 kB\n' >"$TICKET_MEMINFO_PATH"

mkrepo() {  # bare origin + clone with origin/HEAD
  git init -q --bare -b main "$tmp/$1.git"
  git clone -q "$tmp/$1.git" "$tmp/$1" 2>/dev/null
  git -C "$tmp/$1" -c user.email=t@e -c user.name=t commit -q --allow-empty -m init
  mkdir -p "$tmp/$1/src"; printf 'base\n' >"$tmp/$1/src/shared.txt"
  git -C "$tmp/$1" add . && git -C "$tmp/$1" -c user.email=t@e -c user.name=t commit -qm base
  git -C "$tmp/$1" push -q origin main && git -C "$tmp/$1" remote set-head origin main >/dev/null
}
mkrepo rx; mkrepo ry; mkrepo src
"$run" init >/dev/null 2>&1
printf 'targets:\n  rx:\n    path: %s\n  ry:\n    path: %s\n  src:\n    path: %s\n' "$tmp/rx" "$tmp/ry" "$tmp/src" \
  >"$TICKETS_ROOT/config.yml"

# fake child runner: behavior file decides the outcome
beh="$tmp/beh"; mkdir -p "$beh"; log="$tmp/runs.log"; : >"$log"
cat >"$tmp/fake-run.sh" <<EOF
#!/usr/bin/env bash
id=\$1
echo "start \$id \$(date +%s.%N)" >>"$log"
sleep "\${FAKE_SLEEP:-1}"
b="\$(cat "$beh/\$id" 2>/dev/null || echo ship)"
rc=0
case "\$b" in
  ship) "$run" set-status --id "\$id" --status shipped --owner initiator >/dev/null ;;
  human) "$run" set-status --id "\$id" --status waiting_initiator --owner human >/dev/null ;;
  fail-once)
    if [[ -f "$beh/\$id.tried" ]]; then "$run" set-status --id "\$id" --status shipped --owner initiator >/dev/null
    else touch "$beh/\$id.tried"; rc=1; fi ;;
esac
echo "end \$id \$(date +%s.%N)" >>"$log"
exit \$rc
EOF
chmod +x "$tmp/fake-run.sh"
export TICKET_COLLAB_RUN_CMD="$tmp/fake-run.sh"

printf '# Contract\n\n- rx: add a/ and b/ modules\n- ry: consume a/\n' >"$tmp/contract.md"
c() { "$run" fanout "$@"; }
P="$(c plan --from src --title "collab parent" --contract "$tmp/contract.md" | jq -r .id)"
check "plan creates a parent with contract" test -f "$TICKETS_ROOT/_data/$P/contract.md"
A="$(c add --parent "$P" --to rx --title A --scope 'src/a/**' | jq -r .id)"
B="$(c add --parent "$P" --to rx --title B --scope 'src/b/**' | jq -r .id)"
C="$(c add --parent "$P" --to rx --title C --scope 'src/**' | jq -r .id)"
D="$(c add --parent "$P" --to ry --title D --depends-on "$A" | jq -r .id)"
E="$(c add --parent "$P" --to ry --title E --scope 'docs/**' | jq -r .id)"
echo fail-once >"$beh/$E"
check "add rejects deps outside the parent" bash -c "! '$run' collab add --parent '$P' --to rx --title X --depends-on req-nope >/dev/null"
view="$(python3 "$here/lib/ticket_fs.py" phase-view "$A" research)"
check "child phase view embeds parent contract + scope" bash -c "grep -q 'Parent contract' <<<'$view' && grep -q 'src/a/\*\*' <<<'$view' && grep -q 'consume a/' <<<'$view'"

res="$(timeout 120 "$run" fanout run --parent "$P" --mock --max-parallel 3)"
check "scheduler finishes; no branches → done_unmerged, verify skipped (not pass)" \
  jq -e '.ok and .result=="done_unmerged" and .integration.verify.verdict=="skipped" and (.done|length==5)' <<<"$res"
check "parent ticket status shipped" test "$(awk -F': ' '/^status:/{print $2}' "$TICKETS_ROOT/_data/$P/ticket.md")" = shipped

python3 - "$log" "$A" "$B" "$C" "$D" "$E" >"$tmp/intervals.json" <<'PY'
import json, sys
log, A, B, C, D, E = sys.argv[1:]
iv = {}
for ln in open(log):
    kind, tid, ts = ln.split()
    iv.setdefault(tid, []).append((kind, float(ts)))
spans = {t: [(s[1], e[1]) for s, e in zip(v[0::2], v[1::2])] for t, v in iv.items()}
def overlap(x, y):
    return any(a0 < b1 and b0 < a1 for a0, a1 in spans[x] for b0, b1 in spans[y])
pts = sorted([(s, 1) for v in spans.values() for s, _ in v] + [(e, -1) for v in spans.values() for _, e in v])
cur = peak = 0
for _, d in pts:
    cur += d; peak = max(peak, cur)
rx = [A, B, C]
cur = peak_rx = 0
for _, d in sorted([(s, 1) for t in rx for s, _ in spans[t]] + [(e, -1) for t in rx for _, e in spans[t]]):
    cur += d; peak_rx = max(peak_rx, cur)
print(json.dumps({
  "peak": peak, "peak_rx": peak_rx,
  "a_b_parallel": overlap(A, B),
  "c_alone": not overlap(C, A) and not overlap(C, B),
  "d_after_a": min(s for s, _ in spans[D]) >= max(e for _, e in spans[A]),
  "e_runs": len(spans[E]),
}))
PY
iv="$(cat "$tmp/intervals.json")"
check "global cap respected (peak ≤ 3)" jq -e '.peak <= 3' <<<"$iv"
check "per-repo cap respected (rx peak ≤ 2)" jq -e '.peak_rx <= 2' <<<"$iv"
check "disjoint scopes run in parallel (A ∥ B)" jq -e '.a_b_parallel' <<<"$iv"
check "overlapping scope serialized (C never with A/B)" jq -e '.c_alone' <<<"$iv"
check "dependency order (D starts after A ends)" jq -e '.d_after_a' <<<"$iv"
check "failed child retried once then shipped (E ran twice)" jq -e '.e_runs == 2' <<<"$iv"
ev="$TICKETS_ROOT/_data/$P/events.jsonl"
check "queued events carry gate reasons (deps, path_overlap)" \
  jq -e -s '[.[]|select(.kind=="queued")|.gate] | (index("deps")!=null) and (index("path_overlap")!=null)' "$ev"
check "dispatched events carry slot + queue wait" \
  jq -e -s '[.[]|select(.kind=="dispatched")] | length>=6 and all(has("slot") and has("queue_wait_ms"))' "$ev"
check "retry + child_exit + scheduler_end observable" \
  jq -e -s 'map(.kind) | (index("retry")!=null) and (index("child_exit")!=null) and (index("scheduler_end")!=null)' "$ev"
st="$(c status --parent "$P")"
check "status lists children with deps/scope" jq -e --arg d "$D" '.ok and (.children|length==5) and (.children[]|select(.id==$d)|.depends_on|length==1)' <<<"$st"
check "api list --parent filters children" jq -e '.total==5' <<<"$("$run" api list --parent "$P")"
shw="$("$run" api show --id "$P")"
check "api show: children_detail + collab block, schema-valid" \
  bash -c "jq -e '(.children_detail|length==5) and .collab.kind==\"parent\"' <<<'$shw' >/dev/null && python3 '$here/lib/validate_api.py' show <<<'$shw'"

# memory gate: low MemAvailable holds dispatch until it recovers
P2="$(c plan --from src --title "mem gate" --contract "$tmp/contract.md" | jq -r .id)"
M="$(c add --parent "$P2" --to rx --title M | jq -r .id)"
printf 'MemAvailable:   1000000 kB\n' >"$TICKET_MEMINFO_PATH"
( timeout 60 "$run" fanout run --parent "$P2" --mock >"$tmp/mem.json" ) & mpid=$!
sleep 2
check "mem gate queues while MemAvailable is low" \
  jq -e -s --arg m "$M" '[.[]|select(.kind=="queued" and .child==$m)|.gate]|index("mem")!=null' "$TICKETS_ROOT/_data/$P2/events.jsonl"
check "nothing dispatched under mem gate" bash -c "! grep -q 'start $M' '$log'"
printf 'MemAvailable:   16000000 kB\n' >"$TICKET_MEMINFO_PATH"
wait "$mpid"
check "dispatch resumes after memory recovers" jq -e '.ok and .result=="done_unmerged"' "$tmp/mem.json"

# human gate: a challenged child blocks its dependents; parent waits on a human
P3="$(c plan --from src --title "human gate" --contract "$tmp/contract.md" | jq -r .id)"
H="$(c add --parent "$P3" --to rx --title H | jq -r .id)"
H2="$(c add --parent "$P3" --to ry --title H2 --depends-on "$H" | jq -r .id)"
echo human >"$beh/$H"
r3="$(timeout 60 "$run" fanout run --parent "$P3" --mock)"
check "challenged child → parent waiting_human, dependent blocked" \
  jq -e --arg h "$H" --arg h2 "$H2" '.result=="waiting_human" and (.waiting_human|index($h)!=null) and (.blocked|index($h2)!=null)' <<<"$r3"
check "blocked gate recorded" jq -e -s --arg h2 "$H2" '[.[]|select(.kind=="queued" and .child==$h2)|.gate]|index("blocked")!=null' "$TICKETS_ROOT/_data/$P3/events.jsonl"

# integration: real branches merge into ticket/<parent>-integration
P4="$(c plan --from src --title "integrate" --contract "$tmp/contract.md" | jq -r .id)"
I1="$(c add --parent "$P4" --to rx --title I1 --scope 'src/a/**' | jq -r .id)"
I2="$(c add --parent "$P4" --to rx --title I2 --scope 'src/b/**' | jq -r .id)"
mkbranch() {  # repo child path content
  git -C "$tmp/$1" checkout -q -b "ticket/$2" origin/main
  mkdir -p "$(dirname "$tmp/$1/$3")"; printf '%s\n' "$4" >"$tmp/$1/$3"
  git -C "$tmp/$1" add . && git -C "$tmp/$1" -c user.email=t@e -c user.name=t commit -qm "$2"
  git -C "$tmp/$1" checkout -q main
  python3 - "$TICKETS_ROOT/_data/$2/meta.json" "ticket/$2" <<'PY'
import json, sys
p, b = sys.argv[1:]; m = json.load(open(p)); m["branch"] = b; json.dump(m, open(p, "w"))
PY
}
mkbranch rx "$I1" src/a/x.txt a
# I2: uncommitted edit in its own worktree (how implement workers leave it) → snapshot commit
git -C "$tmp/rx" worktree add -q -b "ticket/$I2" "$tmp/wt-$I2" origin/main
mkdir -p "$tmp/wt-$I2/src/b" "$tmp/wt-$I2/.ticket"; printf 'b\n' >"$tmp/wt-$I2/src/b/y.txt"; printf 'scratch\n' >"$tmp/wt-$I2/.ticket/ticket.md"
mkdir -p "$tmp/wt-$I2/src/b/__pycache__"; printf 'x' >"$tmp/wt-$I2/src/b/__pycache__/y.cpython-312.pyc"
printf '__pycache__/\n' >"$tmp/wt-$I2/.gitignore"  # the repo's own rule decides what is generated
python3 - "$TICKETS_ROOT/_data/$I2/meta.json" "$tmp/wt-$I2" <<'PY'
import json, sys
p, w = sys.argv[1:]; m = json.load(open(p)); m["worktree"] = w; json.dump(m, open(p, "w"))
PY
r4="$(timeout 60 "$run" fanout run --parent "$P4" --mock)"
iwt="$(jq -r '.integration.repos.rx.worktree' <<<"$r4")"
check "integration merges both child branches" \
  bash -c "jq -e '.result==\"done\" and (.integration.repos.rx.merged|length==2)' <<<'$r4' >/dev/null && test -f '$iwt/src/a/x.txt' && test -f '$iwt/src/b/y.txt'"
check "merge events ok" jq -e -s '[.[]|select(.kind=="merge")|.result]|all(.=="ok") and length==2' "$TICKETS_ROOT/_data/$P4/events.jsonl"
check "child work snapshotted onto its branch; repo .gitignore respected, .ticket/ excluded" \
  bash -c "jq -e -s '[.[]|select(.kind==\"snapshot\")]|length==1 and .[0].files==2' '$TICKETS_ROOT/_data/$P4/events.jsonl' >/dev/null && ! git -C '$iwt' ls-files | grep -qE '^.ticket/|__pycache__' && test \"\$(jq -r .branch '$TICKETS_ROOT/_data/$I2/meta.json')\" = 'ticket/$I2'"

P5="$(c plan --from src --title "conflict" --contract "$tmp/contract.md" | jq -r .id)"
K1="$(c add --parent "$P5" --to ry --title K1 | jq -r .id)"
K2="$(c add --parent "$P5" --to ry --title K2 | jq -r .id)"
mkbranch ry "$K1" src/shared.txt one; mkbranch ry "$K2" src/shared.txt two
r5="$(timeout 60 "$run" fanout run --parent "$P5" --mock)"
check "conflict → parent waits on a human, files reported, merge aborted" \
  bash -c "jq -e '.result==\"conflict\" and (.integration.repos.ry.conflict.files|index(\"src/shared.txt\")!=null)' <<<'$r5' >/dev/null && test -z \"\$(git -C '$(jq -r '.integration.repos.ry.worktree' <<<"$r5")' status --porcelain)\""
check "parent phase integration_conflict" grep -q 'phase: integration_conflict' "$TICKETS_ROOT/_data/$P5/ticket.md"
# verify path without --mock: recorded-format stream returns a fail verdict
P6="$(c plan --from src --title "verify" --contract "$tmp/contract.md" | jq -r .id)"
V1="$(c add --parent "$P6" --to rx --title V1 --scope 'src/v/**' | jq -r .id)"
mkbranch rx "$V1" src/v/z.txt v
cat >"$tmp/verify.stream.jsonl" <<'EOF'
{"type":"system","subtype":"init","session_id":"sess-verify","model":"m","claude_code_version":"t","tools":["Read"],"mcp_servers":[],"permissionMode":"plan","cwd":"/x"}
{"type":"assistant","message":{"content":[{"type":"text","text":"进展：对照契约核对完毕"}]}}
{"type":"result","subtype":"success","session_id":"sess-verify","num_turns":2,"total_cost_usd":0.01,"result":"{\"verdict\": \"fail\", \"findings\": [\"src/v/z.txt:1 breaks item 1\"]}","usage":{"input_tokens":3,"cache_read_input_tokens":10,"cache_creation_input_tokens":5,"output_tokens":7}}
EOF
r6="$(HOST_AGENT_INVOKE_MOCK=1 HOST_AGENT_INVOKE_MOCK_STREAM="$tmp/verify.stream.jsonl" timeout 60 "$run" fanout run --parent "$P6")"
check "verify fail → parent verify_failed with findings" \
  jq -e '.result=="verify_failed" and (.integration.verify.findings[0]|test("breaks item 1"))' <<<"$r6"
vl="$(ls "$TICKETS_ROOT/_data/$P6/runs/"*.launch.json | head -1)"
check "verify run: fresh/forced_independent, trigger parent, contract in composition" \
  jq -e '.session.reuse=="fresh" and .session.reason=="forced_independent" and .trigger.source=="parent" and (.composition|map(.kind)|index("contract")!=null) and .invocation.mode=="read"' "$vl"
# research: read-only multi-repo run as a ticket (fe1 flows' check substrate)
printf 'Check rx and ry.\n' >"$tmp/task.md"; printf 'Answer in JSON.\n' >"$tmp/system.md"
cat >"$tmp/research.stream.jsonl" <<'EOF'
{"type":"system","subtype":"init","session_id":"sess-r","model":"m","claude_code_version":"t","tools":["Read"],"mcp_servers":[],"permissionMode":"plan","cwd":"/x"}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git -C rx log -1"}},{"type":"text","text":"进展：两个仓库都看过了"}]}}
{"type":"result","subtype":"success","session_id":"sess-r","num_turns":3,"total_cost_usd":0.02,"result":"结论如下\n```json\n{\"verdict\": \"done\", \"evidence\": [\"rx@abc\"]}\n```","usage":{"input_tokens":5,"cache_read_input_tokens":50,"cache_creation_input_tokens":10,"output_tokens":9}}
EOF
rs="$(HOST_AGENT_INVOKE_MOCK=1 HOST_AGENT_INVOKE_MOCK_STREAM="$tmp/research.stream.jsonl" HOST_AGENT_INVOKE_TRACE="$tmp/research-trace.jsonl" \
  "$run" research --from src --repos rx,yy=ry --title "核对承诺 #12" --prompt-file "$tmp/task.md" --system-file "$tmp/system.md" \
  --allow-tool Read --allow-tool 'Bash(git -C {repo} log:*)' --max-turns 60 --origin '{"system":"fe1-flows","flow":12,"step":3}' \
  --result-file "$tmp/research.json")"
RID="$(jq -r .id <<<"$rs")"
check "research returns parsed result + repo bases" \
  jq -e '.ok and .ok_result and .result.verdict=="done" and (.repos|map(.repo)==["rx","yy"]) and .repos[1].target=="ry" and (.repos[0].head|length==40)' <<<"$rs"
check "research ticket: kind research, shipped, origin kept" \
  bash -c "jq -e '.kind==\"research\" and .origin.flow==12 and .repos==[\"rx\",\"ry\"]' '$TICKETS_ROOT/_data/$RID/meta.json' >/dev/null && grep -q '^status: shipped' '$TICKETS_ROOT/_data/$RID/ticket.md'"
check "research worktrees cleaned up" bash -c "! git -C '$tmp/rx' worktree list | grep -q ticket-research && ! git -C '$tmp/ry' worktree list | grep -q ticket-research"
check "research argv: {repo} rules expanded per repo, read mode, max turns" \
  jq -e -s '.[-1] | .mode=="read" and .run_id!=null' "$tmp/research-trace.jsonl"
rl="$(ls "$TICKETS_ROOT/_data/$RID/runs/"*.launch.json | head -1)"
check "research launch: trigger fe1-flows, system+task parts, allow rules in argv" \
  jq -e '.trigger.source=="fe1-flows" and (.composition|map(.kind)|index("system")!=null and index("task")!=null) and (.invocation.argv|index("Bash(git -C yy log:*)")!=null) and (.invocation.argv|index("--max-turns")!=null) and .session.reason=="research_oneshot"' "$rl"
check "research events: checkout per repo + research_done" \
  jq -e -s 'map(.kind) | (map(select(.=="checkout"))|length==2) and index("research_done")!=null and index("milestone")!=null' "$TICKETS_ROOT/_data/$RID/events.jsonl"
check "api list --kind research" jq -e --arg r "$RID" '.total==1 and .tickets[0].id==$r and .tickets[0].kind=="research"' <<<"$("$run" api list --kind research)"
check "research parse_json picks fenced or bare JSON" python3 -c "
import sys; sys.path.insert(0,'$here/lib'); import research as r
assert r.parse_json('x {\"a\": 1} y')=={'a':1}
assert r.parse_json('\x60\x60\x60json\n{\"b\": [1]}\n\x60\x60\x60')=={'b':[1]}
assert r.parse_json('nothing') is None"
check "verdict parser" python3 -c "
import sys; sys.path.insert(0,'$here/lib'); import fanout as collab
assert collab.parse_verdict('进展：x\n{\"verdict\": \"pass\", \"findings\": []}')['verdict']=='pass'
assert collab.parse_verdict('no json')['verdict']=='fail'
assert collab.parse_verdict('{\"verdict\":\"fail\",\"findings\":[\"a.go:3 breaks item 2\"]}')['findings']==['a.go:3 breaks item 2']"
check "scope overlap rules" python3 -c "
import sys; sys.path.insert(0,'$here/lib'); import fanout as c
assert c.scopes_overlap(['src/**'],['src/a/**']) and not c.scopes_overlap(['src/a/**'],['src/b/**'])
assert c.scopes_overlap([],['x/**']) and not c.scopes_overlap(['src/ab/**'],['src/a/**'])"

echo "---"
printf 'pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
