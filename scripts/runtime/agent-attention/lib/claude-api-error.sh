#!/usr/bin/env bash
# Claude API Error / incomplete-turn detection for attention emit (idle_prompt).
# When Claude prints an API Error (or the gateway fails before any assistant
# row is written) the TUI returns to the prompt but Stop often never fires —
# attention stays running. idle_prompt then arrives; if the transcript shows
# that failure mode, treat the turn as done (same as the terminal).
#
# claude_api_error_recent <session_id>
#   exit 0 + prints a one-line reason when the newest transcript signal is
#   an API Error, or a user turn that only got api-request rows (no
#   successful assistant); exit 1 otherwise.

# Prefer CLAUDE_CONFIG_DIR, then ~/.claude, then every
# ~/.config/claude-profiles/*/projects (kimi-home / sub2api home, …).
# Multiple hits: newest mtime wins so a recycled sid under another profile
# does not shadow the live transcript.
claude_transcript_path() {
  local sid="$1"
  [[ -n "$sid" ]] || return 1
  local -a roots=()
  local root d path best="" best_mtime=0 mtime
  if [[ -n "${CLAUDE_CONFIG_DIR:-}" ]]; then
    roots+=("${CLAUDE_CONFIG_DIR}/projects")
  fi
  roots+=("${HOME}/.claude/projects")
  if [[ -d "${HOME}/.config/claude-profiles" ]]; then
    for d in "${HOME}/.config/claude-profiles"/*/projects; do
      [[ -d "$d" ]] || continue
      roots+=("$d")
    done
  fi
  for root in "${roots[@]}"; do
    [[ -d "$root" ]] || continue
    for d in "$root"/*/; do
      path="${d}${sid}.jsonl"
      [[ -f "$path" ]] || continue
      mtime="$(stat -c '%Y' "$path" 2>/dev/null || stat -f '%m' "$path" 2>/dev/null || echo 0)"
      if [[ -z "$best" || "$mtime" -gt "$best_mtime" ]]; then
        best="$path"
        best_mtime="$mtime"
      fi
    done
  done
  [[ -n "$best" ]] || return 1
  printf '%s\n' "$best"
}

# Newest signal in the transcript tail: "error" | "incomplete" | "user" | "other".
# Prints the error / fallback first line on stdout when the turn should end.
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

# last: "error" | "incomplete" | "user" | "other"
last = None
reason = ""
saw_api_after_user = False


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
        saw_api_after_user = False
    elif typ == "user":
        content = text_of(msg) if text else ""
        if not content:
            raw = msg.get("content")
            if isinstance(raw, str):
                content = raw.strip()
        if content and not content.startswith("<"):
            last = "user"
            reason = ""
            saw_api_after_user = False
        # attachment-only / harness user lines: ignore
    elif typ == "assistant" and text:
        last = "other"
        reason = ""
        saw_api_after_user = False
    elif typ.startswith("api-request") and last == "user":
        # Gateway / Anthropic request logged, but no assistant reply yet.
        # Kimi org / auth failures often print in the TUI without writing
        # isApiErrorMessage — idle_prompt is then the only turn-end signal.
        saw_api_after_user = True

if last == "error" and reason:
    print(reason)
    sys.exit(0)
if last == "user" and saw_api_after_user:
    print(reason or "API Error")
    sys.exit(0)
sys.exit(1)
PY
}

# If idle_prompt should end the turn for a Claude API Error / incomplete
# turn, set: status=done, reason_override, AGENT_ATTENTION_DONE_KIND=api_error
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
