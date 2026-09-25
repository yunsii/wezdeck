#!/usr/bin/env bash
# rubric-lib.sh — read the review dimension standard from rubric.conf.
# Override the file with _RUBRIC_CONF=... if needed.

_RUBRIC_CONF="${_RUBRIC_CONF:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rubric.conf}"

# rubric_repro_gated <dimension>  → "yes" | "no" | "" (unknown dimension)
rubric_repro_gated() {
  awk -F'|' -v d="$1" \
    '/^[[:space:]]*#/ || NF<3 {next} $1==d {print $2; exit}' "$_RUBRIC_CONF"
}

# rubric_text  → human/agent-readable dimension list for prompt injection
rubric_text() {
  awk -F'|' \
    '/^[[:space:]]*#/ || NF<3 {next}
     {printf "- %s (%s): %s\n", $1, ($2=="yes" ? "repro-gated" : "design/advisory"), $3}' \
    "$_RUBRIC_CONF"
}

# rubric_dims  → space-separated dimension names
rubric_dims() {
  awk -F'|' '/^[[:space:]]*#/ || NF<3 {next} {printf "%s ", $1}' "$_RUBRIC_CONF"
}
