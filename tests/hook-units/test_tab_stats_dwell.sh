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
# A v1 file with only `weight` keys must still rank when read; the
# next write rewrites it in v2 shape.
printf '\xe2\x96\xb8 %s\n' 'v1 → v2 migration (legacy weight fallback)'
sandbox="$(new_sandbox)"
state_file="$sandbox/wezterm-runtime/state/tab-stats/work.json"
# Use a recent last_bump_ms so the decay applied during the first v2
# write is negligible — that way we can observe the legacy weight
# being added into dwell_ms instead of being decayed away to ~0.
now_ms=$(date +%s%3N)
cat > "$state_file" <<JSON
{
  "version": 1,
  "half_life_days": 7,
  "sessions": {
    "old_top":    { "weight": 1.0, "raw_count": 10, "last_bump_ms": $now_ms },
    "old_bottom": { "weight": 0.1, "raw_count": 1,  "last_bump_ms": $now_ms }
  }
}
JSON

# tab_stats_top_n must read weight as fallback so the rank is preserved
# before any v2 write.
top=$(run_lib_case "$sandbox" "tab_stats_top_n work 1")
[[ "$top" == "old_top" ]] && ok "v1 read: legacy weight ranks old_top first" \
  || no "v1 read: expected old_top, got $top"

# Next write rewrites the file in v2 shape — version bumps, dwell_ms
# field appears, total_dwell_ms appears on the touched session.
run_lib_case "$sandbox" "tab_stats_close_out work old_top 30000" >/dev/null
version=$(jq -r '.version' "$state_file")
top_dwell=$(jq -r '.sessions.old_top.dwell_ms' "$state_file")
top_total=$(jq -r '.sessions.old_top.total_dwell_ms' "$state_file")
[[ "$version" == "2" ]] && ok "write bumps version → 2" \
  || no "version expected 2, got $version"
top_dwell_ok=$(awk -v d="$top_dwell" 'BEGIN { print (d >= 30000.9 && d <= 30001.1) ? 1 : 0 }')
[[ "$top_dwell_ok" == "1" ]] && ok "old_top dwell_ms = 30000 + legacy weight 1.0 (got $top_dwell)" \
  || no "old_top dwell_ms expected ≈30001, got $top_dwell"
[[ "$top_total" == "30000" ]] && ok "old_top total_dwell_ms = 30000 (lifetime starts fresh)" \
  || no "old_top total_dwell_ms expected 30000, got $top_total"

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
