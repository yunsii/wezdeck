# shellcheck shell=bash
# bash -n on staged/selected shell scripts.

hygiene_check_shell_syntax() {
  local root="$1"
  shift
  HYGIENE_SHELL_FAILS=0
  local rel
  for rel in "$@"; do
    [[ "$rel" == *.sh ]] || continue
    [[ -f "$root/$rel" ]] || continue
    if ! bash -n "$root/$rel" 2>/tmp/hygiene-bash-n.err; then
      printf 'FAIL %s: bash -n failed\n' "$rel"
      sed 's/^/  /' /tmp/hygiene-bash-n.err >&2 || true
      HYGIENE_SHELL_FAILS=$((HYGIENE_SHELL_FAILS + 1))
    fi
  done
  rm -f /tmp/hygiene-bash-n.err
}
