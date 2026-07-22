#!/usr/bin/env bash
# Usage:
#   link-platform-skills.sh [--dry-run] [--force]
#
# Symlink platform skills (single source in this repo) into user-level and
# in-repo discovery paths. Mirrors the agent-profiles link pattern: one body,
# many entrypoints; never copy SKILL.md.
#
# Currently linked:
#   adversarial-review  -> scripts/dev/adversarial-review/
#   brainstorm          -> scripts/dev/brainstorm/
#   yuns-engineer      -> scripts/dev/yuns-engineer/
#
# Targets (when present / always for in-repo):
#   ~/.agents/skills/<name>
#   ~/.claude/skills/<name>   (via ~/.agents when possible)
#   openclaw/workspace/skills/<name>
#   skills/<name>             (repo-root thin discovery)

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
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

# name|relative_source_from_repo_root
skills=(
  "adversarial-review|scripts/dev/adversarial-review"
  "brainstorm|scripts/dev/brainstorm"
  "yuns-engineer|scripts/dev/yuns-engineer"
)

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

for entry in "${skills[@]}"; do
  name="${entry%%|*}"
  rel="${entry#*|}"
  src="$repo_root/$rel"
  echo "[skill] $name  <=  $rel"

  # User-level (absolute links; host-local)
  if [[ -d "$HOME/.agents/skills" ]] || [[ -d "$HOME/.agents" ]] || true; then
    mkdir -p "$HOME/.agents/skills" 2>/dev/null || true
    if [[ -d "$HOME/.agents/skills" ]]; then
      link_one "$src" "$HOME/.agents/skills/$name"
    fi
  fi
  if [[ -d "$HOME/.claude/skills" ]] || [[ -d "$HOME/.claude" ]]; then
    mkdir -p "$HOME/.claude/skills" 2>/dev/null || true
    # Prefer chain: claude -> agents -> source (matches coco-* pattern)
    if [[ -L "$HOME/.agents/skills/$name" || -d "$HOME/.agents/skills/$name" ]]; then
      link_one "$HOME/.agents/skills/$name" "$HOME/.claude/skills/$name"
    else
      link_one "$src" "$HOME/.claude/skills/$name"
    fi
  fi

  # In-repo discovery (relative links)
  link_one_rel "$src" "$repo_root/openclaw/workspace/skills/$name"
  link_one_rel "$src" "$repo_root/skills/$name"
done

echo "done."
