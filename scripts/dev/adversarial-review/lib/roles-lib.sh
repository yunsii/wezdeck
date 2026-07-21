#!/usr/bin/env bash
# roles-lib.sh — read the role standard from roles.conf.
# Source after provider.sh. Override the file with _ROLES_CONF=... if needed.

_ROLES_CONF="${_ROLES_CONF:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/roles.conf}"

# role_effort <tool> <role>  → effort string (empty if not found)
role_effort() {
  awk -F'|' -v t="$1" -v r="$2" \
    '/^[[:space:]]*#/ || NF<4 {next} $1==t && $2==r {print $3; exit}' "$_ROLES_CONF"
}

# role_candidates <tool> <role>  → space-separated agent names ([0]=default)
role_candidates() {
  awk -F'|' -v t="$1" -v r="$2" \
    '/^[[:space:]]*#/ || NF<4 {next} $1==t && $2==r {print $4; exit}' "$_ROLES_CONF"
}
