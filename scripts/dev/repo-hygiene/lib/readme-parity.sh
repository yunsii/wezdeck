# shellcheck shell=bash
# Bilingual README.md ↔ README.zh-CN.md structural parity.

HYGIENE_README_FAILS=0

# Args: root, mode (pre-commit|audit), optional staged paths...
# pre-commit: run when README.md or README.zh-CN.md is among staged paths
#             (or when either is missing while the other is staged).
# audit: always run when README.md exists in the tree.
hygiene_check_readme_parity() {
  local root="$1"
  local mode="$2"
  shift 2
  HYGIENE_README_FAILS=0

  local en="README.md" zh="README.zh-CN.md"
  local need=0
  local f

  case "$mode" in
    pre-commit)
      for f in "$@"; do
        if [[ "$f" == "$en" || "$f" == "$zh" ]]; then
          need=1
          break
        fi
      done
      (( need )) || return 0
      ;;
    audit)
      [[ -f "$root/$en" ]] || return 0
      ;;
    *)
      hygiene_err "readme-parity: unknown mode $mode"
      HYGIENE_README_FAILS=1
      return 1
      ;;
  esac

  local py="$HYGIENE_HOME/lib/readme-parity.py"
  local conf="$HYGIENE_HOME/readme-parity.conf"
  if [[ ! -f "$py" ]]; then
    hygiene_err "readme-parity.py missing"
    HYGIENE_README_FAILS=1
    return 1
  fi

  local out rc
  set +e
  out="$(python3 "$py" "$root" "$conf" 2>&1)"
  rc=$?
  set -e
  if [[ -n "$out" ]]; then
    printf '%s\n' "$out"
  fi
  if (( rc != 0 )); then
    HYGIENE_README_FAILS=1
    return 1
  fi
  return 0
}
