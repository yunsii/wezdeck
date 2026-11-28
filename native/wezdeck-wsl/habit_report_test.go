package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHabitReportServesOnlySelectedFields(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_HABIT_SNAPSHOT_DIR", dir)
	data := `{
		"report": {
			"generated_at": "2026-11-28T01:00:00Z",
			"window": {"start": "2026-11-23", "end": "2026-11-28"},
			"work_focus": {"ok": true, "commits": 10, "web_related": 8, "areas": {"web": 8}},
			"agents": {"session": {"keywords": {"top": [{"term": "private phrase"}]}}}
		},
		"markdown": "Private weekly details"
	}`
	if err := os.WriteFile(filepath.Join(dir, "this.json"), []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}

	result, known, err := readRPC("habit.weekly", json.RawMessage(`{"period":"this"}`))
	if err != nil || !known {
		t.Fatalf("readRPC: known=%t err=%v", known, err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "private phrase") || strings.Contains(string(encoded), "Private weekly details") {
		t.Fatalf("read summary exposed raw report data: %s", encoded)
	}
	if !strings.Contains(string(encoded), `"web_related":8`) {
		t.Fatalf("work focus omitted: %s", encoded)
	}

	full, err := habitReport(json.RawMessage(`{"period":"this","include_markdown":true}`))
	if err != nil {
		t.Fatal(err)
	}
	fullJSON, _ := json.Marshal(full)
	if !strings.Contains(string(fullJSON), "Private weekly details") {
		t.Fatal("explicit full report omitted")
	}
}

func TestHabitReportRejectsUnknownPeriodAndHandlesMissingSnapshot(t *testing.T) {
	t.Setenv("WEZDECK_HABIT_SNAPSHOT_DIR", t.TempDir())
	if _, err := habitReport(json.RawMessage(`{"period":"../secrets"}`)); err == nil {
		t.Fatal("path traversal period accepted")
	}
	result, err := habitReport(json.RawMessage(`{"period":"last"}`))
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["available"] != true || result.(map[string]any)["present"] != false {
		t.Fatalf("missing snapshot: %v", result)
	}
	if !signedActions["habit.refresh"] {
		t.Fatal("refresh must require a device signature")
	}
}
