# shellcheck shell=bash
# Cheap secret heuristics on staged text files (not a substitute for gitleaks).

hygiene_check_secrets() {
  local root="$1"
  shift
  HYGIENE_SECRET_FAILS=0
  local rel
  for rel in "$@"; do
    [[ -f "$root/$rel" ]] || continue
    # skip binary-ish and lockfiles; skip this file (patterns would self-match)
    case "$rel" in
      *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.zip|*.gz|*.tgz|*.exe|*.dll|*.so|*.wasm) continue ;;
      *lock.json|*pnpm-lock.yaml|*Cargo.lock) continue ;;
      */secrets-heuristics.sh|secrets-heuristics.sh) continue ;;
    esac
    if grep -nE \
      -e 'BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY' \
      -e 'AKIA[0-9A-Z]{16}' \
      -e 'ghp_[A-Za-z0-9]{36}' \
      -e 'xox[baprs]-[0-9A-Za-z-]{10,}' \
      -e '-----BEGIN PGP PRIVATE KEY BLOCK-----' \
      "$root/$rel" >/tmp/hygiene-secrets.hits 2>/dev/null; then
      printf 'FAIL %s: secret heuristic matched\n' "$rel"
      sed 's/^/  /' /tmp/hygiene-secrets.hits | head -n 5
      HYGIENE_SECRET_FAILS=$((HYGIENE_SECRET_FAILS + 1))
    fi
  done
  rm -f /tmp/hygiene-secrets.hits
}
