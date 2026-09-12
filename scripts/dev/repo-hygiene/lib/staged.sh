# shellcheck shell=bash
# Resolve the file set under review for pre-commit vs audit.

# Print repo-relative paths, one per line. Empty if nothing to check.
hygiene_list_targets() {
  local mode="$1" root="$2"
  case "$mode" in
    pre-commit)
      if [[ -n "${HYGIENE_STAGED_FILES:-}" ]]; then
        # Test / override: newline-separated repo-relative paths
        printf '%s\n' "$HYGIENE_STAGED_FILES"
        return 0
      fi
      # Staged for commit (Added/Copied/Modified/Renamed). Deleted skipped.
      git -C "$root" diff --cached --name-only --diff-filter=ACMR -z \
        | tr '\0' '\n' \
        | sed '/^$/d'
      ;;
    audit)
      git -C "$root" ls-files \
        -z -- '*.md' '*.lua' '*.sh' 'AGENTS.md' 'CLAUDE.md' 'README.md' \
        | tr '\0' '\n' \
        | sed '/^$/d'
      ;;
    *)
      hygiene_err "unknown target mode: $mode"
      return 2
      ;;
  esac
}

hygiene_list_staged_md() {
  local root="$1"
  hygiene_list_targets pre-commit "$root" | grep -E '\.(md|mdx)$' || true
}

hygiene_list_staged_sh() {
  local root="$1"
  hygiene_list_targets pre-commit "$root" | grep -E '\.sh$' || true
}
