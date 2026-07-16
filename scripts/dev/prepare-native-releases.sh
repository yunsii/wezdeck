#!/usr/bin/env bash
# prepare-native-releases.sh — readiness + dry-run packaging for the two
# native release trains (Go picker + C# host-helper).
#
# Does NOT push tags or create GitHub releases. Prints the exact cut
# commands after verifying local state. Docs:
#   docs/picker-release.md
#   docs/host-helper-release.md
#
# Usage:
#   scripts/dev/prepare-native-releases.sh
#   scripts/dev/prepare-native-releases.sh --dry-run-package
#   scripts/dev/prepare-native-releases.sh --targets linux-amd64,linux-arm64

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

dry_run_package=0
picker_targets="linux-amd64"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run-package) dry_run_package=1; shift ;;
    --targets) picker_targets="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 1 ;;
  esac
done

today="$(date +%Y.%m.%d)"
suggest_picker_tag="picker-v${today}.1"
suggest_helper_tag="host-helper-v${today}.1"

# Bump .N if same-day tag already exists on remote/local.
bump_tag() {
  local base="$1" # picker-vYYYY.MM.DD or host-helper-vYYYY.MM.DD
  local n=1
  local remote_hit=""
  while true; do
    if git rev-parse -q --verify "refs/tags/${base}.${n}" >/dev/null 2>&1; then
      n=$((n + 1))
      continue
    fi
    # Bound remote probe so offline / slow networks don't hang prepare.
    remote_hit="$(timeout 5 git ls-remote --tags origin "refs/tags/${base}.${n}" 2>/dev/null || true)"
    if [[ -n "$remote_hit" ]]; then
      n=$((n + 1))
      continue
    fi
    break
  done
  printf '%s.%s\n' "$base" "$n"
}

suggest_picker_tag="$(bump_tag "picker-v${today}")"
suggest_helper_tag="$(bump_tag "host-helper-v${today}")"

section() { printf '\n==> %s\n' "$1"; }
ok() { printf '  [ok] %s\n' "$1"; }
warn() { printf '  [!!] %s\n' "$1"; }
info() { printf '  --  %s\n' "$1"; }

section "git readiness"
branch="$(git branch --show-current)"
info "branch=$branch"
if [[ "$branch" != "master" && "$branch" != "main" ]]; then
  warn "not on master/main — tag from default branch after merge"
fi
if [[ -n "$(git status --porcelain)" ]]; then
  warn "working tree dirty — commit or stash before tagging"
  git status --short | head -20
else
  ok "working tree clean"
fi
ahead="$(git rev-list --count "origin/${branch}..HEAD" 2>/dev/null || echo '?')"
behind="$(git rev-list --count "HEAD..origin/${branch}" 2>/dev/null || echo '?')"
info "ahead=$ahead behind=$behind (vs origin/$branch)"
if [[ "$ahead" != "0" && "$ahead" != "?" ]]; then
  warn "local commits not pushed — push before tag so CI builds the intended SHA"
fi
if [[ "$behind" != "0" && "$behind" != "?" ]]; then
  warn "branch behind origin — pull/rebase before release"
fi

section "current manifests (pinned product versions)"
if command -v jq >/dev/null 2>&1; then
  info "picker: $(jq -r '"\(.version) enabled=\(.enabled) assets=\(.assets|keys|join(","))"' native/picker/release-manifest.json)"
  info "host-helper: $(jq -r '"\(.version) enabled=\(.enabled)"' native/host-helper/windows/release-manifest.json)"
else
  info "jq missing — skip manifest summary"
fi

section "code since last release tags"
if git rev-parse -q --verify picker-v2026.04.26.1 >/dev/null 2>&1; then
  n="$(git rev-list --count picker-v2026.04.26.1..HEAD -- native/picker/ 2>/dev/null || echo 0)"
  info "native/picker commits since picker-v2026.04.26.1: $n"
  git log --oneline picker-v2026.04.26.1..HEAD -- native/picker/ 2>/dev/null | head -8 | sed 's/^/      /'
else
  info "local tag picker-v2026.04.26.1 not present (ok if shallow)"
fi
if git rev-parse -q --verify host-helper-v2026.06.02.1 >/dev/null 2>&1; then
  n="$(git rev-list --count host-helper-v2026.06.02.1..HEAD -- native/host-helper/ 2>/dev/null || echo 0)"
  info "native/host-helper commits since host-helper-v2026.06.02.1: $n"
  git log --oneline host-helper-v2026.06.02.1..HEAD -- native/host-helper/ 2>/dev/null | head -8 | sed 's/^/      /'
fi

section "tooling"
if command -v go >/dev/null 2>&1 || [[ -x "$HOME/.local/go/bin/go" ]]; then
  go_bin="$(command -v go 2>/dev/null || true)"
  [[ -n "$go_bin" ]] || go_bin="$HOME/.local/go/bin/go"
  ok "go: $($go_bin version 2>/dev/null | head -1)"
else
  warn "go missing — local picker dry-run and local install path need it"
fi
if command -v gh >/dev/null 2>&1; then
  ok "gh: $(gh --version 2>/dev/null | head -1)"
  if gh auth status >/dev/null 2>&1; then
    ok "gh authenticated"
  else
    warn "gh not authenticated — cannot watch runs / merge manifest PRs"
  fi
else
  warn "gh missing — install for release watch / PR merge"
fi
if command -v dotnet >/dev/null 2>&1; then
  ok "dotnet: $(dotnet --version 2>/dev/null || true) (WSL — host-helper package needs Windows)"
else
  info "dotnet not in WSL (expected) — host-helper packages on windows-latest CI"
fi

if (( dry_run_package )); then
  section "dry-run package: Go picker ($picker_targets)"
  out="$("$REPO_ROOT/native/picker/package-release.sh" \
    --tag "$suggest_picker_tag" \
    --targets "$picker_targets" 2>&1)" || {
    warn "picker package-release failed"
    printf '%s\n' "$out"
    exit 1
  }
  printf '%s\n' "$out" | sed 's/^/  /'
  ok "picker tarball(s) written under \$TMPDIR/picker-release-$suggest_picker_tag"
  section "dry-run package: C# host-helper"
  info "package-release.ps1 requires Windows + dotnet 8 — CI runs it on tag push"
  info "local force path after release: WEZTERM_WINDOWS_HELPER_INSTALL_SOURCE=release sync-runtime.sh"
fi

section "suggested tags (today $today)"
info "picker:      $suggest_picker_tag"
info "host-helper: $suggest_helper_tag"

section "cut commands (after push to origin/$branch)"
cat <<EOF

  # 0) Push any unpushed commits first
  git push origin $branch

  # 1) Go picker release
  git tag $suggest_picker_tag
  git push origin $suggest_picker_tag
  run_id=\$(gh run list --workflow=picker-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
  gh run watch "\$run_id" --exit-status
  pr_num=\$(gh pr list --head "ci/update-picker-manifest-$suggest_picker_tag" --json number --jq '.[0].number')
  gh pr view "\$pr_num" && gh pr merge "\$pr_num" --squash --delete-branch

  # 2) C# host-helper release
  git tag $suggest_helper_tag
  git push origin $suggest_helper_tag
  run_id=\$(gh run list --workflow=host-helper-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
  gh run watch "\$run_id" --exit-status
  pr_num=\$(gh pr list --head "ci/update-host-helper-manifest-$suggest_helper_tag" --json number --jq '.[0].number')
  gh pr view "\$pr_num" && gh pr merge "\$pr_num" --squash --delete-branch

  # 3) Pull manifests + sync runtime
  git pull --rebase origin $branch
  skills/wezterm-runtime-sync/scripts/sync-runtime.sh

  # Optional: force release-install paths
  WEZTERM_PICKER_INSTALL_SOURCE=release skills/wezterm-runtime-sync/scripts/sync-runtime.sh
  WEZTERM_WINDOWS_HELPER_INSTALL_SOURCE=release skills/wezterm-runtime-sync/scripts/sync-runtime.sh

Full narrative: docs/picker-release.md · docs/host-helper-release.md
EOF
