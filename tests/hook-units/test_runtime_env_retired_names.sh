#!/usr/bin/env bash
# Retired shell-env filenames must warn and must not source.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/runtime-env-lib.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  \xe2\x9c\x93 %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  \xe2\x9c\x97 %s\n' "$1"; }

tmpdir="$(mktemp -d)"
log="$(mktemp)"
warn_file="$(mktemp)"
trap 'rm -rf "$tmpdir" "$log" "$warn_file"' EXIT

printf 'export WEZDECK_REPO=/from-retired\nexport RETIRED_MARKER=1\n' >"$tmpdir/wezterm-env.env"
printf 'export WEZDECK_REPO=/from-current\n' >"$tmpdir/wezdeck-env.env"
chmod 600 "$tmpdir/wezterm-env.env" "$tmpdir/wezdeck-env.env"

export WEZTERM_RUNTIME_LOG_FILE="$log"
export WEZTERM_RUNTIME_LOG_ENABLED=1
unset WEZDECK_REPO RETIRED_MARKER

# Stay in this shell so sourced assignments remain visible.
runtime_env_load_dir "$tmpdir" 2>"$warn_file"
warn="$(cat "$warn_file")"

if [[ "${WEZDECK_REPO:-}" == "/from-current" ]]; then
  ok "current wezdeck-env.env sourced"
else
  no "current wezdeck-env.env sourced (got='${WEZDECK_REPO:-}')"
fi
if [[ -z "${RETIRED_MARKER:-}" ]]; then
  ok "retired wezterm-env.env not sourced"
else
  no "retired wezterm-env.env not sourced (RETIRED_MARKER=${RETIRED_MARKER})"
fi
case "$warn" in
  *"skip retired wezterm-env.env"*"wezdeck-env.env"*) ok "stderr names replacement" ;;
  *) no "stderr names replacement (got='$warn')" ;;
esac
if grep -q 'category="env"' "$log" && grep -q 'retired shell-env file skipped' "$log"; then
  ok "runtime.log category=env"
else
  no "runtime.log category=env (log=$(tr '\n' ' ' <"$log"))"
fi

printf 'pass=%s fail=%s\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
