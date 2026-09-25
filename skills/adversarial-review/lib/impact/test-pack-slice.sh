#!/usr/bin/env bash
# test-pack-slice.sh — offline smoke for --pack-only + --project-slice-file.
#
# Builds a throwaway git repo, runs run.sh --pack-only, applies a keep filter,
# and asserts PROJECT_SLICE reflects the filter (no LLM). 
# Run: lib/impact/test-pack-slice.sh
set -euo pipefail

TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="$TOOL/run.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pack-slice-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM HUP

pass=0
fail() { echo "FAIL: $1"; exit 1; }

# --- fixture repo (same shape as test-impact.sh) -----------------------------
git -C "$TMP" init -q
git -C "$TMP" config user.email t@t.t
git -C "$TMP" config user.name t

cat > "$TMP/lib.sh" <<'EOF'
compute_blast_radius() { echo "v1"; }
EOF
cat > "$TMP/consumer.sh" <<'EOF'
source lib.sh
compute_blast_radius
EOF
cat > "$TMP/decoy.sh" <<'EOF'
# mentions compute_blast_radius only in a comment — still same-name grep hit
# compute_blast_radius
echo other
EOF
git -C "$TMP" add -A
git -C "$TMP" commit -qm base
BASE="$(git -C "$TMP" rev-parse HEAD)"

cat > "$TMP/lib.sh" <<'EOF'
compute_blast_radius() { echo "v2 changed"; }
EOF
git -C "$TMP" add -A
git -C "$TMP" commit -qm change

PACK_DIR="$TMP/pack"
mkdir -p "$PACK_DIR"

# --- 1) pack-only emits candidates ------------------------------------------
META="$("$RUN" "$BASE" --repo "$TMP" --head HEAD --pack-only --keep-pack "$PACK_DIR" --json --writer human --no-probe 2>/dev/null)"
echo "$META" | jq -e '.mode=="pack-only"' >/dev/null || fail "mode should be pack-only"
echo "$META" | jq -e '.has_runtime==1' >/dev/null || fail "has_runtime should be 1"
echo "$META" | jq -e '.impact_candidates_n >= 1' >/dev/null || fail "expected impact candidates"
echo "$META" | jq -e 'any(.impact_candidates[]; .file=="consumer.sh")' >/dev/null \
  || fail "consumer.sh should be in impact_candidates"
[ -f "$PACK_DIR/impact_candidates.json" ] || fail "impact_candidates.json missing"
[ -f "$PACK_DIR/pack.md" ] || fail "pack.md missing"
[ -f "$PACK_DIR/project_slice.keep.example.json" ] || fail "example keep file missing"
pass=$((pass + 1))

# --- 2) keep only consumer.sh -----------------------------------------------
KEEP="$PACK_DIR/project_slice.keep.json"
jq -n --argjson all "$(cat "$PACK_DIR/impact_candidates.json")" '
  {
    keep: [$all[] | select(.file=="consumer.sh")],
    dropped: [$all[] | select(.file!="consumer.sh")],
    filter: "main-agent",
    notes: "test: keep consumer only"
  }' > "$KEEP"

PACK2="$TMP/pack2"
mkdir -p "$PACK2"
# dry-run still builds pack with injected slice
"$RUN" "$BASE" --repo "$TMP" --head HEAD \
  --project-slice-file "$KEEP" --keep-pack "$PACK2" \
  --dry-run --no-probe --writer human >/dev/null 2>&1 \
  || fail "dry-run with project-slice-file failed"

grep -q 'consumer.sh' "$PACK2/pack.md" || fail "filtered pack must mention consumer.sh"
if grep -q 'decoy.sh' "$PACK2/pack.md"; then
  # decoy may appear in DIFF/CHANGESET? No — only lib.sh changed. decoy only in SLICE.
  if grep -A20 '## PROJECT_SLICE' "$PACK2/pack.md" | grep -q 'decoy.sh'; then
    fail "PROJECT_SLICE should not list decoy.sh after filter"
  fi
fi
grep -q 'Filter: main-agent' "$PACK2/pack.md" || fail "pack should record Filter: main-agent"
grep -q 'impact_filter: main-agent' "$PACK2/pack.md" || fail "NOTES should record impact_filter"
pass=$((pass + 1))

# --- 3) array-shaped keep file works ----------------------------------------
ARR="$PACK_DIR/keep-array.json"
jq '[.[] | select(.file=="consumer.sh")]' "$PACK_DIR/impact_candidates.json" > "$ARR"
PACK3="$TMP/pack3"
mkdir -p "$PACK3"
"$RUN" "$BASE" --repo "$TMP" --head HEAD \
  --project-slice-file "$ARR" --keep-pack "$PACK3" \
  --dry-run --no-probe --writer human >/dev/null 2>&1 \
  || fail "array keep file dry-run failed"
grep -q 'Filter: main-agent' "$PACK3/pack.md" || fail "array form should default filter=main-agent"
pass=$((pass + 1))

# --- 4) invalid slice file fails --------------------------------------------
BAD="$PACK_DIR/bad.json"
echo '{"nope": true}' > "$BAD"
if "$RUN" "$BASE" --repo "$TMP" --head HEAD \
  --project-slice-file "$BAD" --dry-run --no-probe --writer human >/dev/null 2>&1; then
  fail "invalid slice file should fail"
fi
pass=$((pass + 1))

echo "PASS ($pass assertions) — pack-only + project-slice-file works"
