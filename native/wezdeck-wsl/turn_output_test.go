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
}
