package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLastTurnAtIgnoresTouchedMtime(t *testing.T) {
	dir := t.TempDir()
	claude := filepath.Join(dir, "c.jsonl")
	_ = os.WriteFile(claude, []byte(strings.Join([]string{
		`{"type":"user","timestamp":"2026-11-21T06:59:50Z","message":{"content":"hi"}}`,
		`{"type":"assistant","timestamp":"2026-11-21T07:00:12.500Z","message":{"content":[]}}`,
		`{"type":"system","subtype":"turn_duration","timestamp":"2026-11-21T07:00:14Z"}`,
		`{"type":"last-prompt"}`,
	}, "\n")+"\n"), 0o600)
	// Claude Code touches the file later, same size
	now := time.Now()
	_ = os.Chtimes(claude, now, now)
	want := time.Date(2026, 11, 21, 7, 0, 12, 500e6, time.UTC).UnixMilli()
	if got := lastTurnAt(claude, "claude"); got != want {
		t.Fatalf("claude: got %d want %d (system lines and mtime don't count)", got, want)
	}

	codex := filepath.Join(dir, "x.jsonl")
	_ = os.WriteFile(codex, []byte(`{"timestamp":"2026-11-21T13:02:20Z","type":"response_item"}`+"\n"+`{"timestamp":"2026-11-21T13:03:03.730Z","type":"event_msg"}`+"\n"), 0o600)
	if got := lastTurnAt(codex, "codex"); got != time.Date(2026, 11, 21, 13, 3, 3, 730e6, time.UTC).UnixMilli() {
		t.Fatalf("codex: %d", got)
	}
	if lastTurnAt(codex, "grok") != 0 {
		t.Fatal("grok lines have no timestamp: 0, the caller keeps mtime")
	}

	// appending a turn changes the size: re-read
	f, _ := os.OpenFile(claude, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString(`{"type":"user","timestamp":"2026-11-22T12:00:00Z","message":{"content":"again"}}` + "\n")
	f.Close()
	if got := lastTurnAt(claude, "claude"); got != time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("after a new turn: %d", got)
	}
}

func TestLastTurnAtFindsStampBehindGiantLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "big.jsonl")
	blob := `{"type":"api-request-blob","message":"` + strings.Repeat("x", 3<<20) + `"}`
	_ = os.WriteFile(path, []byte(`{"type":"assistant","timestamp":"2026-11-20T01:02:03Z"}`+"\n"+blob+"\n"), 0o600)
	if got := lastTurnAt(path, "claude"); got != time.Date(2026, 11, 20, 1, 2, 3, 0, time.UTC).UnixMilli() {
		t.Fatalf("stamp behind a 3 MB line: %d", got)
	}
}

func TestSessionOrderAtUsesTurnBoundaries(t *testing.T) {
	if got := sessionOrderAt(attentionEntry{Status: "running", TS: 900, TurnStarted: 100}, 950); got != 100 {
		t.Fatalf("running output changed order time: %d", got)
	}
	if got := sessionOrderAt(attentionEntry{Status: "waiting", TS: 900, TurnStarted: 100}, 950); got != 100 {
		t.Fatalf("waiting changed order time: %d", got)
	}
	if got := sessionOrderAt(attentionEntry{Status: "done", TS: 200, TurnStarted: 100}, 950); got != 200 {
		t.Fatalf("completion should set order time: %d", got)
	}
	if got := sessionOrderAt(attentionEntry{Status: "idle"}, 150); got != 150 {
		t.Fatalf("idle fallback: %d", got)
	}
	if got := sessionOrderAt(attentionEntry{Status: "idle", TS: 900, archivedOrderAt: 200}, 950); got != 200 {
		t.Fatalf("opening a completed session changed order time: %d", got)
	}
}

func TestSessionOrderSource(t *testing.T) {
	cases := []struct {
		entry attentionEntry
		want  string
	}{
		{attentionEntry{Status: "idle"}, "window_activity"},
		{attentionEntry{Status: "running", TurnStarted: 100}, "turn_started"},
		{attentionEntry{Status: "done", TS: 200}, "completion"},
		{attentionEntry{archivedOrderAt: 300}, "archived_live"},
	}
	for _, tc := range cases {
		if got := sessionOrderSource(tc.entry, "window_activity"); got != tc.want {
			t.Errorf("status=%s: got %s want %s", tc.entry.Status, got, tc.want)
		}
	}
}

func TestSessionOrderChanged(t *testing.T) {
	old := sessionOrderObservation{100, "transcript_turn", 100, "transcript_turn"}
	if sessionOrderChanged(old, false, old) {
		t.Fatal("first ordinary poll should be quiet")
	}
	if !sessionOrderChanged(old, false, sessionOrderObservation{200, "window_activity", 200, "window_activity"}) {
		t.Fatal("first window activity fallback must be recorded")
	}
	if sessionOrderChanged(old, true, old) {
		t.Fatal("repeated poll should be quiet")
	}
	if !sessionOrderChanged(old, true, sessionOrderObservation{200, "window_activity", 200, "window_activity"}) {
		t.Fatal("changed time and source must be recorded")
	}
	if sessionOrderChanged(old, true, sessionOrderObservation{101, "transcript_turn", 100, "transcript_turn"}) {
		t.Fatal("transcript output should not flood ordering logs")
	}
	if !sessionOrderChanged(sessionOrderObservation{100, "window_activity", 100, "window_activity"}, true,
		sessionOrderObservation{101, "window_activity", 100, "window_activity"}) {
		t.Fatal("fallback display time changes must be recorded")
	}
}

func TestSessionFallbackTimeKeepsKnownAttentionTime(t *testing.T) {
	if got, source := sessionFallbackTime(100, 900); got != 100 || source != "attention" {
		t.Fatalf("idle session moved with its tmux window: %d from %s", got, source)
	}
	if got, source := sessionFallbackTime(0, 900); got != 900 || source != "window_activity" {
		t.Fatalf("missing attention time fallback: %d from %s", got, source)
	}
}
