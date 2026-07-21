#!/usr/bin/env bash
# provider plugin: grok (standalone Grok CLI, own API key — NOT the codex gateway)
# Interface: <name>__available / __family / __model / __invoke  (+ optional __aliases)

grok__aliases()  { :; }
grok__available() { command -v grok >/dev/null 2>&1; }
grok__family()   { echo grok; }
grok__model()    { printf '%s' "${ADV_MODEL_GROK:-grok-4.5}"; }

# stdin = full prompt; $1 = effort. Grok needs a prompt file (pack can exceed
# ARG_MAX + special chars); JSON output → .text carries the model's answer.
grok__invoke() {
  local effort="${1:-}" model gtmp gout
  model="$(grok__model)"
  gtmp="$(mktemp "${TMPDIR:-/tmp}/grok-prompt.XXXXXX")"
  cat > "$gtmp"
  gout="$(grok --prompt-file "$gtmp" -m "$model" --output-format json \
            ${effort:+--reasoning-effort "$effort"} 2>/dev/null \
          | jq -r '.text // empty')" || true
  rm -f "$gtmp"
  printf '%s' "$gout"
}
