#!/usr/bin/env bash
# test.sh — offline smoke for cross-repo delegate (no LLM, no real project trees).
#
# Uses an isolated DELEGATE_TICKETS_ROOT + fake target directories so it never
# touches ~/.agent/tickets or your AVC/wezdeck checkouts.
#
# Exit: 0 all pass, 1 any fail.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
run="$here/run.sh"

pass=0
fail=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
check() {
  local d=$1
  shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}

echo "delegate test (MOCK / isolated fs)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/delegate-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

fake_avc="$tmp/fake-avc"
fake_wez="$tmp/fake-wezdeck"
mkdir -p "$fake_avc" "$fake_wez"
# minimal git markers so path walk could resolve if needed
git -C "$fake_avc" init -q
git -C "$fake_wez" init -q
git -C "$fake_wez" config user.email test@example.com
git -C "$fake_wez" config user.name test
git -C "$fake_wez" commit --allow-empty -qm init

export DELEGATE_TICKETS_ROOT="$tmp/tickets"
"$run" init >/dev/null

cat >"$DELEGATE_TICKETS_ROOT/config.yml" <<EOF
targets:
  wezdeck:
    path: $fake_wez
    aliases: [wezdeck, wezterm-config]
  ai-video-collection:
    path: $fake_avc
    aliases: [avc, ai-video-collection]
EOF

# --- create gate ---
if "$run" create --to wezdeck --from avc --title "no assumptions" >/dev/null 2>&1; then
  bad "create without assumptions must fail"
else
  ok "create without assumptions fails"
fi

out="$("$run" create \
  --to wezdeck --from avc \
  --title "mock ticket" \
  --observed "seen in fake avc" \
  --assumed "fake wezdeck should fix X" \
  --snippet-ref "lib/foo.ts:10" 2>/dev/null)"
rc=$?
check "create exits 0" test "$rc" -eq 0
check "create json ok" jq -e '.ok == true' <<<"$out"
id="$(jq -r '.id' <<<"$out")"
check "create returns id" test -n "$id" -a "$id" != null
check "canonical ticket exists" test -f "$DELEGATE_TICKETS_ROOT/_data/$id/ticket.md"
check "inbox symlink exists" test -L "$DELEGATE_TICKETS_ROOT/by-target/wezdeck/inbox/${id}.md"

# real home must be untouched by this run
if [[ -d "${HOME}/.agent/tickets/_data/$id" ]]; then
  bad "must not write ticket into ~/.agent/tickets"
else
  ok "does not pollute ~/.agent/tickets"
fi

# --- inbox from fake wezdeck cwd ---
inbox="$(cd "$fake_wez" && "$run" inbox --to . 2>/dev/null)"
check "inbox sees ticket" jq -e --arg id "$id" '.count >= 1 and (.tickets | map(.id) | index($id) != null)' <<<"$inbox"

# --- --to . from a linked worktree must resolve to the primary allowlist key ---
# (basename of the worktree slug must NOT be treated as the target key)
fake_wt_parent="$tmp/.worktrees/fake-wezdeck"
mkdir -p "$fake_wt_parent"
git -C "$fake_wez" worktree add -q -b task/delegate-resolve "$fake_wt_parent/task-delegate-resolve" >/dev/null
inbox_wt="$(cd "$fake_wt_parent/task-delegate-resolve" && "$run" inbox --to . 2>/dev/null)"
check "inbox --to . from linked worktree resolves primary" \
  jq -e --arg id "$id" '.ok == true and .to == "wezdeck" and (.tickets | map(.id) | index($id) != null)' <<<"$inbox_wt"
key_wt="$(cd "$fake_wt_parent/task-delegate-resolve" && bash -c '
  source "'"$here"'/lib/common.sh"
  delegate_resolve_target_key .
')"
check "resolve_target_key from linked worktree == wezdeck" test "$key_wt" = "wezdeck"

# --- claim / lease conflict (Mode 2 = session) ---
claim1="$("$run" claim --id "$id" --by agent-a --lease-hours 2 2>/dev/null)"
check "claim a ok" jq -e '.ok == true and .claimed_by == "agent-a"' <<<"$claim1"
check "claim defaults to session (owner=human)" jq -e '.owner == "human" and .mode == "session"' <<<"$claim1"
claim2="$("$run" claim --id "$id" --by agent-b --lease-hours 2 2>/dev/null)" || true
check "second claim blocked while lease held" jq -e '.ok == false' <<<"$claim2"

# session lease must block headless run (no silent worktree/worker)
set +e
run_blocked="$("$run" run --id "$id" --phase research --mock 2>&1)"
rc_blocked=$?
set -u
if [[ "$rc_blocked" -ne 0 ]] && grep -q 'lease held\|session lease\|worker claim failed' <<<"$run_blocked"; then
  ok "run refused while session lease held"
else
  bad "run refused while session lease held"
  printf 'rc=%s out=%s\n' "$rc_blocked" "$run_blocked" >&2
fi
# --steal may take over for explicit Mode 3 override
set +e
steal_out="$("$run" run --id "$id" --phase research --mock --steal 2>&1)"
rc_steal=$?
set -u
if [[ "$rc_steal" -eq 0 ]] && printf '%s\n' "$steal_out" | grep '^{' | jq -s -e 'map(select(.ok == true and .owner == "worker")) | length >= 1' >/dev/null 2>&1; then
  ok "run --steal overrides session lease (mock research)"
else
  bad "run --steal overrides session lease (mock research)"
  printf 'rc=%s out=%s\n' "$rc_steal" "$steal_out" >&2
fi
# restore a clean session-claimed ticket for challenge/reply below
"$run" release --id "$id" >/dev/null 2>&1 || true
"$run" claim --id "$id" --by agent-a >/dev/null 2>&1

# --- challenge / reply ---
chal="$("$run" challenge --id "$id" \
  --measured "code already does Y" \
  --impact "consumer throw is wrong" \
  --recommended "drop guard; keep doc" \
  --needs "confirm?" 2>/dev/null)"
check "challenge -> waiting_initiator" jq -e '.status == "waiting_initiator"' <<<"$chal"
check "ticket body has measured_fact" grep -q "measured_fact: code already does Y" "$DELEGATE_TICKETS_ROOT/_data/$id/ticket.md"

reply="$("$run" reply --id "$id" --decision "drop guard" --status waiting_target 2>/dev/null)"
check "reply -> waiting_target" jq -e '.status == "waiting_target"' <<<"$reply"
check "decision section written" grep -q "drop guard" "$DELEGATE_TICKETS_ROOT/_data/$id/ticket.md"

# --- re-claim after reply + close ---
"$run" claim --id "$id" --by agent-a >/dev/null 2>&1
close="$("$run" close --id "$id" --doc docs/topic.md 2>/dev/null)"
check "close ok" jq -e '.ok == true and .status == "closed"' <<<"$close"
check "done bucket link" test -L "$DELEGATE_TICKETS_ROOT/by-target/wezdeck/done/${id}.md"
# reopen via set-status then assert close gate
"$run" set-status --id "$id" --status submitted --owner worker >/dev/null 2>&1
if "$run" close --id "$id" >/dev/null 2>&1; then
  bad "close without --doc/--no-doc must fail"
else
  ok "close without --doc/--no-doc fails"
fi
if "$run" close --id "$id" --no-doc "test" >/dev/null 2>&1; then
  ok "close --no-doc ok"
else
  bad "close --no-doc ok"
fi

# --- next / board / status / show ---
"$run" create --to wezdeck --from avc --title "open2" --observed "o" --assumed "a" >/dev/null 2>&1
next_out="$(cd "$fake_wez" && "$run" next --to . 2>/dev/null)"
check "next returns actions" jq -e '.ok == true and (.actions | length) >= 1' <<<"$next_out"
board="$("$run" board --to wezdeck 2>/dev/null)"
check "board json" jq -e '.ok == true and (.board | has("inbox"))' <<<"$board"
id2="$(jq -r '.actions[0].id' <<<"$next_out")"
show="$("$run" show --id "$id2" 2>/dev/null)"
check "show prints body" grep -q "## Assumptions" <<<"$show"

# --- reindex rebuild ---
rm -rf "$DELEGATE_TICKETS_ROOT/by-target"
"$run" reindex >/dev/null 2>&1
check "reindex restores links" test -d "$DELEGATE_TICKETS_ROOT/by-target/wezdeck"

# --- selfcheck still green ---
check "selfcheck exits 0" "$run" selfcheck

# --- walkthrough text (no seed into real home) ---
wt="$("$run" walkthrough 2>/dev/null)"
check "walkthrough mentions claim" grep -q "claim" <<<"$wt"

# --- phase view trim (omit noise, keep contract) ---
TOOL_ROOT="$(cd "$(dirname "$run")" && pwd)"
id_view="$("$run" create --to wezdeck --from avc --title "phase view" \
  --observed "obs-token-trim" --assumed "assumed-token-trim" \
  --summary "short summary only" 2>/dev/null | jq -r .id)"
python3 - "$DELEGATE_TICKETS_ROOT" "$TOOL_ROOT" "$id_view" <<'PY' >"$tmp/research-view.md"
import importlib.util, os, sys
os.environ["DELEGATE_TICKETS_ROOT"] = sys.argv[1]
spec = importlib.util.spec_from_file_location("ticket_fs", os.path.join(sys.argv[2], "lib", "ticket_fs.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tid = sys.argv[3]
meta, body = mod.read_ticket(tid)
if "## Thread" in body:
    body = body.replace(
        "## Thread\n\n<!-- append Q/A here -->\n",
        "## Thread\n\n- (noise) do-not-inject-this-thread-line\n\n",
        1,
    )
else:
    body += "\n## Thread\n\n- (noise) do-not-inject-this-thread-line\n"
mod.write_ticket(tid, meta, body)
print(mod.render_phase_view(meta, body, "research"), end="")
PY
if grep -q "assumed-token-trim" "$tmp/research-view.md" \
  && grep -q "obs-token-trim" "$tmp/research-view.md" \
  && grep -q "Assumptions" "$tmp/research-view.md" \
  && ! grep -q "do-not-inject-this-thread-line" "$tmp/research-view.md" \
  && ! grep -q "^## Thread" "$tmp/research-view.md" \
  && ! grep -q "^## Decision" "$tmp/research-view.md"; then
  ok "research phase view keeps Assumptions, drops Thread"
else
  bad "research phase view keeps Assumptions, drops Thread"
  cat "$tmp/research-view.md" >&2
fi

"$run" challenge --id "$id_view" \
  --measured "measured-for-implement" \
  --impact "impact-x" \
  --recommended "do-y" \
  --needs "ok?" >/dev/null 2>&1
"$run" reply --id "$id_view" --decision "decision-go-ahead" --status waiting_target >/dev/null 2>&1
python3 - "$DELEGATE_TICKETS_ROOT" "$TOOL_ROOT" "$id_view" <<'PY' >"$tmp/implement-view.md"
import importlib.util, os, sys
os.environ["DELEGATE_TICKETS_ROOT"] = sys.argv[1]
spec = importlib.util.spec_from_file_location("ticket_fs", os.path.join(sys.argv[2], "lib", "ticket_fs.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
meta, body = mod.read_ticket(sys.argv[3])
print(mod.render_phase_view(meta, body, "implement"), end="")
PY
if grep -q "measured-for-implement" "$tmp/implement-view.md" \
  && grep -q "decision-go-ahead" "$tmp/implement-view.md" \
  && grep -q "assumed-token-trim" "$tmp/implement-view.md" \
  && grep -q "obs-token-trim" "$tmp/implement-view.md" \
  && grep -q "Verification" "$tmp/implement-view.md" \
  && ! grep -q "do-not-inject-this-thread-line" "$tmp/implement-view.md"; then
  ok "implement phase view keeps contract+Verification+Decision, drops Thread"
else
  bad "implement phase view keeps contract+Verification+Decision, drops Thread"
  cat "$tmp/implement-view.md" >&2
fi

# --- create --run --mock (no LLM, no real worktree) ---
# create --run --mock → research accept → auto implement → shipped
run_out="$("$run" create \
  --to wezdeck --from avc \
  --title "auto dispatch" \
  --observed "needs research" \
  --assumed "target should verify" \
  --run --mock 2>/dev/null)" || true
if printf '%s\n' "$run_out" | jq -s -e 'map(select(.phase? == "implement_done" or .status? == "shipped")) | length >= 1' >/dev/null 2>&1; then
  ok "create --run --mock auto-implements to shipped"
else
  bad "create --run --mock auto-implements to shipped"
  printf '%s\n' "$run_out" >&2
fi

# prompts written by mock path must use phase views (no Thread)
id_auto="$(printf '%s\n' "$run_out" | jq -s -r 'map(select(.id != null)) | .[0].id // empty')"
if [[ -n "$id_auto" ]]; then
  pr="$DELEGATE_TICKETS_ROOT/_data/$id_auto/prompt-research.md"
  pi="$DELEGATE_TICKETS_ROOT/_data/$id_auto/prompt-implement.md"
  if [[ -f "$pr" ]] && grep -q "Ticket phase view" "$pr" && grep -q "Assumptions" "$pr" && ! grep -q "^## Thread" "$pr"; then
    ok "mock research prompt embeds phase view without Thread"
  else
    bad "mock research prompt embeds phase view without Thread"
  fi
  if [[ -f "$pi" ]] && grep -q "Ticket phase view" "$pi" && grep -q "Verification" "$pi" && ! grep -q "^## Thread" "$pi"; then
    ok "mock implement prompt embeds phase view without Thread"
  else
    bad "mock implement prompt embeds phase view without Thread"
  fi
  # Prove workers went through shared host-agent-invoke (not a private CLI case).
  trace="$DELEGATE_TICKETS_ROOT/_data/$id_auto/host-invoke.trace.jsonl"
  if [[ -f "$trace" ]] \
    && jq -e -s 'map(select(.mock == true and .mode == "write" and .backend == "claude")) | length >= 2' <"$trace" >/dev/null \
    && grep -q 'host_agent_invoke_run' "$here/lib/worker.sh" \
    && ! grep -qE 'claude -p "\$\(cat|codex exec --full-auto "\$\(cat|grok -p "\$\(cat' "$here/lib/worker.sh"; then
    ok "mock workers invoke via shared host-agent-invoke (trace+no private CLI case)"
  else
    bad "mock workers invoke via shared host-agent-invoke (trace+no private CLI case)"
    printf 'trace=%s\n' "$trace" >&2
    [[ -f "$trace" ]] && cat "$trace" >&2
  fi
else
  bad "mock research prompt embeds phase view without Thread"
  bad "mock implement prompt embeds phase view without Thread"
  bad "mock workers invoke via shared host-agent-invoke (trace+no private CLI case)"
fi

# session claim: reply --continue must refuse (Mode 2 stays in TUI)
id_sess="$("$run" create --to wezdeck --from avc --title "session continue refuse" --observed "o" --assumed "a" 2>/dev/null | jq -r .id)"
"$run" claim --id "$id_sess" --by human-dev >/dev/null 2>&1
"$run" set-status --id "$id_sess" --status waiting_initiator --owner initiator --phase research_challenge >/dev/null
# keep claimed_by=human-dev in ticket body (set-status may not clear it)
set +e
sess_cont="$("$run" reply --id "$id_sess" --decision "ok proceed" --continue --mock 2>&1)"
rc_sess_cont=$?
set -u
if [[ "$rc_sess_cont" -ne 0 ]] && grep -qi 'session-claimed\|owner=human\|refused' <<<"$sess_cont"; then
  ok "reply --continue refused for session claim"
else
  bad "reply --continue refused for session claim"
  printf 'rc=%s out=%s\n' "$rc_sess_cont" "$sess_cont" >&2
fi

# challenge path: mock research that challenges, then reply --continue
# Force challenge by writing result then apply — use set-status + reply flow
id_ch="$("$run" create --to wezdeck --from avc --title "need confirm" --observed "o" --assumed "a" 2>/dev/null | jq -r .id)"
"$run" set-status --id "$id_ch" --status waiting_initiator --owner initiator --phase research_challenge >/dev/null
reply_out="$("$run" reply --id "$id_ch" --decision "approved, proceed" --continue --mock 2>/dev/null)" || true
if printf '%s\n' "$reply_out" | jq -s -e 'map(select(.status? == "shipped" or .phase? == "implement_done")) | length >= 1' >/dev/null 2>&1; then
  ok "reply --continue --mock implements after confirm"
else
  # reply json then implement json
  if printf '%s\n' "$reply_out" | grep -q '"status": "shipped"\|implement_done'; then
    ok "reply --continue --mock implements after confirm"
  else
    bad "reply --continue --mock implements after confirm"
    printf '%s\n' "$reply_out" >&2
  fi
fi

# watch --once on shipped reports done
watch_out="$("$run" watch --id "$id_ch" --once --mock 2>/dev/null)" || true
if jq -e '.ok == true and (.done == true or .status == "shipped")' <<<"$watch_out" >/dev/null 2>&1; then
  ok "watch --once on shipped reports done"
else
  bad "watch --once on shipped reports done"
  printf '%s\n' "$watch_out" >&2
fi

echo "---"
printf 'pass=%d fail=%d\n' "$pass" "$fail"
echo "isolated root: $DELEGATE_TICKETS_ROOT"
[[ "$fail" -eq 0 ]]
