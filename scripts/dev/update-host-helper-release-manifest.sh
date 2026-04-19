#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_MANIFEST_PATH="$REPO_ROOT/native/host-helper/windows/release-manifest.json"

usage() {
  cat <<'EOF'
Usage:
  scripts/dev/update-host-helper-release-manifest.sh --tag TAG --sha256 HEX [options]

Options:
  --tag TAG              Release tag, for example host-helper-v2026.04.19.1
  --sha256 HEX           SHA-256 for the published release zip
  --repo OWNER/REPO      GitHub repository slug used to derive the download URL
  --asset-name NAME      Asset filename. Defaults to wezterm-windows-host-helper-<tag>-win-x64.zip
  --url URL              Full download URL. Overrides --repo derived URL
  --output PATH          Output path. Defaults to native/host-helper/windows/release-manifest.json
  -h, --help             Show this help text

Notes:
  - If --repo is omitted, the script tries to infer OWNER/REPO from git remote.origin.url.
  - The script writes schemaVersion=1 and enabled=true.
EOF
}

resolve_repo_slug() {
  local remote_url=""
  remote_url="$(git -C "$REPO_ROOT" config --get remote.origin.url 2>/dev/null || true)"
  [[ -n "$remote_url" ]] || return 1

  if [[ "$remote_url" =~ ^https://github\.com/([^/]+/[^/]+?)(\.git)?$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi

  if [[ "$remote_url" =~ ^git@github\.com:([^/]+/[^/]+?)(\.git)?$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi

  return 1
}

tag=""
sha256=""
repo_slug=""
asset_name=""
download_url=""
output_path="$DEFAULT_MANIFEST_PATH"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      tag="${2:-}"
      shift 2
      ;;
    --sha256)
      sha256="${2:-}"
      shift 2
      ;;
    --repo)
      repo_slug="${2:-}"
      shift 2
      ;;
    --asset-name)
      asset_name="${2:-}"
      shift 2
      ;;
    --url)
      download_url="${2:-}"
      shift 2
      ;;
    --output)
      output_path="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
done

[[ -n "$tag" ]] || { printf 'missing --tag\n' >&2; exit 1; }
[[ "$sha256" =~ ^[0-9A-Fa-f]{64}$ ]] || { printf 'invalid --sha256, expected 64 hex chars\n' >&2; exit 1; }

if [[ -z "$asset_name" ]]; then
  asset_name="wezterm-windows-host-helper-${tag}-win-x64.zip"
fi

if [[ -z "$download_url" ]]; then
  if [[ -z "$repo_slug" ]]; then
    repo_slug="$(resolve_repo_slug || true)"
  fi
  [[ -n "$repo_slug" ]] || {
    printf 'missing --repo and could not infer GitHub repo from remote.origin.url\n' >&2
    exit 1
  }
  download_url="https://github.com/${repo_slug}/releases/download/${tag}/${asset_name}"
fi

mkdir -p "$(dirname "$output_path")"
temp_path="${output_path}.tmp.$$"

cat > "$temp_path" <<EOF
{
  "schemaVersion": 1,
  "enabled": true,
  "version": "$tag",
  "assetName": "$asset_name",
  "downloadUrl": "$download_url",
  "sha256": "${sha256,,}"
}
EOF

mv -f "$temp_path" "$output_path"

printf 'updated manifest: %s\n' "$output_path"
printf 'version=%s\n' "$tag"
printf 'asset_name=%s\n' "$asset_name"
printf 'download_url=%s\n' "$download_url"
