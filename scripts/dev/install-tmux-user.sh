#!/usr/bin/env bash
# User-prefix tmux build — only when PATH tmux is below WezDeck floor (3.7).
# Prefer system/package-manager tmux when it already meets the floor.
#
# Usage:
#   ./scripts/dev/install-tmux-user.sh --check
#   ./scripts/dev/install-tmux-user.sh              # install if needed (tag 3.7b)
#   ./scripts/dev/install-tmux-user.sh 3.7a
#   ./scripts/dev/install-tmux-user.sh --force      # build even if floor already met
#   TMUX_PREFIX=$HOME/.local ./scripts/dev/install-tmux-user.sh
#
# Policy: docs/tmux-install.md
set -euo pipefail

FLOOR_MAJOR=3
FLOOR_MINOR=7
DEFAULT_TAG=3.7b
PREFIX="${TMUX_PREFIX:-$HOME/.local}"
REPO_URL="${TMUX_REPO_URL:-https://github.com/tmux/tmux.git}"

CHECK_ONLY=0
FORCE=0
TAG="$DEFAULT_TAG"

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

tmux_version_string() {
  local bin="${1:-tmux}"
  if ! command -v "$bin" >/dev/null 2>&1 && [[ "$bin" == "tmux" ]]; then
    return 1
  fi
  if [[ "$bin" == "tmux" ]]; then
    tmux -V 2>/dev/null | awk '{print $2}' | sed 's/[^0-9.]//g'
  else
    "$bin" -V 2>/dev/null | awk '{print $2}' | sed 's/[^0-9.]//g'
  fi
}

tmux_version_at_least() {
  local version="$1"
  local major minor
  IFS='.' read -r major minor _ <<<"${version:-0}"
  major="${major:-0}"
  minor="${minor:-0}"
  (( major > FLOOR_MAJOR )) && return 0
  (( major == FLOOR_MAJOR && minor >= FLOOR_MINOR )) && return 0
  return 1
}

path_tmux_meets_floor() {
  local v
  v="$(tmux_version_string tmux 2>/dev/null || true)"
  [[ -n "$v" ]] && tmux_version_at_least "$v"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --check)
      CHECK_ONLY=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --prefix)
      PREFIX="${2:-}"
      shift 2
      ;;
    --tag)
      TAG="${2:-}"
      shift 2
      ;;
    -*)
      echo "install-tmux-user: unknown flag: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      TAG="$1"
      shift
      ;;
  esac
done

if path_tmux_meets_floor; then
  cur="$(command -v tmux)"
  ver="$(tmux_version_string tmux)"
  echo "install-tmux-user: PATH tmux already meets floor ≥${FLOOR_MAJOR}.${FLOOR_MINOR}"
  echo "install-tmux-user:   $cur ($ver)"
  if [[ "$CHECK_ONLY" == "1" ]]; then
    exit 0
  fi
  if [[ "$FORCE" != "1" ]]; then
    echo "install-tmux-user: skip user-prefix build (use --force to override)"
    echo "install-tmux-user: policy: system/package tmux is enough — see docs/tmux-install.md"
    exit 0
  fi
  echo "install-tmux-user: --force set; continuing user-prefix build"
elif [[ "$CHECK_ONLY" == "1" ]]; then
  if command -v tmux >/dev/null 2>&1; then
    echo "install-tmux-user: PATH tmux below floor: $(command -v tmux) ($(tmux_version_string tmux || echo '?'))"
  else
    echo "install-tmux-user: no tmux on PATH"
  fi
  echo "install-tmux-user: need package upgrade or user-prefix install (floor ${FLOOR_MAJOR}.${FLOOR_MINOR})"
  exit 1
fi

if [[ "$(uname -s)" != "Linux" && "$(uname -s)" != "Darwin" ]]; then
  echo "install-tmux-user: unsupported OS $(uname -s)" >&2
  exit 1
fi

need_cmds=(git make)
for c in "${need_cmds[@]}"; do
  command -v "$c" >/dev/null 2>&1 || {
    echo "install-tmux-user: missing '$c'" >&2
    exit 1
  }
done

if [[ "$(uname -s)" == "Linux" ]]; then
  for c in autoconf automake pkg-config; do
    command -v "$c" >/dev/null 2>&1 || {
      echo "install-tmux-user: missing build tool '$c'" >&2
      echo "  Debian/Ubuntu: sudo apt-get install -y build-essential autoconf automake pkg-config libevent-dev libncurses-dev bison git" >&2
      exit 1
    }
  done
fi

workdir="$(mktemp -d "${TMPDIR:-/tmp}/tmux-build.XXXXXX")"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

echo "install-tmux-user: clone $REPO_URL @ $TAG → prefix=$PREFIX"
git clone --depth 1 --branch "$TAG" "$REPO_URL" "$workdir/tmux"
cd "$workdir/tmux"

if [[ -x ./autogen.sh ]]; then
  sh ./autogen.sh
elif [[ -f configure.ac || -f configure.in ]]; then
  autoreconf -fi
fi

./configure --prefix="$PREFIX"
make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
make install

bin="$PREFIX/bin/tmux"
[[ -x "$bin" ]] || {
  echo "install-tmux-user: expected binary missing: $bin" >&2
  exit 1
}

echo "install-tmux-user: OK → $bin ($("$bin" -V))"
echo "install-tmux-user: put $PREFIX/bin before /usr/bin on PATH when this user build is the chosen entry"
echo "install-tmux-user: single user entry only — do not multi-shim cargo/bin or ~/bin"
if command -v tmux >/dev/null 2>&1; then
  echo "install-tmux-user: current command -v tmux = $(command -v tmux) ($(tmux -V 2>/dev/null || true))"
fi
echo "install-tmux-user: restart server if an older binary still owns the live socket (tmux kill-server when convenient)"
