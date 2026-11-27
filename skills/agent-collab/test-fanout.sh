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
  race)  # a session claims it first: the worker loses the claim, the session ships later
    TICKET_SESSION_ID=s-race "$run" claim --id "\$id" --any-cwd >/dev/null
    ( sleep 1; "$run" close --id "\$id" --no-doc "session did it" >/dev/null 2>&1 ) &
    rc=3 ;;
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
# no bash -c '…$view…': the view itself holds quotes and <…> (the propose hint)
if grep -q 'Parent contract' <<<"$view" && grep -q 'src/a/\*\*' <<<"$view" && grep -q 'consume a/' <<<"$view"; then
  ok "child phase view embeds parent contract + scope"
else
  bad "child phase view embeds parent contract + scope"
fi

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

# shared queue: sessions and workers pull from one parent's children
P7="$(c plan --from src --title "shared queue" --contract "$tmp/contract.md" | jq -r .id)"
S1="$(c add --parent "$P7" --to rx --title S1 --scope 'src/s1/**' | jq -r .id)"
(cd "$tmp/rx" && TICKET_SESSION_ID=sess-1 "$run" claim --id "$S1" >/dev/null)
( timeout 60 "$run" fanout run --parent "$P7" --mock >"$tmp/p7.json" ) & p7=$!
sleep 2
check "session-claimed child gated as session (holder recorded), never dispatched" \
  bash -c "jq -e -s --arg s '$S1' '[.[]|select(.kind==\"queued\" and .child==\$s and .gate==\"session\" and .detail==\"sess-1\")]|length==1' '$TICKETS_ROOT/_data/$P7/events.jsonl' >/dev/null && ! grep -q 'start $S1' '$log'"
check "scheduler keeps waiting while the session works" kill -0 "$p7"
S3="$(c add --parent "$P7" --to ry --title S3 | jq -r .id)"
sleep 2
check "child added mid-run joins the queue and is dispatched" \
  bash -c "grep -q 'start $S3' '$log' && jq -e -s --arg s '$S3' '[.[]|select(.kind==\"child_joined\" and .child==\$s)]|length==1' '$TICKETS_ROOT/_data/$P7/events.jsonl' >/dev/null"
(cd "$tmp/rx" && "$run" close --id "$S1" --no-doc "shipped from the session" >/dev/null)
wait "$p7"
check "session-closed child counts as done; parent finishes" jq -e '.ok and .result=="done_unmerged" and (.done|length==2)' "$tmp/p7.json"

# claimability: deps-pending children refuse session claims; inbox shows why
P8="$(c plan --from src --title "claimability" --contract "$tmp/contract.md" | jq -r .id)"
G1="$(c add --parent "$P8" --to rx --title G1 | jq -r .id)"
G2="$(c add --parent "$P8" --to rx --title G2 --depends-on "$G1" | jq -r .id)"
g2c="$(cd "$tmp/rx" && TICKET_SESSION_ID=sess-2 "$run" claim --id "$G2" 2>/dev/null)" || true
check "claim refuses a child whose deps have not shipped" jq -e --arg g "$G1" '.ok==false and .error=="deps pending" and .blocked_by==[$g]' <<<"$g2c"
(cd "$tmp/rx" && TICKET_SESSION_ID=sess-2 "$run" claim --id "$G1" >/dev/null)
ib="$(cd "$tmp/rx" && "$run" inbox --to . 2>/dev/null)"
check "inbox: child shows parent + blocked_by; the claimed one leaves the inbox" \
  jq -e --arg p "$P8" --arg g1 "$G1" --arg g2 "$G2" '(.tickets|map(select(.id==$g2))[0]|.parent==$p and .blocked_by==[$g1]) and (.tickets|map(.id)|index($g1)==null)' <<<"$ib"

# claim race: a worker that loses the claim to a session is not a failed attempt
P9="$(c plan --from src --title "claim race" --contract "$tmp/contract.md" | jq -r .id)"
R="$(c add --parent "$P9" --to rx --title R | jq -r .id)"
echo race >"$beh/$R"
r9="$(timeout 60 "$run" fanout run --parent "$P9" --mock)"
check "lost claim race: no retry, waits for the session, finishes" \
  bash -c "jq -e '.result==\"done_unmerged\"' <<<'$r9' >/dev/null && [ \"\$(grep -c 'start $R' '$log')\" = 1 ] && ! grep -q '\"retry\"' '$TICKETS_ROOT/_data/$P9/events.jsonl'"

# dynamic concurrency: the memory gate (estimate + reservations) limits, not the ceiling
P10="$(c plan --from src --title "mem budget" --contract "$tmp/contract.md" | jq -r .id)"
for n in 1 2 3 4; do c add --parent "$P10" --to "$([ $n -le 2 ] && echo rx || echo ry)" --title "m$n" --scope "src/m$n/**" >/dev/null; done
printf 'MemAvailable:   5120000 kB
' >"$TICKET_MEMINFO_PATH"   # 5000 MB, static: only reservations can hold it
r10="$(FAKE_SLEEP=2 TICKET_RUN_MEM_MB=1000 TICKET_MEM_FLOOR_MB=2400 timeout 60 "$run" fanout run --parent "$P10" --mock --max-parallel 8)"
printf 'MemAvailable:   16000000 kB
' >"$TICKET_MEMINFO_PATH"
# floor 2400, not 2048: a child that already grew (the fake runner's python) shrinks its own reservation,
# which is the point — the margin keeps that from admitting a third here
check "reservations cap parallelism at what memory fits (5000-~2x1000-1000 < 2400 → 2), all finish" \
  jq -e '.result=="done_unmerged" and .peak_parallel==2 and (.done|length==4)' <<<"$r10"
check "mem queue events carry estimate + reservation" \
  jq -e -s '[.[]|select(.kind=="queued" and .gate=="mem")][0]|.est_mb==1000 and .reserved_mb>=1900' "$TICKETS_ROOT/_data/$P10/events.jsonl"
check "scheduler_start records the estimate source" \
  jq -e -s '[.[]|select(.kind=="scheduler_start")][0]|.est_mb==1000 and .est_source=="env" and .cap==8' "$TICKETS_ROOT/_data/$P10/events.jsonl"
check "estimate = p95 of recent real implement runs; default below 3 samples" env -u TICKET_RUN_MEM_MB python3 -c "
import json, os, sys, tempfile; from pathlib import Path
root = Path(tempfile.mkdtemp()); os.environ['TICKETS_ROOT'] = str(root)
sys.path.insert(0, '$here/lib'); import fanout as c
def rec(i, rss, **kw):
    d = root / '_data' / f'req-{i}' / 'runs'; d.mkdir(parents=True, exist_ok=True)
    (d / f'run-{i}.json').write_text(json.dumps({'backend': 'claude', 'phase': 'implement', 'rss_peak_mb': rss, **kw}))
rec(0, 3000); rec(1, 9999, mock=True); rec(2, 9999, phase='research')
assert c.mem_estimate_mb('claude') == {'mb': 1500, 'source': 'default', 'samples': 1}
for i, v in enumerate([2000, 2500, 3500, 4000], 3): rec(i, v)
e = c.mem_estimate_mb('claude'); assert e['source'] == 'measured' and e['samples'] == 5 and e['mb'] == 4000, e
assert c.mem_estimate_mb('codex')['source'] == 'default'
assert c.tree_rss_mb(os.getpid()) > 0"

# draft: a plan agent proposes contract + children; nothing exists until the user approves
mkplan() {  # out-file children-json
  python3 - "$1" "$2" <<'PY'
import json, os, sys
out, kids = sys.argv[1], json.loads(sys.argv[2])
plan = {"contract": "# Contract\n\n- a/ exports f()\n", "children": kids}
if os.environ.get("BRIEF", "1") == "1":
    plan["summary"] = {"problem": "ry 用不了 a 里的 f", "approach": "先在 rx 加 f，再并行接入"}
    plan["status_check"] = [{"item": "f 存在", "status": "missing", "evidence": "src/a/ 无 f"}]
    plan["risks"] = ["需要迁移"]
    for k in kids:
        k.setdefault("effect", "做完后 " + k["title"] + " 可用")
rows = [{"type": "system", "subtype": "init", "session_id": "sess-plan", "model": "m", "claude_code_version": "t",
         "tools": ["Read"], "mcp_servers": [], "permissionMode": "plan", "cwd": "/x"},
        {"type": "result", "subtype": "success", "session_id": "sess-plan", "num_turns": 2, "total_cost_usd": 0.01,
         "result": "plan:\n```json\n" + json.dumps(plan) + "\n```",
         "usage": {"input_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 1}}]
open(out, "w").write("".join(json.dumps(r) + "\n" for r in rows))
PY
}
printf 'Add f() in rx a/ and use it from ry.\n' >"$tmp/goal.md"
mkplan "$tmp/plan.stream.jsonl" '[{"key":"a","to":"rx","title":"add f","observed":"no f","assumed":"f exists","scope":["src/a/**"]},
  {"key":"b","to":"rx","title":"docs","observed":"o","assumed":"a","scope":["src/a/docs/**"]},
  {"key":"c","to":"ry","title":"use f","observed":"o","assumed":"a","depends_on":["a"]}]'
dr="$(HOST_AGENT_INVOKE_MOCK=1 HOST_AGENT_INVOKE_MOCK_STREAM="$tmp/plan.stream.jsonl" "$run" fanout draft --from src --repos rx,ry --title "drafted" --goal-file "$tmp/goal.md")"
DP="$(jq -r .parent <<<"$dr")"
check "draft: parent in plan_review, proposal pending, no children yet" \
  bash -c "jq -e '.ok and .proposal.status==\"pending\" and .proposal.origin==\"draft\" and (.proposal.items|length==3)' <<<'$dr' >/dev/null && grep -q 'phase: plan_review' '$TICKETS_ROOT/_data/$DP/ticket.md' && [ \"\$('$run' fanout status --parent '$DP' | jq '.children|length')\" = 0 ]"
check "draft: overlapping scopes in one repo flagged as a warning" jq -e '.proposal.warnings|length==1 and (.[0]|test("serially"))' <<<"$dr"
check "draft: brief stored (problem/approach, status check, risks, effect per child)" \
  jq -e '.proposal.summary.approach and (.proposal.status_check[0].status=="missing") and .proposal.risks==["需要迁移"] and (.proposal.items|all(.effect))' <<<"$dr"
check "draft: outcome computed, not modelled (3 workers, 2 stages, 2 at once, branch, no push, no money)" \
  jq -e --arg p "$DP" '.proposal.outcome|.workers==3 and .stages==2 and .max_parallel==2 and .pushes==false and .delivery.rx==("ticket/"+$p+"-integration") and (.minutes_each|length==2) and (has("usd")|not) and .est_mb_each>0' <<<"$dr"
check "draft: contract stored on the parent" grep -q 'exports f()' "$TICKETS_ROOT/_data/$DP/contract.md"
check "draft: prompt instructs reading release/migration docs for multi-release constraints" \
  bash -c "grep -rq 'Release and migration constraints' '$TICKETS_ROOT/prompts/'"
check "run refuses while the draft awaits confirmation" bash -c "'$run' fanout run --parent '$DP' --mock | jq -e '.ok==false and (.error|test(\"awaits user confirmation\"))'"
shp="$("$run" api show --id "$DP")"
check "api show exposes the pending draft + contract + brief + outcome (schema-valid) for the web console" \
  bash -c "jq -e '.proposals|length==1 and .[0].id==\"p1\" and .[0].origin==\"draft\" and (.[0].items|length==3) and (.[0].contract|test(\"exports f\")) and .[0].summary.problem and .[0].status_check[0].evidence and .[0].outcome.workers==3 and .[0].items[0].effect' <<<'$shp' >/dev/null && python3 '$here/lib/validate_api.py' show <<<'$shp'"
ap="$("$run" fanout approve --parent "$DP" --proposal p1)"
CA="$(jq -r .created.a <<<"$ap")"; CC="$(jq -r .created.c <<<"$ap")"
check "approve creates children with deps mapped to real ids; parent back to planning" \
  bash -c "jq -e '.ok and (.created|length==3)' <<<'$ap' >/dev/null && jq -e --arg a '$CA' '.depends_on==[\$a]' '$TICKETS_ROOT/_data/$CC/meta.json' >/dev/null && grep -q 'phase: planning' '$TICKETS_ROOT/_data/$DP/ticket.md'"
check "api show: no pending proposals after approve" bash -c "'$run' api show --id '$DP' | jq -e '.proposals==[]'"
check "approved proposal cannot be approved twice" bash -c "'$run' fanout approve --parent '$DP' --proposal p1 | jq -e '.ok==false'"
mkplan "$tmp/bad.stream.jsonl" '[{"key":"x","to":"nope","title":"t","observed":"o","assumed":"a"},{"key":"y","to":"rx","title":"t","observed":"o","assumed":"a","depends_on":["y2"]}]'
bad="$(HOST_AGENT_INVOKE_MOCK=1 HOST_AGENT_INVOKE_MOCK_STREAM="$tmp/bad.stream.jsonl" "$run" fanout draft --from src --repos rx --title "bad" --goal-file "$tmp/goal.md")"
check "invalid draft (unknown target, unknown dep) rejected before review, no parent" \
  jq -e '.ok==false and (.error|test("not in the allowlist")) and (.error|test("unknown depends_on"))' <<<"$bad"
BRIEF=0 mkplan "$tmp/nobrief.stream.jsonl" '[{"key":"n","to":"rx","title":"t","observed":"o","assumed":"a"}]'
nb="$(HOST_AGENT_INVOKE_MOCK=1 HOST_AGENT_INVOKE_MOCK_STREAM="$tmp/nobrief.stream.jsonl" "$run" fanout draft --from src --repos rx --title "nobrief" --goal-file "$tmp/goal.md")"
check "draft without plain-words brief / status check / effect is rejected before review" \
  jq -e '.ok==false and (.error|test("summary.problem")) and (.error|test("status_check missing")) and (.error|test("missing effect"))' <<<"$nb"
mkplan "$tmp/rej.stream.jsonl" '[{"key":"r","to":"rx","title":"t","observed":"o","assumed":"a"}]'
RP="$(HOST_AGENT_INVOKE_MOCK=1 HOST_AGENT_INVOKE_MOCK_STREAM="$tmp/rej.stream.jsonl" "$run" fanout draft --from src --repos rx --title "rej" --goal-file "$tmp/goal.md" | jq -r .parent)"
check "reject: draft rejected, parent plan_rejected, still no children" \
  bash -c "'$run' fanout reject --parent '$RP' --proposal p1 --reason 'split by layer instead' | jq -e '.ok' >/dev/null && grep -q 'phase: plan_rejected' '$TICKETS_ROOT/_data/$RP/ticket.md' && [ \"\$('$run' fanout status --parent '$RP' | jq '.children|length')\" = 0 ]"

# split: a running child proposes a sibling inside its own scope; the user confirms
P11="$(c plan --from src --title "split" --contract "$tmp/contract.md" | jq -r .id)"
SA="$(c add --parent "$P11" --to rx --title SA --scope 'src/sa/**' | jq -r .id)"
check "propose outside the proposer's scope refused" \
  bash -c "'$run' fanout propose --parent '$P11' --by-child '$SA' --title x --effect e --observed o --assumed a --scope 'src/other/**' | jq -e '.ok==false and (.error|test(\"not inside\"))'"
check "propose without --effect refused (the user must read what it gives them)" \
  bash -c "'$run' fanout propose --parent '$P11' --by-child '$SA' --title x --observed o --assumed a --scope 'src/sa/x/**' | jq -e '.ok==false and (.error|test(\"--effect\"))'"
check "propose without scope (whole repo) from a scoped child refused" \
  bash -c "'$run' fanout propose --parent '$P11' --by-child '$SA' --title x --effect e --observed o --assumed a | jq -e '.ok==false'"
pr="$("$run" fanout propose --parent "$P11" --by-child "$SA" --title "sa tests" --effect "sa 有测试" --observed o --assumed a --scope 'src/sa/tests/**' --reason "independent")"
check "propose inside scope → pending split proposal + progress row" \
  bash -c "jq -e '.ok and .proposal.origin==\"split\" and .proposal.by==\"$SA\" and .proposal.items[0].to==\"rx\"' <<<'$pr' >/dev/null && jq -e '.step==\"split_proposed\"' '$TICKETS_ROOT/_data/$P11/progress.json' >/dev/null"
check "phase view tells unsplit children how to propose (never approve)" \
  bash -c "python3 '$here/lib/ticket_fs.py' phase-view '$SA' implement | grep -q 'fanout propose --parent $P11 --by-child $SA'"
r11="$(timeout 60 "$run" fanout run --parent "$P11" --mock)"
check "pending split parks the parent in split_review instead of integrating" \
  bash -c "jq -e '.result==\"awaiting_approval\" and .proposals==[\"p1\"]' <<<'$r11' >/dev/null && grep -q 'phase: split_review' '$TICKETS_ROOT/_data/$P11/ticket.md'"
ap11="$("$run" fanout approve --parent "$P11" --proposal p1 --run --mock)"
for _ in $(seq 1 150); do [ "$(grep -c '"scheduler_end"' "$TICKETS_ROOT/_data/$P11/events.jsonl")" -ge 2 ] && break; sleep 0.2; done
SB="$(jq -r .created.s1 <<<"$ap11")"
check "approved split → sibling with split_from; parent leaves split_review" \
  bash -c "jq -e --arg a '$SA' '.split_from==\$a and .scope==[\"src/sa/tests/**\"]' '$TICKETS_ROOT/_data/$SB/meta.json' >/dev/null && ! grep -q 'phase: split_review' '$TICKETS_ROOT/_data/$P11/ticket.md'"
check "split-born child cannot split again" \
  bash -c "'$run' fanout propose --parent '$P11' --by-child '$SB' --title x --effect e --observed o --assumed a --scope 'src/sa/tests/x/**' | jq -e '.ok==false and (.error|test(\"cannot split again\"))'"
check "split-born phase view says no further splits" \
  bash -c "python3 '$here/lib/ticket_fs.py' phase-view '$SB' implement | grep -q 'cannot propose further splits'"
check "approve --run detaches the scheduler, which ships the new sibling" \
  bash -c "jq -e '.scheduler.detached==true' <<<'$ap11' >/dev/null && [ \"\$(awk -F': ' '/^status:/{print \$2}' '$TICKETS_ROOT/_data/$SB/ticket.md')\" = shipped ] && jq -e -s '[.[]|select(.kind==\"scheduler_end\")]|length==2' '$TICKETS_ROOT/_data/$P11/events.jsonl' >/dev/null"
check "children cap counts pending proposals" bash -c "
  P='$(c plan --from src --title cap --contract "$tmp/contract.md" | jq -r .id)'
  X=\$('$run' fanout add --parent \$P --to rx --title X --scope 'src/x/**' | jq -r .id)
  TICKET_MAX_CHILDREN=2 '$run' fanout propose --parent \$P --by-child \$X --title a --effect e --observed o --assumed a --scope 'src/x/a/**' | jq -e .ok >/dev/null &&
  TICKET_MAX_CHILDREN=2 '$run' fanout propose --parent \$P --by-child \$X --title b --effect e --observed o --assumed a --scope 'src/x/b/**' | jq -e '.ok==false and (.error|test(\"already has 2\"))'"

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
# fanout draft plan runs are research tickets too, so only membership + kind are fixed here
check "api list --kind research" jq -e --arg r "$RID" '(.tickets|map(.id)|index($r)!=null) and all(.tickets[]; .kind=="research")' <<<"$("$run" api list --kind research)"
check "research parse_json picks fenced or bare JSON" python3 -c "
import sys; sys.path.insert(0,'$here/lib'); import research as r
assert r.parse_json('x {\"a\": 1} y')=={'a':1}
assert r.parse_json('\x60\x60\x60json\n{\"b\": [1]}\n\x60\x60\x60')=={'b':[1]}
assert r.parse_json('nothing') is None"
# rename migration: delegate-<id> worktree → ticket-<id> (branch, .delegate, task-meta, meta.json)
LT="req-20250101-000000-abcdef"; LWT="$tmp/.worktrees/rx/delegate-$LT"
git -C "$tmp/rx" worktree add -q -b "delegate/$LT" "$LWT" origin/main
mkdir -p "$LWT/.delegate" "$tmp/.worktrees/rx/.task-meta"; printf 'scratch\n' >"$LWT/.delegate/ticket.md"
printf '{"task_slug":"delegate-%s","worktree_path":"%s","branch_name":"delegate/%s"}\n' "$LT" "$LWT" "$LT" >"$tmp/.worktrees/rx/.task-meta/delegate-$LT.json"
mkdir -p "$TICKETS_ROOT/_data/$LT"; printf '{"worktree":"%s","branch":null}\n' "$LWT" >"$TICKETS_ROOT/_data/$LT/meta.json"
check "legacy-check sees the pre-rename worktree" jq -e '.remaining==1' <<<"$(python3 "$here/lib/observe.py" legacy-check --force 2>/dev/null)"
mig="$(python3 "$here/lib/observe.py" legacy-migrate)"
NWT="$tmp/.worktrees/rx/ticket-$LT"
check "legacy-migrate moves worktree, renames branch + scratch, rewrites task-meta + meta.json" bash -c "
  test -d '$NWT/.ticket' && test ! -e '$LWT' && test \"\$(git -C '$NWT' rev-parse --abbrev-ref HEAD)\" = 'ticket/$LT' &&
  jq -e '.task_slug==\"ticket-$LT\" and .branch_name==\"ticket/$LT\"' '$tmp/.worktrees/rx/.task-meta/ticket-$LT.json' >/dev/null &&
  test ! -e '$tmp/.worktrees/rx/.task-meta/delegate-$LT.json' &&
  jq -e '.worktree==\"$NWT\" and .branch==\"ticket/$LT\"' '$TICKETS_ROOT/_data/$LT/meta.json' >/dev/null"
check "after migration nothing is left to remind about" jq -e '.remaining==0' <<<"$(python3 "$here/lib/observe.py" legacy-check --force 2>/dev/null)"
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
