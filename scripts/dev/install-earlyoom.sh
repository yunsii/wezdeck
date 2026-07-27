#!/usr/bin/env bash
# Install earlyoom as the last-resort airbag for this WSL distro.
#
# Why a userspace killer when the kernel already has one: on 2026-07-26 memory
# and swap were both exhausted and the kernel OOM killer **never fired**. The
# allocations that were failing were order-4 GFP_NOFS (every /mnt/c 9p RPC
# needs a 64 KiB contiguous kmalloc), and the kernel declines to OOM-kill for
# allocations above PAGE_ALLOC_COSTLY_ORDER. Order-0 allocations were still
# technically satisfiable via direct reclaim, so all 20 cores span in
# reclaim/compaction with zero forward progress — CPU pinned, distro
# unresponsive, nothing killed, and the only way out was `taskkill /f /im
# wslservice.exe` from Windows. earlyoom watches MemAvailable + SwapFree
# directly and kills before the kernel paints itself into that corner.
#
# Why not systemd-oomd: its unit of destruction is a *cgroup*, and on this host
# 109 processes — tmux, every agent, every dev server — live in the single
# /init.scope cgroup (that is why the OOM guard watches exactly that cgroup).
# oomd would either not manage init.scope at all or take out the whole thing,
# reproducing the 32 s poweroff/restart loop of 2026-07-25. earlyoom kills one
# process. See docs/diagnostics.md "Guest OOM hardening".
#
# This composes with wezterm-oom-guard rather than replacing it. earlyoom picks
# its victim by /proc/<pid>/oom_score, which folds in oom_score_adj — so the
# guard's -1000 on WSL init and -800 on tmux servers already steer earlyoom
# away from them, and the guard's renormalize sweep is what keeps the fat
# processes eligible. --avoid below is a second layer for the units that live
# outside init.scope and therefore outside the guard's reach.
#
# Config goes in a systemd drop-in, not /etc/default/earlyoom: that file is a
# dpkg conffile and editing it makes every package upgrade prompt. The drop-in
# overrides **ExecStart**, not EARLYOOM_ARGS — the packaged unit's
# `EnvironmentFile=-/etc/default/earlyoom` wins over a drop-in `Environment=`,
# so an args-by-variable drop-in is applied silently and has no effect. Verify
# with the daemon's own startup banner (`--check` prints it), never with
# `systemctl show`, which reports the unit file rather than the live process.
#
# Usage:
#   sudo ./scripts/dev/install-earlyoom.sh            # install + configure + start
#   ./scripts/dev/install-earlyoom.sh --check         # no root, no writes
#   ./scripts/dev/install-earlyoom.sh --print         # dump the generated drop-in
#   sudo ./scripts/dev/install-earlyoom.sh --uninstall # remove the drop-in only
#
# Docs: docs/diagnostics.md "Guest OOM hardening"
set -euo pipefail

DROPIN_DIR="${SYSTEMD_DROPIN_DIR:-/etc/systemd/system/earlyoom.service.d}"
DROPIN_FILE="$DROPIN_DIR/wezdeck.conf"

# SIGTERM once available memory is under 15% **and** free swap under 12%;
# SIGKILL at 10% / 6%. Both conditions must hold — the AND is what keeps this
# from deploying during normal driving.
#
# **Swap is the gate on this host, not memory.** This box legitimately runs at
# 85-88% memory (12-15% available) for hours at a time, so a memory threshold
# tight enough to be meaningful would fire constantly. Free swap is the axis
# that actually distinguishes "busy" from "about to die": it sits near 100%
# free in normal work and only collapses on the way into the livelock.
#
# Sized against two measured incidents on this host (44 GiB + 11 GiB swap):
#
#   2026-07-27 14:48  mem avail 14.0%, swap free 10.5%  -> fires (SIGTERM)
#                     the distro died at 14:52. The previous 8%/10% setting
#                     cleared *neither* threshold here and stayed silent.
#   2026-07-26 11:25  mem avail 11.6%, swap free  6.6%  -> fires (SIGTERM)
#                     that state ran on for four more hours before dying, so
#                     this is an early kill — of the leaked 11 Gi next-server,
#                     which is the correct victim.
#   2026-07-26 09:48  mem avail 11.9%, swap free 20.0%  -> silent (swap ok)
#
# Expect it to kill a leaked dev server rather than never fire; that is the
# intended trade. Raise WEZTERM_EARLYOOM_SWAP if it proves too eager.
MEM_PERCENT="${WEZTERM_EARLYOOM_MEM:-15,10}"
SWAP_PERCENT="${WEZTERM_EARLYOOM_SWAP:-12,6}"
# Deliberately space-free and unquoted: systemd splits $EARLYOOM_ARGS on
# whitespace without shell quote processing, so a regex containing a space (or
# wrapped in quotes, as the packaged /etc/default/earlyoom example shows) would
# arrive as two broken arguments. `^tmux` still matches comm `tmux: server`.
AVOID_RE="${WEZTERM_EARLYOOM_AVOID:-^(init|systemd|sshd|tmux|wezterm|Xwayland|dbus)}"
# Hourly memory report into the journal, so there is a record of the run-up and
# not only of the kill.
REPORT_INTERVAL="${WEZTERM_EARLYOOM_REPORT:-3600}"

MODE=install

# Print the whole header block (line 2 through the line before `set -`) so the
# help text cannot drift out of sync when the header grows.
usage() {
  sed -n '2,/^set -/p' "$0" | sed '$d; s/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE=check ;;
    --print) MODE=print ;;
    --uninstall) MODE=uninstall ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

dropin_text() {
  cat <<EOF
# Generated by scripts/dev/install-earlyoom.sh — edit there, not here.
[Service]
# Override ExecStart outright rather than setting EARLYOOM_ARGS. The packaged
# unit's \`EnvironmentFile=-/etc/default/earlyoom\` **overrides** a drop-in
# \`Environment=\`, so the first cut of this file was silently ignored: the
# daemon came up on the conffile's \`-r 3600\` and the package defaults
# (-m 10 -s 10), which is exactly the config that failed to fire on
# 2026-07-27. The empty ExecStart= resets the list before the real one.
ExecStart=
ExecStart=/usr/bin/earlyoom -r $REPORT_INTERVAL -m $MEM_PERCENT -s $SWAP_PERCENT --avoid $AVOID_RE
# The killer has to outlive the pressure it is killing for. Equivalent to
# earlyoom's own -p, which cannot work through the packaged unit.
OOMScoreAdjust=-100
Nice=-20
EOF
}

# Confirms the daemon would actually come up on these thresholds. earlyoom
# prints its parsed thresholds on startup, and --dryrun needs no privilege, so
# a typo in the argument string is caught at install time instead of being
# discovered during the next incident.
verify_args() {
  command -v earlyoom >/dev/null 2>&1 || return 0
  timeout 5 earlyoom --dryrun -r 0 -m "$MEM_PERCENT" -s "$SWAP_PERCENT" \
    --avoid "$AVOID_RE" 2>&1 | grep -aE 'sending SIGTERM|SIGKILL when' || true
}

case "$MODE" in
  print)
    printf '===== %s =====\n' "$DROPIN_FILE"
    dropin_text
    exit 0
    ;;
  check)
    printf 'package       : %s\n' \
      "$(command -v earlyoom >/dev/null 2>&1 && earlyoom -v 2>&1 | head -1 || printf '<not installed>')"
    printf 'drop-in       : %s\n' \
      "$([[ -f "$DROPIN_FILE" ]] && printf '%s' "$DROPIN_FILE" || printf '<absent>')"
    if [[ -f "$DROPIN_FILE" ]]; then
      printf 'installed args: %s\n' \
        "$(grep -a '^ExecStart=/usr/bin/earlyoom' "$DROPIN_FILE" 2>/dev/null \
          | sed 's|^ExecStart=/usr/bin/earlyoom ||' || printf '<none>')"
    fi
    printf 'would install : -r %s -m %s -s %s --avoid %s\n' \
      "$REPORT_INTERVAL" "$MEM_PERCENT" "$SWAP_PERCENT" "$AVOID_RE"
    # The thresholds the *running* daemon parsed, not the ones we intended.
    # These differed silently for a full day on 2026-07-27, so read them from
    # the daemon's own startup banner rather than trusting the config.
    running_args="$(journalctl -u earlyoom --no-pager 2>/dev/null \
      | grep -aE 'sending SIGTERM when|SIGKILL when' | tail -2 || true)"
    if [[ -n "$running_args" ]]; then
      printf 'daemon parsed :\n'
      printf '%s\n' "$running_args" | sed 's/^/  /'
    fi
    if command -v systemctl >/dev/null 2>&1; then
      # is-active/is-enabled exit non-zero for anything but active/enabled, so
      # take their stdout and only substitute when they printed nothing. The
      # `|| true` is load-bearing under `set -e`: without it, running --check
      # before the unit exists aborts the report it was asked to produce.
      state="$(systemctl is-active earlyoom.service 2>/dev/null || true)"
      enabled="$(systemctl is-enabled earlyoom.service 2>/dev/null || true)"
      printf 'unit          : earlyoom active=%s enabled=%s\n' \
        "${state:-unknown}" "${enabled:-unknown}"
    fi
    printf '\nkills land in : journalctl -u earlyoom\n'
    exit 0
    ;;
esac

[[ "$(id -u)" == 0 ]] || {
  printf 'this mode needs root: sudo %s %s\n' "$0" "--$MODE" >&2
  exit 1
}

if [[ "$MODE" == uninstall ]]; then
  rm -f "$DROPIN_FILE"
  rmdir "$DROPIN_DIR" 2>/dev/null || true
  systemctl daemon-reload
  systemctl try-restart earlyoom.service 2>/dev/null || true
  printf 'removed %s (earlyoom itself left installed; apt remove earlyoom to drop it)\n' "$DROPIN_FILE"
  exit 0
fi

if ! command -v earlyoom >/dev/null 2>&1; then
  printf 'installing earlyoom...\n'
  DEBIAN_FRONTEND=noninteractive apt-get install -y earlyoom
fi

printf 'thresholds earlyoom will parse:\n'
verify_args | sed 's/^/  /'

mkdir -p "$DROPIN_DIR"
dropin_text >"$DROPIN_FILE"
chmod 0644 "$DROPIN_FILE"

systemctl daemon-reload
systemctl enable --now earlyoom.service
# enable --now is a no-op on an already-running unit, so restart explicitly or
# a re-run silently keeps the previous arguments.
systemctl restart earlyoom.service

printf '\n'
"$0" --check || true
