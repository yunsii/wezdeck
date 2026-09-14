#!/usr/bin/env bash
# provider plugin: grok (standalone Grok CLI) — host-agent-invoke read profile
# Interface: <name>__available / __family / __model / __invoke  (+ optional __aliases)

_GROK_HOST_INVOKE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../host-agent-invoke/lib" && pwd)/host-agent-invoke.sh"
# shellcheck source=/dev/null
. "$_GROK_HOST_INVOKE"

grok__aliases()  { :; }
grok__available() { command -v grok >/dev/null 2>&1; }
grok__family()   { echo grok; }
grok__model()    { printf '%s' "${ADV_MODEL_GROK:-grok-4.5}"; }

# stdin = full prompt; $1 = effort.
grok__invoke() {
  local effort="${1:-}" model gtmp raw
  model="$(grok__model)"
  gtmp="$(mktemp "${TMPDIR:-/tmp}/grok-prompt.XXXXXX")"
  cat >"$gtmp"
  raw="$(
    host_agent_invoke_run \
      --backend grok --mode read \
      --cwd "${PWD:-.}" --prompt-file "$gtmp" \
      --model "$model" ${effort:+--effort "$effort"} \
      --capture
  )" || true
  rm -f "$gtmp"
  printf '%s' "$raw" | jq -r '.text // empty'
}
