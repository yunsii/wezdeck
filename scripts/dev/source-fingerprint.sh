#!/usr/bin/env bash
# Version of a source tree, for "is the build under test / running the one
# from these sources?": the last commit touching DIR; with uncommitted edits
# there (tracked or new files) "<commit>-dirty-<hash of those edits>", so
# every edit changes it. Used as the relay version (native/wezdeck-wsl
# build.sh), the web build id (remote-test-stack.sh, wezdeck-release.sh), and
# checked by the cdp tests before they run (web/tests/version.setup.ts).
#
#   scripts/dev/source-fingerprint.sh native/wezdeck-wsl
#   scripts/dev/source-fingerprint.sh web            # tests excluded (below)
set -euo pipefail
dir="${1:?usage: source-fingerprint.sh DIR}"
# what the build is made of: web tests change no build, so they must not
# force a stack restart
specs=("$dir")
[[ "$dir" == web ]] && specs+=(':(exclude)web/tests' ':(exclude)web/vitest.*')
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
commit="$(git log -1 --format=%h -- "${specs[@]}")"
[[ -n "$commit" ]] || commit=dev
changed="$(
  {
    git diff HEAD -- "${specs[@]}"
    git ls-files -o --exclude-standard -z -- "${specs[@]}" | xargs -0 -r sha1sum
  } | sha1sum | cut -c1-8
)"
# the hash of nothing: no edits
if [[ "$changed" == "$(printf '' | sha1sum | cut -c1-8)" ]]; then
  printf '%s\n' "$commit"
else
  printf '%s-dirty-%s\n' "$commit" "$changed"
fi
