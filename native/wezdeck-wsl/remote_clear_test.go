package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClearAttentionValidates(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_ATTENTION_FILE", filepath.Join(dir, "attention.json"))
	os.WriteFile(filepath.Join(dir, "attention.json"), []byte(`{"entries":{}}`), 0o600)
	for _, id := range []string{"", "../x", "a b", strings.Repeat("a", 200)} {
		raw, _ := json.Marshal(map[string]string{"id": id})
		if _, err := clearAttention(raw); err == nil || !strings.Contains(err.Error(), "bad session id") {
			t.Fatalf("id %q: want bad session id, got %v", id, err)
		}
	}
	if _, err := clearAttention([]byte(`{"id":"not-listed"}`)); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("unlisted session: %v", err)
	}
}

// the page's seen-ack names the ts and status it saw: a newer state (a fresh
// question, the next turn) must stay
func TestClearAttentionSkipsChangedEntry(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "attention.json")
	t.Setenv("WEZDECK_ATTENTION_FILE", path)
	doc := `{"entries":{"s1":{"session_id":"s1","status":"waiting","ts":200,"tmux_socket":"/x","tmux_session":"a","tmux_pane":"%1"}}}`
	os.WriteFile(path, []byte(doc), 0o600)
	for _, args := range []string{
		`{"id":"s1","ts":100,"status":"done"}`, // saw an older done
		`{"id":"s1","ts":200,"status":"done"}`, // same ts, not done (now waiting)
		`{"id":"s1","ts":100}`,                 // ts only
	} {
		got, err := clearAttention([]byte(args))
		if err != nil {
			t.Fatalf("%s: %v", args, err)
		}
		if m := got.(map[string]any); m["skipped"] != "changed" {
			t.Fatalf("%s: want skipped, got %v", args, m)
		}
	}
	after, _ := os.ReadFile(path)
	if string(after) != doc {
		t.Fatalf("attention file changed: %s", after)
	}
}
