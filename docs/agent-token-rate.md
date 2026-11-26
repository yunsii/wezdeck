# Agent Token Output Rate

Host-side measurement of LLM token output speed across managed agent CLIs,
designed around **Route B (loopback OTLP) primary + Route A (transcript step
windows) fallback**. No network proxy or TLS interception is required.

## Architecture

1. **Loopback OTLP collector (`wezdeck-wsl otel`)**
   - Code: [`native/wezdeck-wsl/otel_collector.go`](../native/wezdeck-wsl/otel_collector.go),
     [`native/wezdeck-wsl/otel_proto.go`](../native/wezdeck-wsl/otel_proto.go).
   - Listens strictly on loopback (default `127.0.0.1:43180`, overridable via
     `WEZDECK_OTEL_PORT` / `WEZDECK_OTEL_LISTEN`). Non-loopback bindings are
     refused.
   - Accepts both OTLP/HTTP JSON (`application/json`) and OTLP/HTTP Protobuf
     (`application/x-protobuf`, with optional `gzip`) on `/v1/logs`; acknowledges
     `/v1/metrics` and `/v1/traces` with HTTP 200 so multi-signal exporters do
     not spam retries.
   - Privacy: extracts only timing and token-count telemetry; prompt, response,
     and tool bodies are never persisted (even under `--capture-raw` schema
     calibration).
   - Storage (WSL ext4 via [`scripts/runtime/wsl-runtime-paths-lib.sh`](../scripts/runtime/wsl-runtime-paths-lib.sh)):
     - Rotated samples: `~/.local/state/wezterm-runtime/logs/agent-token-rate.jsonl` (10 MiB × 3 backups).
     - Rolling live snapshot: `~/.local/state/wezterm-runtime/state/agent-token-rate/status.json`
       (atomic tmp-rename, `heartbeat_at_ms`, per-session `last_tok_per_s`,
       `ewma_tok_per_s`, `last_decode_tok_per_s`, `last_ttft_ms`).
2. **Single-site fail-open injection**
   - [`scripts/runtime/agent-otel-lib.sh`](../scripts/runtime/agent-otel-lib.sh)
     sourced by [`scripts/runtime/agent-launcher.sh`](../scripts/runtime/agent-launcher.sh).
   - Injects OTel env/args only when `WEZDECK_OTEL_ENABLED != 0`, the caller has
     not already set `OTEL_EXPORTER_OTLP_*ENDPOINT`, and the local collector's
     `status.json` exists while `127.0.0.1:<port>` is `TCP_LISTEN` in
     `/proc/net/tcp` (<1 ms check; zero impact when stopped).
3. **Transcript fallback (Route A)**
   - [`native/wezdeck-wsl/turn_output.go`](../native/wezdeck-wsl/turn_output.go)
     computes per-LLM-step windows (excluding local tool execution time) from
     each agent's transcript so Agy and non-OTel sessions still report effective
     `tok/s`.
   - [`native/wezdeck-wsl/token_rate.go`](../native/wezdeck-wsl/token_rate.go)
     serves `token_rate` on the `session` RPC: OTel `status.json` first (1 s
     mtime/size cache), then `transcript.latestTranscriptRate()`.

## Provider Matrix (calibrated 2026-11-26)

| Agent | Primary | Wire / Event | Calibrated fields | Fallback (Route A) |
|---|---|---|---|---|
| **Claude** (`claude` / `sub2api` / `kimi`) | **B · OTLP JSON** | `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `http/json` → `/v1/logs`, `event.name="api_request"` | `output_tokens`, `duration_ms`, `ttft_ms`, `model`, `query_source`, `wezdeck.profile` → effective + pure decode `tok/s` | `user` → `assistant` step window |
| **Codex** (`0.172.0+`) | **B · OTLP JSON** | `-c otel.log_user_prompt=false -c otel.exporter={otlp-http={...}}` | Accumulates `codex.api_request.duration_ms` + per-chunk `codex.sse_event.duration_ms` per `conversation.id` until terminal `response.completed` (`output_token_count`, `reasoning_token_count`, `ttft_ms`) → effective + pure SSE decode `tok/s` + end-to-end TTFT | `user`/`function_call_output` → `token_count` step window |
| **Grok** (`1.0.92+`) | **B · OTLP Protobuf** | `GROK_EXTERNAL_OTEL=1`, `http/protobuf` → `/v1/logs`, `grok_code.api_request` | `output_tokens` (includes `reasoning_tokens`), `duration_ms`, `model` → effective `tok/s` | — |
| **Agy** (`1.5.18`) | **A · Transcript** | `transcript_full.jsonl` | `PLANNER_RESPONSE.created_at` (with `tool_calls > 0`) → Nth subsequent `GENERIC.created_at` (excludes human idle pauses and early parallel-tool starts) | — |

Short responses (`output_tokens < 20` or `duration_ms < 200`) are kept in the
JSONL with `"noisy": true` for calibration visibility and filtered out of live
EWMA and summary percentiles by default (`--all-samples` includes them).

## Operating

```bash
# Install / start user systemd service (`wezdeck-otel.service`) on primary checkout
scripts/dev/install-otel-collector.sh
scripts/dev/install-otel-collector.sh --check
scripts/dev/install-otel-collector.sh --status

# Diagnostic CLI report (Route B OTel + Route A Agy fallback)
scripts/dev/token-rate-report.sh                  # last 7 days, by profile & model
scripts/dev/token-rate-report.sh --today
scripts/dev/token-rate-report.sh --live           # collector health + recent sessions
scripts/dev/token-rate-report.sh --watch          # live per-request stream
scripts/dev/token-rate-report.sh --raw today
scripts/dev/token-rate-report.sh --transcript-all # include non-OTel Claude/Codex transcripts
scripts/dev/token-rate-report.sh --json

# Re-calibrate OTLP attribute schemas after an upstream agent CLI upgrade
scripts/dev/probe-agent-otel.sh --providers claude-kimi,codex,grok
```

## Web Console Surface

- **Working turn line** (`chat-turn.tsx`): appends smoothed effective rate
  (`运行中… 42s · ↓ 1.8k tokens · 88.6 tok/s`) when available.
- **Session info** (`session-info.tsx`, under Usage): shows `Output rate` with
  effective rate, pure decode rate, TTFT (when OTel provides it), and source
  (`otel` or `transcript`).

## Tests

- Go unit tests: `cd native/wezdeck-wsl && go test -run 'TestOTel|TestSessionTokenRate|TestTurnOutput|TestTranscriptStepRate'`
- Launcher OTel wiring: `bash tests/agent-launcher/test.sh`
- CLI report unit test: `bash tests/hook-units/test_token_rate_report.sh`
- Web unit tests: `cd web && corepack pnpm test:unit tests/chat-turn.unit.test.ts`
