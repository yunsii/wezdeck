package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSessionTokenRatePrefersOTelThenFallsBackToTranscript(t *testing.T) {
	dir := t.TempDir()
	statusPath := filepath.Join(dir, "status.json")
	t.Setenv("WEZDECK_TOKEN_RATE_STATUS", statusPath)

	// Reset cache between tests.
	otelStatusCacheMu.Lock()
	otelStatusCachePath = ""
	otelStatusCacheSnap = nil
	otelStatusCacheMu.Unlock()

	tr := &transcript{format: "agy", tools: map[string]int{}}
	tr.feedAgy([]byte(`{"type":"PLANNER_RESPONSE","created_at":"2026-11-26T12:00:00Z","model":"gemini-4-neon-high","output_tokens":400,"tool_calls":[{"name":"read_file","args":{}}]}`))
	tr.feedAgy([]byte(`{"type":"GENERIC","created_at":"2026-11-26T12:00:08Z","content":"ok"}`))

	// Without OTel status file -> transcript fallback (400 / 8s = 50.0 tok/s).
	got := sessionTokenRateFor("sess-agy", tr)
	if got == nil || got.Source != "transcript" || got.TokPerS != 50.0 || got.Samples != 1 {
		t.Fatalf("expected transcript fallback 50.0 tok/s, got %+v", got)
	}

	// Write OTel status snapshot -> OTel wins for matching session, transcript still serves others.
	statusJSON := `{
	  "schema_version": 1,
	  "heartbeat_at_ms": 1795696400000,
	  "recent_sessions": {
	    "sess-claude": {
	      "provider": "claude",
	      "profile": "claude-kimi",
	      "model": "k3.1-pro-highspeed",
	      "ts_ms": 1795696399000,
	      "last_tok_per_s": 88.6,
	      "ewma_tok_per_s": 92.4,
	      "last_decode_tok_per_s": 120.0,
	      "last_ttft_ms": 2637,
	      "samples": 4
	    }
	  }
	}`
	if err := os.WriteFile(statusPath, []byte(statusJSON), 0o644); err != nil {
		t.Fatalf("write status: %v", err)
	}
	otelStatusCacheMu.Lock()
	otelStatusCachePath = ""
	otelStatusCacheMu.Unlock()

	otelRate := sessionTokenRateFor("sess-claude", tr)
	if otelRate == nil || otelRate.Source != "otel" || otelRate.TokPerS != 92.4 || otelRate.DecodeTokPerS != 120.0 || otelRate.TTFTMS != 2637 {
		t.Fatalf("expected OTel rate, got %+v", otelRate)
	}
	fallbackRate := sessionTokenRateFor("sess-agy", tr)
	if fallbackRate == nil || fallbackRate.Source != "transcript" || fallbackRate.TokPerS != 50.0 {
		t.Fatalf("expected transcript fallback for non-OTel session, got %+v", fallbackRate)
	}
}
