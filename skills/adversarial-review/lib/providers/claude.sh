#!/usr/bin/env bash
# provider plugin: claude (Claude Code CLI) — host-agent-invoke read profile
# Interface: <name>__available / __family / __model / __invoke  (+ optional __aliases)

_CLAUDE_HOST_INVOKE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../scripts/dev/host-agent-invoke/lib" && pwd)/host-agent-invoke.sh"
# shellcheck source=/dev/null
. "$_CLAUDE_HOST_INVOKE"

claude__aliases() { :; }
claude__available() { command -v claude >/dev/null 2>&1; }
claude__family()   { echo claude; }
claude__model()    { printf '%s' "${ADV_MODEL_CLAUDE:-claude-opus-5[1m]}"; }

# stdin = full prompt (pack + INPUT); $1 = effort (may be empty)
claude__invoke() {
  local effort="${1:-}" model gtmp raw
  model="$(claude__model)"
  gtmp="$(mktemp "${TMPDIR:-/tmp}/claude-prompt.XXXXXX")"
  cat >"$gtmp"
  raw="$(
    host_agent_invoke_run \
      --backend claude --mode read \
      --cwd "${PWD:-.}" --prompt-file "$gtmp" \
      --model "$model" ${effort:+--effort "$effort"} \
      --capture
  )" || true
  rm -f "$gtmp"
  printf '%s' "$raw" | jq -r '.result // .text // empty'
}
