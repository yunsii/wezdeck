#!/usr/bin/env bash
# Usage:
#   hotkey-usage-report.sh              pretty table sorted by count desc
#   hotkey-usage-report.sh --json       raw counter JSON
#   hotkey-usage-report.sh --path       resolved counter file path
#
# Reads the aggregate counter maintained by
# scripts/runtime/hotkey-usage-bump.sh and enriches each row with the
# label / registered keys from wezterm-x/commands/manifest.json. Ids not
# present in the manifest (e.g. attention jumps) render as "(unregistered)".

set -euo pipefail

lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$lib_dir/../.." && pwd)"
# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/hotkey-usage-lib.sh"

counter_path="$(hotkey_usage_path)"
hotkey_usage_migrate_legacy "$counter_path"
manifest_path="$repo_root/wezterm-x/commands/manifest.json"

case "${1:-}" in
  --path)
    printf '%s\n' "$counter_path"
    exit 0
    ;;
  --json)
    [[ -f "$counter_path" ]] || { printf 'no counter yet: %s\n' "$counter_path" >&2; exit 0; }
    cat "$counter_path"
    exit 0
    ;;
  '') ;;
  *)
    printf 'unknown flag: %s\n' "$1" >&2
    exit 2
    ;;
esac

if [[ ! -f "$counter_path" ]]; then
  printf 'no counter yet: %s\n' "$counter_path" >&2
  exit 0
fi

command -v jq >/dev/null 2>&1 || { echo 'jq required' >&2; exit 1; }

labels_json='{}'
if [[ -f "$manifest_path" ]]; then
  labels_json="$(jq '
    map({(.id): {
      label: .label,
      keys: ([.hotkeys[]?.keys] | join(" | "))
    }}) | add // {}
  ' "$manifest_path")"
fi

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

jq -r \
  --argjson labels "$labels_json" \
  --arg now "$now" \
  '
    def age(ts):
      if (ts // "") == "" then "?"
      else
        (($now | fromdateiso8601) - (ts | fromdateiso8601))
        | (./86400) | floor | tostring + "d"
      end;

    [ .hotkeys | to_entries[] | {
        count: (.value.count // 0),
        keys:  ($labels[.key].keys  // ""),
        id:    .key,
        label: ($labels[.key].label // "(unregistered)"),
        first: age(.value.first_seen),
        last:  age(.value.last_seen)
      } ]
    | sort_by(-.count)
    | ( ["count","keys","id","label","first","last"]
      , (.[] | [.count, .keys, .id, .label, .first, .last])
      )
    | @tsv
  ' "$counter_path" \
  | column -t -s $'\t'
