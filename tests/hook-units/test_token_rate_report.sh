#!/usr/bin/env bash
# Offline unit test for scripts/dev/token-rate-report.sh (Route B OTel + Route A
# transcript fallback: Agy, Claude, Codex) and live `wezdeck-wsl otel` roundtrip.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP="$(mktemp -d /tmp/wezdeck-token-rate-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

TODAY="$(date -u '+%Y-%m-%d')"
LOG="$TMP/agent-token-rate.jsonl"
STATUS="$TMP/status.json"
AGY_DIR="$TMP/agy/conv-1/.system_generated/logs"
CLAUDE_DIR="$TMP/claude/proj-a"
CODEX_DIR="$TMP/codex/2026/11/26"
mkdir -p "$AGY_DIR" "$CLAUDE_DIR" "$CODEX_DIR"

NOW_MS="$(python3 -c 'import time; print(int(time.time()*1000))')"
cat >"$LOG" <<EOF
{"ts":"${TODAY}T10:00:00Z","ts_ms":$((NOW_MS - 30000)),"source":"otel","provider":"claude","profile":"claude-kimi","model":"k3.1-pro","session_id":"s-otel-1","output_tokens":600,"duration_ms":8000,"tok_per_s":75.0}
{"ts":"${TODAY}T10:01:00Z","ts_ms":$((NOW_MS - 20000)),"source":"otel","provider":"claude","profile":"claude-kimi","model":"k3.1-pro","session_id":"s-otel-1","output_tokens":900,"duration_ms":9000,"tok_per_s":100.0}
{"ts":"${TODAY}T10:01:30Z","ts_ms":$((NOW_MS - 15000)),"source":"otel","provider":"claude","profile":"claude-kimi","model":"k3.1-pro","session_id":"s-otel-1","output_tokens":5,"duration_ms":100,"tok_per_s":50.0,"noisy":true}
{"ts":"${TODAY}T10:02:00Z","ts_ms":$((NOW_MS - 10000)),"source":"otel","provider":"codex","profile":"codex","model":"gpt-5.4","session_id":"s-codex-otel","output_tokens":400,"duration_ms":5000,"ttft_ms":1000,"tok_per_s":80.0,"decode_tok_per_s":100.0}
EOF

cat >"$STATUS" <<EOF
{
  "schema_version": 1,
  "heartbeat_at_ms": ${NOW_MS},
  "started_at_ms": $((NOW_MS - 60000)),
  "pid": 12345,
  "listen": "127.0.0.1:43180",
  "received_records": 4,
  "accepted_samples": 4,
  "recent_sessions": {
    "s-otel-1": {
      "provider": "claude",
      "profile": "claude-kimi",
      "model": "k3.1-pro",
      "ts_ms": $((NOW_MS - 20000)),
      "last_tok_per_s": 100.0,
      "ewma_tok_per_s": 85.0,
      "last_output_tokens": 900,
      "last_duration_ms": 9000,
      "samples": 2
    }
  }
}
EOF

# Route A Agy transcript fixture (multi-tool step + final reply followed by idle pause)
cat >"$AGY_DIR/transcript_full.jsonl" <<EOF
{"type":"USER_INPUT","created_at":"${TODAY}T10:05:00Z","content":"hello"}
{"type":"PLANNER_RESPONSE","created_at":"${TODAY}T10:05:01Z","model":"gemini-4-neon-high","output_tokens":400,"tool_calls":[{"name":"read_file","args":{}},{"name":"read_file","args":{}}]}
{"type":"GENERIC","created_at":"${TODAY}T10:05:03Z","content":"tool 1"}
{"type":"GENERIC","created_at":"${TODAY}T10:05:06Z","content":"tool 2"}
{"type":"PLANNER_RESPONSE","created_at":"${TODAY}T10:05:07Z","model":"gemini-4-neon-high","output_tokens":300}
{"type":"USER_INPUT","created_at":"${TODAY}T10:15:07Z","content":"next"}
EOF

# Route A Claude transcript: one session already covered by OTel (must not double-count),
# one uncovered session (counted only when --transcript-all).
cat >"$CLAUDE_DIR/s-otel-1.jsonl" <<EOF
{"type":"user","timestamp":"${TODAY}T10:00:00Z","message":{"role":"user","content":"hi"}}
{"type":"assistant","timestamp":"${TODAY}T10:00:08Z","message":{"id":"m1","model":"k3.1-pro","content":"ok","usage":{"output_tokens":600}}}
EOF
cat >"$CLAUDE_DIR/s-fallback-only.jsonl" <<EOF
{"type":"user","timestamp":"${TODAY}T10:06:00Z","message":{"role":"user","content":"hi"}}
{"type":"assistant","timestamp":"${TODAY}T10:06:10Z","message":{"id":"m2","model":"claude-opus-4-6","content":"ok","usage":{"output_tokens":500}}}
EOF

# Route A Codex transcript fixture
cat >"$CODEX_DIR/rollout-2026-11-26T10-07-00-s-codex-fb.jsonl" <<EOF
{"type":"session_meta","timestamp":"${TODAY}T10:07:00Z","payload":{"session_id":"s-codex-fb"}}
{"type":"turn_context","timestamp":"${TODAY}T10:07:00Z","payload":{"model":"gpt-5.4"}}
{"type":"response_item","timestamp":"${TODAY}T10:07:01Z","payload":{"type":"message","role":"user","content":[{"text":"hi"}]}}
{"type":"event_msg","timestamp":"${TODAY}T10:07:05Z","payload":{"type":"token_count","info":{"last_token_usage":{"output_tokens":240,"reasoning_output_tokens":60}}}}
EOF

OUT_JSON="$("$REPO_ROOT/scripts/dev/token-rate-report.sh" \
  --days 2 --log "$LOG" --status "$STATUS" \
  --agy-root "$TMP/agy" --claude-root "$TMP/claude" --codex-root "$TMP/codex" \
  --transcript-all --json)"

python3 - "$OUT_JSON" <<'PY'
import json, sys

doc = json.loads(sys.argv[1])
assert doc["meta"]["filtered_noise"] == 1, doc
by_key = {(r["profile"], r["model"], r["source"]): r for r in doc["summary"]}

# OTel Claude (2 non-noisy samples: 75.0, 100.0)
c = by_key[("claude-kimi", "k3.1-pro", "otel")]
assert c["n"] == 2 and c["output_tokens"] == 1500 and c["mean_tok_s"] == 87.5, c

# OTel Codex (1 sample: 80.0 tok/s, 1000ms ttft)
cx = by_key[("codex", "gpt-5.4", "otel")]
assert cx["n"] == 1 and cx["p50_tok_s"] == 80.0 and cx["p50_ttft_ms"] == 1000, cx

# Agy transcript fallback (400 / 5s = 80.0 tok/s)
ag = by_key[("agy", "gemini-4-neon-high", "transcript")]
assert ag["n"] == 1 and ag["p50_tok_s"] == 80.0, ag

# Claude transcript fallback only counted uncovered session (500 / 10s = 50.0)
cf = by_key[("claude", "claude-opus-4-6", "transcript")]
assert cf["n"] == 1 and cf["p50_tok_s"] == 50.0, cf
assert ("claude", "k3.1-pro", "transcript") not in by_key, by_key

# Codex transcript fallback (240 / 4s = 60.0)
cxf = by_key[("codex", "gpt-5.4", "transcript")]
assert cxf["n"] == 1 and cxf["p50_tok_s"] == 60.0, cxf
PY
printf 'PASS token-rate-report merges OTel + transcript fallbacks without double-counting\n'

LIVE_OUT="$("$REPO_ROOT/scripts/dev/token-rate-report.sh" --live --status "$STATUS")"
grep -Fq 'collector=running' <<<"$LIVE_OUT"
grep -Fq 'claude-kimi' <<<"$LIVE_OUT"
printf 'PASS token-rate-report --live renders fresh collector status\n'
