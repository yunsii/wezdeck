#!/usr/bin/env bash
# provider plugin: claude (Claude Code CLI)
# Interface: <name>__available / __family / __model / __invoke  (+ optional __aliases)

claude__aliases() { :; }                 # no extra aliases
claude__available() { command -v claude >/dev/null 2>&1; }
claude__family()   { echo claude; }
claude__model()    { printf '%s' "${ADV_MODEL_CLAUDE:-claude-fable-5[1m]}"; }

# stdin = full prompt (pack + INPUT); $1 = effort (may be empty)
claude__invoke() {
  local effort="${1:-}" model
  model="$(claude__model)"
  claude -p --output-format json \
      --permission-mode plan \
      --allowed-tools Read Grep Glob \
      --model "$model" ${effort:+--effort "$effort"} 2>/dev/null \
    | jq -r '.result // .text // empty'
}
