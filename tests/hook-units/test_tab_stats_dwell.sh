#!/usr/bin/env bash
# Legacy dwell diagnostics in tab-stats v4: tab_stats_bump pays raw_count++ only;
# tab_stats_close_out adds capped dwell credit into dwell_ms and the
# full wall-clock dwell into total_dwell_ms. This file exercises:
#   - the bump-vs-close split (no weight ever paid on entry)
#   - the dead-zone filter (sub-second dwell stays at 0)
#   - legacy dwell remains diagnostic-only for ranking helpers
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

# A 2h burst adds full lifetime dwell but only capped ranking credit.
run_lib_case "$sandbox" "tab_stats_close_out work foo-session 7200000" >/dev/null
dwell=$(jq -r '.sessions["foo-session"].dwell_ms' "$state_file")
total=$(jq -r '.sessions["foo-session"].total_dwell_ms' "$state_file")
[[ "$total" == "7230000" ]] && ok "2h burst → total_dwell_ms = 7,230,000 (240x a 30s burst)" \
  || no "total_dwell_ms expected 7230000, got $total"
dwell_ok=$(awk -v d="$dwell" 'BEGIN { print (d >= 1829999 && d <= 1830001) ? 1 : 0 }')
[[ "$dwell_ok" == "1" ]] && ok "2h burst → dwell_ms capped at prior 30s + 30m credit (got $dwell)" \
  || no "dwell_ms expected ≈1830000 after capped 2h burst, got $dwell"

# bump should NOT change raw_count beyond +1 per fire; close_out should
# never change raw_count at all (asymmetry is the whole point).
run_lib_case "$sandbox" "tab_stats_close_out work foo-session 30000" >/dev/null
raw_after=$(jq -r '.sessions["foo-session"].raw_count' "$state_file")
[[ "$raw_after" == "1" ]] && ok "close_out leaves raw_count alone" \
  || no "raw_count drifted via close_out: $raw_after"

# Legacy dwell does not rank ------------------------------------------
printf '\xe2\x96\xb8 %s\n' 'legacy dwell stays diagnostic-only for ranking helpers'
sandbox="$(new_sandbox)"
state_file="$sandbox/wezterm-runtime/state/tab-stats/work.json"

# heavy: 2h cumulative lifetime dwell, 30m ranking credit.
run_lib_case "$sandbox" \
  "tab_stats_bump work heavy; tab_stats_close_out work heavy 7200000" >/dev/null

# Three different competitors, each a single 30s visit.
for s in light_a light_b light_c; do
  run_lib_case "$sandbox" \
    "tab_stats_bump work $s; tab_stats_close_out work $s 30000" >/dev/null
done

heavy_dwell=$(jq -r '.sessions.heavy.dwell_ms' "$state_file")
ranked=$(run_lib_case "$sandbox" "tab_stats_top_n work 5")
[[ -z "$ranked" ]] && ok "view-only dwell rows do not appear in tab_stats_top_n" \
  || no "expected no ranked rows, got $ranked"
ratio_ok=$(awk -v h="$heavy_dwell" 'BEGIN { print (h >= 1799000 && h <= 1801000) ? 1 : 0 }')
[[ "$ratio_ok" == "1" ]] && ok "heavy dwell_ms still recorded for diagnostics (got $heavy_dwell)" \
  || no "heavy dwell_ms unexpectedly low: $heavy_dwell"

# v1 → v4 migration --------------------------------------------------
# v1 weight values are corrupted by renormalize+fragmentation (a heavily
# refreshed project ends up with 7 small rows whose weights don't sum
# back to true cumulative usage). Migration ignores weight and seeds
# dwell_ms from raw_count * 30000 (30s per past focus event), matching
# the v1 saturation point. This recovers the right magnitude for
# heavily-used projects that v1 demoted via fragmentation.
printf '\xe2\x96\xb8 %s\n' 'v1 → v4 migration (raw_count seeding ignores corrupted weight)'
sandbox="$(new_sandbox)"
state_file="$sandbox/wezterm-runtime/state/tab-stats/work.json"
# Use a recent last_bump_ms so decay during the first v4 write is
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

top=$(run_lib_case "$sandbox" "tab_stats_top_n work 1")
[[ -z "$top" ]] && ok "v1 pre-migration read: view-only weight rows do not rank" \
  || no "v1 read: expected no ranked rows, got $top"

# A close-out on an unrelated session triggers the migration write.
# After that, both sessions are seeded from raw_count and the rank
# flips: heavy_use (20 events * 30s = 600K ms) beats light_use
# (2 events * 30s = 60K ms).
run_lib_case "$sandbox" "tab_stats_close_out work heavy_use 30000" >/dev/null
version=$(jq -r '.version' "$state_file")
[[ "$version" == "4" ]] && ok "write bumps version → 4" \
  || no "version expected 4, got $version"

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

top_after=$(run_lib_case "$sandbox" "tab_stats_top_n work 1")
[[ -z "$top_after" ]] && ok "post-migration: migrated view-only rows still do not rank" \
  || no "post-migration: expected no ranked rows, got $top_after"

# v2 → v4 migration --------------------------------------------------
printf '\xe2\x96\xb8 %s\n' 'v2 → v4 migration clamps legacy uncapped dwell'
sandbox="$(new_sandbox)"
state_file="$sandbox/wezterm-runtime/state/tab-stats/work.json"
now_ms=$(date +%s%3N)
cat > "$state_file" <<JSON
{
  "version": 2,
  "half_life_days": 7,
  "sessions": {
    "frequent":  { "dwell_ms": 1734813895, "total_dwell_ms": 4202636013, "raw_count": 45, "last_bump_ms": $now_ms },
    "overnight": { "dwell_ms": 5013459119, "total_dwell_ms": 5013668127, "raw_count": 5,  "last_bump_ms": $now_ms }
  }
}
JSON

top=$(run_lib_case "$sandbox" "tab_stats_top_n work 1")
[[ -z "$top" ]] && ok "v2 read: view-only dwell rows do not rank" \
  || no "v2 read expected no ranked rows, got $top"
agg_top=$(run_lib_case "$sandbox" "tab_stats_aggregated_tsv work | head -n 1 | cut -f1")
[[ -z "$agg_top" ]] && ok "v2 aggregated TSV omits view-only rows" \
  || no "v2 aggregated TSV expected no rows, got $agg_top"

run_lib_case "$sandbox" "tab_stats_bump work frequent" >/dev/null
version=$(jq -r '.version' "$state_file")
frequent_dwell=$(jq -r '.sessions.frequent.dwell_ms' "$state_file")
overnight_dwell=$(jq -r '.sessions.overnight.dwell_ms' "$state_file")
frequent_total=$(jq -r '.sessions.frequent.total_dwell_ms' "$state_file")
overnight_total=$(jq -r '.sessions.overnight.total_dwell_ms' "$state_file")

[[ "$version" == "4" ]] && ok "v2 migration write bumps version → 4" \
  || no "v2 migration version expected 4, got $version"
freq_ok=$(awk -v d="$frequent_dwell" 'BEGIN { print (d >= 80999000 && d <= 81001000) ? 1 : 0 }')
over_ok=$(awk -v d="$overnight_dwell" 'BEGIN { print (d >= 8999000 && d <= 9001000) ? 1 : 0 }')
[[ "$freq_ok" == "1" ]] && ok "frequent v2 dwell clamps to raw_count * 30m" \
  || no "frequent dwell expected ≈81000000, got $frequent_dwell"
[[ "$over_ok" == "1" ]] && ok "overnight v2 dwell clamps to raw_count * 30m" \
  || no "overnight dwell expected ≈9000000, got $overnight_dwell"
[[ "$frequent_total" == "4202636013" ]] && ok "frequent total_dwell_ms preserved" \
  || no "frequent total_dwell_ms changed: $frequent_total"
[[ "$overnight_total" == "5013668127" ]] && ok "overnight total_dwell_ms preserved" \
  || no "overnight total_dwell_ms changed: $overnight_total"

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
