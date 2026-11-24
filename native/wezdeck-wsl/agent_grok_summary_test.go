package main

import (
	"os"
	"path/filepath"
	"testing"
)

// an empty Grok session (no reply yet): model and effort come from
// summary.json, into the session meta the web console's empty state reads
func TestGrokSummaryModelForAnEmptySession(t *testing.T) {
	dir := t.TempDir()
	history := filepath.Join(dir, "chat_history.jsonl")
	if err := os.WriteFile(history, []byte(`{"type":"system","content":"x"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "summary.json"),
		[]byte(`{"current_model_id":"grok-4.5","reasoning_effort":"xhigh"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	model, effort := grokSummaryModel(history)
	if model != "grok-4.5" || effort != "xhigh" {
		t.Fatalf("model=%q effort=%q", model, effort)
	}
	tr, err := loadTranscript(history, "grok")
	if err != nil {
		t.Fatal(err)
	}
	rows := map[string]string{}
	for _, g := range sessionMeta(attentionEntry{SessionID: "s1"}, history, "grok", tr) {
		if g.Name == "session" {
			for _, r := range g.Rows {
				rows[r.Key] = r.Value
			}
		}
	}
	if rows["model"] != "grok-4.5" || rows["effort"] != "xhigh" {
		t.Fatalf("session meta = %v", rows)
	}
	if m, _ := grokSummaryModel(""); m != "" {
		t.Fatal("no path, no model")
	}
}
