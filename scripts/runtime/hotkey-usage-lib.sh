#!/usr/bin/env bash
# Shared resolver for the hotkey usage counter file.
#
# The counter is pure WSL bash (writer = scripts/runtime/hotkey-usage-bump.sh,
# reader = scripts/dev/hotkey-usage-report.sh) — no Windows-side consumer
# touches it. Per the cross-FS routing rule, files with both writer and
# reader in WSL belong on WSL ext4, not on /mnt/c, so the resolver prefers
# `${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/`.
#
# Legacy data on /mnt/c is migrated transparently on the next bump or read:
# `hotkey_usage_migrate_legacy` moves the old file (and its .lock sibling)
# over to the new home if the new home is empty. Callers should invoke it
# before reading/writing.

# Resolve the canonical (WSL-native) counter path. Stable across invocations
# in the same XDG_STATE_HOME — no detection cost.
hotkey_usage_path() {
  local state_root="${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime"
  printf '%s/hotkey-usage.json' "$state_root"
}

# Resolve the legacy (Windows-side) path if present. Used only by the
# one-time migration. Empty string when WSL is not running on Windows.
hotkey_usage_legacy_path() {
  local lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck disable=SC1091
  . "$lib_dir/windows-runtime-paths-lib.sh" 2>/dev/null || return 0
  if windows_runtime_detect_paths 2>/dev/null; then
    printf '%s/hotkey-usage.json' "$WINDOWS_RUNTIME_STATE_WSL"
  fi
}

# One-time migration: move /mnt/c counter to WSL native. Idempotent —
# returns immediately when there's nothing to do (no legacy file, or the
# new path already has data). Failure is non-fatal; callers continue
# against whichever path resolved.
hotkey_usage_migrate_legacy() {
  local new_path="$1" legacy_path
  [[ -n "$new_path" ]] || return 0
  legacy_path="$(hotkey_usage_legacy_path)" || true
  [[ -n "$legacy_path" && "$legacy_path" != "$new_path" ]] || return 0
  [[ -f "$legacy_path" && ! -f "$new_path" ]] || return 0

  mkdir -p "${new_path%/*}" 2>/dev/null || return 0
  mv -f "$legacy_path" "$new_path" 2>/dev/null || return 0
  [[ -f "${legacy_path}.lock" ]] && mv -f "${legacy_path}.lock" "${new_path}.lock" 2>/dev/null
  return 0
}
