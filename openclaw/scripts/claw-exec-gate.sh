#!/usr/bin/env bash
# Three-layer host-exec gate for YunsClaw:
#   1) rule script (claw-exec-classify.sh)
#   2) Grok lightweight re-check (only when rules say danger, or --always-llm)
#   3) human required only when still risky
#
# Usage:
#   claw-exec-gate.sh "command string"
#   claw-exec-gate.sh --json "command"
#
# Exit codes:
#   0 allow (safe/write, or LLM cleared false-positive)
#   2 danger — human confirmation required (do not run)
#   3 empty/usage
#   4 classifier/LLM infrastructure error (fail closed → treat as need human)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFY="${SCRIPT_DIR}/claw-exec-classify.sh"
JSON_OUT=0
ALWAYS_LLM=0
SKIP_LLM=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_OUT=1; shift ;;
    --always-llm) ALWAYS_LLM=1; shift ;;
    --skip-llm) SKIP_LLM=1; shift ;;
    -h|--help)
      sed -n '2,20p' "$0" | tr -d '#'
      exit 0
      ;;
    --) shift; break ;;
    -*)
      echo "unknown flag: $1" >&2
      exit 3
      ;;
    *) break ;;
  esac
done

cmd="${*:-}"
if [[ -z "${cmd}" && ! -t 0 ]]; then
  cmd="$(cat)"
fi
if [[ -z "${cmd}" ]]; then
  echo '{"decision":"deny","layer":"input","label":"danger","reason":"empty command","human_required":true}'
  exit 3
fi

[[ -x "${CLASSIFY}" ]] || { echo "missing ${CLASSIFY}" >&2; exit 4; }

# --- Layer 1: rules ---
set +e
rule_json="$("${CLASSIFY}" "${cmd}" 2>/dev/null)"
rule_ec=$?
set -e
rule_label="$(printf '%s' "${rule_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("label","write"))' 2>/dev/null || echo write)"
rule_reason="$(printf '%s' "${rule_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason",""))' 2>/dev/null || true)"

emit() {
  # decision allow|deny, layer, label, reason, human_required, llm?
  python3 - <<'PY' "$@"
import json, sys
decision, layer, label, reason, human, llm = sys.argv[1:7]
out = {
  "decision": decision,
  "layer": layer,
  "label": label,
  "reason": reason,
  "human_required": human == "1",
}
if llm and llm != "-":
    out["llm"] = json.loads(llm)
print(json.dumps(out, ensure_ascii=False))
PY
}

# safe / write: allow without LLM (unless --always-llm)
if [[ "${rule_ec}" -eq 0 || "${rule_ec}" -eq 1 ]]; then
  if [[ "${ALWAYS_LLM}" -eq 0 ]]; then
    emit allow rules "${rule_label}" "${rule_reason}" 0 -
    exit 0
  fi
fi

# empty classify
if [[ "${rule_ec}" -eq 3 ]]; then
  emit deny rules danger "empty or invalid" 1 -
  exit 3
fi

# --- Layer 2: Grok re-check for danger (or always-llm) ---
if [[ "${SKIP_LLM}" -eq 1 ]]; then
  emit deny rules "${rule_label}" "LLM skipped: ${rule_reason}" 1 -
  exit 2
fi

llm_json="$(
python3 - <<'PY' "${cmd}" "${rule_label}" "${rule_reason}"
import json, os, sys, urllib.request
from pathlib import Path

cmd, rule_label, rule_reason = sys.argv[1], sys.argv[2], sys.argv[3]

def fail(msg):
    print(json.dumps({"ok": False, "error": msg, "label": "danger", "reason": msg}, ensure_ascii=False))
    raise SystemExit(0)

# credentials from OpenClaw config (local only)
oc_path = Path.home() / ".openclaw" / "openclaw.json"
if not oc_path.is_file():
    fail("no openclaw.json")
cfg = json.loads(oc_path.read_text())
prov = ((cfg.get("models") or {}).get("providers") or {}).get("grok-proxy") or {}
base = (prov.get("baseUrl") or "").rstrip("/")
key = prov.get("apiKey") or os.environ.get("GROK_PROXY_API_KEY") or os.environ.get("XAI_API_KEY")
model = "grok-4.5"
models = prov.get("models") or []
if models and isinstance(models[0], dict) and models[0].get("id"):
    model = models[0]["id"]
if not base or not key:
    fail("missing grok-proxy baseUrl/apiKey")

system = (
    "You are a host-shell risk classifier for a personal coding agent. "
    "Reply with ONLY a single JSON object, no markdown, schema: "
    '{"label":"safe|write|danger","reason":"short","confidence":0.0} '
    "Labels: safe=read-only probe; write=normal dev edit/test/git non-force; "
    "danger=destructive, force-push, secret exfil, pipe-to-shell, system damage. "
    "When unsure between write and danger, choose danger. "
    "Be brief."
)
user = (
    f"Rule pre-label: {rule_label} ({rule_reason})\n"
    f"Command:\n```\n{cmd[:4000]}\n```\n"
    "Classify the command."
)

# OpenAI-compatible Responses API (same as OpenClaw grok-proxy)
url = base + "/responses"
body = {
    "model": model,
    "input": [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ],
}
req = urllib.request.Request(
    url,
    data=json.dumps(body).encode(),
    headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "User-Agent": "YunsClaw-exec-gate/1.0",
        "Accept": "application/json",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode())
except Exception as e:
    detail = ""
    if hasattr(e, "read"):
        try:
            detail = e.read().decode()[:200]
        except Exception:
            pass
    fail(f"llm request failed: {type(e).__name__} {detail}".strip())

text = ""
# responses API: output[].content[].text
try:
    for block in data.get("output") or []:
        for c in block.get("content") or []:
            if c.get("type") in ("output_text", "text") and c.get("text"):
                text += c["text"]
        if block.get("type") == "message":
            for c in block.get("content") or []:
                if c.get("text"):
                    text += c["text"]
except Exception:
    pass
if not text:
    try:
        text = data["choices"][0]["message"]["content"]
    except Exception:
        text = json.dumps(data)[:2000]

# extract first JSON object (model may echo twice)
label, reason, conf = "danger", "unparsed llm output", 0.0
import re
for m in re.finditer(r"\{[^{}]*\}", text):
    try:
        obj = json.loads(m.group(0))
        lab = str(obj.get("label", "")).lower().strip()
        if lab not in ("safe", "write", "danger"):
            continue
        label = lab
        reason = str(obj.get("reason", ""))[:300]
        conf = float(obj.get("confidence", 0) or 0)
        break
    except Exception:
        continue
else:
    # fallback: keyword in text
    low = text.lower()
    if '"label":"safe"' in low or '"label": "safe"' in low:
        label, reason = "safe", "parsed from text"
    elif '"label":"write"' in low or '"label": "write"' in low:
        label, reason = "write", "parsed from text"
    elif "danger" in low:
        label, reason = "danger", "parsed keyword danger from text"
if label not in ("safe", "write", "danger"):
    label = "danger"
    reason = f"invalid label from llm: {label}"

print(json.dumps({
    "ok": True,
    "label": label,
    "reason": reason,
    "confidence": conf,
    "model": model,
    "raw_excerpt": text[:400],
}, ensure_ascii=False))
PY
)"

llm_ok="$(printf '%s' "${llm_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok",False))' 2>/dev/null || echo False)"
llm_label="$(printf '%s' "${llm_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("label","danger"))' 2>/dev/null || echo danger)"
llm_reason="$(printf '%s' "${llm_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason",""))' 2>/dev/null || true)"

if [[ "${llm_ok}" != "True" && "${llm_ok}" != "true" ]]; then
  emit deny llm danger "LLM layer failed: ${llm_reason:-unknown}; human required" 1 "${llm_json:--}"
  exit 4
fi

# --- Layer 3: human only if still danger ---
if [[ "${llm_label}" == "danger" ]]; then
  emit deny llm danger "${llm_reason}" 1 "${llm_json}"
  exit 2
fi

# LLM cleared to safe/write
emit allow llm "${llm_label}" "${llm_reason}" 0 "${llm_json}"
exit 0
