#!/usr/bin/env bash
# Check + initialize human-run runtime for this machine.
# Safe to re-run (idempotent). Agents must call this before propose.
#
# Does:
#   1. Locate CLI in the wezdeck tree that hosts this skill
#   2. If $WEZDECK_REPO/cli lacks wd-run/x/lib, symlink from that tree
#      (so wezterm-env PATH and humans' `x` work without waiting for git merge)
#   3. Refresh ~/.wezterm-x/agent-tools.env wd_run= (and keep other keys)
#   4. Smoke: wd-run can source lib + print usage
set -euo pipefail

# The platform entry may be reached through ~/.agents/skills/human-run or
# ~/.claude/skills/human-run. Resolve the source file before walking back to
# the repo root; the symlink path points at the user's home, not this tree.
source_file="$(readlink -f "${BASH_SOURCE[0]}")"
TOOL_HOME="$(cd "$(dirname "$source_file")" && pwd -P)"
SKILL_DIR="$TOOL_HOME"
# skills/human-run → wezdeck root
WEZDECK_FROM_SKILL="$(cd "$SKILL_DIR/../.." && pwd)"
SRC_CLI="$WEZDECK_FROM_SKILL/scripts/runtime/cli"
SRC_LIB="$WEZDECK_FROM_SKILL/scripts/runtime/agent-run-lib.sh"
SRC_WD_RUN="$SRC_CLI/wd-run"
SRC_X="$SRC_CLI/x"

log() { printf 'human-run ensure-env: %s\n' "$*" >&2; }

die() {
  printf 'human-run ensure-env: FAIL: %s\n' "$*" >&2
  exit 1
}

[[ -x "$SRC_WD_RUN" ]] || die "skill tree missing wd-run at $SRC_WD_RUN (re-link skill from a wezdeck with human-run CLI)"
[[ -x "$SRC_X" ]] || die "skill tree missing x at $SRC_X"
[[ -f "$SRC_LIB" ]] || die "skill tree missing agent-run-lib.sh at $SRC_LIB"

# Target install tree for PATH consumers (wezterm-env.env)
REPO="${WEZDECK_REPO:-$WEZDECK_FROM_SKILL}"
REPO="$(cd "$REPO" 2>/dev/null && pwd -P)" || die "WEZDECK_REPO is not an existing checkout: ${WEZDECK_REPO:-$REPO}"
[[ -f "$REPO/scripts/runtime/agent-run-lib.sh" ]] || die "WEZDECK_REPO is not a wezdeck checkout: $REPO"
DST_CLI="$REPO/scripts/runtime/cli"
DST_LIB="$REPO/scripts/runtime/agent-run-lib.sh"

ensure_link_or_copy() {
  local src="$1" dst="$2"
  if [[ -x "$dst" ]] || [[ -f "$dst" && "$dst" == *.sh ]]; then
    # Already present — if it works, leave it (may be real file from checkout)
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  if ln -sfn "$src" "$dst" 2>/dev/null; then
    log "linked $dst -> $src"
    return 0
  fi
  cp -f "$src" "$dst"
  chmod a+x "$dst" 2>/dev/null || true
  log "copied $dst from $src"
}

if [[ -d "$REPO/scripts/runtime" ]] || [[ -d "$REPO" ]]; then
  mkdir -p "$DST_CLI"
  ensure_link_or_copy "$SRC_WD_RUN" "$DST_CLI/wd-run"
  ensure_link_or_copy "$SRC_X" "$DST_CLI/x"
  ensure_link_or_copy "$SRC_LIB" "$DST_LIB"
  # paths-lib: if REPO's copy lacks AGENT_RUN constants, prefer running via
  # skill-tree wd-run (its ../agent-run-lib sources skill-tree paths after we
  # also ensure WSL_* live in the lib's sibling paths file). When DST_LIB is a
  # symlink to SRC_LIB, init_paths loads skill-tree wsl-runtime-paths-lib — OK.
else
  log "WEZDECK_REPO=$REPO missing; skipping PATH tree install (agent-tools will point at skill tree)"
fi

# Agents always get the skill-tree binary (ships with matching agent-run-lib +
# paths constants). REPO symlinks above are for human PATH / wezterm-env only.
WD_RUN_ABS="$SRC_WD_RUN"

# Refresh agent-tools.env — merge keys, always set wd_run to working binary.
marker_dir="$HOME/.wezterm-x"
marker="$marker_dir/agent-tools.env"
mkdir -p "$marker_dir"
tmp="$(mktemp)"
# Preserve existing keys when present
repo_root="$REPO"
agent_clipboard=""
open_file_in_vscode=""
if [[ -f "$marker" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      repo_root=*) repo_root="${line#repo_root=}" ;;
      agent_clipboard=*) agent_clipboard="${line#agent_clipboard=}" ;;
      open_file_in_vscode=*) open_file_in_vscode="${line#open_file_in_vscode=}" ;;
    esac
  done <"$marker"
fi
[[ -n "$agent_clipboard" ]] || agent_clipboard="$repo_root/scripts/runtime/agent-clipboard.sh"
[[ -n "$open_file_in_vscode" ]] || open_file_in_vscode="$repo_root/scripts/runtime/open-file-in-vscode.sh"

cat >"$tmp" <<EOF
version=1
repo_root=$repo_root
agent_clipboard=$agent_clipboard
open_file_in_vscode=$open_file_in_vscode
wd_run=$WD_RUN_ABS
EOF
mv -f "$tmp" "$marker"
chmod 600 "$marker" 2>/dev/null || true
log "wrote $marker wd_run=$WD_RUN_ABS"

# Smoke: resolved binary must run usage (no network, no state required)
if ! "$WD_RUN_ABS" -h >/dev/null 2>&1 && ! "$WD_RUN_ABS" --help >/dev/null 2>&1; then
  # wd-run usage exits 1 on empty — accept that if stderr mentions propose
  out="$("$WD_RUN_ABS" 2>&1 || true)"
  [[ "$out" == *propose* ]] || die "wd-run smoke failed at $WD_RUN_ABS"
fi
log "ok wd_run=$WD_RUN_ABS"
printf '%s\n' "$WD_RUN_ABS"
