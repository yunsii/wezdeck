#!/usr/bin/env bash
# Probe: discover harness-registered background work that should surface as
# attention running_kind=background after Stop (Claude status=shell, etc.).
#
# Live path is emit.sh (Stop gate + sidecar / Grok backgroundTasks). This
# script is dry-run / schema validation only — it does not write attention.json.
#
# Claude (primary today):
#   Read ~/.claude/sessions/<pid>.json for live PIDs whose status is "shell"
#   (Claude's own label for "turn idle, background bash still running").
#   Enrich with /tmp/claude-*/…/<session>/tasks/*.output and child cmdline.
#
# Grok:
#   Validate a captured Stop hook stdin JSON for backgroundTasks[] /
#   sessionCrons[] shape (--validate-grok-stop). Capture recipe printed by
#   --grok-capture-help (no emit change in Phase 0).
#
# Usage:
#   scripts/dev/attention-bg-probe.sh
#   scripts/dev/attention-bg-probe.sh --provider claude
#   scripts/dev/attention-bg-probe.sh --provider grok --validate-grok-stop FILE
#   scripts/dev/attention-bg-probe.sh --json
#   scripts/dev/attention-bg-probe.sh --grok-capture-help
#
# Flags:
#   --provider P     claude | grok | all   (default: all)
#   --json           machine-readable summary on stdout
#   --session ID     only this session_id / thread id
#   --validate-grok-stop FILE
#                    schema-check a captured Grok Stop stdin payload
#   --grok-capture-help
#                    print how to capture that payload once
#   --sample-dir DIR where validate copies a normalized sample (default:
#                    $runtime_state/.../agent-attention/bg-probe/)
#   --apply          refused (exit 2); use real agent Stop / hooks to upsert
#
# Exit:
#   0  ran; printed findings (including "none")
#   1  usage / IO error
#   2  --apply refused, or grok sample failed schema

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/attention-state-lib.sh"
# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/windows-runtime-paths-lib.sh" 2>/dev/null || true
windows_runtime_detect_paths >/dev/null 2>&1 || true

provider=all
json_out=0
session_filter=''
grok_stop_file=''
grok_capture_help=0
sample_dir=''
apply=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) provider="$2"; shift 2 ;;
    --json) json_out=1; shift ;;
    --session) session_filter="$2"; shift 2 ;;
    --validate-grok-stop) grok_stop_file="$2"; shift 2 ;;
    --grok-capture-help) grok_capture_help=1; shift ;;
    --sample-dir) sample_dir="$2"; shift 2 ;;
    --apply) apply=1; shift ;;
    -h|--help) sed -n '2,48p' "$0"; exit 0 ;;
    *) printf 'unknown flag: %s\n' "$1" >&2; exit 1 ;;
  esac
done

if [[ "$apply" -eq 1 ]]; then
  printf '%s\n' \
    'Refusing --apply: attention upserts go through emit.sh hooks.' \
    'Seed happens on Bash bg PostToolUse + Stop; re-run without --apply.' >&2
  exit 2
fi

case "$provider" in
  claude|grok|all) ;;
  *) printf 'unknown --provider %s (claude|grok|all)\n' "$provider" >&2; exit 1 ;;
esac

attention_json="$(attention_state_path)"
state_dir="$(dirname "$attention_json")"
if [[ -z "$sample_dir" ]]; then
  sample_dir="$state_dir/bg-probe"
fi

print_grok_capture_help() {
  cat <<'EOF'
Capture one Grok Stop stdin payload (Phase 0 schema sample):

  1. Start a Grok pane, run a background shell, e.g.:
       ask Grok to: run `sleep 120` with background:true, then finish the turn
  2. Temporarily wrap the Stop hook command so stdin is teed, e.g. in
     ~/.claude/settings.json (Grok loads Claude hooks by compat) or a
     ~/.grok/hooks/*.json Stop entry:

       command: "tee /tmp/attention-bg-probe-grok-stop.json | <existing emit … done>"

  3. Trigger Stop (let the turn end while the bg task still runs).
  4. Validate:

       scripts/dev/attention-bg-probe.sh --provider grok \
         --validate-grok-stop /tmp/attention-bg-probe-grok-stop.json

  Expected keys (camelCase on the wire): backgroundTasks[], sessionCrons[].
  Each backgroundTasks[] entry: id, type (shell|monitor|subagent), status,
  plus command (shell) or description (monitor/subagent).

  Leave the tee in place only for one capture; restore the plain emit after.
EOF
}

if [[ "$grok_capture_help" -eq 1 ]]; then
  print_grok_capture_help
  exit 0
fi

validate_grok_stop() {
  local file="$1"
  if [[ ! -r "$file" ]]; then
    printf 'grok Stop sample not readable: %s\n' "$file" >&2
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    printf 'jq required for --validate-grok-stop\n' >&2
    return 1
  fi

  local report
  report="$(jq -r '
    def is_obj: type == "object";
    def arr: if . == null then [] elif type == "array" then . else [.] end;
    def task_ok:
      (has("id") or has("taskId") or has("task_id"))
      and ((.type // .taskType // "") | test("^(shell|monitor|subagent)$"));
    def cron_ok:
      (has("id") or has("jobId") or has("job_id"));
    if (is_obj | not) then
      "FAIL: root is not an object"
    else
      (.backgroundTasks // .background_tasks // null) as $bt
      | (.sessionCrons // .session_crons // null) as $sc
      | if $bt == null and $sc == null then
          "FAIL: neither backgroundTasks nor sessionCrons present"
        elif $bt != null and (($bt | type) != "array") then
          "FAIL: backgroundTasks is not an array"
        elif $sc != null and (($sc | type) != "array") then
          "FAIL: sessionCrons is not an array"
        else
          ($bt | arr) as $tasks
          | ($sc | arr) as $crons
          | ($tasks | map(select(task_ok | not)) | length) as $bad_t
          | ($crons | map(select(cron_ok | not)) | length) as $bad_c
          | if $bad_t > 0 then
              "FAIL: \($bad_t) backgroundTasks entries missing id/type"
            elif $bad_c > 0 then
              "FAIL: \($bad_c) sessionCrons entries missing id"
            else
              "OK tasks=\($tasks|length) shell=\($tasks|map(select((.type//"")=="shell"))|length) monitor=\($tasks|map(select((.type//"")=="monitor"))|length) subagent=\($tasks|map(select((.type//"")=="subagent"))|length) crons=\($crons|length)"
            end
        end
    end
  ' "$file")"

  printf 'grok Stop sample: %s\n' "$file"
  printf '  %s\n' "$report"
  if [[ "$report" != OK* ]]; then
    return 2
  fi

  mkdir -p "$sample_dir"
  local dest="$sample_dir/grok-stop-sample.json"
  jq '{
      captured_note: "Phase 0 schema sample; redact secrets before sharing",
      backgroundTasks: (.backgroundTasks // .background_tasks // []),
      sessionCrons: (.sessionCrons // .session_crons // []),
      hook_event_name: (.hook_event_name // .hookEventName // null),
      reason: (.reason // null)
    }' "$file" >"$dest"
  printf '  normalized copy: %s\n' "$dest"

  # Proposed attention rows (dry-run) for shell tasks only — Phase 0 scope.
  jq -r '
    (.backgroundTasks // .background_tasks // [])
    | map(select((.type // "") == "shell"))
    | if length == 0 then
        "  proposed: (no shell tasks — Stop would stay done under default filter)"
      else
        .[] |
        "  proposed: status=running running_kind=background type=shell id=\(.id // .taskId // "?") summary=\((.command // .description // "")[0:80])"
      end
  ' "$file"
  return 0
}

probe_claude() {
  local py_out
  py_out="$(SESSION_FILTER="$session_filter" ATTENTION_JSON="$attention_json" python3 - <<'PY'
import json, os, glob, pathlib, re, subprocess
from datetime import datetime, timezone

session_filter = os.environ.get("SESSION_FILTER") or ""
attention_path = os.environ.get("ATTENTION_JSON") or ""

def pid_alive(pid):
    try:
        return pid and os.path.exists(f"/proc/{int(pid)}")
    except Exception:
        return False

def child_summary(pid, limit=3, depth=0):
    """Interesting descendant cmdlines under pid (unwrap claude/zsh shells)."""
    if depth > 4:
        return []
    try:
        out = subprocess.check_output(
            ["ps", "--ppid", str(pid), "-o", "pid=,etime=,cmd="],
            text=True, stderr=subprocess.DEVNULL,
        )
    except Exception:
        return []
    rows = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        if "agent-resume" in line or "primary-pane-wrapper" in line:
            continue
        rows.append(re.sub(r"\s+", " ", line)[:200])
        if len(rows) >= limit:
            break
    if not rows:
        return []
    # Unwrap a single wrapper (nested claude binary or zsh -c snapshot).
    if len(rows) == 1:
        only = rows[0]
        m = re.match(r"^(\d+)\s+", only)
        if m and (
            "/claude" in only
            or "zsh -c" in only
            or "shell-snapshots" in only
        ):
            deeper = child_summary(int(m.group(1)), limit, depth + 1)
            if deeper:
                return deeper
    return rows

def task_dir_for(session_id):
    if not session_id:
        return None
    for root in pathlib.Path("/tmp").glob("claude-*"):
        matches = list(root.glob(f"**/{session_id}/tasks"))
        if matches:
            return str(matches[0])
    return None

def open_tasks(tasks_dir):
    if not tasks_dir or not os.path.isdir(tasks_dir):
        return []
    found = []
    for p in sorted(pathlib.Path(tasks_dir).glob("*.output")):
        try:
            data = p.read_text(errors="replace")
        except Exception:
            continue
        name = p.name[: -len(".output")] if p.name.endswith(".output") else p.name
        # symlink to subagent jsonl is not a shell bg task
        if p.is_symlink():
            continue
        exited = "[exited with code" in data
        empty = len(data.strip()) == 0
        # Heuristic: empty = likely live; non-empty without exited marker may
        # be stale orphan output — still report with confidence=low.
        if empty:
            conf = "high"
        elif not exited:
            conf = "low"
        else:
            continue
        found.append({
            "id": name,
            "path": str(p),
            "bytes": p.stat().st_size,
            "empty": empty,
            "confidence": conf,
        })
    return found

attention_entry = {}
if attention_path and os.path.isfile(attention_path):
    try:
        attention_entry = json.load(open(attention_path)).get("entries") or {}
    except Exception:
        attention_entry = {}

candidates = []
for path in glob.glob(os.path.expanduser("~/.claude/sessions/*.json")):
    try:
        d = json.load(open(path))
    except Exception:
        continue
    status = d.get("status") or ""
    if status != "shell":
        continue
    pid = d.get("pid")
    if not pid_alive(pid):
        continue
    sid = d.get("sessionId") or d.get("session_id") or ""
    if session_filter and sid != session_filter and not sid.startswith(session_filter):
        continue
    tmux = d.get("tmux") or ""
    # tmux field shape: "<session>:@<win>.%<pane>"
    tmux_session = tmux_window = tmux_pane = ""
    m = re.match(r"^([^:]+):(@\d+)\.(%\d+)$", tmux)
    if m:
        tmux_session, tmux_window, tmux_pane = m.group(1), m.group(2), m.group(3)
    tasks_dir = task_dir_for(sid)
    tasks = open_tasks(tasks_dir)
    att = attention_entry.get(sid) or {}
    children = child_summary(pid)
    summary = ""
    if children:
        summary = children[0]
        # Drop leading "pid etime " from ps rows when present.
        summary = re.sub(r"^\d+\s+\S+\s+", "", summary)
        if "eval '" in summary:
            summary = summary.split("eval '", 1)[-1].rstrip("'")[:100]
        elif "node " in summary:
            summary = summary[summary.find("node "):][:100]
        elif "/claude" in summary or "zsh -c" in summary:
            summary = summary[:100]
    elif tasks:
        summary = f"task:{tasks[0]['id']}"
    proposed_reason = "bg·shell: " + (summary or sid[:8])
    candidates.append({
        "provider": "claude",
        "session_id": sid,
        "claude_status": status,
        "pid": pid,
        "name": d.get("name") or "",
        "cwd": d.get("cwd") or "",
        "tmux_raw": tmux,
        "tmux_session": tmux_session,
        "tmux_window": tmux_window,
        "tmux_pane": tmux_pane,
        "tasks_dir": tasks_dir or "",
        "open_tasks": tasks,
        "children": children,
        "attention_status": att.get("status") or "(absent)",
        "attention_reason": (att.get("reason") or "")[:80],
        "proposed": {
            "status": "running",
            "running_kind": "background",
            "reason": proposed_reason[:120],
            "bg": {
                "source": "claude-session-status-shell",
                "tasks": [
                    {"id": t["id"], "type": "shell", "summary": proposed_reason[:80]}
                    for t in tasks if t.get("confidence") == "high"
                ] or ([{"id": "unknown", "type": "shell", "summary": proposed_reason[:80]}] if children else []),
            },
        },
        "gap": att.get("status") != "running",
    })

print(json.dumps({"provider": "claude", "candidates": candidates}, ensure_ascii=False))
PY
)"

  if [[ "$json_out" -eq 1 ]]; then
    # Will merge later when provider=all; for claude-only print now.
    if [[ "$provider" == "claude" ]]; then
      printf '%s\n' "$py_out"
    else
      printf '%s' "$py_out"
    fi
    CLAUDE_JSON="$py_out"
    return 0
  fi

  local n
  n="$(printf '%s' "$py_out" | jq -r '.candidates|length')"
  printf 'Claude: %s live session(s) with status=shell\n' "$n"
  if [[ "$n" -eq 0 ]]; then
    printf '  (none — no alive ~/.claude/sessions/*.json with status=shell)\n'
    CLAUDE_JSON="$py_out"
    return 0
  fi

  printf '%s' "$py_out" | jq -r '
    .candidates[] |
    (
      "  session=\(.session_id)\n" +
      "    name=\(.name) pid=\(.pid) claude_status=\(.claude_status)\n" +
      "    tmux=\(.tmux_session) \(.tmux_window) \(.tmux_pane)\n" +
      "    cwd=\(.cwd)\n" +
      "    attention_now=\(.attention_status) reason=\(.attention_reason)\n" +
      "    gap=\(.gap)\n" +
      "    children:\n" +
      (if (.children|length)==0 then "      (none)\n" else (.children[] | "      - \(.)\n") end) +
      "    open_tasks (non-exited outputs):\n" +
      (if (.open_tasks|length)==0 then "      (none)\n" else
         (.open_tasks[] | "      - id=\(.id) conf=\(.confidence) bytes=\(.bytes)\n") end) +
      "    proposed: status=\(.proposed.status) running_kind=\(.proposed.running_kind)\n" +
      "              reason=\(.proposed.reason)\n" +
      "              bg.tasks=\(.proposed.bg.tasks|tostring)\n"
    )
  '
  CLAUDE_JSON="$py_out"
}

CLAUDE_JSON='{"provider":"claude","candidates":[]}'
GROK_SECTION=''

if [[ "$provider" == "claude" || "$provider" == "all" ]]; then
  probe_claude
fi

if [[ "$provider" == "grok" || "$provider" == "all" ]]; then
  if [[ -n "$grok_stop_file" ]]; then
    set +e
    validate_grok_stop "$grok_stop_file"
    grok_rc=$?
    set -e
    if [[ "$grok_rc" -ne 0 ]]; then
      exit "$grok_rc"
    fi
  else
    if [[ "$json_out" -eq 0 ]]; then
      printf 'Grok: no --validate-grok-stop FILE given\n'
      if [[ -f "$sample_dir/grok-stop-sample.json" ]]; then
        printf '  existing normalized sample: %s\n' "$sample_dir/grok-stop-sample.json"
        printf '  re-validate: %s --provider grok --validate-grok-stop %s\n' \
          "$0" "$sample_dir/grok-stop-sample.json"
      else
        printf '  no sample yet — run: %s --grok-capture-help\n' "$0"
      fi
    fi
  fi
fi

if [[ "$json_out" -eq 1 && "$provider" == "all" ]]; then
  # Merge claude blob; grok is side-channel unless validating.
  printf '%s\n' "$CLAUDE_JSON" | jq --argjson grok_ok "$(
    if [[ -f "$sample_dir/grok-stop-sample.json" ]]; then echo true; else echo false; fi
  )" '. + {grok_sample_present: $grok_ok}'
fi

if [[ "$json_out" -eq 0 ]]; then
  printf '\nPhase 0 dry-run only — attention.json untouched (%s).\n' "$attention_json"
fi
