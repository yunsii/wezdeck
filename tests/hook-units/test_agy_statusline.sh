#!/usr/bin/env bash
# Unit test for scripts/runtime/agy-statusline.sh and agy-statusline-tap.sh.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
render_script="$repo_root/scripts/runtime/agy-statusline.sh"
tap_script="$repo_root/scripts/runtime/agy-statusline-tap.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

assert_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" != "$want" ]]; then
    printf 'FAIL %s:\n  got : %q\n  want: %q\n' "$label" "$got" "$want" >&2
    exit 1
  fi
}

# 1. Wide Gemini snapshot renders model, mode, ctx, gemini 5h/7d with resets, and compact 3p summary.
gem_json='{
  "conversation_id": "bc0c1e21-bed2-4dd6-9848-c7f466052594",
  "model": {"id": "Gemini 4 Neon (High)", "display_name": "Gemini 4 Neon (High)"},
  "cycle_mode": "auto",
  "context_window": {"context_window_size": 1048576, "used_percentage": 14.24},
  "quota": {
    "gemini-5h": {"remaining_fraction": 0.9516, "reset_time": "2026-11-27T18:59:05Z", "reset_in_seconds": 15638},
    "gemini-weekly": {"remaining_fraction": 0.434, "reset_time": "2026-12-03T06:59:01Z", "reset_in_seconds": 490834},
    "3p-5h": {"remaining_fraction": 1, "reset_time": "1970-01-01T00:00:00Z", "reset_in_seconds": 0},
    "3p-weekly": {"remaining_fraction": 0.5, "reset_time": "2026-12-04T06:26:12Z", "reset_in_seconds": 575265}
  },
  "email": "secret@example.com",
  "terminal_width": 120
}'
got="$(WEZDECK_AGY_STATUS_DIR="$tmp_dir/s1" printf '%s' "$gem_json" | WEZDECK_AGY_STATUS_DIR="$tmp_dir/s1" bash "$render_script")"
assert_eq "wide gemini" "$got" "Gemini 4 Neon (High)  [auto]  ctx:14%  5h:5%(rst:4h 20m)  7d:57%(rst:5d 16h)  3p:0%/50%"

# 2. Narrow terminal hides secondary group so the line stays compact.
narrow_json="$(printf '%s' "$gem_json" | jq -c '.terminal_width = 80')"
got_narrow="$(printf '%s' "$narrow_json" | WEZDECK_AGY_STATUS_DIR="$tmp_dir/s2" bash "$render_script")"
assert_eq "narrow gemini" "$got_narrow" "Gemini 4 Neon (High)  [auto]  ctx:14%  5h:5%(rst:4h 20m)  7d:57%(rst:5d 16h)"

# 3. Third-party model switches primary buckets to 3p-* and omits rst for epoch-0 3p-5h; includes plan_tier when present.
tp_json="$(printf '%s' "$gem_json" | jq -c '.model = {"id": "Claude Sonnet 4.5", "display_name": "Claude Sonnet 4.5"} | .plan_tier = "Pro"')"
got_tp="$(printf '%s' "$tp_json" | WEZDECK_AGY_STATUS_DIR="$tmp_dir/s3" bash "$render_script")"
assert_eq "3p with plan" "$got_tp" "[Pro] Claude Sonnet 4.5  [auto]  ctx:14%  5h:0%  7d:50%(rst:6d 15h)  gem:5%/57%"

# 4. Tap writes both <session_id>.json and _account.json, strips email, and writes _account.json even when session_id is empty.
printf '%s' "$gem_json" | WEZDECK_AGY_STATUS_DIR="$tmp_dir/tap1" bash "$tap_script"
[[ -f "$tmp_dir/tap1/bc0c1e21-bed2-4dd6-9848-c7f466052594.json" ]] || { echo "FAIL missing session json" >&2; exit 1; }
[[ -f "$tmp_dir/tap1/_account.json" ]] || { echo "FAIL missing _account.json" >&2; exit 1; }
if jq -e 'has("email")' "$tmp_dir/tap1/_account.json" >/dev/null 2>&1; then
  echo "FAIL email must not be written to tap snapshot" >&2
  exit 1
fi

no_id_json="$(printf '%s' "$gem_json" | jq -c '.conversation_id = ""')"
printf '%s' "$no_id_json" | WEZDECK_AGY_STATUS_DIR="$tmp_dir/tap2" bash "$tap_script"
[[ -f "$tmp_dir/tap2/_account.json" ]] || { echo "FAIL _account.json missing when conversation_id is empty" >&2; exit 1; }
assert_eq "only _account.json when id empty" "$(ls -1 "$tmp_dir/tap2" | wc -l | tr -d ' ')" "1"

# 5. Path traversal session_id is rejected for per-session file while _account.json still updates cleanly.
bad_id_json="$(printf '%s' "$gem_json" | jq -c '.conversation_id = "../evil"')"
printf '%s' "$bad_id_json" | WEZDECK_AGY_STATUS_DIR="$tmp_dir/tap3" bash "$tap_script"
[[ ! -f "$tmp_dir/evil.json" ]] || { echo "FAIL path traversal written" >&2; exit 1; }
[[ -f "$tmp_dir/tap3/_account.json" ]] || { echo "FAIL _account.json missing" >&2; exit 1; }

echo "PASS test_agy_statusline"
