#!/usr/bin/env bash
# Minimal host-exec risk labels for YunsClaw.
# NOT a replacement for Feishu allowlist / coco-forge / claw worktree rules.
#
# Usage:
#   claw-exec-classify.sh "command string"
#   echo "cmd" | claw-exec-classify.sh
#
# Exit codes: 0=safe  1=write  2=danger  3=usage/empty
# Stdout: one line JSON {"label":"safe|write|danger","reason":"..."}
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

# Normalize for matching (lowercase single line)
norm="$(printf '%s' "${cmd}" | tr '[:upper:]' '[:lower:]' | tr '\n' ' ')"

label="write"
reason="default write/unknown — treat as needs care but not hard-block"

# --- danger (must ask human; do not silent-run if you honor this) ---
if echo "${norm}" | grep -qE \
  'rm[[:space:]]+(-[a-z]*f|-[a-z]*r|-[a-z]*rf|-[a-z]*fr)|rm[[:space:]]+--recursive|git[[:space:]]+push[[:space:]]+.*--force|git[[:space:]]+push[[:space:]]+-f|git[[:space:]]+reset[[:space:]]+--hard|git[[:space:]]+clean[[:space:]]+-fd|curl[^|;
]*\|[[:space:]]*(ba)?sh|wget[^|;
]*\|[[:space:]]*(ba)?sh|mkfs\.|dd[[:space:]]+if=|:(){:|:&};:|chmod[[:space:]]+777[[:space:]]+/|chown[[:space:]]+-r[[:space:]]+.* /|drop[[:space:]]+table|truncate[[:space:]]+table|>[[:space:]]*/etc/|>[[:space:]]*/boot|shutdown|reboot|systemctl[[:space:]]+(stop|disable)[[:space:]]+ssh'; then
  label="danger"
  reason="matches destructive / force-push / pipe-to-shell / system-alter pattern"
elif echo "${norm}" | grep -qE \
  '\.env(\.|$|")|id_rsa|id_ed25519|\.pem\b|api[_-]?key|app_secret|password=|authorization:[[:space:]]*bearer'; then
  # reading secrets often appears as cat/less of key files
  if echo "${norm}" | grep -qE 'cat |less |head |tail |tee |cp |scp |curl |wget |printenv|env |export '; then
    label="danger"
    reason="likely secret/credential material access"
  fi
fi

# --- safe (auto ok under personal full mode; classifier still labels) ---
if [[ "${label}" != "danger" ]]; then
  # pure probes / read-only git / listing
  if echo "${norm}" | grep -qE \
    '^(cd[[:space:]]+[^;&|]+[[:space:]]*(;|&&))?[[:space:]]*(ls|test|\[|echo|pwd|whoami|uname|realpath|readlink|dirname|basename|wc|head|tail|cat|less|file|stat|find|rg|grep|git[[:space:]]+(status|log|diff|show|branch|rev-parse|remote|worktree[[:space:]]+list)|pnpm[[:space:]]+(test|lint|typecheck| -C)|npm[[:space:]]+(test|run[[:space:]]+test)|node[[:space:]]+-e[[:space:]]+["'\'']console|true|false)([[:space:]]|$)'; then
    # rough: if no && with write tools and no redirect overwrite of random paths
    if ! echo "${norm}" | grep -qE 'git[[:space:]]+(commit|push|reset|clean|checkout|rebase|merge)|rm |mv |dd |tee |sed[[:space:]]+-i|>[^>]|>>'; then
      # allow simple && chains of read-only
      if ! echo "${norm}" | grep -qE 'curl |wget |ssh |scp |rsync '; then
        label="safe"
        reason="read-only / probe / status-style command"
      fi
    fi
  fi
  # source env files alone or with read-only probes
  if echo "${norm}" | grep -qE 'source[[:space:]]+~?/?\.config/shell-env\.d/|source[[:space:]]+.*/openclaw-tasks\.env'; then
    if ! echo "${norm}" | grep -qE 'rm |git[[:space:]]+push|curl .*\|'; then
      label="safe"
      reason="load local shell-env then probe"
    fi
  fi
fi

# --- write (normal dev; auto ok if you trust agent + worktree policy) ---
if [[ "${label}" != "danger" && "${label}" != "safe" ]]; then
  if echo "${norm}" | grep -qE \
    'git[[:space:]]+(add|commit|switch|checkout|pull|fetch|stash|cherry-pick|rebase|merge|push[^-])|pnpm[[:space:]]+i|npm[[:space:]]+i|mkdir |touch |cp |mv |sed[[:space:]]+-i|npx |turbo |eslint|prettier|vitest|pytest'; then
    label="write"
    reason="normal development write / package / git (non-force)"
  fi
fi

# force push already danger; plain push is write
if [[ "${label}" != "danger" ]] && echo "${norm}" | grep -qE 'git[[:space:]]+push'; then
  if echo "${norm}" | grep -qE -- '--force|-f\b'; then
    label="danger"
    reason="git push --force"
  else
    label="write"
    reason="git push (still confirm policy: ask user before main/master)"
  fi
fi

python3 -c 'import json,sys; print(json.dumps({"label":sys.argv[1],"reason":sys.argv[2]},ensure_ascii=False))' \
  "${label}" "${reason}"

case "${label}" in
  safe) exit 0 ;;
  write) exit 1 ;;
  danger) exit 2 ;;
  *) exit 3 ;;
esac
