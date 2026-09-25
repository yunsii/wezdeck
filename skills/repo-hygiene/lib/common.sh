# shellcheck shell=bash
# Shared helpers for repo-hygiene.

hygiene_repo_root() {
  if [[ -n "${HYGIENE_REPO_ROOT:-}" ]]; then
    printf '%s\n' "$HYGIENE_REPO_ROOT"
    return 0
  fi
  # lib/ -> repo-hygiene/ -> dev/ -> scripts/ -> repo
  cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd
}

hygiene_home() {
  if [[ -n "${HYGIENE_HOME:-}" ]]; then
    printf '%s\n' "$HYGIENE_HOME"
    return 0
  fi
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

hygiene_log() {
  printf '[repo-hygiene] %s\n' "$*"
}

hygiene_err() {
  printf '[repo-hygiene] %s\n' "$*" >&2
}

# Match path against a simple glob (* within a segment, ** across segments).
hygiene_glob_match() {
  local path="$1" pattern="$2"
  python3 - "$path" "$pattern" <<'PY'
import fnmatch, sys
path, pattern = sys.argv[1], sys.argv[2]
# fnmatch does not treat ** specially across dirs the same way; normalize.
if "**" in pattern:
    # Convert **/x and a/**/b to recursive-ish fnmatch by allowing any dirs.
    alt = pattern.replace("**/", "*").replace("/**", "/*")
    ok = fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(path, alt)
    # Also try segment-wise: scripts/**/*.sh → scripts/*/*.sh, scripts/*.sh, ...
    if not ok and pattern.endswith("/**/*.sh"):
        prefix = pattern[: -len("/**/*.sh")]
        ok = path.startswith(prefix + "/") and path.endswith(".sh")
    elif not ok and "/**/" in pattern:
        pre, post = pattern.split("/**/", 1)
        ok = path.startswith(pre + "/") and fnmatch.fnmatch(path.split("/")[-1], post.split("/")[-1]) and post.split("/")[-1] in path
    sys.exit(0 if ok else 1)
sys.exit(0 if fnmatch.fnmatch(path, pattern) else 1)
PY
}

hygiene_relpath() {
  local abs="$1" root="$2"
  if [[ "$abs" == "$root" ]]; then
    printf '.\n'
    return
  fi
  if [[ "$abs" == "$root"/* ]]; then
    printf '%s\n' "${abs#"$root"/}"
    return
  fi
  printf '%s\n' "$abs"
}

hygiene_line_count() {
  local f="$1"
  if [[ ! -f "$f" ]]; then
    echo 0
    return
  fi
  wc -l <"$f" | tr -d '[:space:]'
}
