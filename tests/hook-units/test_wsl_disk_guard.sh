#!/usr/bin/env bash
# Regression tests for scripts/runtime/wsl-disk-guard.sh alert gating.
#
# The alert rules are the whole reason this guard is not just `df` in a cron
# job, and they are easy to get subtly wrong in ways you only notice months
# later — either by popping on every sample until you learn to dismiss the
# popup unread, or by going quiet after the first warning and never
# escalating. So they get pinned here:
#
#   * fires when the level escalates
#   * silent when the level is unchanged (except crit past its cooldown)
#   * silent when the level improves
#   * never fires below warn
#
# Also pins that classification keys on *headroom* (host avail + the reusable
# gap inside the vhdx), not on host avail alone. A dedicated WSL volume can sit
# at a tiny host avail indefinitely while the distro reuses gap in place; an
# avail-keyed threshold would scream through that entirely normal state.
#
# Runs against a sparse fake vhdx in a tmpdir, so it needs no Windows, no real
# D:, and leaves the user's published status file untouched.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
guard="$repo_root/scripts/runtime/wsl-disk-guard.sh"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

status_file="$tmpdir/status.json"
alert_log="$tmpdir/alerts.log"
fake_vhdx="$tmpdir/ext4.vhdx"
fake_reminder="$tmpdir/fake-reminder.sh"

# Sparse: 200 GiB of apparent size, ~0 bytes on disk.
truncate -s 200G "$fake_vhdx"

cat >"$fake_reminder" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$2" >>"$FAKE_REMINDER_LOG"
EOF
chmod +x "$fake_reminder"

pass=0
fail=0
it() {
  local name="$1"
  shift
  if "$@"; then
    pass=$((pass + 1))
    printf '  \xE2\x9C\x93 %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  \xE2\x9C\x97 %s\n' "$name"
  fi
}

# Run one sample with the given threshold overrides.
sample() {
  env \
    WEZTERM_DISK_STATUS_FILE="$status_file" \
    WEZTERM_DISK_VHDX="$fake_vhdx" \
    WEZTERM_DISK_REMINDER_BIN="$fake_reminder" \
    FAKE_REMINDER_LOG="$alert_log" \
    "$@" \
    "$guard" sample
}

level_is() {
  local want="$1"
  local got
  got="$(grep -o '"level"[[:space:]]*:[[:space:]]*"[a-z]*"' "$status_file" | head -1 | grep -o '[a-z]*"$' | tr -d '"')"
  [[ "$got" == "$want" ]] || {
    printf '    level expected=%s actual=%s\n' "$want" "$got" >&2
    return 1
  }
}

alert_count() {
  [[ -f "$alert_log" ]] || { printf '0\n'; return 0; }
  wc -l <"$alert_log" | tr -d ' '
}

alerts_are() {
  local want="$1" got
  got="$(alert_count)"
  [[ "$got" == "$want" ]] || {
    printf '    alert count expected=%s actual=%s\n' "$want" "$got" >&2
    return 1
  }
}

printf '\xE2\x96\xB8 wsl-disk-guard alert gating\n'

# Thresholds are percentages of budget (volume size minus reserve), so a case
# forces a level by moving the percentage rather than the disk. 200 is above
# any achievable percentage; 0 is below every one.
high=200
low=0

sample WEZTERM_DISK_WARN_PCT="$low" WEZTERM_DISK_CRIT_PCT="$low" >/dev/null 2>&1
it 'level=ok' level_is ok
it 'ok does not alert' alerts_are 0

# The regression this pins: the fake vhdx contributes a ~100G gap, so a guard
# keyed on host avail alone would classify differently from one keyed on
# headroom — and the host reserve must come back off the top, or WSL would be
# told it may consume the volume down to zero.
it 'headroom = avail + gap - reserve' bash -c \
  "jq -e '.headroom_bytes == (.host_avail_bytes + .gap_bytes - .reserve_bytes)' '$status_file' >/dev/null"
it 'gap is present but does not change the level' level_is ok

sample WEZTERM_DISK_WARN_PCT="$low" WEZTERM_DISK_CRIT_PCT="$low" WEZTERM_DISK_RESERVE_GB=0 >/dev/null 2>&1
it 'reserve=0 makes headroom exactly avail + gap' bash -c \
  "jq -e '.headroom_bytes == (.host_avail_bytes + .gap_bytes)' '$status_file' >/dev/null"

# A reserve larger than everything available must clamp at zero rather than
# publish a negative budget the badge would then try to format.
sample WEZTERM_DISK_WARN_PCT="$low" WEZTERM_DISK_CRIT_PCT="$low" \
  WEZTERM_DISK_RESERVE_GB=100000 WEZTERM_DISK_ALERT=0 >/dev/null 2>&1
it 'oversized reserve clamps headroom to zero' bash -c \
  "jq -e '.headroom_bytes == 0' '$status_file' >/dev/null"

# Back to a normal reserve, and reset the level to ok so the alert-gating
# sequence below starts from a known state.
sample WEZTERM_DISK_WARN_PCT="$low" WEZTERM_DISK_CRIT_PCT="$low" >/dev/null 2>&1
it 'level back to ok before alert sequence' level_is ok
it 'no alerts fired during the reserve cases' alerts_are 0

sample WEZTERM_DISK_WARN_PCT="$high" WEZTERM_DISK_CRIT_PCT="$low" >/dev/null 2>&1
it 'low headroom yields warn' level_is warn
it 'escalation to warn alerts once' alerts_are 1

sample WEZTERM_DISK_WARN_PCT="$high" WEZTERM_DISK_CRIT_PCT="$low" >/dev/null 2>&1
it 'repeated warn stays silent' alerts_are 1

sample WEZTERM_DISK_WARN_PCT="$high" WEZTERM_DISK_CRIT_PCT="$high" >/dev/null 2>&1
it 'escalation warn -> crit alerts' alerts_are 2

sample WEZTERM_DISK_WARN_PCT="$high" WEZTERM_DISK_CRIT_PCT="$high" >/dev/null 2>&1
it 'repeated crit inside cooldown stays silent' alerts_are 2

sample WEZTERM_DISK_WARN_PCT="$high" WEZTERM_DISK_CRIT_PCT="$high" \
  WEZTERM_DISK_ALERT_COOLDOWN=0 >/dev/null 2>&1
it 'repeated crit past cooldown re-alerts' alerts_are 3

sample WEZTERM_DISK_WARN_PCT="$low" WEZTERM_DISK_CRIT_PCT="$low" >/dev/null 2>&1
it 'recovery to ok is silent' alerts_are 3
it 'recovered level is ok' level_is ok

sample WEZTERM_DISK_WARN_PCT="$high" WEZTERM_DISK_CRIT_PCT="$high" \
  WEZTERM_DISK_ALERT=0 >/dev/null 2>&1
it 'WEZTERM_DISK_ALERT=0 suppresses even an escalation' alerts_are 3

# --- configured volume ---------------------------------------------------
# WEZTERM_DISK_VOLUME overrides the vhdx-derived mount. The subtle part is
# that the gap then has to stop counting: space inside a vhdx that lives on
# some *other* disk contributes nothing to the watched disk's budget, and
# folding it in would inflate the headroom of a volume it is not even on.
vhdx_mount="$(df --output=target "$fake_vhdx" | tail -1)"
other_mount=""
for candidate in /mnt/c /mnt/d /; do
  [[ -d "$candidate" ]] || continue
  [[ "$(df --output=target "$candidate" 2>/dev/null | tail -1)" == "$vhdx_mount" ]] && continue
  other_mount="$candidate"
  break
done

sample WEZTERM_DISK_WARN_PCT="$low" WEZTERM_DISK_CRIT_PCT="$low" \
  WEZTERM_DISK_VOLUME="$vhdx_mount" >/dev/null 2>&1
it 'configured volume is honored' bash -c \
  "jq -e --arg m '$vhdx_mount' '.host_mount == \$m' '$status_file' >/dev/null"
it 'gap still counts when the vhdx is on the watched volume' bash -c \
  "jq -e '.headroom_bytes == (.host_avail_bytes + .gap_bytes - .reserve_bytes)' '$status_file' >/dev/null"

if [[ -n "$other_mount" ]]; then
  sample WEZTERM_DISK_WARN_PCT="$low" WEZTERM_DISK_CRIT_PCT="$low" \
    WEZTERM_DISK_VOLUME="$other_mount" >/dev/null 2>&1
  it 'watching a different volume drops the gap from headroom' bash -c \
    "jq -e '.headroom_bytes == (.host_avail_bytes - .reserve_bytes)' '$status_file' >/dev/null"
  it 'the gap is still reported for diagnosis' bash -c \
    "jq -e '.gap_bytes > 0' '$status_file' >/dev/null"
else
  printf '  (no second volume available; skipped cross-volume gap cases)\n'
fi

# The badge is a JSON consumer; a malformed publish would silently freeze it
# on its last-known value rather than fail loudly.
if command -v jq >/dev/null 2>&1; then
  it 'published status is valid JSON' bash -c "jq -e . '$status_file' >/dev/null"
  it 'gap is derived, not echoed' bash -c \
    "jq -e '.gap_bytes == (.vhdx_bytes - .guest_used_bytes)' '$status_file' >/dev/null"
else
  printf '  (jq missing; skipped JSON assertions)\n'
fi

printf 'wsl-disk-guard: %d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
