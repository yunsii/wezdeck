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

# --- claim / lease conflict ---
claim1="$("$run" claim --id "$id" --by agent-a --lease-hours 2 2>/dev/null)"
check "claim a ok" jq -e '.ok == true and .claimed_by == "agent-a"' <<<"$claim1"
claim2="$("$run" claim --id "$id" --by agent-b --lease-hours 2 2>/dev/null)" || true
check "second claim blocked while lease held" jq -e '.ok == false' <<<"$claim2"

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
