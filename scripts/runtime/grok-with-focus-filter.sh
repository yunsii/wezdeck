#!/usr/bin/env bash
# Launch Grok Build with terminal FocusIn/FocusOut CSI stripped.
#
# Why: Grok full-repaints on FocusGained; under tmux+WezTerm that shows as a
# whole-transcript flash when Alt+o / pane click switches focus. Session-wide
# `focus-events off` stops the flash but also starves Vim/Claude/attention.
# This wrapper keeps focus-events on for the session and only blinds Grok.
#
# Install (seats PATH symlinks — grok's ~/.zshrc prepends ~/.grok/bin ahead of
# ~/.local/bin, so a ~/.local/bin/grok symlink alone is skipped):
#   scripts/runtime/grok-with-focus-filter.sh --install
# That keeps the real binary at ~/.grok/bin/grok.real and points
# ~/.grok/bin/grok (+ ~/.local/bin/grok) at this script.
#
# After `grok update` the updater overwrites ~/.grok/bin/grok again. Standing
# automation (preferred over remembering --install):
#   1) Every normal launch runs a quiet ensure (promote newest download →
#      grok.real; re-seat PATH symlinks if clobbered). Skip with
#      GROK_FOCUS_FILTER_SKIP_ENSURE=1.
#   2) Interactive zsh: shell-env.d `grok()` calls this wrapper by absolute
#      path so update cannot steal the name via PATH (see
#      wezterm-x/local.example/shell-env.d/grok-focus-filter.env).
#
# Health check (non-mutating; agents/docs triage first):
#   scripts/runtime/grok-with-focus-filter.sh --check
#
# Opt out for one run: GROK_FOCUS_FILTER=0 grok ...
# Point at a specific binary: GROK_REAL_BIN=/path/to/grok grok ...
# Docs: docs/tmux-ui.md#grok-build-in-tmux (Standing ops after grok update).
set -euo pipefail

# When installed as ~/.grok/bin/grok or ~/.local/bin/grok → this file,
# BASH_SOURCE is the symlink path; resolve to scripts/runtime/ first.
_SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$_SELF")" && pwd)"
FILTER_PY="$SCRIPT_DIR/grok-focus-filter.py"
REPO_WRAPPER="$SCRIPT_DIR/grok-with-focus-filter.sh"

is_focus_filter_wrapper() {
  # True for *any* checkout's grok-with-focus-filter.sh (primary, worktree,
  # or a copied path). Comparing only to $_SELF wrongly treated another
  # worktree's wrapper as "real binary" and copied it into grok.real.
  local path="$1"
  local resolved base dir
  [[ -z "$path" ]] && return 1
  resolved="$(readlink -f "$path" 2>/dev/null || printf '%s' "$path")"
  base="$(basename "$resolved")"
  [[ "$base" == "grok-with-focus-filter.sh" ]] && return 0
  [[ "$resolved" == "$_SELF" || "$resolved" == "$REPO_WRAPPER" ]] && return 0
  dir="$(dirname "$resolved")"
  [[ -f "$dir/grok-focus-filter.py" && -f "$resolved" ]] || return 1
  # Cheap content marker — avoid promoting random scripts beside the py.
  grep -q 'grok-focus-filter.py' "$resolved" 2>/dev/null
}

# Back-compat name used throughout this file.
is_this_wrapper() { is_focus_filter_wrapper "$1"; }

is_probable_grok_elf() {
  local path="$1"
  [[ -f "$path" && -x "$path" ]] || return 1
  is_focus_filter_wrapper "$path" && return 1
  # file(1) is enough; avoid promoting shell/python into grok.real.
  local kind
  kind="$(file -b "$path" 2>/dev/null || true)"
  [[ "$kind" == *ELF* ]]
}

resolve_real_bin() {
  if [[ -n "${GROK_REAL_BIN:-}" && -x "${GROK_REAL_BIN}" ]]; then
    if is_this_wrapper "${GROK_REAL_BIN}"; then
      printf 'grok-with-focus-filter: GROK_REAL_BIN points at the wrapper\n' >&2
      exit 127
    fi
    printf '%s\n' "$GROK_REAL_BIN"
    return
  fi
  local candidate
  # Prefer the parked real binary; never pick a focus-filter wrapper script.
  for candidate in \
    "${HOME}/.grok/bin/grok.real" \
    "${HOME}/.grok/downloads/grok-1.0.5-linux-x86_64" \
    "${HOME}/.grok/downloads/grok-1.0.7-linux-x86_64"; do
    if is_probable_grok_elf "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  # Newest matching download artifact, if any.
  local newest=""
  if compgen -G "${HOME}/.grok/downloads/grok-*-linux-x86_64" >/dev/null 2>&1; then
    newest="$(ls -1t "${HOME}/.grok/downloads"/grok-*-linux-x86_64 2>/dev/null | head -1 || true)"
  fi
  if [[ -n "$newest" ]] && is_probable_grok_elf "$newest"; then
    printf '%s\n' "$newest"
    return
  fi
  # Last resort: PATH entries that look like a real ELF grok.
  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    if is_probable_grok_elf "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done < <(type -aP grok 2>/dev/null || true)
  printf 'grok-with-focus-filter: cannot find a real grok binary (expected ~/.grok/bin/grok.real)\n' >&2
  exit 127
}

install_wrapper() {
  local grok_dir="${HOME}/.grok/bin"
  local target="${grok_dir}/grok"
  local real="${grok_dir}/grok.real"
  local local_link="${HOME}/.local/bin/grok"

  mkdir -p "$grok_dir" "${HOME}/.local/bin"

  if [[ -e "$target" || -L "$target" ]]; then
    if is_this_wrapper "$target"; then
      printf 'install: %s already points at the focus-filter wrapper\n' "$target"
    elif [[ -f "$target" && ! -L "$target" ]]; then
      if [[ -e "$real" ]]; then
        # Keep newer of the two as grok.real
        if [[ "$target" -nt "$real" ]]; then
          mv -f "$target" "$real"
          printf 'install: moved newer %s → %s\n' "$target" "$real"
        else
          rm -f "$target"
          printf 'install: removed stale %s (kept existing %s)\n' "$target" "$real"
        fi
      else
        mv -f "$target" "$real"
        printf 'install: moved %s → %s\n' "$target" "$real"
      fi
    else
      # Unexpected symlink (e.g. `grok update` repointed ~/.grok/bin/grok at
      # downloads/grok-*-linux-x86_64). Park / promote that artifact into
      # grok.real so the wrapper keeps the newest binary.
      local dest
      dest="$(readlink -f "$target" 2>/dev/null || true)"
      if [[ -n "$dest" ]] && is_probable_grok_elf "$dest"; then
        if [[ ! -e "$real" || "$dest" -nt "$real" ]]; then
          cp -f "$dest" "$real"
          chmod +x "$real"
          printf 'install: promoted %s → %s\n' "$dest" "$real"
        fi
      elif [[ -n "$dest" ]]; then
        printf 'install: skip promoting non-ELF symlink target %s\n' "$dest"
      fi
      rm -f "$target"
    fi
  fi

  if ! is_probable_grok_elf "$real"; then
    # Missing, or a previous bug parked a wrapper script here — reseed.
    local seed=""
    if compgen -G "${HOME}/.grok/downloads/grok-*-linux-x86_64" >/dev/null 2>&1; then
      seed="$(ls -1t "${HOME}/.grok/downloads"/grok-*-linux-x86_64 2>/dev/null | head -1 || true)"
    fi
    if [[ -n "$seed" ]] && is_probable_grok_elf "$seed"; then
      cp -f "$seed" "$real"
      chmod +x "$real"
      printf 'install: seeded %s from %s\n' "$real" "$seed"
    else
      printf 'install: missing real ELF at %s and no downloads seed\n' "$real" >&2
      exit 1
    fi
  else
    # Even when grok.real already exists, prefer a newer download artifact
    # left behind by `grok update` (common: symlink overwritten, .real stale).
    local newest=""
    if compgen -G "${HOME}/.grok/downloads/grok-*-linux-x86_64" >/dev/null 2>&1; then
      newest="$(ls -1t "${HOME}/.grok/downloads"/grok-*-linux-x86_64 2>/dev/null | head -1 || true)"
    fi
    if [[ -n "$newest" ]] && is_probable_grok_elf "$newest" && [[ "$newest" -nt "$real" ]]; then
      cp -f "$newest" "$real"
      chmod +x "$real"
      printf 'install: upgraded %s from newer download %s\n' "$real" "$newest"
    fi
  fi

  ln -sfn "$REPO_WRAPPER" "$target"
  ln -sfn "$REPO_WRAPPER" "$local_link"
  printf 'install: %s → %s\n' "$target" "$REPO_WRAPPER"
  printf 'install: %s → %s\n' "$local_link" "$REPO_WRAPPER"
  printf 'install: real binary %s\n' "$real"
  printf 'Re-run after every `grok update`. Exit and --resume any live Grok session.\n'
  # Smoke: resolved real must not be the wrapper.
  GROK_REAL_BIN= "$REPO_WRAPPER" --version >/dev/null
  printf 'install: smoke --version ok via wrapper\n'
}

# Quiet heal used on every normal launch (and safe to call repeatedly).
# Promotes a newer downloads/ artifact into grok.real and re-seats PATH
# symlinks when `grok update` clobbered them. No smoke --version (avoids
# recursion). Log with GROK_FOCUS_FILTER_ENSURE_LOG=1.
ensure_wrapper() {
  local grok_dir="${HOME}/.grok/bin"
  local target="${grok_dir}/grok"
  local real="${grok_dir}/grok.real"
  local local_link="${HOME}/.local/bin/grok"
  local log=0
  [[ "${GROK_FOCUS_FILTER_ENSURE_LOG:-0}" == "1" ]] && log=1
  ensure_log() { (( log )) && printf 'ensure: %s\n' "$*" >&2 || true; }

  mkdir -p "$grok_dir" "${HOME}/.local/bin"

  # If update left an ELF or downloads symlink at ~/.grok/bin/grok, park it.
  if [[ -e "$target" || -L "$target" ]] && ! is_this_wrapper "$target"; then
    if [[ -f "$target" && ! -L "$target" ]]; then
      if [[ ! -e "$real" || "$target" -nt "$real" ]]; then
        mv -f "$target" "$real"
        ensure_log "moved newer ELF → $real"
      else
        rm -f "$target"
        ensure_log "removed stale ELF (kept $real)"
      fi
    else
      local dest
      dest="$(readlink -f "$target" 2>/dev/null || true)"
      if [[ -n "$dest" ]] && is_probable_grok_elf "$dest"; then
        if [[ ! -e "$real" || "$dest" -nt "$real" ]]; then
          cp -f "$dest" "$real"
          chmod +x "$real"
          ensure_log "promoted $dest → $real"
        fi
      elif [[ -n "$dest" ]]; then
        ensure_log "skip promoting non-ELF symlink target $dest"
      fi
      rm -f "$target"
      ensure_log "removed clobbered symlink at $target"
    fi
  fi

  # Seed / upgrade grok.real from newest download (never park a wrapper script).
  local newest=""
  if compgen -G "${HOME}/.grok/downloads/grok-*-linux-x86_64" >/dev/null 2>&1; then
    newest="$(ls -1t "${HOME}/.grok/downloads"/grok-*-linux-x86_64 2>/dev/null | head -1 || true)"
  fi
  if ! is_probable_grok_elf "$real"; then
    if [[ -n "$newest" ]] && is_probable_grok_elf "$newest"; then
      cp -f "$newest" "$real"
      chmod +x "$real"
      ensure_log "seeded $real from $newest"
    else
      ensure_log "no grok.real ELF and no downloads seed (resolve_real_bin may still find PATH)"
    fi
  elif [[ -n "$newest" ]] && is_probable_grok_elf "$newest" && [[ "$newest" -nt "$real" ]]; then
    cp -f "$newest" "$real"
    chmod +x "$real"
    ensure_log "upgraded $real from $newest"
  fi

  if ! is_this_wrapper "$target"; then
    ln -sfn "$REPO_WRAPPER" "$target"
    ensure_log "$target → wrapper"
  fi
  if ! is_this_wrapper "$local_link"; then
    ln -sfn "$REPO_WRAPPER" "$local_link"
    ensure_log "$local_link → wrapper"
  fi
}

# Non-mutating health check for docs / agents / post-update ops.
# Exit 0 when grok.real is executable and interactive launch hits the wrapper
# (PATH symlink and/or zsh function). Exit 1 with actionable lines otherwise.
check_wrapper() {
  local target="${HOME}/.grok/bin/grok"
  local real="${HOME}/.grok/bin/grok.real"
  local local_link="${HOME}/.local/bin/grok"
  local rc=0

  if is_this_wrapper "$target"; then
    printf 'ok: %s → focus-filter wrapper\n' "$target"
  else
    printf 'FAIL: %s is not the focus-filter wrapper\n' "$target"
    if [[ -L "$target" ]]; then
      printf '  currently → %s\n' "$(readlink "$target" 2>/dev/null || true)"
    elif [[ -e "$target" ]]; then
      printf '  currently a plain file/ELF (typical after `grok update`)\n'
    else
      printf '  missing\n'
    fi
    printf '  fix: scripts/runtime/grok-with-focus-filter.sh --install\n'
    printf '  (or just run grok via wrapper / zsh grok() — launch ensure reseats)\n'
    rc=1
  fi

  if [[ -x "$real" ]]; then
    printf 'ok: %s executable\n' "$real"
  else
    printf 'FAIL: missing executable %s\n' "$real"
    printf '  fix: scripts/runtime/grok-with-focus-filter.sh --install\n'
    rc=1
  fi

  if is_this_wrapper "$local_link"; then
    printf 'ok: %s → focus-filter wrapper (backup PATH entry)\n' "$local_link"
  else
    printf 'WARN: %s is not the wrapper (PATH backup missing)\n' "$local_link"
  fi

  # Interactive launch: zsh function (absolute wrapper) OR PATH first hit.
  local kind=""
  kind="$(zsh -ilc 'whence -w grok' 2>/dev/null || true)"
  if [[ "$kind" == *': function'* ]]; then
    printf 'ok: interactive grok is a zsh function (launch wrap; update-safe)\n'
  else
    local first=""
    first="$(zsh -ilc 'command -v grok' 2>/dev/null || command -v grok || true)"
    if [[ -n "$first" ]] && is_this_wrapper "$first"; then
      printf 'ok: login/PATH first hit is the wrapper (%s)\n' "$first"
    elif [[ -n "$first" ]]; then
      printf 'FAIL: login/PATH first hit is %s (not the wrapper)\n' "$first"
      printf '  install shell-env.d/grok-focus-filter.env or re-run --install\n'
      rc=1
    else
      printf 'FAIL: grok not on PATH and no zsh function\n'
      rc=1
    fi
  fi

  if (( rc == 0 )); then
    printf 'check: focus-filter install looks healthy\n'
  else
    printf 'check: focus-filter install needs repair (see FAIL lines above)\n' >&2
  fi
  return "$rc"
}

if [[ "${1:-}" == "--install" ]]; then
  install_wrapper
  exit 0
fi

if [[ "${1:-}" == "--check" ]]; then
  check_wrapper
  exit $?
fi

if [[ "${1:-}" == "--ensure" ]]; then
  ensure_wrapper
  exit 0
fi

if [[ "${GROK_FOCUS_FILTER_SKIP_ENSURE:-0}" != "1" ]]; then
  ensure_wrapper
fi

REAL_BIN="$(resolve_real_bin)"
export GROK_REAL_BIN="$REAL_BIN"

if [[ ! -f "$FILTER_PY" ]]; then
  printf 'grok-with-focus-filter: missing %s\n' "$FILTER_PY" >&2
  exit 127
fi

exec python3 "$FILTER_PY" -- "$REAL_BIN" "$@"
