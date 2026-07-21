#!/usr/bin/env bash
# check-mermaid.sh — syntax-validate every ```mermaid block in markdown files.
#
# Uses mermaid's own parser (mermaid.parse) under jsdom — real grammar checking,
# NO chromium/render. Catches things eyeballing misses (empty-label dashed edges,
# bad arrows, unbalanced brackets, unknown directives).
#
# Usage:
#   check-mermaid.sh                 # all docs/**.md
#   check-mermaid.sh FILE [FILE...]  # specific files
#
# Deps (mermaid + jsdom) are installed once into a cache dir outside the repo.
# Exit: 0 all blocks parse, 1 any fail, 2 setup error.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/wezterm-config-mermaid"

command -v node >/dev/null 2>&1 || { echo "[check-mermaid] node not found" >&2; exit 2; }

# Target files
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  mapfile -t files < <(find "$repo/docs" -name '*.md' | sort)
fi
[ "${#files[@]}" -gt 0 ] || { echo "[check-mermaid] no files"; exit 0; }
abs=()
for f in "${files[@]}"; do abs+=("$(cd "$(dirname "$f")" && pwd)/$(basename "$f")"); done

# One-time dependency install (outside the repo)
if [ ! -d "$cache/node_modules/mermaid" ]; then
  echo "[check-mermaid] one-time install of mermaid + jsdom in $cache …" >&2
  mkdir -p "$cache"
  ( cd "$cache" && npm init -y >/dev/null 2>&1 && npm i mermaid@11 jsdom >/dev/null 2>&1 ) \
    || { echo "[check-mermaid] npm install failed" >&2; exit 2; }
fi

# Emit the checker INTO the cache dir so ESM resolves mermaid/jsdom from there.
cat > "$cache/check.mjs" <<'MJS'
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!DOCTYPE html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const mermaid = (await import("mermaid")).default;
mermaid.initialize({ startOnLoad: false });

let total = 0, failed = 0;
for (const f of process.argv.slice(2)) {
  const lines = readFileSync(f, "utf8").split("\n");
  let inB = false, buf = [], start = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!inB && /^```mermaid\s*$/.test(l)) { inB = true; buf = []; start = i + 1; continue; }
    if (inB && /^```\s*$/.test(l)) {
      inB = false; total++;
      try { await mermaid.parse(buf.join("\n")); }
      catch (e) {
        failed++;
        const m = String(e.message || e).split("\n").slice(0, 4).join(" ⏎ ").slice(0, 180);
        console.error(`  ✗ ${f}:${start} (mermaid block)  ${m}`);
      }
      continue;
    }
    if (inB) buf.push(l);
  }
  if (inB) { total++; failed++; console.error(`  ✗ ${f}:${start} (mermaid block) unterminated — no closing fence`); }
}
console.log(`${failed ? "✗" : "✓"} mermaid: ${total - failed}/${total} block(s) parse-clean`);
process.exit(failed ? 1 : 0);
MJS

node "$cache/check.mjs" "${abs[@]}"
