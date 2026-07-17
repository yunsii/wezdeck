#!/usr/bin/env bash
# Read-only readiness checks for the openclaw package + local host.
# Does not send Feishu messages, start the Gateway, or write outside /tmp.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_root="$(cd "${script_dir}/.." && pwd)"
src_workspace="${pkg_root}/workspace"
dest_workspace="${OPENCLAW_WORKSPACE:-${HOME}/.openclaw/workspace}"

pass=0
fail=0
warn=0

ok() { echo "PASS  $*"; pass=$((pass + 1)); }
bad() { echo "FAIL  $*"; fail=$((fail + 1)); }
wrn() { echo "WARN  $*"; warn=$((warn + 1)); }

echo "== openclaw package =="

if [[ -f "${pkg_root}/README.md" ]]; then
  ok "package README present"
else
  bad "package README missing"
fi

if [[ -f "${src_workspace}/AGENTS.md" ]]; then
  ok "workspace/AGENTS.md present"
else
  bad "workspace/AGENTS.md missing"
fi

if [[ -f "${src_workspace}/skills/dev-task/SKILL.md" ]]; then
  ok "skills/dev-task present"
else
  bad "skills/dev-task missing"
fi

if [[ -f "${src_workspace}/skills/task-ledger/SKILL.md" ]]; then
  ok "skills/task-ledger present"
else
  bad "skills/task-ledger missing"
fi

if [[ -x "${pkg_root}/scripts/dev-task-ledger.sh" ]]; then
  ok "dev-task-ledger.sh executable"
else
  bad "dev-task-ledger.sh missing or not executable"
fi

if [[ -x "${pkg_root}/scripts/claw-exec-classify.sh" && -x "${pkg_root}/scripts/claw-exec-gate.sh" && -x "${pkg_root}/scripts/claw-run.sh" ]]; then
  ok "exec-risk scripts executable (classify/gate/run)"
else
  bad "exec-risk scripts missing or not executable"
fi

if [[ -f "${src_workspace}/skills/exec-risk/SKILL.md" ]]; then
  ok "skills/exec-risk present"
else
  bad "skills/exec-risk missing"
fi

# Main protocol markers (orchestration checklist / modes — not full user profile)
if grep -q 'Hard checklist' "${src_workspace}/AGENTS.md" 2>/dev/null \
  && grep -q '开发方式' "${src_workspace}/AGENTS.md" 2>/dev/null; then
  ok "AGENTS.md main checklist + 开发方式 present"
else
  bad "AGENTS.md missing main checklist/开发方式 sections"
fi
if grep -q 'Main checklist' "${src_workspace}/skills/dev-task/SKILL.md" 2>/dev/null; then
  ok "dev-task main checklist present"
else
  bad "dev-task missing main checklist"
fi
if grep -q 'Development modes' "${pkg_root}/README.md" 2>/dev/null; then
  ok "README Development modes section present"
else
  bad "README missing Development modes section"
fi

# Offline gate path only (no LLM, no side effects)
if CLAW_RUN_SKIP_LLM=1 "${pkg_root}/scripts/claw-run.sh" --dry-run --skip-llm 'true' >/dev/null 2>&1; then
  ok "claw-run dry-run allows safe command"
else
  bad "claw-run dry-run failed on safe command"
fi
if CLAW_RUN_SKIP_LLM=1 "${pkg_root}/scripts/claw-run.sh" --dry-run --skip-llm 'rm -rf /' >/dev/null 2>&1; then
  bad "claw-run dry-run should deny rm -rf /"
else
  ok "claw-run dry-run denies danger (exit non-zero)"
fi

if [[ -f "${pkg_root}/config/openclaw.json5.example" ]]; then
  ok "config example present"
else
  bad "config example missing"
fi

if [[ -f "${pkg_root}/config/feishu-openclaw.env.example" ]]; then
  ok "feishu env example present"
else
  bad "feishu env example missing"
fi

echo
echo "== link =="

if [[ -L "${dest_workspace}" ]]; then
  resolved="$(readlink -f "${dest_workspace}" 2>/dev/null || true)"
  expected="$(readlink -f "${src_workspace}")"
  if [[ "${resolved}" == "${expected}" ]]; then
    ok "workspace linked: ${dest_workspace}"
  else
    bad "workspace symlink points elsewhere: ${resolved}"
  fi
elif [[ -d "${dest_workspace}" ]]; then
  wrn "workspace is a real directory (not symlink): ${dest_workspace}"
  if [[ -f "${dest_workspace}/AGENTS.md" ]]; then
    ok "runtime AGENTS.md exists (copy mode?)"
  else
    bad "runtime workspace has no AGENTS.md — run link-workspace.sh"
  fi
else
  wrn "not linked yet: ${dest_workspace} (run scripts/link-workspace.sh after install)"
fi

echo
echo "== host binaries (optional for package-only) =="

if command -v openclaw >/dev/null 2>&1; then
  ok "openclaw on PATH: $(command -v openclaw)"
else
  wrn "openclaw not on PATH (install later)"
fi

if [[ -d "${HOME}/.openclaw" ]]; then
  ok "~/.openclaw exists"
else
  wrn "~/.openclaw missing (onboard later)"
fi

# Chrome DevTools MCP (core browser) — optional if openclaw + CDP present
if command -v openclaw >/dev/null 2>&1 && [[ -f "${HOME}/.openclaw/openclaw.json" ]]; then
  if openclaw mcp list 2>/dev/null | grep -q 'chrome-devtools'; then
    ok "openclaw mcp chrome-devtools configured"
  else
    wrn "openclaw mcp chrome-devtools missing — see openclaw/README.md Chrome MCP section"
  fi
fi
if curl -sS -m 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  ok "CDP http://127.0.0.1:9222 answers"
else
  wrn "CDP 9222 not answering — start WezDeck debug Chrome (docs/browser-debug.md)"
fi
if [[ -f "${src_workspace}/skills/chrome-devtools/SKILL.md" ]]; then
  ok "skills/chrome-devtools present"
else
  bad "skills/chrome-devtools missing"
fi

if command -v claude >/dev/null 2>&1; then
  ok "claude on PATH"
else
  wrn "claude not on PATH"
fi

if command -v codex >/dev/null 2>&1; then
  ok "codex on PATH"
else
  wrn "codex not on PATH"
fi

if [[ -d "${HOME}/work" ]]; then
  ok "~/work exists"
else
  wrn "~/work missing — set ALLOWED roots to your real work root"
fi

echo
echo "== secrets placeholders (names only) =="

env_dir="${HOME}/.config/shell-env.d"
if [[ -d "${env_dir}" ]]; then
  if compgen -G "${env_dir}/*feishu*" >/dev/null \
    || compgen -G "${env_dir}/*lark*" >/dev/null \
    || compgen -G "${env_dir}/*openclaw*" >/dev/null \
    || compgen -G "${env_dir}/*grok*" >/dev/null; then
    ok "found feishu/openclaw/grok-related env file name(s) under shell-env.d"
  else
    wrn "no *feishu*/*lark*/*openclaw*/*grok* file in shell-env.d yet"
  fi
else
  wrn "shell-env.d missing"
fi

# Never print secret values — mode checks only
for secret_name in feishu-openclaw.env grok-proxy.env; do
  secret_path="${env_dir}/${secret_name}"
  if [[ -f "${secret_path}" ]]; then
    mode="$(stat -c '%a' "${secret_path}" 2>/dev/null || echo '?')"
    if [[ "${mode}" == "600" || "${mode}" == "400" ]]; then
      ok "${secret_name} mode is ${mode}"
    else
      wrn "${secret_name} mode is ${mode} (prefer 600)"
    fi
  fi
done

if command -v openclaw >/dev/null 2>&1; then
  if openclaw channels status --probe >/dev/null 2>&1; then
    ok "openclaw channels status --probe succeeded (details not printed)"
  else
    wrn "openclaw channels status --probe failed or gateway down"
  fi
fi

if command -v lark-cli >/dev/null 2>&1; then
  ok "lark-cli on PATH"
else
  wrn "lark-cli not on PATH (needed for task ledger)"
fi

if [[ -f "${HOME}/.config/shell-env.d/openclaw-tasks.env" ]]; then
  mode="$(stat -c '%a' "${HOME}/.config/shell-env.d/openclaw-tasks.env" 2>/dev/null || echo '?')"
  if [[ "${mode}" == "600" || "${mode}" == "400" ]]; then
    ok "openclaw-tasks.env mode is ${mode}"
  else
    wrn "openclaw-tasks.env mode is ${mode} (prefer 600)"
  fi
  # shellcheck disable=SC1091
  set -a
  # shellcheck disable=SC1090
  source "${HOME}/.config/shell-env.d/openclaw-tasks.env" 2>/dev/null || true
  set +a
  if [[ -n "${OPENCLAW_TASKS_BASE_TOKEN:-}" && -n "${OPENCLAW_TASKS_TABLE_ID:-}" ]]; then
    ok "task ledger base/table env set (values not printed)"
  else
    wrn "openclaw-tasks.env missing BASE_TOKEN or TABLE_ID"
  fi
else
  wrn "openclaw-tasks.env not present — copy config/openclaw-tasks.env.example"
fi

echo
echo "== summary =="
echo "pass=${pass} warn=${warn} fail=${fail}"

if [[ "${fail}" -gt 0 ]]; then
  exit 1
fi
exit 0
