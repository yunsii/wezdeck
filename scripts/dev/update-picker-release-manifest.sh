#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_MANIFEST_PATH="$REPO_ROOT/native/picker/release-manifest.json"

usage() {
  cat <<'EOF'
Usage:
  scripts/dev/update-picker-release-manifest.sh --tag TAG --asset KEY=SHA [options]

Options:
  --tag TAG                Release tag, for example picker-v2026.04.27.1
  --asset KEY=SHA          Per-target asset SHA-256. KEY is os-arch (e.g. linux-amd64).
                           Repeatable. The asset name is derived as
                           wezdeck-picker-<tag>-<key>.tar.gz unless --asset-name overrides it.
  --asset-name KEY=NAME    Override the derived asset name for KEY. Repeatable.
  --repo OWNER/REPO        GitHub repo slug used to derive the download URL.
                           Inferred from git remote.origin.url when omitted.
  --output PATH            Output path. Defaults to native/picker/release-manifest.json.
  -h, --help               Show this help text.

Notes:
  - Writes schemaVersion=1 and enabled=true.
  - Assets schema is a map keyed by os-arch so additional architectures
    (linux-arm64, darwin-arm64, ...) slot in by adding more --asset flags.
  - Requires `jq` for JSON assembly.
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
repo_slug=""
output_path="$DEFAULT_MANIFEST_PATH"
declare -A asset_shas=()
declare -A asset_names=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      tag="${2:-}"
      shift 2
      ;;
    --asset)
      pair="${2:-}"
      [[ "$pair" == *=* ]] || { printf 'invalid --asset, expected KEY=SHA, got %q\n' "$pair" >&2; exit 1; }
      asset_shas["${pair%%=*}"]="${pair#*=}"
      shift 2
      ;;
    --asset-name)
      pair="${2:-}"
      [[ "$pair" == *=* ]] || { printf 'invalid --asset-name, expected KEY=NAME, got %q\n' "$pair" >&2; exit 1; }
      asset_names["${pair%%=*}"]="${pair#*=}"
      shift 2
      ;;
    --repo)
      repo_slug="${2:-}"
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
[[ ${#asset_shas[@]} -gt 0 ]] || { printf 'at least one --asset KEY=SHA is required\n' >&2; exit 1; }

command -v jq >/dev/null 2>&1 || { printf 'jq is required but not on PATH\n' >&2; exit 1; }

if [[ -z "$repo_slug" ]]; then
  repo_slug="$(resolve_repo_slug || true)"
  [[ -n "$repo_slug" ]] || {
    printf 'missing --repo and could not infer GitHub repo from remote.origin.url\n' >&2
    exit 1
  }
fi

for key in "${!asset_shas[@]}"; do
  sha="${asset_shas[$key]}"
  [[ "$sha" =~ ^[0-9A-Fa-f]{64}$ ]] || {
    printf 'invalid sha for %s: expected 64 hex chars, got %q\n' "$key" "$sha" >&2
    exit 1
  }
done

assets_json='{}'
for key in "${!asset_shas[@]}"; do
  sha_lc="${asset_shas[$key],,}"
  name="${asset_names[$key]:-wezdeck-picker-${tag}-${key}.tar.gz}"
  url="https://github.com/${repo_slug}/releases/download/${tag}/${name}"
  assets_json="$(printf '%s' "$assets_json" | jq \
    --arg key "$key" \
    --arg name "$name" \
    --arg url "$url" \
    --arg sha "$sha_lc" \
    '. + {($key): {assetName: $name, downloadUrl: $url, sha256: $sha}}')"
done

mkdir -p "$(dirname "$output_path")"
temp_path="${output_path}.tmp.$$"

printf '%s' "$assets_json" | jq \
  --arg tag "$tag" \
  '{schemaVersion: 1, enabled: true, version: $tag, assets: .}' \
  > "$temp_path"

mv -f "$temp_path" "$output_path"

printf 'updated manifest: %s\n' "$output_path"
printf 'version=%s\n' "$tag"
for key in "${!asset_shas[@]}"; do
  sha_lc="${asset_shas[$key],,}"
  name="${asset_names[$key]:-wezdeck-picker-${tag}-${key}.tar.gz}"
  printf '%s.asset_name=%s\n' "$key" "$name"
  printf '%s.sha256=%s\n' "$key" "$sha_lc"
done
