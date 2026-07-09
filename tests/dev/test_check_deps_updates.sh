#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"

cat >"$tmp/bin/wezterm.exe" <<'EOF'
#!/usr/bin/env bash
printf 'wezterm 20260331-040028-577474d8\n'
EOF

cat >"$tmp/bin/tmux" <<'EOF'
#!/usr/bin/env bash
printf 'tmux 3.7b\n'
EOF

cat >"$tmp/bin/go" <<'EOF'
#!/usr/bin/env bash
printf 'go version go1.26.5 linux/amd64\n'
EOF

cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

url="${@: -1}"
case "$url" in
  https://api.github.com/repos/wezterm/wezterm/releases/tags/nightly)
    cat <<'JSON'
{
  "tag_name": "nightly",
  "target_commitish": "c53ca64c33d1658602b9a3aaa412eca9c6544294",
  "assets": [
    {
      "name": "WezTerm-windows-nightly.zip",
      "digest": "sha256:316527b7627d096bd0066c56a85f812077add01c150de20e69608c21ca535adc",
      "updated_at": "2026-07-08T04:51:25Z",
      "browser_download_url": "https://github.com/wezterm/wezterm/releases/download/nightly/WezTerm-windows-nightly.zip"
    }
  ]
}
JSON
    ;;
  https://api.github.com/repos/tmux/tmux/releases/latest)
    printf '{"tag_name":"3.7b"}\n'
    ;;
  https://go.dev/VERSION?m=text)
    printf 'go1.26.5\n'
    ;;
  https://raw.githubusercontent.com/wezterm/wezterm/main/docs/changelog.md)
    cat <<'MD'
### Continuous/Nightly

#### Fixed
* Windows IME fix.

### 20240203
MD
    ;;
  *)
    printf 'unexpected curl url: %s\n' "$url" >&2
    exit 2
    ;;
esac
EOF

chmod +x "$tmp/bin/"*

set +e
output="$(PATH="$tmp/bin:/usr/bin:/bin" bash "$repo_root/scripts/dev/check-deps-updates.sh" --no-color --timeout 1 2>&1)"
status=$?
set -e

printf '%s\n' "$output"

[[ "$status" -eq 1 ]] || {
  printf 'expected exit 1 for newer wezterm asset, got %s\n' "$status" >&2
  exit 1
}
grep -Fq 'nightly zip 20260708-045125' <<<"$output"
grep -Fq 'nightly asset newer' <<<"$output"
grep -Fq 'nightly tag target_commitish: c53ca64c33d1 (diagnostic only)' <<<"$output"
if grep -Fq 'behind nightly head' <<<"$output"; then
  printf 'stale target_commitish must not drive update status\n' >&2
  exit 1
fi
