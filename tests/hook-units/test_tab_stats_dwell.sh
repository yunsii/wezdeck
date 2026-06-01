#!/usr/bin/env bash
# Dwell-weighted tab-stats: tab_stats_bump only pays raw_count++;
# tab_stats_close_out converts dwell into the weight delta. This file
# exercises the curve directly and the entry/leave wiring inside
# tab-stats-bump.sh, so future tweaks to the bump-vs-close split can't
# silently reintroduce the "Alt+x peek = full promote" regression.
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

# Curve sanity --------------------------------------------------------
printf '\xe2\x96\xb8 %s\n' 'dwell-to-weight curve'
sandbox="$(new_sandbox)"

w0=$(run_lib_case "$sandbox" 'tab_stats_dwell_to_weight 500')
[[ "$w0" == "0" ]] && ok "dead-zone (500ms) → 0" || no "dead-zone expected 0, got $w0"

w_sat=$(run_lib_case "$sandbox" 'tab_stats_dwell_to_weight 30000')
[[ "$w_sat" == "1" ]] && ok "saturation (30000ms) → 1" || no "saturation expected 1, got $w_sat"

w_over=$(run_lib_case "$sandbox" 'tab_stats_dwell_to_weight 60000')
[[ "$w_over" == "1" ]] && ok "over-saturation (60000ms) → 1" || no "over-sat expected 1, got $w_over"

w_lin=$(run_lib_case "$sandbox" 'tab_stats_dwell_to_weight 15500')
expected_lin=$(awk 'BEGIN { printf "%.6f", (15500 - 1000) / (30000 - 1000) }')
[[ "$w_lin" == "$expected_lin" ]] && ok "linear (15.5s) → $expected_lin" \
  || no "linear expected $expected_lin, got $w_lin"

w_edge=$(run_lib_case "$sandbox" 'tab_stats_dwell_to_weight 1000')
expected_edge=$(awk 'BEGIN { printf "%.6f", 0 }')
[[ "$w_edge" == "$expected_edge" ]] && ok "dead-zone boundary (exactly 1000ms) → 0.0" \
  || no "edge expected $expected_edge, got $w_edge"

# bump-then-close-out -------------------------------------------------
printf '\xe2\x96\xb8 %s\n' 'bump vs close-out responsibilities'
sandbox="$(new_sandbox)"
state_file="$sandbox/wezterm-runtime/state/tab-stats/work.json"

run_lib_case "$sandbox" "tab_stats_bump work foo-session" >/dev/null
raw=$(jq -r '.sessions["foo-session"].raw_count' "$state_file" 2>/dev/null || echo MISS)
weight=$(jq -r '.sessions["foo-session"].weight' "$state_file" 2>/dev/null || echo MISS)
[[ "$raw" == "1" ]] && ok "bump → raw_count=1" || no "raw_count expected 1, got $raw"
# Entry must NOT pay weight on its own. Pre-fix the bump alone normalized
# to 1.0; after the split it stays at 0 until close_out.
[[ "$weight" == "0" ]] && ok "bump → weight=0 (paid on leave)" \
  || no "weight expected 0 after bump, got $weight"

# Sub-second close-out: filtered, no weight.
run_lib_case "$sandbox" "tab_stats_close_out work foo-session 500" >/dev/null
weight=$(jq -r '.sessions["foo-session"].weight' "$state_file")
[[ "$weight" == "0" ]] && ok "close_out dwell=500ms (dead-zone) → still 0" \
  || no "dead-zone close-out leaked weight: $weight"

# Genuine work burst: full saturation pays weight 1.0.
run_lib_case "$sandbox" "tab_stats_close_out work foo-session 30000" >/dev/null
weight=$(jq -r '.sessions["foo-session"].weight' "$state_file")
[[ "$weight" == "1" ]] && ok "close_out dwell=30s → weight=1.0" \
  || no "saturation close-out expected 1, got $weight"

# bump should NOT change raw_count beyond +1 per fire; close_out should
# never change raw_count at all (asymmetry is the whole point).
run_lib_case "$sandbox" "tab_stats_close_out work foo-session 30000" >/dev/null
raw_after=$(jq -r '.sessions["foo-session"].raw_count' "$state_file")
[[ "$raw_after" == "1" ]] && ok "close_out leaves raw_count alone" \
  || no "raw_count drifted via close_out: $raw_after"

# Cold session promote threshold --------------------------------------
printf '\xe2\x96\xb8 %s\n' 'cold session vs hot competitor (top-N membership)'
sandbox="$(new_sandbox)"
state_file="$sandbox/wezterm-runtime/state/tab-stats/work.json"

# Hot competitor: bump + close-out 30s twice so it's well-anchored at 1.0.
run_lib_case "$sandbox" "tab_stats_bump work hot; tab_stats_close_out work hot 30000" >/dev/null
run_lib_case "$sandbox" "tab_stats_bump work hot; tab_stats_close_out work hot 30000" >/dev/null
hot_weight=$(jq -r '.sessions["hot"].weight' "$state_file")
[[ "$hot_weight" == "1" ]] && ok "hot session anchored at 1.0" \
  || no "hot session expected 1, got $hot_weight"

# Cold peek: enter cold session, leave within dead-zone.
run_lib_case "$sandbox" "tab_stats_bump work cold; tab_stats_close_out work cold 500" >/dev/null
cold_weight=$(jq -r '.sessions["cold"].weight' "$state_file")
[[ "$cold_weight" == "0" ]] && ok "cold peek (sub-second) does not promote: weight=0" \
  || no "cold peek leaked weight: $cold_weight"

# Real cold work burst: 30s.
run_lib_case "$sandbox" "tab_stats_bump work cold; tab_stats_close_out work cold 30000" >/dev/null
cold_weight=$(jq -r '.sessions["cold"].weight' "$state_file")
hot_weight=$(jq -r '.sessions["hot"].weight' "$state_file")
# After +1.0 on cold, max becomes 1.0 (cold) and hot decays slightly +
# divides by max → still close to 1.0. Both should be ≥ 0.99.
cold_ok=$(awk -v w="$cold_weight" 'BEGIN { print (w >= 0.99) ? 1 : 0 }')
hot_ok=$(awk -v w="$hot_weight" 'BEGIN { print (w >= 0.99) ? 1 : 0 }')
if [[ "$cold_ok" == "1" && "$hot_ok" == "1" ]]; then
  ok "cold 30s burst promotes to top tier alongside hot (cold=$cold_weight hot=$hot_weight)"
else
  no "cold 30s expected ≥0.99 hot expected ≥0.99 got cold=$cold_weight hot=$hot_weight"
fi

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
# actual dwell. We're not asserting a specific weight (depends on real
# clock skew), only that it's strictly > 0 to confirm the close-out
# path fired with a non-dead-zone dwell.
run_bump beta /dev/pts/9
alpha_weight=$(jq -r '.sessions.alpha.weight' "$state_dir/work.json")
alpha_ok=$(awk -v w="$alpha_weight" 'BEGIN { print (w > 0) ? 1 : 0 }')
if [[ "$alpha_ok" == "1" ]]; then
  ok "switch alpha→beta closes alpha with dwell-based weight (=$alpha_weight)"
else
  no "alpha close-out expected > 0, got $alpha_weight"
fi

# Beta should have raw_count=1, weight=0 (bump alone never pays).
beta_raw=$(jq -r '.sessions.beta.raw_count' "$state_dir/work.json")
beta_weight=$(jq -r '.sessions.beta.weight' "$state_dir/work.json")
[[ "$beta_raw" == "1" ]] && ok "beta raw_count=1 after entry" || no "beta raw_count: $beta_raw"
# After normalization beta may end up at 0 or near 0 depending on max.
# What we care about is that bump alone did NOT pay weight; the
# pre-normalize weight is 0. Post-normalize it is 0 / max(alpha) = 0.
[[ "$beta_weight" == "0" ]] && ok "beta entry leaves it at weight=0 (bump-only)" \
  || no "beta weight expected 0, got $beta_weight"

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
