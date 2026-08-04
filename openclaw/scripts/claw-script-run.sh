#!/usr/bin/env bash
# claw-script-run.sh — run multi-line agent logic from a real file (not python -c / node -e).
#
# Why: Feishu/OpenClaw agents often emit literal "\n" or broken quoting in inline
# interpreters, which shows up as 🛠️ Exec failed with SyntaxError. Writing a file
# first makes the script inspectable and avoids escape damage.
#
# Usage:
#   claw-script-run.sh [--lang python3|python|node|bash|zsh|sh] [--name stem] [--keep] <<'EOF'
#   ...script body...
#   EOF
#
#   claw-script-run.sh --file /path/to/script.py [--] [args...]
#   claw-script-run.sh --lang python3 --file /path/to/script.py -- --flag
#
#   printf '%s\n' 'print(1+1)' | claw-script-run.sh --lang python3 --name add
#
# Env:
#   CLAW_SCRIPT_DIR  override output dir (default: ~/.openclaw/tmp/scripts)
#   OPENCLAW_STATE_DIR  used if CLAW_SCRIPT_DIR unset (…/tmp/scripts under it)
#
# Exit: underlying interpreter exit code; 3 = usage; 4 = write/run infra failure
set -euo pipefail

LANG_BIN=""
NAME="script"
KEEP=0
FILE=""
FROM_STDIN=1
ARGS=()

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  echo "claw-script-run: $*" >&2
  exit 3
}

infra() {
  echo "claw-script-run: $*" >&2
  exit 4
}

ext_for_lang() {
  case "$1" in
    python3|python) echo py ;;
    node) echo mjs ;;
    bash|zsh|sh) echo sh ;;
    *) echo txt ;;
  esac
}

detect_lang_from_file() {
  local f="$1" base ext
  base="$(basename -- "$f")"
  ext="${base##*.}"
  case "$ext" in
    py) echo python3 ;;
    mjs|js|cjs) echo node ;;
    sh) echo bash ;;
    *)
      if head -n1 "$f" | grep -q 'python'; then
        echo python3
      elif head -n1 "$f" | grep -q 'node'; then
        echo node
      else
        echo bash
      fi
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --lang|-l)
      [[ $# -ge 2 ]] || die "--lang needs a value"
      LANG_BIN="$2"
      shift 2
      ;;
    --name|-n)
      [[ $# -ge 2 ]] || die "--name needs a value"
      NAME="$2"
      shift 2
      ;;
    --keep|-k)
      KEEP=1
      shift
      ;;
    --file|-f)
      [[ $# -ge 2 ]] || die "--file needs a path"
      FILE="$2"
      FROM_STDIN=0
      shift 2
      ;;
    --)
      shift
      ARGS+=("$@")
      break
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      # positional file path convenience
      if [[ -z "$FILE" && -f "$1" ]]; then
        FILE="$1"
        FROM_STDIN=0
        shift
        ARGS+=("$@")
        break
      fi
      die "unexpected arg: $1 (use --file or stdin)"
      ;;
  esac
done

# sanitize name
NAME="$(printf '%s' "$NAME" | tr -cd 'A-Za-z0-9._-' | cut -c1-64)"
[[ -n "$NAME" ]] || NAME="script"

STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
OUT_DIR="${CLAW_SCRIPT_DIR:-$STATE_DIR/tmp/scripts}"
mkdir -p "$OUT_DIR" || infra "cannot create $OUT_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)-$$"
TARGET=""

if [[ "$FROM_STDIN" -eq 1 ]]; then
  if [[ -z "$LANG_BIN" ]]; then
    LANG_BIN="python3"
  fi
  case "$LANG_BIN" in
    python3|python|node|bash|zsh|sh) ;;
    *) die "unsupported --lang: $LANG_BIN" ;;
  esac
  TARGET="$OUT_DIR/${STAMP}-${NAME}.$(ext_for_lang "$LANG_BIN")"
  # Preserve exact bytes from stdin (no shell reinterpretation)
  cat >"$TARGET" || infra "failed writing $TARGET"
  if [[ ! -s "$TARGET" ]]; then
    infra "empty script body (stdin was empty)"
  fi
else
  [[ -n "$FILE" ]] || die "--file path required"
  [[ -f "$FILE" ]] || infra "file not found: $FILE"
  if [[ -z "$LANG_BIN" ]]; then
    LANG_BIN="$(detect_lang_from_file "$FILE")"
  fi
  TARGET="$FILE"
fi

cleanup() {
  if [[ "$FROM_STDIN" -eq 1 && "$KEEP" -eq 0 && -n "$TARGET" && -f "$TARGET" ]]; then
    rm -f -- "$TARGET" || true
  fi
}
trap cleanup EXIT

case "$LANG_BIN" in
  python3|python)
    command -v "$LANG_BIN" >/dev/null 2>&1 || infra "interpreter not found: $LANG_BIN"
    exec "$LANG_BIN" "$TARGET" "${ARGS[@]+"${ARGS[@]}"}"
    ;;
  node)
    command -v node >/dev/null 2>&1 || infra "interpreter not found: node"
    exec node "$TARGET" "${ARGS[@]+"${ARGS[@]}"}"
    ;;
  bash|zsh|sh)
    command -v "$LANG_BIN" >/dev/null 2>&1 || infra "interpreter not found: $LANG_BIN"
    chmod +x "$TARGET" 2>/dev/null || true
    exec "$LANG_BIN" "$TARGET" "${ARGS[@]+"${ARGS[@]}"}"
    ;;
  *)
    die "unsupported language: $LANG_BIN"
    ;;
esac
