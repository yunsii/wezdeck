#!/usr/bin/env bash
# Provisions the static `picker` binary used by the tmux popup pickers
# (Alt+/, Alt+g, Ctrl+Shift+P) at native/picker/bin/picker. Two paths
# to that binary:
#
#   1. Local Go build (preferred when Go is available — maintainers and
#      contributors iterating on picker source).
#   2. Prebuilt release tarball pinned in release-manifest.json (for
#      end users without a Go toolchain). Fetched once into
#      ${WEZDECK_PICKER_CACHE:-$XDG_CACHE_HOME/wezdeck/picker}/<version>
#      and SHA-256 verified before extraction.
#
# Skips silently when neither path is usable; the popup pickers fall
# back to bash implementations (tmux-attention-picker.sh, etc.).
#
# Source preference: WEZTERM_PICKER_INSTALL_SOURCE=auto|local|release
# (default auto). `auto` tries local first, then release.
#
# Build flags for the local path: CGO_ENABLED=0 + GOOS=linux for a
# fully static ELF (no libc / glibc dependency). `-ldflags='-s -w'`
# strips debug info (~2MB vs ~6MB).

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out_path="$script_dir/bin/picker"
manifest_path="$script_dir/release-manifest.json"

source_pref="${WEZTERM_PICKER_INSTALL_SOURCE:-auto}"

# Resolve `go` from PATH first, then fall back to common manual-install
# locations. sync-runtime.sh runs in a non-interactive shell that may
# not have inherited the user's PATH additions for ~/.local/go/bin etc.
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

build_local() {
  local go_bin
  go_bin="$(resolve_go)" || return 1
  mkdir -p "$script_dir/bin"

  # Skip-if-current: when the existing binary is at least as new as every
  # Go source input, there's nothing to build. `go build` itself is also
  # incremental, but spawning the toolchain still costs ~150ms in steady
  # state — meaningful when sync-runtime is rerun frequently.
  if [[ -x "$out_path" ]]; then
    local newer_src
    newer_src="$(
      cd "$script_dir"
      find . -maxdepth 4 \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' \) \
        -not -path './bin/*' -newer "$out_path" -print -quit 2>/dev/null
    )"
    if [[ -z "$newer_src" ]]; then
      printf 'build-picker: up-to-date %s (%s) — skipping go build\n' \
        "$out_path" \
        "$(stat -c '%s bytes' "$out_path" 2>/dev/null || echo 'unknown size')"
      return 0
    fi
  fi

  (
    cd "$script_dir"
    CGO_ENABLED=0 GOOS=linux "$go_bin" build -trimpath -ldflags='-s -w' -o "$out_path" .
  )
  printf 'build-picker: wrote %s (%s) via local go build using %s\n' \
    "$out_path" \
    "$(stat -c '%s bytes' "$out_path" 2>/dev/null || echo 'unknown size')" \
    "$go_bin"
}

sha_match() {
  local file="$1" expected="$2" actual
  actual="$(sha256sum "$file" | awk '{print $1}')"
  [[ "${actual,,}" == "${expected,,}" ]]
}

# Map host kernel/arch to a release-manifest asset key (e.g. linux-amd64).
host_asset_key() {
  local kernel arch
  kernel="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) return 1 ;;
  esac
  printf '%s-%s\n' "$kernel" "$arch"
}

install_release() {
  command -v jq >/dev/null 2>&1 || {
    printf 'build-picker: release path requires jq\n' >&2
    return 1
  }
  [[ -f "$manifest_path" ]] || {
    printf 'build-picker: release manifest missing at %s\n' "$manifest_path" >&2
    return 1
  }

  local enabled version key asset_name url sha
  enabled="$(jq -r '.enabled // false' "$manifest_path")"
  [[ "$enabled" == "true" ]] || {
    printf 'build-picker: release manifest disabled\n' >&2
    return 1
  }
  version="$(jq -r '.version // ""' "$manifest_path")"
  [[ -n "$version" ]] || {
    printf 'build-picker: release manifest has no version\n' >&2
    return 1
  }
  key="$(host_asset_key)" || {
    printf 'build-picker: unsupported host arch %s for release path\n' "$(uname -m)" >&2
    return 1
  }
  asset_name="$(jq -r --arg k "$key" '.assets[$k].assetName // empty' "$manifest_path")"
  url="$(jq -r --arg k "$key" '.assets[$k].downloadUrl // empty' "$manifest_path")"
  sha="$(jq -r --arg k "$key" '.assets[$k].sha256 // empty' "$manifest_path")"
  [[ -n "$asset_name" && -n "$url" && -n "$sha" ]] || {
    printf 'build-picker: release manifest has no asset for %s\n' "$key" >&2
    return 1
  }

  local cache_root cache_dir cache_file
  cache_root="${WEZDECK_PICKER_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/wezdeck/picker}"
  cache_dir="$cache_root/$version"
  cache_file="$cache_dir/$asset_name"
  mkdir -p "$cache_dir"

  if [[ ! -f "$cache_file" ]] || ! sha_match "$cache_file" "$sha"; then
    local fetch_tmp="$cache_file.tmp.$$"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL -o "$fetch_tmp" "$url" || {
        rm -f "$fetch_tmp"
        printf 'build-picker: download failed from %s\n' "$url" >&2
        return 1
      }
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "$fetch_tmp" "$url" || {
        rm -f "$fetch_tmp"
        printf 'build-picker: download failed from %s\n' "$url" >&2
        return 1
      }
    else
      printf 'build-picker: neither curl nor wget available for release fetch\n' >&2
      return 1
    fi
    sha_match "$fetch_tmp" "$sha" || {
      rm -f "$fetch_tmp"
      printf 'build-picker: sha256 mismatch on %s\n' "$asset_name" >&2
      return 1
    }
    mv -f "$fetch_tmp" "$cache_file"
  fi

  mkdir -p "$script_dir/bin"
  tar -xzf "$cache_file" -C "$script_dir/bin" picker
  chmod +x "$out_path"
  printf 'build-picker: wrote %s (%s) via release %s (%s)\n' \
    "$out_path" \
    "$(stat -c '%s bytes' "$out_path" 2>/dev/null || echo 'unknown size')" \
    "$version" \
    "$key"
}

case "$source_pref" in
  local)
    build_local || {
      printf 'build-picker: skipped (source=local but go not found in PATH or ~/.local/go/bin or /usr/local/go/bin); picker will use bash fallback\n'
      exit 0
    }
    ;;
  release)
    install_release || {
      printf 'build-picker: skipped (source=release but install failed); picker will use bash fallback\n'
      exit 0
    }
    ;;
  auto)
    if build_local 2>/dev/null; then
      :
    elif install_release; then
      :
    else
      printf 'build-picker: skipped (no go toolchain and release manifest unavailable for this host); picker will use bash fallback\n'
      exit 0
    fi
    ;;
  *)
    printf 'build-picker: invalid WEZTERM_PICKER_INSTALL_SOURCE=%s (expected auto|local|release)\n' "$source_pref" >&2
    exit 1
    ;;
esac
