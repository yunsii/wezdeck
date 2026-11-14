# shellcheck shell=bash
# Installed pre-commit hook vs. the tracked source (skills/repo-hygiene/hooks/pre-commit).
#
# install-hooks.sh *copies* the hook into the shared git hooks dir, so a later
# change to the tracked source (for example the runner moving from
# scripts/dev/repo-hygiene/ to skills/repo-hygiene/) does not reach the
# installed copy. A stale copy printed "runner missing … skip" and silently
# let every commit through (found 2026-11-14). This helper makes that drift
# visible to `run.sh audit` / `run.sh hook-status` / sync-runtime.
#
# hygiene_hook_status <repo_root>
#   Sets HYGIENE_HOOK_STATUS (one word) and HYGIENE_HOOK_DETAIL; call it
#   directly, not via $(...), so both variables reach the caller:
#     ok         installed hook matches the tracked source
#     missing    no pre-commit hook installed
#     drift      installed hook differs from the tracked source
#     hookspath  core.hooksPath points elsewhere, so the shared hook is not used
#     unknown    not a git repo / tracked source missing
#   Returns 0 only for ok.

hygiene_hook_status() {
  local root="${1:?missing repo root}"
  local src="$root/skills/repo-hygiene/hooks/pre-commit"
  HYGIENE_HOOK_STATUS=""
  HYGIENE_HOOK_DETAIL=""

  local common
  if ! common="$(git -C "$root" rev-parse --git-common-dir 2>/dev/null)"; then
    HYGIENE_HOOK_DETAIL="not a git repo: $root"
    HYGIENE_HOOK_STATUS=unknown
    return 1
  fi
  case "$common" in
    /*) ;;
    *) common="$(cd "$root/$common" && pwd)" ;;
  esac
  if [[ ! -f "$src" ]]; then
    HYGIENE_HOOK_DETAIL="tracked hook source missing: $src"
    HYGIENE_HOOK_STATUS=unknown
    return 1
  fi

  local hooks_path
  hooks_path="$(git -C "$root" config --get core.hooksPath || true)"
  if [[ -n "$hooks_path" ]]; then
    HYGIENE_HOOK_DETAIL="core.hooksPath=$hooks_path overrides $common/hooks"
    HYGIENE_HOOK_STATUS=hookspath
    return 1
  fi

  local dest="$common/hooks/pre-commit"
  if [[ ! -f "$dest" ]]; then
    HYGIENE_HOOK_DETAIL="no hook at $dest"
    HYGIENE_HOOK_STATUS=missing
    return 1
  fi
  if ! cmp -s "$src" "$dest"; then
    HYGIENE_HOOK_DETAIL="$dest differs from $src"
    HYGIENE_HOOK_STATUS=drift
    return 1
  fi
  HYGIENE_HOOK_DETAIL="$dest"
  HYGIENE_HOOK_STATUS=ok
}
