#!/usr/bin/env bash
# Link this repo's openclaw/workspace into the live OpenClaw workspace path.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_root="$(cd "${script_dir}/.." && pwd)"
src="${pkg_root}/workspace"

dest="${OPENCLAW_WORKSPACE:-${HOME}/.openclaw/workspace}"

if [[ ! -d "${src}" ]]; then
  echo "error: missing source workspace: ${src}" >&2
  exit 1
fi

if [[ ! -f "${src}/AGENTS.md" ]]; then
  echo "error: ${src}/AGENTS.md not found" >&2
  exit 1
fi

mkdir -p "$(dirname "${dest}")"

if [[ -e "${dest}" || -L "${dest}" ]]; then
  if [[ -L "${dest}" ]]; then
    current="$(readlink -f "${dest}" 2>/dev/null || readlink "${dest}")"
    target="$(readlink -f "${src}")"
    if [[ "${current}" == "${target}" ]]; then
      echo "ok: already linked"
      echo "  ${dest} -> ${src}"
      exit 0
    fi
    echo "error: ${dest} is a symlink to ${current}" >&2
    echo "  refuse to replace; unset or move it, or set OPENCLAW_WORKSPACE" >&2
    exit 2
  fi
  if [[ -d "${dest}" ]]; then
    if [[ -f "${dest}/AGENTS.md" ]]; then
      echo "error: ${dest} already exists as a directory with AGENTS.md" >&2
      echo "  merge manually or: mv ${dest} ${dest}.bak && $0" >&2
      exit 2
    fi
    # empty-ish dir from onboard — only replace if no AGENTS.md
    if [[ -n "$(ls -A "${dest}" 2>/dev/null || true)" ]]; then
      echo "error: ${dest} exists and is non-empty" >&2
      echo "  move it aside first" >&2
      exit 2
    fi
    rmdir "${dest}"
  else
    echo "error: ${dest} exists and is not a directory/symlink" >&2
    exit 2
  fi
fi

ln -sfn "${src}" "${dest}"
echo "ok: linked workspace"
echo "  ${dest} -> ${src}"
echo "note: point OpenClaw agents.defaults.workspace at this path if needed"
