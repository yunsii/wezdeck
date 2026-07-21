#!/usr/bin/env bash
# agent-matrix-status.sh — native / ACP / review path matrix (no secrets).
# Usage: ./openclaw/scripts/agent-matrix-status.sh
set -euo pipefail

ok() { printf '  %-20s %s\n' "$1" "$2"; }

bin_ver() {
  local b="$1"
  if command -v "$b" >/dev/null 2>&1; then
    local p v
    p="$(command -v "$b")"
    v="$("$b" --version 2>/dev/null | head -1 | tr -d '\r' || true)"
    printf '%s (%s)' "$p" "${v:-version?}"
  else
    printf 'MISSING'
  fi
}

first_model() {
  local f="$1"
  if [ -f "$f" ]; then
    grep -E '^model = ' "$f" | head -1 || echo 'model = (none)'
  else
    echo "(no file)"
  fi
}

auth_pfx() {
  local f="$1"
  if [ ! -f "$f" ]; then
    echo 'auth=MISSING'
    return
  fi
  python3 - "$f" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
try:
    k = json.loads(p.read_text()).get("OPENAI_API_KEY") or ""
    print("auth_pfx=" + k[:6] + "… len=" + str(len(k)))
except Exception:
    print("auth=unreadable")
PY
}

echo "=== Agent matrix status ($(date -Iseconds)) ==="
echo
echo "## Binaries (host PATH)"
ok "claude" "$(bin_ver claude)"
ok "codex" "$(bin_ver codex)"
ok "grok" "$(bin_ver grok)"
ok "openclaw" "$(bin_ver openclaw)"
echo
echo "## Native config (user assets — do not overwrite from ACP)"
ok "codex_model" "$(first_model "${HOME}/.codex/config.toml")"
ok "codex_auth" "$(auth_pfx "${HOME}/.codex/auth.json")"
ok "grok_config" "$([ -f "${HOME}/.grok/config.toml" ] && echo present || echo missing)"
ok "claude_home" "$([ -d "${HOME}/.claude" ] && echo present || echo missing)"
echo
echo "## ACP isolation (OpenClaw only)"
ACP_HOME="${HOME}/.openclaw/acpx/codex-home"
ok "acp_codex_home" "$ACP_HOME"
ok "acp_model" "$(first_model "${ACP_HOME}/config.toml")"
ok "acp_auth" "$(auth_pfx "${ACP_HOME}/auth.json")"
if [ -f "${HOME}/.codex/auth.json" ] && [ -f "${ACP_HOME}/auth.json" ]; then
  python3 <<'PY'
import json
from pathlib import Path
h = json.loads(Path.home().joinpath(".codex/auth.json").read_text()).get("OPENAI_API_KEY")
a = json.loads(Path.home().joinpath(".openclaw/acpx/codex-home/auth.json").read_text()).get("OPENAI_API_KEY")
print("  auth_isolated       " + str(h != a))
PY
fi
echo
echo "## OpenClaw Main"
if [ -f "${HOME}/.openclaw/openclaw.json" ]; then
  python3 <<'PY'
import json
from pathlib import Path
c = json.loads(Path.home().joinpath(".openclaw/openclaw.json").read_text())
m = c.get("agents", {}).get("defaults", {}).get("model", {})
print("  main_model          " + str(m))
acp = c.get("acp", {})
print("  acp_enabled         " + str(acp.get("enabled")))
print("  acp_defaultAgent    " + str(acp.get("defaultAgent")))
print("  acp_allowed         " + str(acp.get("allowedAgents")))
PY
fi
echo
echo "## Full names (use in 推荐卡 / 汇报)"
ok "Claude-TUI" "host claude (H2/C2)"
ok "Claude-ACP" "C3 agentId=claude"
ok "Codex-TUI" "host codex + ~/.codex (H2/C2)"
ok "Codex-ACP" "C3 agentId=codex + isolated CODEX_HOME"
ok "Codex-Grok-profile" "host grok CLI (review; alias name kept for back-compat)"
ok "Main-Grok" "openclaw main model"
ok "Grok-native" "host grok CLI"
echo
echo "## Review backends (must: env -u CODEX_HOME)"
ok "review-claude" "claude"
ok "review-codex" "codex host default"
ok "review-grok" "standalone grok CLI: grok -p -m grok-4.5 (own key, not codex gateway)"
echo
echo "## C3 spawn guards (Main must enforce)"
echo "  - cwd must be claw-* under allowlist"
echo "  - single writer; no Main+TUI+ACP parallel write"
echo "  - inject constitution prefix (AGENTS.md / dev-task)"
echo "  - never rewrite host ~/.codex|~/.grok defaults for ACP fixes"
echo
echo "Done."
