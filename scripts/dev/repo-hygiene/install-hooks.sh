#!/usr/bin/env bash
# Install a shared pre-commit hook into the repository's common git dir
# so all worktrees inherit it. The hook itself resolves --show-toplevel
# and runs that checkout's scripts/dev/repo-hygiene/run.sh.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
src="$here/hooks/pre-commit"

if ! git -C "$root" rev-parse --git-common-dir >/dev/null 2>&1; then
  echo "[repo-hygiene] not a git repo: $root" >&2
  exit 2
fi

common="$(cd "$root" && git rev-parse --git-common-dir)"
# git-common-dir may be relative
case "$common" in
  /*) ;;
  *) common="$(cd "$root/$common" && pwd)" ;;
esac
hooks_dir="$common/hooks"
mkdir -p "$hooks_dir"
dest="$hooks_dir/pre-commit"

# If core.hooksPath is set to something else, warn — we still write common hooks.
hooks_path="$(git -C "$root" config --get core.hooksPath || true)"
if [[ -n "$hooks_path" ]]; then
  echo "[repo-hygiene] warning: core.hooksPath=$hooks_path is set;" >&2
  echo "  git will use that path instead of $hooks_dir unless you unset it." >&2
fi

# Copy (do not symlink into a worktree path): the hook body resolves
# `git rev-parse --show-toplevel` and runs THAT checkout's run.sh, so a
# recycled/deleted worktree must not break the shared hook.
if [[ -e "$dest" || -L "$dest" ]]; then
  if [[ -f "$dest" && ! -L "$dest" ]] && cmp -s "$src" "$dest"; then
    echo "[repo-hygiene] hook already installed (content match): $dest"
    exit 0
  fi
  bak="$dest.bak.$(date +%Y%m%d%H%M%S)"
  echo "[repo-hygiene] backing up existing hook to $bak"
  mv "$dest" "$bak"
fi

cp "$src" "$dest"
chmod +x "$dest"
echo "[repo-hygiene] installed pre-commit: $dest (copied from $src)"
echo "[repo-hygiene] verify: git commit (staged md with a broken link should fail)"

