#!/usr/bin/env bash
# test-impact.sh — offline, deterministic smoke test for the impact resolver.
#
# Builds a throwaway git repo where a downstream file references a symbol defined
# in a changed file, then asserts `impact.sh scan` surfaces that downstream file
# via the grep resolver. No network, no LLM. Run: lib/impact/test-impact.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/impact-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM HUP

git -C "$TMP" init -q
git -C "$TMP" config user.email t@t.t
git -C "$TMP" config user.name t

# base commit: define a symbol + a downstream file that references it + a decoy
cat > "$TMP/lib.sh" <<'EOF'
compute_blast_radius() { echo "v1"; }
EOF
cat > "$TMP/consumer.sh" <<'EOF'
source lib.sh
compute_blast_radius
EOF
cat > "$TMP/unrelated.sh" <<'EOF'
echo "nothing to see"
EOF
git -C "$TMP" add -A
git -C "$TMP" commit -qm base
BASE="$(git -C "$TMP" rev-parse HEAD)"

# change the definition (touches compute_blast_radius)
cat > "$TMP/lib.sh" <<'EOF'
compute_blast_radius() { echo "v2 changed"; }
EOF
git -C "$TMP" add -A
git -C "$TMP" commit -qm change

OUT="$("$DIR/impact.sh" scan "$BASE" --head HEAD --repo "$TMP")"

pass=0
fail() { echo "FAIL: $1"; echo "--- output ---"; echo "$OUT" | jq . 2>/dev/null || echo "$OUT"; exit 1; }

# 1. valid JSON array
echo "$OUT" | jq -e 'type == "array"' >/dev/null || fail "output is not a JSON array"

# 2. downstream consumer.sh surfaces
echo "$OUT" | jq -e 'any(.[]; .file == "consumer.sh" and .symbol == "compute_blast_radius")' >/dev/null \
  || fail "consumer.sh reference to compute_blast_radius not found"
pass=$((pass + 1))

# 3. the changed file itself is excluded (diff already carries it)
echo "$OUT" | jq -e 'all(.[]; .file != "lib.sh")' >/dev/null \
  || fail "changed file lib.sh should be excluded from downstream hits"
pass=$((pass + 1))

# 4. unrelated file is NOT dragged in
echo "$OUT" | jq -e 'all(.[]; .file != "unrelated.sh")' >/dev/null \
  || fail "unrelated.sh must not appear"
pass=$((pass + 1))

# 5. grep hits are labeled same-name confidence
echo "$OUT" | jq -e 'all(.[]; .confidence == "same-name")' >/dev/null \
  || fail "grep resolver hits must be labeled same-name"
pass=$((pass + 1))

# 6. resolvers command lists grep
"$DIR/impact.sh" resolvers | grep -qx grep || fail "resolvers should list grep"
pass=$((pass + 1))

echo "PASS ($pass assertions) — impact grep resolver works"
