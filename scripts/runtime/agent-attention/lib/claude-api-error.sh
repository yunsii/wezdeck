#!/usr/bin/env bash
# Claude API Error detection for attention emit (idle_prompt path).
# When Claude prints an API Error the TUI returns to the prompt but Stop
# often never fires — attention stays running. idle_prompt then arrives;
# if the transcript's newest signal is that API Error, treat the turn as
# done (same as the terminal).
#
# claude_api_error_recent <session_id>
#   exit 0 + prints a one-line reason when the newest transcript signal is
#   an API Error; exit 1 otherwise.

claude_transcript_path() {
  local sid="$1"
  [[ -n "$sid" ]] || return 1
  local root="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/projects"
  [[ -d "$root" ]] || return 1
  # Session files are ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
  local path=""
  local d
  for d in "$root"/*/; do
    [[ -f "${d}${sid}.jsonl" ]] || continue
    path="${d}${sid}.jsonl"
    break
  done
  [[ -n "$path" ]] || return 1
  printf '%s\n' "$path"
}

# Newest signal in the transcript tail: "error" | "user" | "other".
# Prints the error first line on stdout when the newest signal is error.
claude_api_error_recent() {
  local sid="$1"
  local path
  path="$(claude_transcript_path "$sid")" || return 1
  [[ -n "$path" && -f "$path" ]] || return 1
  python3 - "$path" <<'PY'
import json, os, sys

path = sys.argv[1]
try:
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        if size > 262144:
            f.seek(size - 262144)
            f.readline()
        data = f.read()
except OSError:
    sys.exit(1)

last = None  # "error" | "user" | "other"
reason = ""


def text_of(msg):
    content = (msg or {}).get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                parts.append(str(b["text"]))
        return "\n".join(parts).strip()
    return ""


for line in data.splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        row = json.loads(line)
    except Exception:
        continue
    if row.get("isMeta"):
        continue
    typ = row.get("type") or ""
    msg = row.get("message") or {}
    model = str(msg.get("model") or "")
    text = text_of(msg)
    is_err = bool(row.get("isApiErrorMessage")) or (
        model.startswith("<") and text.startswith("API Error:")
    )
    if typ == "assistant" and is_err and text:
        last = "error"
        reason = text.split("\n", 1)[0][:160]
    elif typ == "user":
        # Human (or queued human) input after the error starts a new turn.
        content = text_of(msg) if text else ""
        if not content:
            # content may be blocks; already in text_of
            raw = msg.get("content")
            if isinstance(raw, str):
                content = raw.strip()
        if content and not content.startswith("<"):
            last = "user"
        elif typ == "user":
            # attachment-only / harness user lines: ignore for "after error"
            pass
    elif typ == "assistant" and text:
        last = "other"

if last == "error" and reason:
    print(reason)
    sys.exit(0)
sys.exit(1)
PY
}

# If idle_prompt should end the turn for a Claude API Error, set:
#   status=done, reason_override, AGENT_ATTENTION_DONE_KIND=api_error
# and return 0. Otherwise return 1 (caller should ignore as before).
# Usage: claude_api_error_end_turn_from_idle <session_id> || true
claude_api_error_end_turn_from_idle() {
  local sid="$1"
  local reason=""
  [[ -n "$sid" ]] || return 1
  reason="$(claude_api_error_recent "$sid" 2>/dev/null)" || return 1
  status="done"
  reason_override="${reason:-API Error}"
  AGENT_ATTENTION_DONE_KIND="api_error"
  export AGENT_ATTENTION_DONE_KIND
  runtime_log_info attention "api error ends turn" \
    "provider=${provider:-}" \
    "session_id=$sid" \
    "notification_type=idle_prompt" \
    "reason=${reason_override:0:120}" \
    "wezterm_pane=${WEZTERM_PANE:-}" \
    "tmux_pane=${TMUX_PANE:-}" \
    "entry_ts_ms=${entry_ts_ms:-}" 2>/dev/null || true
  return 0
}
