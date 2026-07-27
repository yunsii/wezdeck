#!/usr/bin/env bash
# Regression tests for scripts/runtime/wsl-oom-guard.sh badge classification.
#
# The badge exists because of a specific failure the guard could already see
# and nobody could: on 2026-07-26 the distro sat above the 85% high-water mark
# for four hours and then livelocked, with memory reading a survivable 88% the
# whole time while swap drained to zero. So the properties pinned here are the
# ones that make the badge worth having at all:
#
#   * silent while healthy — an always-on number is one you learn to ignore
#   * warn / crit on the memory axis
#   * warn / crit on the *swap* axis while memory still looks calm, which is
#     the exact shape of the incident that motivated this
#   * a swapless guest reads 0% swap as "no signal", not as "0% is fine"
#   * the published JSON stays parseable even when the largest process has a
#     space in its comm (Next.js reports `next-server (v1…`, which silently
#     corrupted top_rss_mib in the first cut)
#
# Runs against fixture meminfo files and a fake `ps`, so it needs no root, no
# memory pressure, and leaves the user's published status file untouched.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
guard="$repo_root/scripts/runtime/wsl-oom-guard.sh"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

status_file="$tmpdir/status.json"

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

# All values in kB, as the kernel writes them. MemTotal is held at ~1 GiB so
# the percentages in each fixture are obvious by inspection.
write_meminfo() {
  local path="$1" mem_avail="$2" swap_total="$3" swap_free="$4"
  cat >"$path" <<EOF
MemTotal:        1000000 kB
MemFree:          $mem_avail kB
MemAvailable:     $mem_avail kB
SwapTotal:       $swap_total kB
SwapFree:        $swap_free kB
EOF
}

# Returns the level the guard published for a given fixture.
level_for() {
  local mem_avail="$1" swap_total="$2" swap_free="$3"
  local meminfo="$tmpdir/meminfo"
  write_meminfo "$meminfo" "$mem_avail" "$swap_total" "$swap_free"
  rm -f "$status_file"
  WEZTERM_OOM_MEMINFO="$meminfo" \
  WEZTERM_OOM_STATUS_FILE="$status_file" \
    "$guard" sample >/dev/null 2>&1
  grep -o '"level"[[:space:]]*:[[:space:]]*"[a-z]*"' "$status_file" 2>/dev/null \
    | head -1 | grep -o '[a-z]*"$' | tr -d '"'
}

expect_level() {
  local want="$1" mem_avail="$2" swap_total="$3" swap_free="$4"
  local got
  got="$(level_for "$mem_avail" "$swap_total" "$swap_free")"
  [[ "$got" == "$want" ]] && return 0
  printf '    expected level=%s got=%s (mem_avail=%s swap %s/%s)\n' \
    "$want" "${got:-<none>}" "$mem_avail" "$swap_free" "$swap_total" >&2
  return 1
}

printf '\xE2\x96\xB8 wsl-oom-guard badge classification\n'

# 20% memory used, swap untouched.
it 'ok while both axes are low' expect_level ok 800000 1000000 1000000

# 87% / 95% used, swap untouched — the memory axis alone.
it 'warn once memory crosses the high-water mark' expect_level warn 130000 1000000 1000000
it 'crit once memory crosses the crit threshold' expect_level crit 50000 1000000 1000000

# 60% memory used — comfortably below warn — with swap at 80% / 95%. This is
# the 2026-07-26 shape: a memory-only badge stays dark right through it.
it 'warn on swap alone while memory looks calm' expect_level warn 400000 1000000 200000
it 'crit on swap alone while memory looks calm' expect_level crit 400000 1000000 50000

# A guest with swap off reports 0/0. Treating that as 0% used is correct;
# treating a missing denominator as pressure would light the bar forever.
it 'ok on a swapless guest with calm memory' expect_level ok 800000 0 0
it 'still warns on a swapless guest when memory is high' expect_level warn 130000 0 0

# --- top_comm JSON safety ------------------------------------------------
# The first cut emitted "comm rss" and split it with `read -r comm rss`, so a
# comm containing a space put half the name into the number field and produced
# invalid JSON — exactly what Next.js's `next-server (v1…` does in practice.
fake_bin="$tmpdir/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/ps" <<'EOF'
#!/usr/bin/env bash
# Only the top-consumer query is faked; anything else falls through so the
# shim cannot silently change unrelated behavior.
case "$*" in
  *"rss,comm"*) printf '%s\n' " 2068480 next-server (v1" ;;
  *) exec /usr/bin/ps "$@" ;;
esac
EOF
chmod +x "$fake_bin/ps"

json_survives_spaced_comm() {
  local meminfo="$tmpdir/meminfo"
  write_meminfo "$meminfo" 50000 1000000 1000000
  rm -f "$status_file"
  PATH="$fake_bin:$PATH" \
  WEZTERM_OOM_MEMINFO="$meminfo" \
  WEZTERM_OOM_STATUS_FILE="$status_file" \
    "$guard" sample >/dev/null 2>&1

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$status_file" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d['top_comm'] == 'next-server (v1', d['top_comm']
assert d['top_rss_mib'] == 2020, d['top_rss_mib']
PY
    return $?
  fi
  # No python3: fall back to pinning the two fields textually.
  grep -q '"top_comm": "next-server (v1"' "$status_file" \
    && grep -q '"top_rss_mib": 2020' "$status_file"
}

it 'keeps the JSON valid when the largest comm contains a space' json_survives_spaced_comm

top_omitted_while_ok() {
  local meminfo="$tmpdir/meminfo"
  write_meminfo "$meminfo" 800000 1000000 1000000
  rm -f "$status_file"
  WEZTERM_OOM_MEMINFO="$meminfo" \
  WEZTERM_OOM_STATUS_FILE="$status_file" \
    "$guard" sample >/dev/null 2>&1
  grep -q '"top_comm": null' "$status_file"
}

# Skipping the `ps` sweep in the common case is deliberate, not incidental:
# the recorder republishes on a 30 s heartbeat and nobody reads top_comm while
# the level is ok.
it 'omits the top consumer while healthy' top_omitted_while_ok

printf 'wsl-oom-guard: %d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
