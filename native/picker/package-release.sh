#!/usr/bin/env bash
# package-release.sh — build release tarballs for the Go picker.
#
# Used by .github/workflows/picker-release.yml and by local dry-runs via
# scripts/dev/prepare-native-releases.sh. Mirrors the host-helper
# package-release.ps1 shape: one script owns packaging; CI only publishes.
#
# Usage:
#   native/picker/package-release.sh --tag picker-vYYYY.MM.DD.N [--out-dir DIR] [--targets KEY,...]
#
# Outputs (printed as KEY=VALUE lines for CI GITHUB_OUTPUT consumption):
#   asset_paths=...           space-separated archive paths
#   linux-amd64_asset_name=...
#   linux-amd64_sha256=...
#   linux-amd64_archive_path=...
#   (same fields per target key)
#
# Default targets: linux-amd64. Pass --targets linux-amd64,linux-arm64 to
# cross-compile additional arches (Go cross-compile; no CGO).

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tag=""
out_dir=""
targets="linux-amd64"

usage() {
  cat <<'EOF'
Usage:
  native/picker/package-release.sh --tag TAG [options]

Options:
  --tag TAG              Release tag (e.g. picker-v2026.07.16.1)
  --out-dir DIR          Output directory (default: $TMPDIR/picker-release-<tag>)
  --targets KEY,...      Comma-separated os-arch keys (default: linux-amd64).
                         Supported: linux-amd64, linux-arm64
  -h, --help             Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) tag="${2:-}"; shift 2 ;;
    --out-dir) out_dir="${2:-}"; shift 2 ;;
    --targets) targets="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$tag" ]] || { usage >&2; exit 1; }
[[ -d "$script_dir" ]] || exit 1

if [[ -z "$out_dir" ]]; then
  out_dir="${TMPDIR:-/tmp}/picker-release-$tag"
fi
mkdir -p "$out_dir"

resolve_go() {
  if command -v go >/dev/null 2>&1; then
    command -v go
    return 0
  fi
  for candidate in "$HOME/.local/go/bin/go" /usr/local/go/bin/go; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

go_bin="$(resolve_go)" || {
  printf 'package-release: go not found in PATH / ~/.local/go/bin / /usr/local/go/bin\n' >&2
  exit 1
}

# KEY → GOOS GOARCH
target_to_go() {
  case "$1" in
    linux-amd64) printf 'linux amd64\n' ;;
    linux-arm64) printf 'linux arm64\n' ;;
    *) return 1 ;;
  esac
}

IFS=',' read -ra target_list <<< "$targets"
asset_paths=()
declare -A out_fields=()

for key in "${target_list[@]}"; do
  key="$(printf '%s' "$key" | tr -d '[:space:]')"
  [[ -n "$key" ]] || continue
  go_pair="$(target_to_go "$key")" || {
    printf 'package-release: unsupported target %s\n' "$key" >&2
    exit 1
  }
  read -r goos goarch <<< "$go_pair"

  bin_dir="$out_dir/$key"
  mkdir -p "$bin_dir"
  (
    cd "$script_dir"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
      "$go_bin" build -trimpath -ldflags='-s -w' \
      -o "$bin_dir/picker" .
  )

  asset="wezdeck-picker-$tag-$key.tar.gz"
  archive="$out_dir/$asset"
  tar -C "$bin_dir" -czf "$archive" picker
  sha="$(sha256sum "$archive" | awk '{print $1}')"
  size="$(stat -c '%s' "$archive" 2>/dev/null || wc -c < "$archive")"

  printf 'package-release: %s (%s bytes) sha256=%s\n' "$archive" "$size" "$sha" >&2

  asset_paths+=("$archive")
  # Flatten key for GITHUB_OUTPUT (hyphen ok in values; keep key as-is)
  out_fields["${key}_asset_name"]="$asset"
  out_fields["${key}_sha256"]="$sha"
  out_fields["${key}_archive_path"]="$archive"
done

# Stable KEY=VALUE lines for CI / callers
printf 'asset_paths=%s\n' "${asset_paths[*]}"
for k in "${!out_fields[@]}"; do
  printf '%s=%s\n' "$k" "${out_fields[$k]}"
done

# Underscore aliases for GitHub Actions job outputs (hyphen keys are awkward
# in needs.build.outputs.*).
if [[ -n "${out_fields[linux-amd64_asset_name]:-}" ]]; then
  printf 'linux_amd64_asset_name=%s\n' "${out_fields[linux-amd64_asset_name]}"
  printf 'linux_amd64_sha256=%s\n' "${out_fields[linux-amd64_sha256]}"
  printf 'linux_amd64_archive_path=%s\n' "${out_fields[linux-amd64_archive_path]}"
fi
if [[ -n "${out_fields[linux-arm64_asset_name]:-}" ]]; then
  printf 'linux_arm64_asset_name=%s\n' "${out_fields[linux-arm64_asset_name]}"
  printf 'linux_arm64_sha256=%s\n' "${out_fields[linux-arm64_sha256]}"
  printf 'linux_arm64_archive_path=%s\n' "${out_fields[linux-arm64_archive_path]}"
fi
