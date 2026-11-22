#!/usr/bin/env bash
# Offline tests for scripts/runtime/browser-profile.sh (scene → profile
# resolution and identity checks). A temp HOME + config; never reads the
# machine's real wezterm-x/local/browser-profiles.json.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI="$REPO/scripts/runtime/browser-profile.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" WEZDECK_BROWSER_PROFILES="$TMP/profiles.json"
export WEZDECK_BROWSER_BACKEND=ego WEZTERM_RUNTIME_LOG_FILE="$TMP/logs/runtime.log" WEZTERM_RUNTIME_LOG_ENABLED=1
mkdir -p "$TMP/logs" "$HOME/work/app" "$HOME/work/app/deep" "$HOME/github/site" "$HOME/github/work-mirror" "$TMP/elsewhere"
cat >"$WEZDECK_BROWSER_PROFILES" <<JSON
{
  "fallback": "ask",
  "scenes": {
    "work": { "label": "办公", "default": "work", "paths": ["~/work", "~/github/work-mirror"] },
    "personal": { "label": "个人", "default": "personal", "paths": ["~/github"] }
  },
  "profiles": {
    "work": { "scene": "work", "backends": { "ego": "Profile 1" },
              "accounts": { "dash.cloudflare.com": "me@company.example" } },
    "personal": { "scene": "personal", "backends": { "ego": "Profile 4" },
                  "accounts": { "dash.cloudflare.com": "me@personal.example", "github.com": "me" } },
    "personal-alt": { "scene": "personal", "backends": { "ego": "Profile 5" } },
    "anon": { "scene": null, "anonymous": true, "backends": { "ego": "Profile 2" } },
    "cdp-only": { "scene": "work", "backends": { "cdp": "chrome-debug-work" } }
  }
}
JSON

pass=0 fail=0
expect() { # name, want-exit, want-jq-expr, command...
  local name="$1" want="$2" filter="$3"
  shift 3
  local out code
  out="$("$@" 2>/dev/null)"
  code=$?
  if [[ "$code" == "$want" ]] && jq -e "$filter" >/dev/null 2>&1 <<<"$out"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL %s (exit %s, want %s): %s\n' "$name" "$code" "$want" "$out"
  fi
}

expect "work repo → work" 0 '.profile == "work" and .backend_profile == "Profile 1"' \
  "$CLI" resolve --cwd "$HOME/work/app/deep"
expect "personal repo → personal" 0 '.profile == "personal" and .scene == "personal"' \
  "$CLI" resolve --cwd "$HOME/github/site"
expect "longest prefix wins (work mirror under ~/github)" 0 '.profile == "work"' \
  "$CLI" resolve --cwd "$HOME/github/work-mirror"
expect "unknown directory → ask with choices" 2 '.need == "ask" and (.choices | length) == 2' \
  "$CLI" resolve --cwd "$TMP/elsewhere"
expect "no cwd → ask" 2 '.need == "ask"' "$CLI" resolve
expect "scene named by the human" 0 '.profile == "personal" and (.reason | test("named"))' \
  "$CLI" resolve --scene personal --cwd "$HOME/work/app"
expect "profile named by the human beats cwd" 0 '.profile == "personal-alt" and .backend_profile == "Profile 5"' \
  "$CLI" resolve --profile personal-alt --cwd "$HOME/work/app"
expect "anonymous profile" 0 '.profile == "anon" and .scene == null' "$CLI" resolve --anon
expect "unknown profile" 1 '.ok == false' "$CLI" resolve --profile nope
expect "profile without an id for this backend" 1 '.ok == false and (.error | test("backend"))' \
  "$CLI" resolve --profile cdp-only
expect "check: right account" 0 '.verdict == "match"' \
  "$CLI" check --profile personal --url https://dash.cloudflare.com/abc --actual ME@personal.example
expect "check: wrong account stops" 3 '.verdict == "mismatch" and .expected == "me@personal.example"' \
  "$CLI" check --profile personal --url https://dash.cloudflare.com/abc --actual me@company.example
expect "check: subdomain uses the parent registration" 3 '.verdict == "mismatch"' \
  "$CLI" check --profile work --url https://one.dash.cloudflare.com --actual me@personal.example
expect "check: unregistered site is not blocked" 0 '.verdict == "unregistered"' \
  "$CLI" check --profile work --url https://github.com/x --actual someone
expect "expect: registered site" 0 '.expected == "me"' "$CLI" expect --profile personal --url https://github.com/me
expect "list" 0 '.fallback == "ask" and (.profiles | has("anon"))' "$CLI" list

# fallback scene instead of asking
jq '.fallback = "personal"' "$WEZDECK_BROWSER_PROFILES" >"$TMP/p2.json"
expect "fallback scene" 0 '.profile == "personal" and (.reason | test("fallback"))' \
  env WEZDECK_BROWSER_PROFILES="$TMP/p2.json" "$CLI" resolve --cwd "$TMP/elsewhere"

# observability: choices and checks are logged under browser_agent
if grep -rqs 'category="browser_agent".*browser profile resolved' "$TMP/logs" ||
  grep -rqs 'browser profile resolved' "$TMP/logs"; then pass=$((pass + 1)); else
  fail=$((fail + 1)); echo "FAIL resolve not logged"; fi
if grep -rqs 'browser identity checked.*verdict=mismatch\|verdict="mismatch"' "$TMP/logs"; then pass=$((pass + 1)); else
  fail=$((fail + 1)); echo "FAIL mismatch not logged"; fi

printf 'browser-profile: %d passed, %d failed\n' "$pass" "$fail"
((fail == 0))
