#!/usr/bin/env bash
# Usage:
#   link-platform-skills.sh [--dry-run] [--force]
#
# Symlink platform skills (single source in this repo) into user-level and
# in-repo discovery paths. Mirrors the agent-profiles link pattern: one body,
# many entrypoints; never copy SKILL.md.
#
# The registry is skills/manifest.tsv. Platform rows are linked to user-level
# directories; repo-local rows remain in the checkout and are only routed by
# project docs.
#
# Targets (when present / always for in-repo):
#   ~/.agents/skills/<name>
#   ~/.claude/skills/<name>   (via ~/.agents when possible)
#   openclaw/workspace/skills/<name>
#   skills/<name>             (the real source directory in this checkout)

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
default_repo_root="$(cd "$script_dir/../.." && pwd)"
repo_root="${WEZDECK_REPO:-$default_repo_root}"
repo_root="$(cd "$repo_root" 2>/dev/null && pwd -P)" || {
  printf 'platform-skills: WEZDECK_REPO is not an existing checkout: %s\n' \
    "${WEZDECK_REPO:-$repo_root}" >&2
  exit 1
}
[[ -d "$repo_root/scripts/dev" ]] || {
  printf 'platform-skills: WEZDECK_REPO is not a wezdeck checkout: %s\n' "$repo_root" >&2
  exit 1
}
dry_run=0
force=0

usage() {
  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while (($#)); do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --force) force=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

manifest="$repo_root/skills/manifest.tsv"
[[ -f "$manifest" ]] || {
  printf 'platform-skills: manifest missing: %s\n' "$manifest" >&2
  exit 1
}

link_one() {
  local src=$1 dst=$2
  local status cur src_real

  src_real=$(readlink -f "$src")
  if [[ ! -e "$src_real" ]]; then
    printf '  %-60s missing-source\n' "$dst"
    return 1
  fi

  if [[ -L "$dst" ]]; then
    cur=$(readlink -f "$dst" 2>/dev/null || true)
    if [[ "$cur" == "$src_real" ]]; then
      status=ok
    elif ((force)); then
      status=replace
    else
      printf '  %-60s conflict (-> %s; use --force)\n' "$dst" "${cur:-?}"
      return 0
    fi
  elif [[ -e "$dst" ]]; then
    if ((force)); then
      status=replace
    else
      printf '  %-60s conflict (exists; use --force)\n' "$dst"
      return 0
    fi
  else
    status=link
  fi

  printf '  %-60s %s\n' "$dst" "$status"
  ((dry_run)) && return 0
  case "$status" in
    ok) ;;
    replace)
      rm -rf "$dst"
      ln -s "$src_real" "$dst"
      ;;
    link)
      mkdir -p "$(dirname "$dst")"
      ln -s "$src_real" "$dst"
      ;;
  esac
}

# Prefer relative symlinks inside the repo so checkouts stay portable.
link_one_rel() {
  local src_abs=$1 dst=$2
  local dst_dir rel status cur cur_abs src_real

  src_real=$(readlink -f "$src_abs")
  dst_dir=$(dirname "$dst")
  mkdir -p "$dst_dir"
  rel=$(realpath --relative-to="$dst_dir" "$src_real" 2>/dev/null || true)
  if [[ -z "$rel" ]]; then
    # fallback absolute
    link_one "$src_real" "$dst"
    return
  fi

  if [[ -L "$dst" ]]; then
    cur=$(readlink "$dst" 2>/dev/null || true)
    cur_abs=$(readlink -f "$dst" 2>/dev/null || true)
    if [[ "$cur_abs" == "$src_real" ]]; then
      status=ok
    elif ((force)); then
      status=replace
    else
      printf '  %-60s conflict (-> %s; use --force)\n' "$dst" "${cur:-?}"
      return 0
    fi
  elif [[ -e "$dst" ]]; then
    if ((force)); then
      status=replace
    else
      printf '  %-60s conflict (exists; use --force)\n' "$dst"
      return 0
    fi
  else
    status=link
  fi

  printf '  %-60s %s (rel %s)\n' "$dst" "$status" "$rel"
  ((dry_run)) && return 0
  case "$status" in
    ok) ;;
    replace)
      rm -rf "$dst"
      ln -s "$rel" "$dst"
      ;;
    link)
      ln -s "$rel" "$dst"
      ;;
  esac
}

((dry_run)) && echo "(dry run — no filesystem changes)"

echo "[platform-skills] source repo: $repo_root"

while IFS=$'\t' read -r name rel class user_links openclaw_link; do
  [[ -n "$name" && "${name:0:1}" != "#" ]] || continue
  [[ "$class" == platform ]] || continue
  src="$repo_root/$rel"
  echo "[skill] $name  <=  $rel"

  # User-level (absolute links; host-local)
  if [[ "$user_links" == *agents* ]]; then
    mkdir -p "$HOME/.agents/skills" 2>/dev/null || true
    if [[ -d "$HOME/.agents/skills" ]]; then
      link_one "$src" "$HOME/.agents/skills/$name"
    fi
  fi
  if [[ "$user_links" == *claude* ]]; then
    mkdir -p "$HOME/.claude/skills" 2>/dev/null || true
    # Prefer chain: claude -> agents -> source (matches coco-* pattern)
    if [[ -L "$HOME/.agents/skills/$name" || -d "$HOME/.agents/skills/$name" ]]; then
      link_one "$HOME/.agents/skills/$name" "$HOME/.claude/skills/$name"
    else
      link_one "$src" "$HOME/.claude/skills/$name"
    fi
  fi

  if [[ "$openclaw_link" == yes ]]; then
    link_one_rel "$src" "$repo_root/openclaw/workspace/skills/$name"
  fi
done < "$manifest"

# PATH entry for short CLI `delegate` (idempotent; skill name is cross-repo-delegate)
if [[ -x "$repo_root/skills/cross-repo-delegate/run.sh" ]]; then
  echo "[cli] delegate → ~/.local/bin/delegate"
  if ((dry_run)); then
    echo "  (dry run) would run: skills/cross-repo-delegate/run.sh install-cli"
  else
    "$repo_root/skills/cross-repo-delegate/run.sh" install-cli || true
  fi
fi

echo "done."
