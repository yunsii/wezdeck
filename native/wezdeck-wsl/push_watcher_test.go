package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPushWatcher_AttentionEdgeAndDedupAndTicketEvents(t *testing.T) {
	tmp := t.TempDir()
	attPath := filepath.Join(tmp, "attention.json")
	ticketsRoot := filepath.Join(tmp, "tickets")
	t.Setenv("WEZDECK_ATTENTION_FILE", attPath)
	t.Setenv("TICKETS_ROOT", ticketsRoot)

	// Prepare ticket metadata for title lookup
	tid := "req-20261127-120001-push01"
	tDir := filepath.Join(ticketsRoot, "_data", tid)
	if err := os.MkdirAll(tDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tDir, "ticket.md"), []byte("---\ntitle: \"统一推送联调\"\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	eventsPath := filepath.Join(ticketsRoot, "events.jsonl")
	// Pre-existing historical event MUST NOT be replayed on startup
	if err := os.WriteFile(eventsPath, []byte(`{"kind":"proposal_created","ticket":"`+tid+`","count":2}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Initial attention state with one running session
	startMS := time.Now().Add(-90 * time.Second).UnixMilli()
	writeAttention := func(entries map[string]any) {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"entries": entries})
		if err := os.WriteFile(attPath, raw, 0o644); err != nil {
			t.Fatal(err)
		}
		// Ensure mtime advances even on fast filesystems
		future := time.Now().Add(time.Duration(len(raw)) * time.Millisecond)
		_ = os.Chtimes(attPath, future, future)
	}
	writeAttention(map[string]any{
		"s1": map[string]any{
			"session_id":   "s1",
			"status":       "running",
			"repo":         "wezdeck",
			"agent_name":   "claude",
			"title":        "修推送",
			"turn_started": startMS,
		},
	})

	var emitted []pushEmitFrame
	w := newPushWatcher(func(f pushEmitFrame) {
		emitted = append(emitted, f)
	})
	w.deskActiveFn = func() bool { return false }

	// Seed tick: zero notifications emitted
	w.pollAttention(attPath)
	w.pollTicketEvents(eventsPath)
	if len(emitted) != 0 {
		t.Fatalf("expected 0 pushes on seed tick, got %+v", emitted)
	}

	// Transition s1 -> waiting (permission_prompt) + s2 (ticket manager session) -> waiting
	writeAttention(map[string]any{
		"s1": map[string]any{
			"session_id":   "s1",
			"status":       "waiting",
			"waiting_kind": "permission_prompt",
			"repo":         "wezdeck",
			"title":        "修推送",
		},
		"s2": map[string]any{
			"session_id":   "s2",
			"status":       "waiting",
			"waiting_kind": "ask_user_question",
			"ticket_id":    tid,
			"title":        "统一推送联调",
		},
	})
	w.pollAttention(attPath)
	if len(emitted) != 2 {
		t.Fatalf("expected 2 waiting pushes, got %d: %+v", len(emitted), emitted)
	}
	var sawSession, sawTicket bool
	for _, f := range emitted {
		if f.Kind == "session_waiting" && f.Tag == "session:s1" && f.URL == "/console/sessions/s1" {
			sawSession = true
		}
		if f.Kind == "ticket_waiting" && f.Tag == "ticket:"+tid && f.URL == "/console/collab/"+tid {
			sawTicket = true
		}
	}
	if !sawSession || !sawTicket {
		t.Fatalf("expected both session_waiting and deduped ticket_waiting, got %+v", emitted)
	}

	// Transition s1 -> running then done after >= 60s
	emitted = nil
	writeAttention(map[string]any{
		"s1": map[string]any{
			"session_id":   "s1",
			"status":       "running",
			"repo":         "wezdeck",
			"agent_name":   "claude",
			"title":        "修推送",
			"turn_started": startMS,
		},
	})
	w.pollAttention(attPath)
	emitted = nil
	writeAttention(map[string]any{
		"s1": map[string]any{
			"session_id":   "s1",
			"status":       "done",
			"repo":         "wezdeck",
			"agent_name":   "claude",
			"title":        "修推送",
			"turn_started": startMS,
			"ts":           time.Now().UnixMilli(),
		},
	})
	w.pollAttention(attPath)
	if len(emitted) != 1 || emitted[0].Kind != "session_done" || emitted[0].TurnElapsedS < 60 {
		t.Fatalf("expected session_done push for long turn, got %+v", emitted)
	}

	// Append new ticket events (proposal_created + verify_done)
	emitted = nil
	f, err := os.OpenFile(eventsPath, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"kind":"proposal_created","ticket":"` + tid + `","count":3}` + "\n")
	_, _ = f.WriteString(`{"kind":"verify_done","ticket":"` + tid + `","to":"coco-forge","passed":true}` + "\n")
	_ = f.Close()

	w.pollTicketEvents(eventsPath)
	if len(emitted) != 2 {
		t.Fatalf("expected 2 ticket pushes, got %+v", emitted)
	}
	if emitted[0].Kind != "ticket_proposal" || !strings.Contains(emitted[0].Title, "统一推送联调") {
		t.Fatalf("unexpected proposal push: %+v", emitted[0])
	}
	if emitted[1].Kind != "ticket_verify" || emitted[1].URL != "/console/collab/"+tid {
		t.Fatalf("unexpected verify push: %+v", emitted[1])
	}
}
