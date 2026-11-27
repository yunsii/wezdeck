package main

import "testing"

func TestSessionWindow(t *testing.T) {
	msgs := make([]chatMessage, 100)
	msgs[90].Pending = true // a tool call still waiting for its result
	n := func(v int) *int { return &v }
	cases := []struct {
		name       string
		args       sessionArgs
		start, end int
		window     string
	}{
		{"first open", sessionArgs{}, 40, 100, "full"},
		{"old page asks a limit", sessionArgs{Limit: 120}, 0, 100, "full"},
		{"poll, nothing pending in reach", sessionArgs{Since: n(80)}, 80, 100, "since"},
		{"poll reaches back to the pending call", sessionArgs{Since: n(95)}, 90, 100, "since"},
		{"poll at the end", sessionArgs{Since: n(100)}, 90, 100, "since"},
		{"since past the end: transcript rewritten", sessionArgs{Since: n(130)}, 40, 100, "full"},
		{"earlier page", sessionArgs{Before: n(40), Limit: 60}, 0, 40, "before"},
		{"earlier page in the middle", sessionArgs{Before: n(70), Limit: 20}, 50, 70, "before"},
	}
	for _, c := range cases {
		s, e, w := sessionWindow(msgs, c.args)
		if s != c.start || e != c.end || w != c.window {
			t.Errorf("%s: got %d..%d %s, want %d..%d %s", c.name, s, e, w, c.start, c.end, c.window)
		}
	}
}

func TestSessionWindowResetsStaleCodexCursor(t *testing.T) {
	msgs := make([]chatMessage, 10)
	legacy, current, cursor := 0, codexMessagesRev, 7
	for _, args := range []sessionArgs{
		{Since: &cursor, MessagesRev: &legacy},
		{Before: &cursor, MessagesRev: &legacy},
	} {
		if start, end, span := sessionWindow(msgs, args.forMessagesRev(current)); start != 0 || end != 10 || span != "full" {
			t.Fatalf("got %d:%d %s, want 0:10 full", start, end, span)
		}
	}
	args := sessionArgs{Since: &cursor, MessagesRev: &current}
	if start, end, span := sessionWindow(msgs, args.forMessagesRev(current)); start != 7 || end != 10 || span != "since" {
		t.Fatalf("got %d:%d %s, want 7:10 since", start, end, span)
	}
}

func TestSessionWindowIncludesLatestUserMessage(t *testing.T) {
	// Long tool-heavy turn: latest user prompt is at 25, followed by 74 tool/assistant messages (> default limit 60).
	msgs := make([]chatMessage, 100)
	for i := range msgs {
		msgs[i].Role = "tool"
	}
	msgs[25].Role = "user"
	if start, end, span := sessionWindow(msgs, sessionArgs{}); start != 25 || end != 100 || span != "full" {
		t.Fatalf("expected full window extended to latest user at 25, got %d..%d %s", start, end, span)
	}

	// When a user message already sits inside the tail 60, keep the normal 40..100 window.
	msgs[80].Role = "user"
	if start, end, span := sessionWindow(msgs, sessionArgs{}); start != 40 || end != 100 || span != "full" {
		t.Fatalf("expected normal 40..100 when user already in window, got %d..%d %s", start, end, span)
	}

	// Safety bound: a user message farther back than sessionLatestUserMaxExtra does not pull unbounded history.
	huge := make([]chatMessage, 600)
	for i := range huge {
		huge[i].Role = "tool"
	}
	huge[5].Role = "user"
	if start, end, span := sessionWindow(huge, sessionArgs{}); start != 540 || end != 600 || span != "full" {
		t.Fatalf("expected bounded 540..600 when latest user exceeds max extra, got %d..%d %s", start, end, span)
	}
}
