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
