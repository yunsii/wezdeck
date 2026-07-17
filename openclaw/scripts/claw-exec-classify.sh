#!/usr/bin/env bash
# Minimal host-exec risk labels for YunsClaw.
# NOT a replacement for Feishu allowlist / coco-forge / claw worktree rules.
#
# Usage:
#   claw-exec-classify.sh "command string"
#   echo "cmd" | claw-exec-classify.sh
#
# Exit: 0=safe  1=write  2=danger  3=empty
# Stdout: one line JSON {"label":"...","reason":"..."}
set -euo pipefail

cmd="${*:-}"
if [[ -z "${cmd}" && ! -t 0 ]]; then
  cmd="$(cat)"
fi
cmd="$(printf '%s' "${cmd}" | tr -d '\r')"
if [[ -z "${cmd}" ]]; then
  echo '{"label":"danger","reason":"empty command"}'
  exit 3
fi

norm="$(printf '%s' "${cmd}" | tr '[:upper:]' '[:lower:]' | tr '\n' ' ')"

python3 - "${norm}" <<'PY'
import json, re, sys

norm = sys.argv[1]

def finish(label: str, reason: str, code: int) -> None:
    print(json.dumps({"label": label, "reason": reason}, ensure_ascii=False))
    raise SystemExit(code)

danger_res = [
    (r"\brm\s+-[a-z0-9]*[rf]", "rm with -r/-f"),
    (r"\brm\s+--recursive", "rm --recursive"),
    (r"\bgit\s+push\b[^\n]*(--force|\s-f\b)", "git push --force"),
    (r"\bgit\s+reset\s+--hard\b", "git reset --hard"),
    (r"\bgit\s+clean\s+-[a-z0-9]*f", "git clean -f"),
    (r"curl[^\n|]*\|\s*(ba)?sh", "curl|sh"),
    (r"wget[^\n|]*\|\s*(ba)?sh", "wget|sh"),
    (r"\bmkfs\.", "mkfs"),
    (r"\bdd\s+if=", "dd if="),
    (r">\s*/etc/", "write under /etc"),
    (r">\s*/boot\b", "write under /boot"),
    (r"\b(shutdown|reboot)\b", "shutdown/reboot"),
    (r"\bsystemctl\s+(stop|disable)\s+ssh", "disable ssh"),
    (r"\bdrop\s+table\b", "drop table"),
]
for pat, why in danger_res:
    if re.search(pat, norm):
        finish("danger", why, 2)

if re.search(
    r"(\.env\b|id_rsa|id_ed25519|\.pem\b|api[_-]?key|app_secret|password=|authorization:\s*bearer)",
    norm,
) and re.search(
    r"\b(cat|less|head|tail|tee|cp|scp|curl|wget|printenv|env|export)\b",
    norm,
):
    finish("danger", "likely secret/credential material access", 2)

safe_hint = re.search(
    r"\b(ls|test|echo|pwd|whoami|uname|realpath|readlink|dirname|basename|wc|"
    r"head|tail|cat|file|stat|find|rg|grep)\b"
    r"|\bgit\s+(status|log|diff|show|branch|rev-parse|remote|worktree\s+list)\b"
    r"|\b(pnpm|npm)\s+(test|lint|typecheck)\b"
    r"|\bsource\s+\S*shell-env\.d/"
    r"|\bsource\s+\S*openclaw-tasks\.env",
    norm,
)
write_bad = re.search(
    r"\bgit\s+(commit|push|reset|clean|checkout|rebase|merge|add)\b"
    r"|\brm\s|\bmv\s|\bdd\s|\btee\s|\bsed\s+-i|\bcurl\s|\bwget\s|\bssh\s",
    norm,
)
if safe_hint and not write_bad:
    finish("safe", "read-only / probe / status-style command", 0)

if re.search(
    r"\bgit\s+(add|commit|switch|checkout|pull|fetch|stash|cherry-pick|rebase|merge|push)\b"
    r"|\b(pnpm|npm)\s+i(nstall)?\b|\bmkdir\b|\btouch\b|\bcp\s|\bmv\s|\bsed\s+-i"
    r"|\bnpx\b|\bturbo\b|\bvitest\b|\bpytest\b",
    norm,
):
    if re.search(r"\bgit\s+push\b", norm) and re.search(r"(--force|\s-f\b)", norm):
        finish("danger", "git push --force", 2)
    if re.search(r"\bgit\s+push\b", norm):
        finish("write", "git push (still ask before main/master per AGENTS)", 1)
    finish("write", "normal development write / package / git", 1)

finish("write", "default write/unknown — treat as needs care but not hard-block", 1)
PY
