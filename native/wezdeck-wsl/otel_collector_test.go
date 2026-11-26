package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Minimal protobuf wire builders for testing OTLP ExportLogsServiceRequest
// without pulling external protobuf libraries.
func pbTag(fieldNum uint64, wireType uint64) []byte {
	var buf [10]byte
	n := binary.PutUvarint(buf[:], (fieldNum<<3)|wireType)
	return buf[:n]
}

func pbLen(fieldNum uint64, payload []byte) []byte {
	var out []byte
	out = append(out, pbTag(fieldNum, 2)...)
	var buf [10]byte
	n := binary.PutUvarint(buf[:], uint64(len(payload)))
	out = append(out, buf[:n]...)
	out = append(out, payload...)
	return out
}

func pbVarint(fieldNum uint64, v uint64) []byte {
	var out []byte
	out = append(out, pbTag(fieldNum, 0)...)
	var buf [10]byte
	n := binary.PutUvarint(buf[:], v)
	out = append(out, buf[:n]...)
	return out
}

func pbFixed64(fieldNum uint64, v uint64) []byte {
	var out []byte
	out = append(out, pbTag(fieldNum, 1)...)
	var buf [8]byte
	binary.LittleEndian.PutUint64(buf[:], v)
	out = append(out, buf[:]...)
	return out
}

func pbKVString(k, v string) []byte {
	av := pbLen(1, []byte(v))
	return append(pbLen(1, []byte(k)), pbLen(2, av)...)
}

func pbKVInt(k string, v int64) []byte {
	av := pbVarint(3, uint64(v))
	return append(pbLen(1, []byte(k)), pbLen(2, av)...)
}

func pbKVDouble(k string, v float64) []byte {
	av := pbFixed64(4, math.Float64bits(v))
	return append(pbLen(1, []byte(k)), pbLen(2, av)...)
}

func TestOTelCollectorIngestsClaudeCodexJSONAndGrokProtobuf(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "agent-token-rate.jsonl")
	statusPath := filepath.Join(dir, "status.json")
	rawPath := filepath.Join(dir, "raw-schema.jsonl")

	c := newOTelCollector("127.0.0.1:43180", logPath, statusPath, rawPath)
	fixedNow := time.Date(2026, 11, 26, 12, 30, 0, 0, time.UTC)
	c.nowFunc = func() time.Time { return fixedNow }
	srv := httptest.NewServer(c.handler())
	defer srv.Close()

	// 1. Claude Code OTLP/HTTP JSON (`claude_code.api_request`)
	claudePayload := `{
	  "resourceLogs": [{
	    "resource": {"attributes": [
	      {"key": "service.name", "value": {"stringValue": "claude-code"}},
	      {"key": "wezdeck.provider", "value": {"stringValue": "claude"}},
	      {"key": "wezdeck.profile", "value": {"stringValue": "claude-kimi"}},
	      {"key": "wezdeck.pane", "value": {"stringValue": "%12"}}
	    ]},
	    "scopeLogs": [{
	      "scope": {"name": "com.anthropic.claude_code.events"},
	      "logRecords": [{
	        "timeUnixNano": "1795696200000000000",
	        "body": {"stringValue": "claude_code.api_request"},
	        "attributes": [
	          {"key": "event.name", "value": {"stringValue": "claude_code.api_request"}},
	          {"key": "model", "value": {"stringValue": "k3.1-pro"}},
	          {"key": "query_source", "value": {"stringValue": "main"}},
	          {"key": "session.id", "value": {"stringValue": "sess-claude-1"}},
	          {"key": "output_tokens", "value": {"intValue": "600"}},
	          {"key": "input_tokens", "value": {"intValue": "1200"}},
	          {"key": "cache_read_tokens", "value": {"intValue": "50000"}},
	          {"key": "duration_ms", "value": {"intValue": "8000"}},
	          {"key": "prompt", "value": {"stringValue": "TOP_SECRET_USER_PROMPT"}}
	        ]
	      }]
	    }]
	  }]
	}`
	resp, err := http.Post(srv.URL+"/v1/logs", "application/json", strings.NewReader(claudePayload))
	if err != nil {
		t.Fatalf("claude post: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("claude status %d", resp.StatusCode)
	}

	// 2. Codex 0.172 OTLP/HTTP JSON (multi-event stream: api_request + sse_event chunks + response.completed summary)
	codexPayload := `{
	  "resourceLogs": [{
	    "resource": {"attributes": [
	      {"key": "service.name", "value": {"stringValue": "codex_exec"}}
	    ]},
	    "scopeLogs": [{
	      "scope": {"name": "codex_otel"},
	      "logRecords": [
	        {
	          "timeUnixNano": "1795696200000000000",
	          "eventName": "event otel/src/events/session_telemetry.rs:839",
	          "attributes": [
	            {"key": "event.name", "value": {"stringValue": "codex.api_request"}},
	            {"key": "conversation.id", "value": {"stringValue": "sess-codex-1"}},
	            {"key": "http.response.status_code", "value": {"intValue": 200}},
	            {"key": "duration_ms", "value": {"stringValue": "1000"}}
	          ]
	        },
	        {
	          "timeUnixNano": "1795696202000000000",
	          "eventName": "event otel/src/events/session_telemetry.rs:1125",
	          "attributes": [
	            {"key": "event.name", "value": {"stringValue": "codex.sse_event"}},
	            {"key": "event.kind", "value": {"stringValue": "response.output_item.done"}},
	            {"key": "conversation.id", "value": {"stringValue": "sess-codex-1"}},
	            {"key": "duration_ms", "value": {"stringValue": "2500"}}
	          ]
	        },
	        {
	          "timeUnixNano": "1795696204000000000",
	          "eventName": "event otel/src/events/session_telemetry.rs:1125",
	          "attributes": [
	            {"key": "event.name", "value": {"stringValue": "codex.sse_event"}},
	            {"key": "event.kind", "value": {"stringValue": "response.completed"}},
	            {"key": "conversation.id", "value": {"stringValue": "sess-codex-1"}},
	            {"key": "duration_ms", "value": {"stringValue": "1500"}}
	          ]
	        },
	        {
	          "timeUnixNano": "1795696205000000000",
	          "eventName": "event otel/src/events/session_telemetry.rs:1189",
	          "attributes": [
	            {"key": "event.name", "value": {"stringValue": "codex.sse_event"}},
	            {"key": "event.kind", "value": {"stringValue": "response.completed"}},
	            {"key": "model", "value": {"stringValue": "gpt-6.2-sol"}},
	            {"key": "conversation.id", "value": {"stringValue": "sess-codex-1"}},
	            {"key": "output_token_count", "value": {"stringValue": "400"}},
	            {"key": "reasoning_token_count", "value": {"intValue": 120}},
	            {"key": "input_token_count", "value": {"stringValue": "10000"}},
	            {"key": "cached_token_count", "value": {"intValue": 8000}},
	            {"key": "ttft_ms", "value": {"intValue": 40}}
	          ]
	        }
	      ]
	    }]
	  }]
	}`
	resp, err = http.Post(srv.URL+"/v1/logs", "application/json", strings.NewReader(codexPayload))
	if err != nil {
		t.Fatalf("codex post: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("codex status %d", resp.StatusCode)
	}

	// 3. Grok Build OTLP/HTTP Protobuf + gzip
	var resBytes []byte
	resBytes = append(resBytes, pbLen(1, pbKVString("service.name", "grok-cli"))...)
	resBytes = append(resBytes, pbLen(1, pbKVString("wezdeck.profile", "grok"))...)

	var lrBytes []byte
	lrBytes = append(lrBytes, pbFixed64(1, 1795696210000000000)...)
	lrBytes = append(lrBytes, pbLen(12, []byte("grok_code.api_request"))...)
	lrBytes = append(lrBytes, pbLen(6, pbKVString("model", "grok-code-fast"))...)
	lrBytes = append(lrBytes, pbLen(6, pbKVString("session.id", "sess-grok-1"))...)
	lrBytes = append(lrBytes, pbLen(6, pbKVInt("output_tokens", 900))...)
	lrBytes = append(lrBytes, pbLen(6, pbKVInt("reasoning_tokens", 200))...)
	lrBytes = append(lrBytes, pbLen(6, pbKVDouble("duration_ms", 6000.0))...)
	lrBytes = append(lrBytes, pbLen(6, pbKVString("assistant_response", "TOP_SECRET_RESPONSE"))...)

	scopeBytes := pbLen(1, []byte("grok.otel"))
	slBytes := append(pbLen(1, scopeBytes), pbLen(2, lrBytes)...)
	rlBytes := append(pbLen(1, resBytes), pbLen(2, slBytes)...)
	protoReq := pbLen(1, rlBytes)

	var gzBuf bytes.Buffer
	gzw := gzip.NewWriter(&gzBuf)
	_, _ = gzw.Write(protoReq)
	_ = gzw.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/logs", &gzBuf)
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("Content-Encoding", "gzip")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("grok proto post: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("grok proto status %d", resp.StatusCode)
	}

	// Verify /v1/metrics acks cleanly.
	resp, err = http.Post(srv.URL+"/v1/metrics", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("metrics post: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("metrics status %d", resp.StatusCode)
	}

	// Force status write and verify JSONL samples.
	if err := c.writeStatus(); err != nil {
		t.Fatalf("writeStatus: %v", err)
	}
	rawJSONL, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read jsonl: %v", err)
	}
	if strings.Contains(string(rawJSONL), "TOP_SECRET") {
		t.Fatalf("jsonl leaked sensitive content: %s", string(rawJSONL))
	}
	lines := strings.Split(strings.TrimSpace(string(rawJSONL)), "\n")
	if len(lines) != 3 {
		t.Fatalf("got %d samples, want 3:\n%s", len(lines), string(rawJSONL))
	}

	var samples []tokenRateSample
	for _, l := range lines {
		var s tokenRateSample
		if err := json.Unmarshal([]byte(l), &s); err != nil {
			t.Fatalf("unmarshal sample: %v", err)
		}
		samples = append(samples, s)
	}

	// Claude: 600 / 8s = 75.0 tok/s
	if samples[0].Provider != "claude" || samples[0].Profile != "claude-kimi" || samples[0].TokPerS != 75.0 || samples[0].PaneID != "%12" {
		t.Fatalf("unexpected claude sample: %+v", samples[0])
	}
	// Codex: 400 / 5s = 80.0 tok/s; pure SSE 400 / 4s = 100.0 tok/s; total TTFT = 1000 + 40 = 1040ms
	if samples[1].Provider != "codex" || samples[1].TokPerS != 80.0 || samples[1].DecodeTokPerS != 100.0 || samples[1].TTFTMS != 1040 || samples[1].ReasoningTokens != 120 {
		t.Fatalf("unexpected codex sample: %+v", samples[1])
	}
	// Grok: 900 / 6s = 150.0 tok/s
	if samples[2].Provider != "grok" || samples[2].Model != "grok-code-fast" || samples[2].TokPerS != 150.0 || samples[2].ReasoningTokens != 200 {
		t.Fatalf("unexpected grok sample: %+v", samples[2])
	}

	// Raw schema capture must NEVER leak prompt/response strings.
	rawCapture, err := os.ReadFile(rawPath)
	if err != nil {
		t.Fatalf("read raw schema capture: %v", err)
	}
	if strings.Contains(string(rawCapture), "TOP_SECRET") {
		t.Fatalf("raw capture leaked secret content: %s", string(rawCapture))
	}
	if !strings.Contains(string(rawCapture), `"str(len=22)"`) {
		t.Fatalf("expected sanitized string placeholder in capture: %s", string(rawCapture))
	}

	// Status snapshot should hold all 3 sessions.
	statusBytes, err := os.ReadFile(statusPath)
	if err != nil {
		t.Fatalf("read status: %v", err)
	}
	var snap otelStatusSnapshot
	if err := json.Unmarshal(statusBytes, &snap); err != nil {
		t.Fatalf("unmarshal status: %v", err)
	}
	if snap.ReceivedRecords != 6 || snap.AcceptedSamples != 3 || len(snap.RecentSessions) != 3 {
		t.Fatalf("unexpected status snapshot: %+v", snap)
	}
	if snap.RecentSessions["sess-claude-1"].LastTokPerS != 75.0 {
		t.Fatalf("unexpected claude session rate: %+v", snap.RecentSessions["sess-claude-1"])
	}
}

func TestIsLoopbackListen(t *testing.T) {
	if !isLoopbackListen("127.0.0.1:43180") || !isLoopbackListen("localhost:43180") || !isLoopbackListen("[::1]:43180") {
		t.Fatal("expected loopback addresses to pass")
	}
	if isLoopbackListen("0.0.0.0:43180") || isLoopbackListen(":43180") || isLoopbackListen("192.168.1.5:43180") {
		t.Fatal("expected non-loopback addresses to fail")
	}
}
