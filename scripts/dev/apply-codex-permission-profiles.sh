#!/usr/bin/env bash
# Apply tracked Codex permission overlays into CODEX_HOME as regular files.
#
# Repo templates own only the permission slice. Codex may write model / notice /
# tui (and similar) into the host profile file at runtime — those keys are
# preserved. Symlinks into the checkout are converted to regular files so the
# working tree is never dirtied by Codex writes.
#
# Usage:
#   apply-codex-permission-profiles.sh           # apply auto + full-access
#   apply-codex-permission-profiles.sh auto      # one profile
#   apply-codex-permission-profiles.sh --dry-run

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
default_repo_root="$(cd "$script_dir/../.." && pwd -P)"
repo_root="${WEZDECK_REPO:-$default_repo_root}"
repo_root="$(cd "$repo_root" 2>/dev/null && pwd -P)" || {
  printf 'codex-profiles: WEZDECK_REPO is not an existing checkout: %s\n' \
    "${WEZDECK_REPO:-$repo_root}" >&2
  exit 1
}
source_dir="$repo_root/agent-profiles/v1/host-setup"
target_dir="${CODEX_HOME:-$HOME/.codex}"

# Keys the repo template is allowed to set / refresh on the host file.
MANAGED_KEYS_REGEX='^(approval_policy|approvals_reviewer|sandbox_mode)$'

dry_run=0
profiles=()

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while (($#)); do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    auto|full-access) profiles+=("$1"); shift ;;
    *)
      printf 'codex-profiles: unknown arg: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ((${#profiles[@]} == 0)); then
  profiles=(auto full-access)
fi

mkdir -p "$target_dir"

is_managed_key() {
  [[ "$1" =~ $MANAGED_KEYS_REGEX ]]
}

# Print top-level key=value lines from a template (stop at first [section]).
template_managed_assignments() {
  local template="$1"
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "$line" =~ ^\[ ]] && break
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      # Capture before is_managed_key: its =~ would clobber BASH_REMATCH.
      if is_managed_key "$key"; then
        printf '%s\t%s\n' "$key" "$val"
      fi
    fi
  done < "$template"
}

# Upsert managed assignments into $target; preserve all other lines/sections.
upsert_managed_keys() {
  local target="$1"
  local template="$2"
  local tmp assignments_file key val
  local -A want=()
  local -A seen=()

  assignments_file="$(mktemp)"
  template_managed_assignments "$template" > "$assignments_file"
  if [[ ! -s "$assignments_file" ]]; then
    rm -f "$assignments_file"
    printf 'codex-profiles: template has no managed keys: %s\n' "$template" >&2
    return 1
  fi

  while IFS=$'\t' read -r key val; do
    want["$key"]="$val"
  done < "$assignments_file"
  rm -f "$assignments_file"

  tmp="$(mktemp)"
  if [[ -f "$target" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*= ]]; then
        key="${BASH_REMATCH[1]}"
        if is_managed_key "$key" && [[ -n "${want[$key]+x}" ]]; then
          printf '%s = %s\n' "$key" "${want[$key]}"
          seen["$key"]=1
          continue
        fi
      fi
      printf '%s\n' "$line"
    done < "$target" > "$tmp"
  else
    : > "$tmp"
  fi

  # Append any managed keys still missing (e.g. brand-new host file after
  # symlink conversion that somehow lacked them, or older host copies).
  for key in "${!want[@]}"; do
    if [[ -z "${seen[$key]+x}" ]]; then
      printf '%s = %s\n' "$key" "${want[$key]}" >> "$tmp"
    fi
  done

  if ((dry_run)); then
    printf 'dry-run: would write %s\n' "$target"
    rm -f "$tmp"
    return 0
  fi
  chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$target"
}

apply_one() {
  local profile="$1"
  local source_file="$source_dir/$profile.config.toml"
  local target_file="$target_dir/$profile.config.toml"
  local snap

  [[ -f "$source_file" ]] || {
    printf 'codex-profiles: missing profile source: %s\n' "$source_file" >&2
    return 1
  }

  if [[ -L "$target_file" ]]; then
    # Snapshot through the link first so Codex runtime keys survive, then
    # replace the symlink with a regular file before upserting managed keys.
    snap="$(mktemp)"
    cp -L "$target_file" "$snap"
    if ((dry_run)); then
      printf 'dry-run: would replace symlink %s with regular file\n' "$target_file"
      rm -f "$snap"
    else
      rm -f "$target_file"
      mv "$snap" "$target_file"
      chmod 600 "$target_file" 2>/dev/null || true
      printf 'codex-profiles: converted symlink to regular file: %s\n' "$target_file"
    fi
  elif [[ ! -e "$target_file" ]]; then
    if ((dry_run)); then
      printf 'dry-run: would create %s from template\n' "$target_file"
    else
      cp "$source_file" "$target_file"
      chmod 600 "$target_file" 2>/dev/null || true
      printf 'codex-profiles: created %s\n' "$target_file"
    fi
  elif [[ -f "$target_file" ]]; then
    :
  else
    printf 'codex-profiles: refusing non-regular target: %s\n' "$target_file" >&2
    return 1
  fi

  upsert_managed_keys "$target_file" "$source_file"
  printf 'codex-profiles: applied %s -> %s\n' "$profile" "$target_file"
}

for profile in "${profiles[@]}"; do
  apply_one "$profile"
done
