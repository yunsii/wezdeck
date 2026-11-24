#!/usr/bin/env bash
# Frame-by-frame flash probe for the web console's wide split (会话 / 工单):
# drives the remote test stack in an ego task space (the agent browser), presses
# rows like a person and records every animation frame (DOM state) plus every
# painted frame (trace screenshots, pixels), then reports what flashed. Born from a day of
# "it still flashes" (2026-11-24): screenshots and single assertions missed a
# 70 ms solid-blue row, a frame at the old scroll offset and a Loading… frame.
#
#   scripts/dev/web-frame-probe.sh [sessions|tickets] [--out DIR] [--after MS]
#
# sessions  two real Claude conversations (the newest transcripts under
#           ~/.claude/projects, read through the stack's relay) on throwaway
#           tmux panes; presses B, A, B after warming both
# tickets   two tickets from the stack's store copy; presses 2, 1, 2
#
# Exit 0 = no flash, 1 = findings (printed, and in OUT/summary.json), 2 = setup.
# OUT keeps frames/*.jpg (look at the flagged ones), samples.json, summary.json.
# Wide viewport only (1280×720 via Emulation); a phone pushes pages instead.
# Writes the stack's attention file (sessions); never the live one. Logs one
# `category=web_probe` row per run.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
scenario=sessions
out=''
after=900
while [[ $# -gt 0 ]]; do
  case "$1" in
    sessions|tickets) scenario=$1; shift ;;
    --out) out=$2; shift 2 ;;
    --after) after=$2; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "web-frame-probe: unknown argument $1" >&2; exit 2 ;;
  esac
done
state="${XDG_STATE_HOME:-$HOME/.local/state}/wezdeck/web-frame-probe"
mkdir -p "$state"
out="${out:-$state/$(date +%Y%m%d-%H%M%S)-$scenario}"
mkdir -p "$out/frames"

command -v ego-browser >/dev/null || { echo "web-frame-probe: ego-browser not on PATH (browser backend ego)" >&2; exit 2; }
eval "$("$repo/scripts/dev/remote-test-stack.sh" ensure 2>/dev/null | grep '^export ')"
stack="${WEZDECK_TEST_STACK_DIR:?remote-test-stack.sh ensure printed no env}"
base="${WEZDECK_REMOTE_URL:-http://127.0.0.1:3018}"
token="${WEZDECK_REMOTE_TOKEN:-dev-client-token}"
profile="$("$repo/scripts/runtime/browser-profile.sh" resolve --anon | python3 -c 'import json,sys; print(json.load(sys.stdin)["backend_profile"])')"

sock=''
cleanup() { [[ -n "$sock" ]] && tmux -S "$sock" kill-server 2>/dev/null; true; }
trap cleanup EXIT

if [[ "$scenario" == sessions ]]; then
  mapfile -t ids < <(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null \
    | while read -r f; do [[ $(stat -c %s "$f") -gt 200000 ]] && basename "$f" .jsonl; done | head -2)
  [[ ${#ids[@]} -eq 2 ]] || { echo "web-frame-probe: need two Claude transcripts > 200 KB" >&2; exit 2; }
  dir="$(mktemp -d /tmp/wfp-XXXX)"
  sock="$dir/s"
  entries='{}'
  for i in 0 1; do
    mkdir -p "$dir/w$i"
    tmux -S "$sock" new-session -d -s "p$i" -c "$dir/w$i" -x 100 -y 20 cat
    pane="$(tmux -S "$sock" display-message -p -t "p$i" '#{pane_id}')"
    entries="$(python3 - "$entries" "${ids[$i]}" "$sock" "p$i" "$pane" <<'PY'
import json, sys, time
e = json.loads(sys.argv[1]); sid, sock, name, pane = sys.argv[2:]
e[sid] = dict(session_id=sid, tmux_socket=sock, tmux_session=name, tmux_pane=pane,
              status="idle", agent_name="claude", tmux_window_name=name,
              last_user_prompt="probe", ts=int(time.time() * 1000))
print(json.dumps(e))
PY
)"
  done
  printf '{"entries":%s}\n' "$entries" > "$stack/attention.json"
  a="[data-session=\"${ids[0]}\"]"; b="[data-session=\"${ids[1]}\"]"
  url="$base/zh/console/sessions/${ids[0]}?remote=1#pair=$token"
  cfg_extra="$(printf '"rowSelector":%s,"warm":[%s,%s],"presses":[%s,%s,%s],"titleSelector":"[data-testid=session-title]","selectedSelector":".vt-split-list [data-session].row-selected","idAttr":"data-session"' \
    "$(jq -Rn --arg v "$a" '$v')" "$(jq -Rn --arg v "$b" '$v')" "$(jq -Rn --arg v "$a" '$v')" \
    "$(jq -Rn --arg v "$b" '$v')" "$(jq -Rn --arg v "$a" '$v')" "$(jq -Rn --arg v "$b" '$v')")"
else
  mapfile -t ids < <(TICKETS_ROOT="$stack/tickets" python3 "$repo/skills/agent-collab/lib/api.py" list --status closed,shipped --limit 2 | jq -r '.tickets[].id')
  [[ ${#ids[@]} -eq 2 ]] || { echo "web-frame-probe: the stack's store copy has < 2 tickets" >&2; exit 2; }
  a="[data-ticket=\"${ids[0]}\"]"; b="[data-ticket=\"${ids[1]}\"]"
  url="$base/zh/console/collab/${ids[0]}?remote=1#pair=$token"
  cfg_extra="$(printf '"rowSelector":%s,"warm":[],"presses":[%s,%s,%s],"filter":"已结束","titleSelector":"[data-testid=ticket-pane] h1","selectedSelector":".vt-split-list [data-ticket].row-selected","idAttr":"data-ticket"' \
    "$(jq -Rn --arg v "$a" '$v')" "$(jq -Rn --arg v "$b" '$v')" "$(jq -Rn --arg v "$a" '$v')" "$(jq -Rn --arg v "$b" '$v')")"
fi

space="$(cat "$state/space" 2>/dev/null || true)"
cfg="{\"url\":$(jq -Rn --arg v "$url" '$v'),\"space\":${space:-null},\"spaceName\":\"wezdeck 逐帧探针\",\"profile\":\"$profile\",\"width\":1280,\"height\":720,\"mobile\":false,\"settleMs\":2500,\"afterMs\":$after,\"scroller\":\".vt-page\",$cfg_extra}"
script="$(mktemp)"
{ printf 'const CFG = %s\n' "$cfg"; cat "$here/web-frame-probe/probe.mjs"; } > "$script"

ego-browser nodejs < "$script" 2>&1 | python3 -c '
import base64, os, sys
out = sys.argv[1]
for line in sys.stdin:
    if line.startswith("FRAME "):
        _, n, _t, data = line.rstrip("\n").split(" ", 3)
        open(os.path.join(out, "frames", "f%04d.jpg" % int(n)), "wb").write(base64.b64decode(data))
    elif line.startswith("SAMPLES "):
        open(os.path.join(out, "samples.json"), "w").write(line[8:])
    elif line.startswith("SPACE "):
        open(sys.argv[2], "w").write(line[6:].strip())
    else:
        sys.stdout.write(line)
' "$out" "$state/space"
rm -f "$script"
[[ -s "$out/samples.json" ]] || { echo "web-frame-probe: the ego script produced no samples" >&2; exit 2; }

set +e
python3 "$here/web-frame-probe/analyze.py" "$out" --scenario "$scenario"
rc=$?
set -e
findings="$(jq '.findings | length' "$out/summary.json")"
# shellcheck source=/dev/null
source "$repo/scripts/runtime/runtime-log-lib.sh"
runtime_log_info web_probe "frame probe finished" scenario="$scenario" findings="$findings" \
  frames="$(jq '.painted_frames' "$out/summary.json")" accent_max="$(jq '.accent_max' "$out/summary.json")" out="$out" || true
echo "out: $out"
exit "$rc"
