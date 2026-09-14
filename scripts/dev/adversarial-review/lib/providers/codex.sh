#!/usr/bin/env bash
# provider plugin: codex (Codex CLI, native/default host config). alias: gpt
# Uses host-agent-invoke read profile. Interface: __available / __family / __model / __invoke

_CODEX_HOST_INVOKE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../host-agent-invoke/lib" && pwd)/host-agent-invoke.sh"
# shellcheck source=/dev/null
. "$_CODEX_HOST_INVOKE"

_codex_bin() {
  if command -v codex >/dev/null 2>&1; then command -v codex; return 0; fi
  local c
  for c in "$HOME/.local/bin/codex" "$HOME/.codex/bin/codex"; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

# Codex exec emits NDJSON; pull the final agent message text.
_codex_extract_text() {
  python3 -c '
import sys, json
last = ""
for ln in sys.stdin:
    ln = ln.strip()
    if not ln:
        continue
    try:
        ev = json.loads(ln)
    except Exception:
        continue
    for key in ("text", "delta", "content", "message"):
        v = ev.get(key)
        if isinstance(v, str) and v.strip():
            last = v
        elif isinstance(v, dict):
            c = v.get("content") or v.get("text")
            if isinstance(c, str) and c.strip():
                last = c
            elif isinstance(c, list):
                parts = []
                for item in c:
                    if isinstance(item, dict) and isinstance(item.get("text"), str):
                        parts.append(item["text"])
                    elif isinstance(item, str):
                        parts.append(item)
                if parts:
                    last = "".join(parts)
    if ev.get("type") in ("agent_message", "message", "item.completed"):
        item = ev.get("item") or ev.get("message") or {}
        if isinstance(item, dict):
            tx = item.get("text") or item.get("content")
            if isinstance(tx, str) and tx.strip():
                last = tx
print(last)
'
}

codex__aliases()  { echo gpt; }
codex__available() { _codex_bin >/dev/null 2>&1; }
codex__family()   { echo codex; }
codex__model()    { printf '%s' "${ADV_MODEL_CODEX:-gpt-5.5}"; }

# stdin = full prompt; $1 = effort. Host CODEX_HOME via host-agent-invoke.
codex__invoke() {
  local effort="${1:-}" model gtmp raw
  model="$(codex__model)"
  gtmp="$(mktemp "${TMPDIR:-/tmp}/codex-prompt.XXXXXX")"
  cat >"$gtmp"
  raw="$(
    host_agent_invoke_run \
      --backend codex --mode read \
      --cwd "${PWD:-.}" --prompt-file "$gtmp" \
      --model "$model" ${effort:+--effort "$effort"} \
      --capture
  )" || true
  rm -f "$gtmp"
  printf '%s' "$raw" | _codex_extract_text
}
