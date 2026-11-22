#!/usr/bin/env bash
# Browser identity (scene → profile) for agents: which browser profile a task
# must use, and whether the account a page is logged into is the expected one.
# docs/browser-debug.md "Scenes and profiles".
#
#   browser-profile.sh resolve [--cwd PATH] [--scene NAME] [--profile ID] [--anon]
#       → JSON {ok, profile, scene, label, backend, backend_profile, reason, accounts}
#         or  {ok:false, need:"ask", reason, choices}   (exit 2: ask the human)
#   browser-profile.sh expect  --profile ID --url URL
#       → JSON {host, expected}   (expected null when the site is not registered)
#   browser-profile.sh check   --profile ID --url URL --actual ACCOUNT
#       → JSON {verdict: match|mismatch|unregistered, expected, actual}
#         exit 0 for match / unregistered, 3 for mismatch (stop, tell the human)
#   browser-profile.sh list    → JSON of scenes and profiles
#
# Resolution order (first that decides wins):
#   1. --profile ID (the human named a profile)
#   2. --anon → the profile marked "anonymous" (public pages, acceptance runs)
#   3. --scene NAME (the human named a scene) → that scene's default
#   4. --cwd → the scene whose `paths` prefix matches longest → its default
#   5. config "fallback": a scene name, or "ask" (exit 2, list the choices)
#
# Config: ${WEZDECK_BROWSER_PROFILES:-<repo>/wezterm-x/local/browser-profiles.json}
# (template: wezterm-x/local.example/browser-profiles.json). Backend from
# WEZDECK_BROWSER_BACKEND (ego | cdp); a profile maps each backend to its own
# id under "backends" so cdp can be added later without changing the shape.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
export WEZTERM_RUNTIME_LOG_SOURCE="browser-profile.sh"

config="${WEZDECK_BROWSER_PROFILES:-$REPO_ROOT/wezterm-x/local/browser-profiles.json}"
backend="${WEZDECK_BROWSER_BACKEND:-ego}"

die() {
  jq -cn --arg error "$1" '{ok: false, error: $error}'
  exit "${2:-1}"
}

command -v jq >/dev/null 2>&1 || {
  printf '{"ok":false,"error":"jq is required"}\n'
  exit 1
}
[[ -r "$config" ]] || die "no browser profile config at $config (copy wezterm-x/local.example/browser-profiles.json)"
jq -e '.scenes and .profiles' "$config" >/dev/null 2>&1 || die "invalid config $config: needs .scenes and .profiles"

host_of() {
  local url="${1#*://}"
  url="${url%%/*}"
  url="${url%%:*}"
  printf '%s' "${url,,}"
}

# Pretty answer for one profile id + why it was chosen.
answer() {
  local id="$1" reason="$2"
  jq -c --arg id "$id" --arg reason "$reason" --arg backend "$backend" '
    .profiles[$id] as $p
    | if $p == null then {ok: false, error: ("unknown profile " + $id)}
      else {
        ok: true,
        profile: $id,
        scene: ($p.scene // null),
        label: ($p.label // $id),
        backend: $backend,
        backend_profile: ($p.backends[$backend] // null),
        reason: $reason,
        accounts: ($p.accounts // {})
      } end' "$config"
}

log_choice() {
  local outcome="$1" profile="$2" reason="$3"
  runtime_log_info browser_agent "browser profile resolved" \
    "outcome=$outcome" "profile=$profile" "backend=$backend" "reason=$reason" \
    "cwd=${cwd:-}"
}

cmd_resolve() {
  local profile='' scene='' anon=0
  cwd=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd) cwd="${2:-}"; shift 2 ;;
      --scene) scene="${2:-}"; shift 2 ;;
      --profile) profile="${2:-}"; shift 2 ;;
      --anon) anon=1; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  local reason id
  if [[ -n "$profile" ]]; then
    id="$profile"
    reason="named by the human"
  elif ((anon)); then
    id="$(jq -r '.profiles | to_entries[] | select(.value.anonymous == true) | .key' "$config" | head -n1)"
    [[ -n "$id" ]] || die "no profile is marked anonymous"
    reason="anonymous browsing requested"
  elif [[ -n "$scene" ]]; then
    id="$(jq -r --arg s "$scene" '.scenes[$s].default // empty' "$config")"
    [[ -n "$id" ]] || die "unknown scene $scene"
    reason="scene $scene named by the human"
  else
    local abs=''
    if [[ -n "$cwd" ]]; then
      abs="$(cd "$cwd" 2>/dev/null && pwd -P || printf '%s' "$cwd")"
    fi
    # longest matching path prefix across all scenes (~ expanded)
    local match
    match="$(jq -r --arg home "$HOME" '
      .scenes | to_entries[]
      | .key as $scene
      | (.value.paths // [])[]
      | sub("^~"; $home)
      | [$scene, .] | @tsv' "$config" |
      while IFS=$'\t' read -r s prefix; do
        prefix="${prefix%/}"
        if [[ -n "$abs" && ("$abs" == "$prefix" || "$abs" == "$prefix"/*) ]]; then
          printf '%s\t%s\t%s\n' "${#prefix}" "$s" "$prefix"
        fi
      done | sort -rn | head -n1)"
    if [[ -n "$match" ]]; then
      scene="$(cut -f2 <<<"$match")"
      id="$(jq -r --arg s "$scene" '.scenes[$s].default // empty' "$config")"
      reason="$abs is under $(cut -f3 <<<"$match") (scene $scene)"
    else
      local fallback
      fallback="$(jq -r '.fallback // "ask"' "$config")"
      if [[ "$fallback" == "ask" ]]; then
        log_choice ask '' "no scene for cwd=${abs:-none}"
        jq -c --arg reason "no scene matches ${abs:-the current directory}; ask which one" '
          {ok: false, need: "ask", reason: $reason,
           choices: [.scenes | to_entries[] | {scene: .key, label: (.value.label // .key), profile: .value.default}]}' "$config"
        exit 2
      fi
      scene="$fallback"
      id="$(jq -r --arg s "$scene" '.scenes[$s].default // empty' "$config")"
      reason="no scene for ${abs:-the current directory}; fallback scene $scene"
    fi
  fi
  local out
  out="$(answer "$id" "$reason")"
  if [[ "$(jq -r '.ok' <<<"$out")" != "true" ]]; then
    printf '%s\n' "$out"
    exit 1
  fi
  if [[ "$(jq -r '.backend_profile' <<<"$out")" == "null" ]]; then
    log_choice no_backend_profile "$id" "$reason"
    jq -c --arg b "$backend" '. + {ok: false, error: ("profile has no id for backend " + $b)}' <<<"$out"
    exit 1
  fi
  log_choice chosen "$id" "$reason"
  printf '%s\n' "$out"
}

expected_for() {
  local id="$1" host="$2"
  # exact host first, then the longest registered parent domain
  jq -r --arg id "$id" --arg host "$host" '
    (.profiles[$id].accounts // {}) as $a
    | [$a | to_entries[] | . as $e | select($host == $e.key or ($host | endswith("." + $e.key)))]
    | sort_by(.key | length) | reverse | .[0].value // empty' "$config"
}

cmd_expect() {
  local id='' url=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --profile) id="${2:-}"; shift 2 ;;
      --url) url="${2:-}"; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  [[ -n "$id" && -n "$url" ]] || die "usage: expect --profile ID --url URL"
  local host expected
  host="$(host_of "$url")"
  expected="$(expected_for "$id" "$host")"
  jq -cn --arg host "$host" --arg expected "$expected" \
    '{host: $host, expected: (if $expected == "" then null else $expected end)}'
}

cmd_check() {
  local id='' url='' actual=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --profile) id="${2:-}"; shift 2 ;;
      --url) url="${2:-}"; shift 2 ;;
      --actual) actual="${2:-}"; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  [[ -n "$id" && -n "$url" ]] || die "usage: check --profile ID --url URL --actual ACCOUNT"
  local host expected verdict code=0
  host="$(host_of "$url")"
  expected="$(expected_for "$id" "$host")"
  if [[ -z "$expected" ]]; then
    verdict=unregistered
  elif [[ "${actual,,}" == "${expected,,}" ]]; then
    verdict=match
  else
    verdict=mismatch
    code=3
  fi
  runtime_log_info browser_agent "browser identity checked" \
    "verdict=$verdict" "profile=$id" "host=$host" "expected=$expected" "actual=$actual"
  jq -cn --arg verdict "$verdict" --arg host "$host" --arg expected "$expected" --arg actual "$actual" --arg id "$id" \
    '{verdict: $verdict, profile: $id, host: $host,
      expected: (if $expected == "" then null else $expected end), actual: $actual}'
  exit "$code"
}

case "${1:-}" in
  resolve) shift; cmd_resolve "$@" ;;
  expect) shift; cmd_expect "$@" ;;
  check) shift; cmd_check "$@" ;;
  list) jq -c '{fallback: (.fallback // "ask"), scenes, profiles}' "$config" ;;
  *)
    printf 'usage: %s resolve|expect|check|list ...\n' "$0" >&2
    exit 1
    ;;
esac
