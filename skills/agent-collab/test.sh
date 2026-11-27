#!/usr/bin/env bash
# test.sh — offline smoke for cross-repo ticket (no LLM, no real project trees).
#
# Uses an isolated TICKETS_ROOT + fake target directories so it never
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

echo "ticket test (MOCK / isolated fs)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/ticket-test.XXXXXX")"
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

export TICKETS_ROOT="$tmp/tickets"
export WEZTERM_RUNTIME_LOG_FILE="$tmp/runtime.log"
export WEZTERM_RUNTIME_LOG_ENABLED=1
"$run" init >/dev/null

cat >"$TICKETS_ROOT/config.yml" <<EOF
targets:
  wezdeck:
    path: $fake_wez
    aliases: [wezdeck, wezterm-config]
  ai-video-collection:
    path: $fake_avc
    aliases: [avc, ai-video-collection]
EOF

# Session claims must run inside the target repo (cwd check): every ticket below
# targets wezdeck, so run the suite from the fake wezdeck checkout.
cd "$fake_wez"

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
check "canonical ticket exists" test -f "$TICKETS_ROOT/_data/$id/ticket.md"
check "inbox symlink exists" test -L "$TICKETS_ROOT/by-target/wezdeck/inbox/${id}.md"

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
git -C "$fake_wez" worktree add -q -b task/ticket-resolve "$fake_wt_parent/task-ticket-resolve" >/dev/null
inbox_wt="$(cd "$fake_wt_parent/task-ticket-resolve" && "$run" inbox --to . 2>/dev/null)"
check "inbox --to . from linked worktree resolves primary" \
  jq -e --arg id "$id" '.ok == true and .to == "wezdeck" and (.tickets | map(.id) | index($id) != null)' <<<"$inbox_wt"
key_wt="$(cd "$fake_wt_parent/task-ticket-resolve" && bash -c '
  source "'"$here"'/lib/common.sh"
  ticket_resolve_target_key .
')"
check "resolve_target_key from linked worktree == wezdeck" test "$key_wt" = "wezdeck"

# --- session identity: two sessions of one $USER must not share a lease ---
id_ident="$("$run" create --to wezdeck --from avc --title "identity" --observed o --assumed a 2>/dev/null | jq -r .id)"
c_a="$(env -u TICKET_SESSION_ID -u CLAUDE_CODE_SESSION_ID TMUX_PANE=%1 "$run" claim --id "$id_ident" 2>/dev/null)"
check "default claim identity = tmux pane" jq -e '.ok == true and .claimed_by == "tmux:%1"' <<<"$c_a"
c_b="$(env -u TICKET_SESSION_ID -u CLAUDE_CODE_SESSION_ID TMUX_PANE=%2 "$run" claim --id "$id_ident" 2>/dev/null)" || true
check "other session (same \$USER) blocked by live lease" jq -e '.ok == false and .error == "lease held" and .claimed_by == "tmux:%1"' <<<"$c_b"
c_a2="$(env -u TICKET_SESSION_ID -u CLAUDE_CODE_SESSION_ID TMUX_PANE=%1 "$run" claim --id "$id_ident" 2>/dev/null)"
check "same session re-claim is idempotent" jq -e '.ok == true and .claimed_by == "tmux:%1"' <<<"$c_a2"
c_env="$(env -u TMUX_PANE TICKET_SESSION_ID=custom-x "$run" claim --id "$id_ident" 2>/dev/null)" || true
check "TICKET_SESSION_ID wins and is a distinct holder" jq -e '.ok == false and .claimed_by == "tmux:%1"' <<<"$c_env"
c_cc="$(env -u TMUX_PANE -u TICKET_SESSION_ID CLAUDE_CODE_SESSION_ID=abc "$run" renew --id "$id_ident" 2>/dev/null)" || true
check "claude session id identity is not the tmux holder (renew refused)" jq -e '.ok == false and .by == "claude:abc"' <<<"$c_cc"
c_user="$(env -u TMUX_PANE -u TICKET_SESSION_ID -u CLAUDE_CODE_SESSION_ID "$run" claim --id "$id_ident" 2>&1)" || true
check "no identity env falls back to \$USER and warns" grep -q 'falling back to \$USER' <<<"$c_user"

# --- renew / release are holder-only ---
lease0="$(jq -r .lease_until_epoch "$TICKETS_ROOT/_data/$id_ident/meta.json")"
r_ok="$(TMUX_PANE=%1 "$run" renew --id "$id_ident" --lease-hours 3 2>/dev/null)"
lease1="$(jq -r .lease_until_epoch "$TICKETS_ROOT/_data/$id_ident/meta.json")"
check "holder renew extends lease" bash -c "jq -e '.ok == true' <<<'$r_ok' >/dev/null && [ '$lease1' -gt '$lease0' ]"
check "renew writes a renewed event" grep -q '"renewed"' "$TICKETS_ROOT/_data/$id_ident/events.jsonl"
r_bad="$(TMUX_PANE=%2 "$run" renew --id "$id_ident" 2>/dev/null)" || true
check "non-holder renew refused" jq -e '.ok == false and .error == "not lease holder"' <<<"$r_bad"
rel_bad="$(TMUX_PANE=%2 "$run" release --id "$id_ident" 2>/dev/null)" || true
check "non-holder release refused while lease live" jq -e '.ok == false and .error == "lease held"' <<<"$rel_bad"
rel_ok="$(TMUX_PANE=%1 "$run" release --id "$id_ident" 2>/dev/null)"
check "holder release frees the ticket" jq -e '.ok == true and .status == "submitted"' <<<"$rel_ok"
TMUX_PANE=%1 "$run" claim --id "$id_ident" >/dev/null 2>&1
rel_force="$(TMUX_PANE=%2 "$run" release --id "$id_ident" --force 2>/dev/null)"
check "release --force overrides another live lease" jq -e '.ok == true' <<<"$rel_force"
check "forced release is recorded" bash -c "grep '\"released\"' '$TICKETS_ROOT/_data/$id_ident/events.jsonl' | tail -1 | jq -e '.forced == true' >/dev/null"
# expired lease: anyone may claim
TMUX_PANE=%1 "$run" claim --id "$id_ident" --lease-hours 0 >/dev/null 2>&1
c_exp="$(TMUX_PANE=%2 "$run" claim --id "$id_ident" 2>/dev/null)"
check "expired lease is claimable by another session" jq -e '.ok == true and .claimed_by == "tmux:%2"' <<<"$c_exp"
TMUX_PANE=%2 "$run" release --id "$id_ident" >/dev/null 2>&1

# --- session claim needs cwd in the target repo ---
c_cwd="$(cd "$tmp" && TMUX_PANE=%1 "$run" claim --id "$id_ident" 2>&1)" || true
check "session claim outside target repo refused" grep -q '"error":"wrong cwd"' <<<"$c_cwd"
c_other="$(cd "$fake_avc" && TMUX_PANE=%1 "$run" claim --id "$id_ident" 2>&1)" || true
check "session claim from another allowlisted repo refused" grep -q '"cwd_target":"ai-video-collection"' <<<"$c_other"
c_wt="$(cd "$fake_wt_parent/task-ticket-resolve" && TMUX_PANE=%1 "$run" claim --id "$id_ident" 2>/dev/null)"
check "session claim from a linked worktree of the target ok" jq -e '.ok == true' <<<"$c_wt"
TMUX_PANE=%1 "$run" release --id "$id_ident" >/dev/null 2>&1
c_any="$(cd "$tmp" && TMUX_PANE=%1 "$run" claim --id "$id_ident" --any-cwd 2>/dev/null)"
check "--any-cwd overrides the cwd check" jq -e '.ok == true' <<<"$c_any"
TMUX_PANE=%1 "$run" release --id "$id_ident" >/dev/null 2>&1

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
"$run" release --id "$id" --force >/dev/null 2>&1 || true
"$run" claim --id "$id" --by agent-a >/dev/null 2>&1

# --- challenge / reply ---
chal="$("$run" challenge --id "$id" \
  --measured "code already does Y" \
  --impact "consumer throw is wrong" \
  --recommended "drop guard; keep doc" \
  --needs "confirm?" 2>/dev/null)"
check "challenge -> waiting_initiator" jq -e '.status == "waiting_initiator"' <<<"$chal"
check "ticket body has measured_fact" grep -q "measured_fact: code already does Y" "$TICKETS_ROOT/_data/$id/ticket.md"

check "plain challenge leaves no questions" jq -e '.questions == null' <<<"$("$run" api show --id "$id")"

# --- structured questions (tappable on the phone) ---
qs='[{"header":"Guard","question":"Drop the consumer guard?","options":[{"label":"Drop it","description":"code already does Y"},{"label":"Keep it"}]},{"question":"bad: one option","options":["only"]}]'
chal_q="$("$run" challenge --id "$id" --measured "code already does Y" --impact "x" --recommended "drop" \
  --needs "drop the guard?" --questions "$qs" 2>/dev/null)"
check "challenge --questions keeps only valid questions" jq -e '.questions == 1' <<<"$chal_q"
show_q="$("$run" api show --id "$id")"
check "api show exposes questions while waiting_initiator" \
  jq -e '.questions.source == "challenge" and (.questions.questions|length)==1 and .questions.questions[0].options[1].label=="Keep it" and .questions.questions[0].multi_select==false' <<<"$show_q"
check "ticket.md lists the options" grep -q "  - Drop it — code already does Y" "$TICKETS_ROOT/_data/$id/ticket.md"
if python3 "$here/lib/validate_api.py" show <<<"$show_q" 2>"$tmp/val.err"; then ok "show with questions validates"
elif [[ $? -eq 2 ]]; then ok "show with questions validation skipped (jsonschema missing)"
else bad "show with questions validates"; cat "$tmp/val.err" >&2; fi
bad_q="$("$run" challenge --id "$id" --measured m --impact i --recommended r --questions 'not json' 2>&1)"
check "challenge rejects non-JSON --questions" grep -q "not JSON" <<<"$bad_q"

reply="$("$run" reply --id "$id" --decision "drop guard" --status waiting_target 2>/dev/null)"
check "reply -> waiting_target" jq -e '.status == "waiting_target"' <<<"$reply"
check "decision section written" grep -q "drop guard" "$TICKETS_ROOT/_data/$id/ticket.md"
check "reply archives the questions with the answer" \
  bash -c "test ! -e '$TICKETS_ROOT/_data/$id/questions.json' && jq -e '.answer==\"drop guard\" and (.questions|length)==1' '$TICKETS_ROOT/_data/$id/questions-history.jsonl'"
check "api show has no questions after reply" jq -e '.questions == null' <<<"$("$run" api show --id "$id")"
check "reply event records answered_questions" \
  jq -e -s 'map(select(.type=="reply"))|last|.answered_questions==true' "$TICKETS_ROOT/_data/$id/events.jsonl"

# research result with questions → waiting_initiator + questions.json; accept clears them
apply_research() {
  printf '%s\n' "$2" >"$TICKETS_ROOT/_data/$1/worker-result.json"
  bash -c 'source "$1/lib/common.sh"; source "$1/lib/worker.sh"; ticket_worker_apply_result "$2"' _ "$here" "$1" 2>"$tmp/apply.err" | tail -n1
}
rq="$(apply_research "$id" '{"verdict":"challenge","verification":{"needs_initiator_decision":"which API?"},"questions":[{"question":"Which API?","options":[{"label":"v1"},{"label":"v2"}],"multi_select":true}]}')"
check "research challenge with questions" jq -e '.status=="waiting_initiator" and .questions==1' <<<"$rq"
check "research questions readable via api show" \
  jq -e '.questions.source=="research" and .questions.questions[0].multi_select==true' <<<"$("$run" api show --id "$id")"
ra="$(apply_research "$id" '{"verdict":"accept","verification":{},"questions":[{"question":"ignored","options":["a","b"]}]}')"
check "research accept ignores and clears questions" \
  bash -c "jq -e '.questions==0' <<<'$ra' >/dev/null && test ! -e '$TICKETS_ROOT/_data/$id/questions.json'"
"$run" set-status --id "$id" --status waiting_target --owner worker >/dev/null 2>&1

# --- attach: ticket session → tmux window (fake tmux, nothing real touched) ---
fakebin="$tmp/fakebin"; mkdir -p "$fakebin"
sess_suffix="$(bash "$here/../../scripts/runtime/tmux-worktree/print-session-names.sh" x "$fake_wez" | cut -f2 | cut -d_ -f3-)"
cat >"$fakebin/tmux" <<FAKE
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$tmp/tmux.log"
case "\$1" in
  list-sessions) printf '100\twezterm_old_%s\n200\twezterm_work_%s\n300\twezterm_x_other_abc\n' "$sess_suffix" "$sess_suffix" ;;
  new-window) printf '@9\t%%99\n' ;;
esac
FAKE
chmod +x "$fakebin/tmux"
python3 - "$TICKETS_ROOT/_data/$id/meta.json" "$fake_wez" <<'PY'
import json, sys
p, wt = sys.argv[1], sys.argv[2]
d = json.load(open(p))
d["worktree"] = wt
d["sessions"] = {"research": {"backend": "claude", "id": "11111111-2222-3333-4444-555555555555", "last_used_epoch": 1},
                 "worker": {"backend": "codex", "id": "66666666-7777-8888-9999-000000000000", "last_used_epoch": 2}}
json.dump(d, open(p, "w"))
PY
att_dry="$(PATH="$fakebin:$PATH" "$run" attach --id "$id" --dry-run)"
check "attach picks newest session, ticket worktree, most active repo session" \
  jq -e --arg wt "$fake_wez" '.ok and .role=="worker" and .backend=="codex" and .cwd==$wt and .cwd_source=="ticket_worktree" and (.tmux_session|startswith("wezterm_work_")) and (.command[0]|endswith("scripts/runtime/agent-launcher.sh")) and .command[1]=="codex"' <<<"$att_dry"
check "attach --dry-run creates no window" bash -c "! grep -q new-window '$tmp/tmux.log'"
att="$(PATH="$fakebin:$PATH" "$run" attach --id "$id" --role research)"
check "attach opens a window via agent-launcher with the typed resume id" \
  bash -c "jq -e '.ok and .pane_id==\"%99\" and .backend==\"claude\"' <<<'$att' >/dev/null && grep -q 'new-window .*WEZDECK_RESUME_SESSION_ID=11111111-2222-3333-4444-555555555555 .*agent-launcher.sh claude' '$tmp/tmux.log' && grep -q 'set-option -p -t %99 @wezterm_pane_role agent-cli:claude' '$tmp/tmux.log'"
check "attach session-claims the open ticket and records it" \
  bash -c "jq -e '.claimed==true' <<<'$att' >/dev/null && jq -e '.attached.pane_id==\"%99\" and .claimed_by==\"tmux:%99\"' '$TICKETS_ROOT/_data/$id/meta.json' >/dev/null"
mkdir -p "$TICKETS_ROOT/_data/$id/runs"; : >"$TICKETS_ROOT/_data/$id/runs/run-x.launch.json"
PATH="$fakebin:$PATH" "$run" attach --id "$id" --dry-run >/dev/null 2>&1
check "attach refuses while a headless run is in flight" test $? -eq 3
rm -f "$TICKETS_ROOT/_data/$id/runs/run-x.launch.json"
"$run" release --id "$id" --by tmux:%99 >/dev/null 2>&1 || true

# --- re-claim after reply + close ---
"$run" claim --id "$id" --by agent-a >/dev/null 2>&1
close="$("$run" close --id "$id" --doc docs/topic.md 2>/dev/null)"
check "close ok" jq -e '.ok == true and .status == "closed"' <<<"$close"
check "done bucket link" test -L "$TICKETS_ROOT/by-target/wezdeck/done/${id}.md"
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
rm -rf "$TICKETS_ROOT/by-target"
"$run" reindex >/dev/null 2>&1
check "reindex restores links" test -d "$TICKETS_ROOT/by-target/wezdeck"

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
python3 - "$TICKETS_ROOT" "$TOOL_ROOT" "$id_view" <<'PY' >"$tmp/research-view.md"
import importlib.util, os, sys
os.environ["TICKETS_ROOT"] = sys.argv[1]
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
python3 - "$TICKETS_ROOT" "$TOOL_ROOT" "$id_view" <<'PY' >"$tmp/implement-view.md"
import importlib.util, os, sys
os.environ["TICKETS_ROOT"] = sys.argv[1]
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
  pr="$TICKETS_ROOT/_data/$id_auto/prompt-research.md"
  pi="$TICKETS_ROOT/_data/$id_auto/prompt-implement.md"
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
  trace="$TICKETS_ROOT/_data/$id_auto/host-invoke.trace.jsonl"
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

# --- Mode 3 step progress (progress.json + progress cmd + events) ---
id_prog="$("$run" create --to wezdeck --from avc --title "progress trail" \
  --observed "o" --assumed "a" --run --mock 2>/dev/null | jq -s -r 'map(select(.id != null)) | .[0].id // empty')"
if [[ -z "$id_prog" ]]; then
  # create --run prints multiple JSON lines; id may only be on create line
  id_prog="$("$run" create --to wezdeck --from avc --title "progress trail2" \
    --observed "o" --assumed "a" 2>/dev/null | jq -r .id)"
  "$run" run --id "$id_prog" --phase auto --mock >/dev/null 2>&1 || true
fi
prog_json="$("$run" progress --id "$id_prog" 2>/dev/null)" || true
if jq -e '.ok == true and (.progress.step | tostring | length) > 0' <<<"$prog_json" >/dev/null 2>&1; then
  ok "progress --id returns snapshot with step"
else
  bad "progress --id returns snapshot with step"
  printf '%s\n' "$prog_json" >&2
fi
ev_file="$TICKETS_ROOT/_data/$id_prog/events.jsonl"
if [[ -f "$ev_file" ]] && grep -q '"type": "progress"' "$ev_file" \
  && grep -q 'research_start\|implement_start\|research_done\|implement_done' "$ev_file"; then
  ok "events.jsonl contains progress milestones"
else
  bad "events.jsonl contains progress milestones"
  [[ -f "$ev_file" ]] && cat "$ev_file" >&2
fi
pf="$TICKETS_ROOT/_data/$id_prog/progress.json"
if [[ -f "$pf" ]] && jq -e '.step and .message' "$pf" >/dev/null 2>&1; then
  ok "progress.json written for Mode 3 run"
else
  bad "progress.json written for Mode 3 run"
  [[ -f "$pf" ]] && cat "$pf" >&2
fi
watch_prog="$("$run" watch --id "$id_prog" --once --mock 2>/dev/null)" || true
if jq -e '.ok == true and (has("progress") or has("new_events") or .done == true)' <<<"$watch_prog" >/dev/null 2>&1; then
  ok "watch --once includes progress fields"
else
  bad "watch --once includes progress fields"
  printf '%s\n' "$watch_prog" >&2
fi

# --- worktree reclaim on close + gc ---
export WEZDECK_REPO="${WEZDECK_REPO:-$HOME/github/wezterm-config}"
if [[ ! -x "$WEZDECK_REPO/scripts/runtime/worktree/worktree-task" ]]; then
  WEZDECK_REPO="$(cd "$here/../.." && pwd)"
fi
id_gc="$("$run" create --to wezdeck --from avc --title "gc reclaim" \
  --observed "o" --assumed "a" 2>/dev/null | jq -r .id)"
gc_slug="ticket-${id_gc}"
gc_wt_parent="$tmp/.worktrees/fake-wezdeck"
mkdir -p "$gc_wt_parent"
git -C "$fake_wez" worktree add -q -b "ticket/${id_gc}" "$gc_wt_parent/$gc_slug" >/dev/null
mkdir -p "$gc_wt_parent/$gc_slug/.ticket"
printf '{"mock":true}\n' >"$gc_wt_parent/$gc_slug/.ticket/worker-result.json"
python3 - "$TICKETS_ROOT" "$id_gc" "$gc_wt_parent/$gc_slug" <<'PY'
import json, sys
from pathlib import Path
root, tid, wt = sys.argv[1], sys.argv[2], sys.argv[3]
meta = Path(root) / "_data" / tid / "meta.json"
data = json.loads(meta.read_text()) if meta.is_file() else {}
data["worktree"] = wt
meta.write_text(json.dumps(data, indent=2) + "\n")
PY
close_gc="$("$run" close --id "$id_gc" --no-doc "gc test" 2>/dev/null)"
check "close reclaims .ticket-only dirty worktree" \
  jq -e '.ok == true and .worktree_reclaim.ok == true and (.worktree_reclaim.action == "reclaimed")' <<<"$close_gc"
check "close removed worktree dir" test ! -d "$gc_wt_parent/$gc_slug"
meta_wt="$(python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get("worktree"); print("" if v is None else v)' \
  "$TICKETS_ROOT/_data/$id_gc/meta.json")"
check "close cleared meta.worktree" test -z "$meta_wt"

# dirty non-allowlisted → skip on close (keep-worktree off, no --force)
id_dirty="$("$run" create --to wezdeck --from avc --title "dirty skip" \
  --observed "o" --assumed "a" 2>/dev/null | jq -r .id)"
dirty_slug="ticket-${id_dirty}"
git -C "$fake_wez" worktree add -q -b "ticket/${id_dirty}" "$gc_wt_parent/$dirty_slug" >/dev/null
printf 'keep-me\n' >"$gc_wt_parent/$dirty_slug/EXTRA_DIRTY.txt"
python3 - "$TICKETS_ROOT" "$id_dirty" "$gc_wt_parent/$dirty_slug" <<'PY'
import json, sys
from pathlib import Path
root, tid, wt = sys.argv[1], sys.argv[2], sys.argv[3]
meta = Path(root) / "_data" / tid / "meta.json"
data = json.loads(meta.read_text()) if meta.is_file() else {}
data["worktree"] = wt
meta.write_text(json.dumps(data, indent=2) + "\n")
PY
close_dirty="$("$run" close --id "$id_dirty" --no-doc "dirty" 2>/dev/null)"
check "close skips non-allowlisted dirty worktree" \
  jq -e '.ok == true and .worktree_reclaim.ok == false and .worktree_reclaim.reason == "dirty"' <<<"$close_dirty"
check "dirty worktree still present after close" test -d "$gc_wt_parent/$dirty_slug"

# gc --dry-run sees the leftover closed+dirty tree
gc_dry="$("$run" gc --dry-run --status closed 2>/dev/null)"
check "gc dry-run lists closed dirty candidate" \
  jq -e --arg id "$id_dirty" '.dry_run == true and (.candidates | map(.id) | index($id) != null)' <<<"$gc_dry"

# gc --execute --force reclaims it
gc_exe="$("$run" gc --execute --force --status closed --id "$id_dirty" 2>/dev/null)"
check "gc --execute --force reclaims dirty closed tree" \
  jq -e '.dry_run == false and .reclaimed >= 1' <<<"$gc_exe"
check "gc removed dirty worktree" test ! -d "$gc_wt_parent/$dirty_slug"

# close --keep-worktree leaves tree
id_keep="$("$run" create --to wezdeck --from avc --title "keep wt" \
  --observed "o" --assumed "a" 2>/dev/null | jq -r .id)"
keep_slug="ticket-${id_keep}"
git -C "$fake_wez" worktree add -q -b "ticket/${id_keep}" "$gc_wt_parent/$keep_slug" >/dev/null
python3 - "$TICKETS_ROOT" "$id_keep" "$gc_wt_parent/$keep_slug" <<'PY'
import json, sys
from pathlib import Path
root, tid, wt = sys.argv[1], sys.argv[2], sys.argv[3]
meta = Path(root) / "_data" / tid / "meta.json"
data = json.loads(meta.read_text()) if meta.is_file() else {}
data["worktree"] = wt
meta.write_text(json.dumps(data, indent=2) + "\n")
PY
close_keep="$("$run" close --id "$id_keep" --no-doc "keep" --keep-worktree 2>/dev/null)"
check "close --keep-worktree skips reclaim" \
  jq -e '.ok == true and .worktree_reclaim.reason == "keep_worktree"' <<<"$close_keep"
check "keep-worktree dir still present" test -d "$gc_wt_parent/$keep_slug"
# cleanup leftover for trap
git -C "$fake_wez" worktree remove -f "$gc_wt_parent/$keep_slug" >/dev/null 2>&1 || rm -rf "$gc_wt_parent/$keep_slug"

# --- worktrees decision table ---
id_wt="$("$run" create --to wezdeck --from avc --title "worktrees report" \
  --observed "o" --assumed "a" 2>/dev/null | jq -r .id)"
wt_slug="ticket-${id_wt}"
git -C "$fake_wez" worktree add -q -b "ticket/${id_wt}" "$gc_wt_parent/$wt_slug" >/dev/null
mkdir -p "$gc_wt_parent/$wt_slug/.ticket"
printf 'x\n' >"$gc_wt_parent/$wt_slug/.ticket/ticket.md"
python3 - "$TICKETS_ROOT" "$id_wt" "$gc_wt_parent/$wt_slug" <<'PY'
import json, sys
from pathlib import Path
root, tid, wt = sys.argv[1], sys.argv[2], sys.argv[3]
meta = Path(root) / "_data" / tid / "meta.json"
data = json.loads(meta.read_text()) if meta.is_file() else {}
data["worktree"] = wt
meta.write_text(json.dumps(data, indent=2) + "\n")
PY
wt_rep="$("$run" worktrees --id "$id_wt" 2>/dev/null)"
check "worktrees lists ticket with ticket_only dirty" \
  jq -e --arg id "$id_wt" '.ok == true and .count == 1 and .worktrees[0].id == $id and .worktrees[0].exists == true and .worktrees[0].dirty == "ticket_only" and (.worktrees[0].suggest | length) > 0' <<<"$wt_rep"
wt_alive="$("$run" worktrees --alive 2>/dev/null)"
check "worktrees --alive includes live tree" \
  jq -e --arg id "$id_wt" '(.worktrees | map(.id) | index($id) != null)' <<<"$wt_alive"
# close → suggest path gone / clear_meta or absent from --alive
"$run" close --id "$id_wt" --no-doc "worktrees test" >/dev/null 2>&1
wt_after="$("$run" worktrees --alive 2>/dev/null)"
check "worktrees --alive empty after close reclaim" \
  jq -e --arg id "$id_wt" '(.worktrees | map(.id) | index($id) == null)' <<<"$wt_after"

# ---------------------------------------------------------------- observability (docs/collab.md)
echo "observability"
fx="$here/../../scripts/dev/host-agent-invoke/tests/fixtures"
obs_out="$(HOST_AGENT_INVOKE_MOCK_STREAM="$fx/claude.stream.jsonl" TICKET_TRIGGER_SOURCE=cli "$run" create \
  --to wezdeck --from avc --title "obs ticket" --observed "o" --assumed "a token=abcdefghijklmnop1234" \
  --run --mock 2>"$tmp/obs.err")"
id_obs="$(head -1 <<<"$obs_out" | jq -r '.id')"
runs_dir="$TICKETS_ROOT/_data/$id_obs/runs"
n_launch="$(find "$runs_dir" -name '*.launch.json' 2>/dev/null | wc -l)"
n_rec="$(find "$runs_dir" -name 'run-*.json' ! -name '*.launch.json' 2>/dev/null | wc -l)"
check "research + implement each leave launch + run record" test "$n_launch" -eq 2 -a "$n_rec" -eq 2
first_launch="$(find "$runs_dir" -name '*.launch.json' | sort | head -1)"
check "launch record: trigger, prompt sha, composition (template git blob + phase view), session" \
  jq -e '.trigger.source=="cli" and (.prompt.sha256|length==64) and (.prompt.store_sha256|length==64)
    and (.composition|map(.kind)|index("template")!=null and index("phase_view")!=null)
    and ((.composition[]|select(.kind=="template")|.git_blob)|type=="string")
    and .session.reuse=="fresh" and .session.reason=="no_prior" and .invocation.backend=="claude"' "$first_launch"
sha="$(jq -r '.prompt.store_sha256' "$first_launch")"
check "stored prompt is content-addressed and redacted" \
  bash -c "test -f '$TICKETS_ROOT/prompts/$sha.md' && grep -q 'redacted:assignment' '$TICKETS_ROOT/prompts/$sha.md' && ! grep -q abcdefghijklmnop1234 '$TICKETS_ROOT/prompts/$sha.md'"
check "redaction rule names recorded in launch" jq -e '.prompt.redactions|index("assignment")!=null' "$first_launch"
check "implement resumed the research session (warm cache)" \
  jq -e -s 'map(select(.phase=="implement"))[0].session | .reuse=="resume" and .reason=="warm_cache"' "$runs_dir"/run-*[0-9a-f].json
check "meta.json sessions.worker carries id + history + ttl" \
  jq -e '.sessions.worker | (.id|type=="string") and (.history_tokens>0) and .cache_ttl=="1h"' "$TICKETS_ROOT/_data/$id_obs/meta.json"
check "events: envelope + strictly increasing global seq" \
  jq -e -s '(map(.seq)) as $s | ($s|length>5) and ([range(1;$s|length)] | all(. as $i | $s[$i] > $s[$i-1])) and all(.v==1 and (.kind|type=="string") and (.ticket|type=="string"))' "$TICKETS_ROOT/events.jsonl"
check "run events flow into ticket stream (session_init/tool/milestone/run_end)" \
  jq -e -s 'map(.kind) as $k | ["run_start","session_init","tool","milestone","run_end"] | all(. as $x | $k|index($x)!=null)' "$TICKETS_ROOT/_data/$id_obs/events.jsonl"
check "runtime.log gets collab rows (lifecycle + run_end), not tool noise" \
  bash -c "grep -q 'category=\"collab\" .*message=\"collab run_end\"' '$WEZTERM_RUNTIME_LOG_FILE' && grep -q 'message=\"collab created\"' '$WEZTERM_RUNTIME_LOG_FILE' && ! grep -q 'collab tool' '$WEZTERM_RUNTIME_LOG_FILE'"

# api contract: every command validates against schema/*.json
run_one="$(jq -r 'select(.phase=="research")|.run' "$runs_dir"/run-*[0-9a-f].json | head -1)"
api_ok=1
for spec in "health" "list --limit 5" "show --id $id_obs" "events --after 0 --limit 50" "events --ticket $id_obs" \
  "run --run $run_one" "prompt --sha $sha" "transcript --run $run_one" "metrics --window all" "metrics --ticket $id_obs" \
  "show --id req-nope-000" "prompt --sha zz" "events --ticket ../x" "bogus"; do
  # shellcheck disable=SC2086
  cmd="${spec%% *}"; [[ "$cmd" == bogus ]] && cmd=health
  out="$("$run" api $spec)"
  if ! python3 "$here/lib/validate_api.py" "$cmd" <<<"$out" 2>"$tmp/val.err"; then
    rc=$?
    [[ $rc -eq 2 ]] && { ok "api schema validation skipped (jsonschema missing)"; api_ok=2; break; }
    api_ok=0; printf 'api %s: %s\n' "$spec" "$(cat "$tmp/val.err")" >&2
  fi
done
[[ $api_ok -eq 1 ]] && ok "api outputs (8 commands + errors) validate against schema/"
[[ $api_ok -eq 0 ]] && bad "api outputs validate against schema/"
ref_obs="$("$run" api show --id "$id_obs" | jq -r '.reference')"
check "api show reference: concise core metadata (id, route, dir, show command)" \
  bash -c 'r=$1; id=$2; grep -qx "\[wezdeck 工单\] obs ticket" <<<"$(head -1 <<<"$r")" &&
    grep -q "^id: $id · 类型 ticket" <<<"$r" && grep -q "^路由: ai-video-collection → wezdeck · 状态 " <<<"$r" &&
    grep -q "^目录: .*/_data/$id/$" <<<"$r" &&
    grep -qx "查看: ticket api show --id $id" <<<"$(tail -1 <<<"$r")" &&
    [[ $(wc -l <<<"$r") -le 7 ]]' _ "$ref_obs" "$id_obs"
met="$("$run" api metrics --window all --ticket "$id_obs")"
check "metrics: sessions, reuse mix, cache hit, trigger, per-repo hit, per-reuse cost" \
  jq -e '.runs==2 and .sessions==1 and .by_reuse.resume.runs==1 and .reuse_reasons.warm_cache==1 and .cache_hit_rate==0.6566 and .by_trigger.cli==2 and .by_backend.claude.runs==2
    and .by_repo.wezdeck.cache_hit_rate==0.6566 and (.by_reuse.resume.cost_usd|type=="number")' <<<"$met"
check "health --repo matches from/to" jq -e '.tickets>=1 and .scope.repo=="wezdeck"' <<<"$("$run" api health --repo wezdeck)"
check "health --repo unknown → 0" jq -e '.tickets==0' <<<"$("$run" api health --repo nope)"
check "metrics --repo unknown → 0 runs" jq -e '.runs==0 and .scope.repo=="nope"' <<<"$("$run" api metrics --window all --repo nope)"
TICKET_TRIGGER_SOURCE=fe1-web "$run" set-status --id "$id_obs" --status shipped --owner initiator >/dev/null 2>&1
check "lifecycle events record via (fe1-web)" jq -e -s 'map(select(.kind=="status"))|last|.via=="fe1-web"' "$TICKETS_ROOT/_data/$id_obs/events.jsonl"
check "runtime.log collab row carries via" grep -q 'via="fe1-web"' "$WEZTERM_RUNTIME_LOG_FILE"
cur="$("$run" api events --after 0 --limit 3 | jq '.next')"
check "events cursor pages forward" jq -e --argjson c "$cur" '.events[0].seq == ($c+1)' <<<"$("$run" api events --after "$cur" --limit 1)"

# reuse decisions (observe.py decide_reuse)
dr() { python3 -c "import sys; sys.path.insert(0,'$here/lib'); import observe as o, json; print(json.dumps(o.decide_reuse('$id_obs','worker',sys.argv[1],sys.argv[2])))" "$@"; }
wt_obs="$(jq -r '.sessions.worker.worktree' "$TICKETS_ROOT/_data/$id_obs/meta.json")"
check "reuse: other backend → fresh/backend_changed" jq -e '.reuse=="fresh" and .reason=="backend_changed"' <<<"$(dr codex "$wt_obs")"
check "reuse: other worktree → fresh/worktree_changed" jq -e '.reason=="worktree_changed"' <<<"$(dr claude /elsewhere)"
python3 - "$TICKETS_ROOT/_data/$id_obs/meta.json" <<'PY2'
import json,sys
p=sys.argv[1]; m=json.load(open(p)); m["sessions"]["worker"]["last_used_epoch"]-=7200; m["sessions"]["worker"]["history_tokens"]=200000; json.dump(m,open(p,"w"))
PY2
check "reuse: idle past ttl + big history → fresh/stale_cache" jq -e '.reuse=="fresh" and .reason=="stale_cache"' <<<"$(dr claude "$wt_obs")"
python3 - "$TICKETS_ROOT/_data/$id_obs/meta.json" <<'PY2'
import json,sys
p=sys.argv[1]; m=json.load(open(p)); m["sessions"]["worker"]["history_tokens"]=5000; json.dump(m,open(p,"w"))
PY2
check "reuse: idle past ttl + small history → resume/small_history" jq -e '.reuse=="resume" and .reason=="small_history"' <<<"$(dr claude "$wt_obs")"
check "reuse: TICKET_SESSION_REUSE=0 → fresh/disabled" jq -e '.reason=="disabled"' <<<"$(TICKET_SESSION_REUSE=0 dr claude "$wt_obs")"

# resume failure falls back to one fresh run with reason resume_failed
python3 - "$TICKETS_ROOT/_data/$id_obs/meta.json" <<'PY2'
import json,sys,time
p=sys.argv[1]; m=json.load(open(p)); m["sessions"]["worker"]["last_used_epoch"]=int(time.time()); json.dump(m,open(p,"w"))
PY2
(
  # shellcheck source=/dev/null
  . "$here/lib/common.sh" 2>/dev/null; . "$here/../../scripts/dev/host-agent-invoke/lib/host-agent-invoke.sh"; . "$here/lib/worker.sh"
  TOOL_ROOT="$here"; printf 'x\n' >"$tmp/p.md"
  HOST_AGENT_INVOKE_MOCK=1 HOST_AGENT_INVOKE_MOCK_RC=1 HOST_AGENT_INVOKE_MOCK_STREAM="$fx/claude.stream.jsonl" \
    ticket_worker_invoke claude "$wt_obs" "$tmp/p.md" "$tmp/w.log" write "$id_obs" implement >/dev/null 2>&1
)
check "resume failure retries once fresh (reason resume_failed)" \
  jq -e -s 'map(.session) | (map(select(.reason=="resume_failed"))|length==1)' "$runs_dir"/run-*[0-9a-f].json

# retention: old streams/launches/unreferenced prompts/global events pruned; run records kept
old_run="$runs_dir/run-19990101-000000-aaaaaa"
printf '{}\n' >"$old_run.stream.jsonl"; printf '{"prompt":{"store_sha256":"%s"}}\n' "$(printf 0%.0s {1..64})" >"$old_run.launch.json"
printf '{"run":"x"}\n' >"$old_run.json"
printf 'old\n' >"$TICKETS_ROOT/prompts/$(printf 1%.0s {1..64}).md"
touch -d '40 days ago' "$old_run.stream.jsonl" "$old_run.launch.json" "$TICKETS_ROOT/prompts/$(printf 1%.0s {1..64}).md"
printf '{"v":1,"seq":0,"ticket":"x","kind":"old","ts":"1999-01-01T00:00:00Z"}\n' >>"$TICKETS_ROOT/events.jsonl"
ret="$(python3 "$here/lib/observe.py" retention --force)"
check "retention prunes old stream/launch/prompt/global events, keeps run record + live prompt" \
  bash -c "jq -e '.streams>=1 and .launches>=1 and .prompts==1 and .events==1' <<<'$ret' >/dev/null && test -f '$old_run.json' && test ! -f '$old_run.stream.jsonl' && test -f '$TICKETS_ROOT/prompts/$sha.md'"

# --- standalone run gate (lib/gate.py): same slots + memory budget as fan-out ---
gate_meminfo="$tmp/gate-meminfo"
slots="$TICKETS_ROOT/.locks/slots"
gate_env=(env TICKET_MEMINFO_PATH="$gate_meminfo" TICKET_GATE_TICK=0.2 TICKET_RUN_MEM_MB=1000 TICKET_MEM_FLOOR_MB=2048)
gid() { "$run" create --to wezdeck --from avc --title "$1" --observed o --assumed a 2>/dev/null | jq -r .id; }
ev() { jq -c -s "$1" "$TICKETS_ROOT/_data/$2/events.jsonl"; }
# memory: queue while it does not fit, run once it does
g1="$(gid "gate mem")"
printf 'MemAvailable:   2048000 kB\n' >"$gate_meminfo"   # 2000 MB: 2000-0-1000 < 2048
( "${gate_env[@]}" "$run" run --id "$g1" --phase research --mock >"$tmp/g1.out" 2>"$tmp/g1.err" ) & g1pid=$!
sleep 1
check "gate: low memory queues the run (event + progress), nothing claimed yet" \
  bash -c "jq -e -s '[.[]|select(.kind==\"queued\" and .gate==\"mem\" and .est_mb==1000)]|length==1' '$TICKETS_ROOT/_data/$g1/events.jsonl' >/dev/null && jq -e '.step==\"queued\"' '$TICKETS_ROOT/_data/$g1/progress.json' >/dev/null && ! grep -q '\"claimed\"' '$TICKETS_ROOT/_data/$g1/events.jsonl'"
check "gate: waiting reason on stderr for the blocked caller" grep -q 'queued: 2000 MB free' "$tmp/g1.err"
printf 'MemAvailable:   16000000 kB\n' >"$gate_meminfo"
wait "$g1pid"; rc_g1=$?
check "gate: runs once memory fits; dispatched records the wait" \
  bash -c "[ $rc_g1 -eq 0 ] && jq -e -s '[.[]|select(.kind==\"dispatched\")][0]|.queue_wait_ms>=500' '$TICKETS_ROOT/_data/$g1/events.jsonl' >/dev/null && grep -q '\"claimed\"' '$TICKETS_ROOT/_data/$g1/events.jsonl'"
check "gate: the slot is free again after the run" python3 -c "
import fcntl, sys
for i in range(8):
    try:
        f = open('$slots/%d.lock' % i)
    except FileNotFoundError:
        continue
    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)"
# a held slot (another run, any kind) is reserved for: 4000 - ~1000 - 1000 < 2048
sleep 300 & holder=$!
python3 -c "
import fcntl, os, sys, time
os.makedirs('$slots', exist_ok=True)
f = open('$slots/0.lock', 'a+'); fcntl.flock(f, fcntl.LOCK_EX); f.seek(0); f.truncate(); f.write('$holder'); f.flush()
open('$tmp/holding', 'w').close(); time.sleep(300)" & locker=$!
for _ in $(seq 1 25); do [ -f "$tmp/holding" ] && break; sleep 0.2; done
printf 'MemAvailable:   4096000 kB\n' >"$gate_meminfo"
g2="$(gid "gate reserve")"
( "${gate_env[@]}" "$run" run --id "$g2" --phase research --mock >/dev/null 2>&1 ) & g2pid=$!
sleep 1
check "gate: reserves for runs already holding a slot (fan-out or standalone)" \
  jq -e -s '[.[]|select(.kind=="queued" and .gate=="mem")][0]|.reserved_mb>=900' "$TICKETS_ROOT/_data/$g2/events.jsonl"
# end the queued run's whole tree (subshell → run.sh → gate.py) by its unique id
pkill -f -- "--id $g2" 2>/dev/null; wait "$g2pid" 2>/dev/null
check "gate: the abandoned queued run is gone (no stray gate racing later checks)" bash -c "! pgrep -f -- 'gate[.]py --id $g2' >/dev/null"
# slots: TICKET_MAX_PARALLEL=1 and slot 0 held → queue on slot
printf 'MemAvailable:   16000000 kB\n' >"$gate_meminfo"
g3="$(gid "gate slot")"
( "${gate_env[@]}" TICKET_MAX_PARALLEL=1 "$run" run --id "$g3" --phase research --mock >/dev/null 2>&1 ) & g3pid=$!
sleep 1
check "gate: all slots busy queues with gate=slot" jq -e -s '[.[]|select(.kind=="queued")][0].gate=="slot"' "$TICKETS_ROOT/_data/$g3/events.jsonl"
kill "$locker" "$holder" 2>/dev/null; wait "$locker" "$holder" 2>/dev/null
wait "$g3pid"; rc_g3=$?
check "gate: a freed slot lets the queued run through" bash -c "[ $rc_g3 -eq 0 ] && grep -q '\"dispatched\"' '$TICKETS_ROOT/_data/$g3/events.jsonl'"
# a fan-out scheduler's child is gated already: no second gate
printf 'MemAvailable:   1024000 kB\n' >"$gate_meminfo"
g4="$(gid "gate child")"
"${gate_env[@]}" TICKET_PARENT_SCHEDULER=req-parent "$run" run --id "$g4" --phase research --mock >/dev/null 2>&1
check "gate: scheduler children skip the standalone gate" bash -c "! grep -q '\"queued\"' '$TICKETS_ROOT/_data/$g4/events.jsonl' && grep -q '\"claimed\"' '$TICKETS_ROOT/_data/$g4/events.jsonl'"

echo "---"
printf 'pass=%d fail=%d\n' "$pass" "$fail"
echo "isolated root: $TICKETS_ROOT"
[[ "$fail" -eq 0 ]]
