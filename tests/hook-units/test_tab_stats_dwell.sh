#!/usr/bin/env bash
# Dwell-weighted tab-stats v2: tab_stats_bump pays raw_count++ only;
# tab_stats_close_out adds the actual dwell_ms (uncapped, never
# normalized) into dwell_ms and total_dwell_ms. This file exercises:
#   - the bump-vs-close split (no weight ever paid on entry)
#   - the dead-zone filter (sub-second dwell stays at 0)
#   - the long-vs-short rank stability (regression for the v1
#     renormalize-to-1.0 bug that demoted heavily-used sessions
#     after a few 30s peeks elsewhere)
#   - the tab-stats-bump.sh enter-state + close-out wiring
#
# Drive: scripts/dev/test-lua-units.sh (the runner sweeps hook-units/
# too) or run this file directly.
set -u

guard_sandbox_paths() {
  local p="$1"
  if [[ -z "$p" || "$p" == /mnt/c/* ]]; then
    echo "SAFETY ABORT: sandbox path resolves to live state ($p)" >&2
    exit 99
  fi
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lib="$repo_root/scripts/runtime/tab-stats-lib.sh"
bump="$repo_root/scripts/runtime/tab-stats-bump.sh"

pass=0
fail=0
note() { printf '  %s\n' "$1"; }
ok()   { pass=$((pass+1)); printf '  \xe2\x9c\x93 %s\n' "$1"; }
no()   { fail=$((fail+1)); printf '  \xe2\x9c\x97 %s\n' "$1"; }

# Fresh sandbox per case so state files do not leak across tests.
new_sandbox() {
  local sandbox
  sandbox="$(mktemp -d -t wezterm-tab-stats-XXXXXX)"
  guard_sandbox_paths "$sandbox/wezterm-runtime"
  mkdir -p "$sandbox/wezterm-runtime/state/tab-stats"
  printf '%s' "$sandbox"
}

# Source the lib inside a subshell that targets the sandbox so we can
# call tab_stats_close_out / tab_stats_bump directly with predictable
# state. Echoes the resulting workspace JSON.
run_lib_case() {
  local sandbox="$1"; shift
  env \
    WINDOWS_RUNTIME_STATE_WSL="$sandbox/wezterm-runtime" \
    WINDOWS_LOCALAPPDATA_WSL="$sandbox" \
    WINDOWS_USERPROFILE_WSL="$sandbox" \
    XDG_STATE_HOME="$sandbox" \
    WEZTERM_NO_PATH_CACHE=1 \
    bash -c "
      set -u
      . '$lib'
      $*
    "
}

# bump-then-close-out -------------------------------------------------
printf '\xe2\x96\xb8 %s\n' 'bump vs close-out responsibilities'
sandbox="$(new_sandbox)"
state_file="$sandbox/wezterm-runtime/state/tab-stats/work.json"

run_lib_case "$sandbox" "tab_stats_bump work foo-session" >/dev/null
raw=$(jq -r '.sessions["foo-session"].raw_count' "$state_file" 2>/dev/null || echo MISS)
dwell=$(jq -r '.sessions["foo-session"].dwell_ms' "$state_file" 2>/dev/null || echo MISS)
[[ "$raw" == "1" ]] && ok "bump → raw_count=1" || no "raw_count expected 1, got $raw"
# Entry must NOT pay dwell on its own; it stays at 0 until close_out.
[[ "$dwell" == "0" ]] && ok "bump → dwell_ms=0 (paid on leave)" \
  || no "dwell_ms expected 0 after bump, got $dwell"

# Sub-second close-out: filtered, no dwell.
run_lib_case "$sandbox" "tab_stats_close_out work foo-session 500" >/dev/null
dwell=$(jq -r '.sessions["foo-session"].dwell_ms' "$state_file")
[[ "$dwell" == "0" ]] && ok "close_out dwell=500ms (dead-zone) → still 0" \
  || no "dead-zone close-out leaked dwell: $dwell"

# Genuine work burst: 30000ms close-out adds 30000 to dwell_ms +
# total_dwell_ms (no normalization, no saturation cap).
run_lib_case "$sandbox" "tab_stats_close_out work foo-session 30000" >/dev/null
dwell=$(jq -r '.sessions["foo-session"].dwell_ms' "$state_file")
total=$(jq -r '.sessions["foo-session"].total_dwell_ms' "$state_file")
# Decay over <1s is negligible (factor ~1.0), so dwell ≈ 30000 ± epsilon.
dwell_ok=$(awk -v d="$dwell" 'BEGIN { print (d >= 29999 && d <= 30001) ? 1 : 0 }')
[[ "$dwell_ok" == "1" ]] && ok "close_out 30s → dwell_ms ≈ 30000 (got $dwell)" \
  || no "close_out 30s expected ≈30000, got $dwell"
[[ "$total" == "30000" ]] && ok "close_out 30s → total_dwell_ms = 30000 (never decayed)" \
  || no "total_dwell_ms expected 30000, got $total"

# A 2h burst adds proportionally more dwell — uncapped. This is the
# key v2 property the v1 saturation curve was hiding.
run_lib_case "$sandbox" "tab_stats_close_out work foo-session 7200000" >/dev/null
total=$(jq -r '.sessions["foo-session"].total_dwell_ms' "$state_file")
[[ "$total" == "7230000" ]] && ok "2h burst → total_dwell_ms = 7,230,000 (240x a 30s burst)" \
  || no "total_dwell_ms expected 7230000, got $total"

# bump should NOT change raw_count beyond +1 per fire; close_out should
# never change raw_count at all (asymmetry is the whole point).
run_lib_case "$sandbox" "tab_stats_close_out work foo-session 30000" >/dev/null
raw_after=$(jq -r '.sessions["foo-session"].raw_count' "$state_file")
[[ "$raw_after" == "1" ]] && ok "close_out leaves raw_count alone" \
  || no "raw_count drifted via close_out: $raw_after"

# Long-used vs short-visit rank stability -----------------------------
# Regression for the v1 normalize-to-1.0 bug: a session with 2h of
# dwell must stay ranked above three different sessions that each only
# got a single 30s visit. Under v1 those three competitors all tied at
# weight=1.0 after their close-out and could displace the long-used
# session out of top-N. Under v2 the 240x ms-scale gap is preserved.
printf '\xe2\x96\xb8 %s\n' 'long-used session stays ranked above short visits'
sandbox="$(new_sandbox)"
state_file="$sandbox/wezterm-runtime/state/tab-stats/work.json"

# heavy: 2h cumulative dwell.
run_lib_case "$sandbox" \
  "tab_stats_bump work heavy; tab_stats_close_out work heavy 7200000" >/dev/null

# Three different competitors, each a single 30s visit.
for s in light_a light_b light_c; do
  run_lib_case "$sandbox" \
    "tab_stats_bump work $s; tab_stats_close_out work $s 30000" >/dev/null
done

heavy_dwell=$(jq -r '.sessions.heavy.dwell_ms' "$state_file")
top_name=$(jq -r '
  (.sessions // {})
  | to_entries
  | sort_by(- (.value.dwell_ms // 0))
  | .[0].key
' "$state_file")
[[ "$top_name" == "heavy" ]] && ok "heavy session retains rank 1 after 3 short competitors" \
  || no "expected heavy at rank 1, got $top_name"

ratio_ok=$(awk -v h="$heavy_dwell" 'BEGIN { print (h >= 7100000) ? 1 : 0 }')
[[ "$ratio_ok" == "1" ]] && ok "heavy dwell_ms ≥ 7.1M (decay over a few writes is tiny)" \
  || no "heavy dwell_ms unexpectedly low: $heavy_dwell"

# v1 → v2 migration --------------------------------------------------
# v1 weight values are corrupted by renormalize+fragmentation (a heavily
# refreshed project ends up with 7 small rows whose weights don't sum
# back to true cumulative usage). Migration ignores weight and seeds
# dwell_ms from raw_count * 30000 (30s per past focus event), matching
# the v1 saturation point. This recovers the right magnitude for
# heavily-used projects that v1 demoted via fragmentation.
printf '\xe2\x96\xb8 %s\n' 'v1 → v2 migration (raw_count seeding ignores corrupted weight)'
sandbox="$(new_sandbox)"
state_file="$sandbox/wezterm-runtime/state/tab-stats/work.json"
# Use a recent last_bump_ms so decay during the first v2 write is
# negligible — that way we can assert exact seed values.
now_ms=$(date +%s%3N)
# heavy_use has tiny weight (fragmented across imaginary refresh rows)
# but high raw_count — true magnitude must be recovered from raw_count.
# light_use has high weight but low raw_count — gets demoted as the
# fragmentation pathology suggests it should.
cat > "$state_file" <<JSON
{
  "version": 1,
  "half_life_days": 7,
  "sessions": {
    "heavy_use": { "weight": 0.05, "raw_count": 20, "last_bump_ms": $now_ms },
    "light_use": { "weight": 1.0,  "raw_count": 2,  "last_bump_ms": $now_ms }
  }
}
JSON

# tab_stats_top_n's read-side fallback still uses weight (it only sees
# what's on disk; the writer migration hasn't fired yet). So at read
# time before any write, light_use still ranks higher by weight.
top=$(run_lib_case "$sandbox" "tab_stats_top_n work 1")
[[ "$top" == "light_use" ]] && ok "v1 pre-migration read: weight-based fallback ranks light_use first" \
  || no "v1 read: expected light_use, got $top"

# A close-out on an unrelated session triggers the migration write.
# After that, both sessions are seeded from raw_count and the rank
# flips: heavy_use (20 events * 30s = 600K ms) beats light_use
# (2 events * 30s = 60K ms).
run_lib_case "$sandbox" "tab_stats_close_out work heavy_use 30000" >/dev/null
version=$(jq -r '.version' "$state_file")
[[ "$version" == "2" ]] && ok "write bumps version → 2" \
  || no "version expected 2, got $version"

heavy_dwell=$(jq -r '.sessions.heavy_use.dwell_ms' "$state_file")
heavy_total=$(jq -r '.sessions.heavy_use.total_dwell_ms' "$state_file")
light_dwell=$(jq -r '.sessions.light_use.dwell_ms' "$state_file")
light_total=$(jq -r '.sessions.light_use.total_dwell_ms' "$state_file")

# heavy_use: seed 20*30000=600000 + delta 30000 = 630000
heavy_dwell_ok=$(awk -v d="$heavy_dwell" 'BEGIN { print (d >= 629999 && d <= 630001) ? 1 : 0 }')
[[ "$heavy_dwell_ok" == "1" ]] && ok "heavy_use dwell_ms ≈ 630000 (raw_count seed + 30s close-out)" \
  || no "heavy_use dwell_ms expected ≈630000, got $heavy_dwell"
heavy_total_ok=$(awk -v t="$heavy_total" 'BEGIN { print (t >= 629999 && t <= 630001) ? 1 : 0 }')
[[ "$heavy_total_ok" == "1" ]] && ok "heavy_use total_dwell_ms ≈ 630000" \
  || no "heavy_use total_dwell_ms expected ≈630000, got $heavy_total"

# light_use: seed 2*30000=60000, no delta (not the target)
light_dwell_ok=$(awk -v d="$light_dwell" 'BEGIN { print (d >= 59999 && d <= 60001) ? 1 : 0 }')
[[ "$light_dwell_ok" == "1" ]] && ok "light_use dwell_ms = 60000 (raw_count seed, weight 1.0 ignored)" \
  || no "light_use dwell_ms expected 60000, got $light_dwell"
[[ "$light_total" == "60000" ]] && ok "light_use total_dwell_ms = 60000" \
  || no "light_use total_dwell_ms expected 60000, got $light_total"

# Final rank after migration: heavy_use first (the corrupted v1 weight
# is discarded; raw_count drives the true ordering).
top_after=$(run_lib_case "$sandbox" "tab_stats_top_n work 1")
[[ "$top_after" == "heavy_use" ]] && ok "post-migration: heavy_use rank #1 (raw_count seeding wins)" \
  || no "post-migration: expected heavy_use, got $top_after"

# tab-stats-bump.sh: enter/leave wiring -------------------------------
printf '\xe2\x96\xb8 %s\n' 'tab-stats-bump.sh enter-state + close-out flow'
sandbox="$(new_sandbox)"
state_dir="$sandbox/wezterm-runtime/state/tab-stats"

# Mock tmux for `show-options -v -t <session> @wezterm_workspace`.
mkdir -p "$sandbox/bin"
cat > "$sandbox/bin/tmux" <<'TMUX_EOF'
#!/usr/bin/env bash
case "${1:-}" in
  show-options)
    # We always tag sessions into the `work` workspace for the test;
    # the bump script consumes -v -t <session> @wezterm_workspace.
    printf '%s\n' work
    ;;
  *) exit 0 ;;
esac
TMUX_EOF
chmod +x "$sandbox/bin/tmux"

run_bump() {
  local session="$1" client_tty="$2"
  env \
    WINDOWS_RUNTIME_STATE_WSL="$sandbox/wezterm-runtime" \
    WINDOWS_LOCALAPPDATA_WSL="$sandbox" \
    WINDOWS_USERPROFILE_WSL="$sandbox" \
    XDG_STATE_HOME="$sandbox" \
    WEZTERM_NO_PATH_CACHE=1 \
    PATH="$sandbox/bin:$PATH" \
    bash "$bump" "$session" "$client_tty"
}

# First call: no enter state → no close-out path, just bump + record enter.
run_bump alpha /dev/pts/9
enter_file="$sandbox/wezterm-runtime/state/tab-stats-enter/pts_9.txt"
[[ -f "$enter_file" ]] && ok "first call writes enter-state file ($(basename "$enter_file"))" \
  || no "enter-state file not written"

# Sleep just past the dead zone so the eventual close-out pays > 0.
sleep 1.2

# Switching to a different session should close-out alpha with the
# actual dwell_ms. The dwell is ms-scale, so we assert > 1000 (past
# dead zone) to confirm the close-out fired with a real time delta.
run_bump beta /dev/pts/9
alpha_dwell=$(jq -r '.sessions.alpha.dwell_ms' "$state_dir/work.json")
alpha_ok=$(awk -v d="$alpha_dwell" 'BEGIN { print (d > 1000) ? 1 : 0 }')
if [[ "$alpha_ok" == "1" ]]; then
  ok "switch alpha→beta closes alpha with dwell_ms = $alpha_dwell"
else
  no "alpha close-out expected > 1000ms, got $alpha_dwell"
fi

# Beta should have raw_count=1, dwell_ms=0 (bump alone never pays).
beta_raw=$(jq -r '.sessions.beta.raw_count' "$state_dir/work.json")
beta_dwell=$(jq -r '.sessions.beta.dwell_ms' "$state_dir/work.json")
[[ "$beta_raw" == "1" ]] && ok "beta raw_count=1 after entry" || no "beta raw_count: $beta_raw"
[[ "$beta_dwell" == "0" ]] && ok "beta entry leaves it at dwell_ms=0 (bump-only)" \
  || no "beta dwell_ms expected 0, got $beta_dwell"

# Same-session duplicate hook fire within the throttle window: must
# NOT rewrite enter_ms (would clobber the dwell of an in-progress
# focus burst). Record current enter_ms, fire again, compare.
prev_enter_line=$(cat "$enter_file")
run_bump beta /dev/pts/9
now_enter_line=$(cat "$enter_file")
[[ "$prev_enter_line" == "$now_enter_line" ]] && ok "same-session re-fire preserves enter_ms" \
  || no "same-session re-fire rewrote enter_ms: was '$prev_enter_line' now '$now_enter_line'"

printf 'tab-stats dwell suite: %d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
