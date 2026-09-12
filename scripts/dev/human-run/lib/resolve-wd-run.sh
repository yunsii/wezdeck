#!/usr/bin/env bash
# Resolve absolute path to wezdeck `wd-run`. Print path on stdout; exit 1 if none.
# Prefer the wezdeck tree that hosts this skill (symlink-resolved) over a stale
# $WEZTERM_REPO — other-repo agents often have WEZTERM_REPO on an older checkout.
set -euo pipefail

is_exe() {
  [[ -n "${1:-}" && -x "$1" ]]
}

# Skill dir = …/scripts/dev/human-run (follow links)
skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Sibling under scripts/: scripts/dev/human-run → scripts/runtime/cli/wd-run
colocated_raw="$skill_dir/../runtime/cli/wd-run"
colocated=""
if [[ -e "$colocated_raw" ]]; then
  colocated="$(cd "$(dirname "$colocated_raw")" && pwd)/$(basename "$colocated_raw")"
fi

# Colocated BEFORE WEZTERM_REPO / possibly-stale agent-tools: the linked skill
# tree is the one that shipped human-run + CLI together.
candidates=()
[[ -n "${WD_RUN:-}" ]] && candidates+=("$WD_RUN")
[[ -n "$colocated" ]] && candidates+=("$colocated")

if [[ -f "${HOME}/.wezterm-x/agent-tools.env" ]]; then
  wd_from_env="$(grep -E '^wd_run=' "${HOME}/.wezterm-x/agent-tools.env" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
  [[ -n "$wd_from_env" ]] && candidates+=("$wd_from_env")
fi

if command -v wd-run >/dev/null 2>&1; then
  candidates+=("$(command -v wd-run)")
fi

[[ -n "${WEZTERM_REPO:-}" ]] && candidates+=("$WEZTERM_REPO/scripts/runtime/cli/wd-run")
candidates+=("${HOME}/github/wezterm-config/scripts/runtime/cli/wd-run")

seen=""
for c in "${candidates[@]}"; do
  [[ -n "$c" ]] || continue
  case " $seen " in
    *" $c "*) continue ;;
  esac
  seen+=" $c"
  if is_exe "$c"; then
    printf '%s\n' "$c"
    exit 0
  fi
done

printf 'human-run: wd-run not found (run ensure-env.sh)\n' >&2
printf 'human-run: skill_dir=%s colocated_try=%s\n' "$skill_dir" "${colocated:-none}" >&2
exit 1
