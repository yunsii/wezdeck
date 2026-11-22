#!/usr/bin/env bash
# Provisions the static `wezdeck-wsl` binary used by the Windows Runtime's
# WSL bridge (`wsl.exe … wezdeck-wsl attach`) at
# native/wezdeck-wsl/bin/wezdeck-wsl.
#
# Local Go build only (no release tarball yet). CGO_ENABLED=0 + GOOS=linux
# for a fully static ELF. Skip-if-current when the source fingerprint
# (scripts/dev/source-fingerprint.sh) equals the one stamped in bin/.version.
#
# A missing binary makes GET /api/v1/wsl time out and degrades every
# Linux-owned snapshot (workspaces / wakatime / worktree status) on the
# Web Console. Sync treats a failed build as a hard error when Go is
# available; when Go is missing and no binary exists, exit non-zero.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out_path="$script_dir/bin/wezdeck-wsl"

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
  if [[ -x "$out_path" ]]; then
    printf 'build-wezdeck-wsl: go missing; keeping existing %s\n' "$out_path"
    exit 0
  fi
  printf 'build-wezdeck-wsl: go toolchain missing and %s absent\n' "$out_path" >&2
  exit 1
}

mkdir -p "$script_dir/bin"

# version (version.go): the source fingerprint — last commit touching this
# tree, plus a hash of uncommitted edits — so any edit rebuilds and the cdp
# tests / release can compare it with what the relay reports
version="$("$script_dir/../../scripts/dev/source-fingerprint.sh" native/wezdeck-wsl 2>/dev/null || echo dev)"
stamp_path="$script_dir/bin/.version"

if [[ -x "$out_path" && "$version" != dev && "$(cat "$stamp_path" 2>/dev/null)" == "$version" ]]; then
  printf 'build-wezdeck-wsl: up-to-date %s (version %s) — skipping go build\n' "$out_path" "$version"
  exit 0
fi

(
  cd "$script_dir"
  CGO_ENABLED=0 GOOS=linux "$go_bin" build -trimpath \
    -ldflags="-s -w -X main.buildVersion=$version" -o "$out_path" .
)
printf '%s\n' "$version" >"$stamp_path"
printf 'build-wezdeck-wsl: wrote %s (%s) via local go build using %s\n' \
  "$out_path" \
  "$(stat -c '%s bytes' "$out_path" 2>/dev/null || echo 'unknown size')" \
  "$go_bin"
