package main

import "testing"

func TestTurnOutputCountsRepliesSinceTheTurn(t *testing.T) {
	lines := []string{
		`{"type":"user","timestamp":"2026-11-23T08:00:00.000Z","message":{"role":"user","content":"first"}}`,
		`{"type":"assistant","timestamp":"2026-11-23T08:00:05.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"a"}],"usage":{"output_tokens":100}}}`,
		`{"type":"user","timestamp":"2026-11-23T08:10:00.000Z","message":{"role":"user","content":"second"}}`,
		// one reply over two lines: counted once
		`{"type":"assistant","timestamp":"2026-11-23T08:10:03.000Z","message":{"id":"m2","role":"assistant","content":[{"type":"thinking","thinking":"x"}],"usage":{"output_tokens":3520}}}`,
		`{"type":"assistant","timestamp":"2026-11-23T08:10:03.500Z","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"b"}],"usage":{"output_tokens":3520}}}`,
		`{"type":"assistant","timestamp":"2026-11-23T08:10:09.000Z","message":{"id":"m3","role":"assistant","content":[{"type":"text","text":"c"}],"usage":{"output_tokens":208}}}`,
	}
	tr := &transcript{tools: map[string]int{}}
	for _, l := range lines {
		tr.feedLine([]byte(l))
	}
	turn := int64(1795421400000) // 2026-11-23T08:10:00Z
	if got := tr.turnOutput(turn); got != 3728 {
		t.Fatalf("turn output %d, want 3728", got)
	}
	if got := tr.turnOutput(0); got != 3828 {
		t.Fatalf("all output %d, want 3828", got)
	}
	last, ewma, n := tr.latestTranscriptRate()
	// m1: 100/5s = 20.0; m2: 3520/3s = 1173.3; m3 has no preceding user step.
	if n != 2 || last != 1173.3 || ewma <= 20.0 {
		t.Fatalf("claude step rate got last=%v ewma=%v n=%d", last, ewma, n)
	}
}

func TestTranscriptStepRateForCodexAndAgy(t *testing.T) {
	codexTr := &transcript{format: "codex", tools: map[string]int{}}
	for _, l := range []string{
		`{"type":"response_item","timestamp":"2026-11-26T12:00:00Z","payload":{"type":"message","role":"user","content":[{"text":"hi"}]}}`,
		`{"type":"event_msg","timestamp":"2026-11-26T12:00:04Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":200},"total_token_usage":{"input_tokens":100,"output_tokens":200}}}}`,
		`{"type":"response_item","timestamp":"2026-11-26T12:01:00Z","payload":{"type":"function_call_output","call_id":"c1","output":"ok"}}`,
		`{"type":"event_msg","timestamp":"2026-11-26T12:01:05Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"output_tokens":500},"total_token_usage":{"input_tokens":300,"output_tokens":700}}}}`,
	} {
		codexTr.feedCodex([]byte(l))
	}
	last, ewma, n := codexTr.latestTranscriptRate()
	// Step 1: 200/4s=50.0, Step 2: 500/5s=100.0 -> EWMA = 0.4*100 + 0.6*50 = 70.0
	if n != 2 || last != 100.0 || ewma != 70.0 {
		t.Fatalf("codex rate got last=%v ewma=%v n=%d, want 100/70/2", last, ewma, n)
	}

	agyTr := &transcript{format: "agy", tools: map[string]int{}}
	for _, l := range []string{
		`{"type":"USER_INPUT","created_at":"2026-11-26T12:04:56Z","content":"hi"}`,
		`{"type":"PLANNER_RESPONSE","created_at":"2026-11-26T12:04:57Z","model":"gemini-4-neon-high","output_tokens":400,"tool_calls":[{"name":"read_file","args":{}},{"name":"read_file","args":{}}]}`,
		`{"type":"GENERIC","created_at":"2026-11-26T12:05:00Z","content":"tool 1"}`,
		`{"type":"GENERIC","created_at":"2026-11-26T12:05:05Z","content":"tool 2"}`,
		// Final reply with no tool calls followed by long human pause must not distort rate.
		`{"type":"PLANNER_RESPONSE","created_at":"2026-11-26T12:05:06Z","model":"gemini-4-neon-high","output_tokens":300}`,
		`{"type":"USER_INPUT","created_at":"2026-11-26T12:10:06Z","content":"thanks"}`,
	} {
		agyTr.feedAgy([]byte(l))
	}
	alast, aewma, an := agyTr.latestTranscriptRate()
	// 400 / 8s (12:05:05 - 12:04:57) = 50.0 tok/s; final reply ignored.
	if an != 1 || alast != 50.0 || aewma != 50.0 {
		t.Fatalf("agy rate got last=%v ewma=%v n=%d, want 50/50/1", alast, aewma, an)
	}
}
