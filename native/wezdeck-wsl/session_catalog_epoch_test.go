package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSessionCatalogEpochIsStableWithinHostProcess(t *testing.T) {
	state := filepath.Join(t.TempDir(), "attention.json")
	if err := os.WriteFile(state, []byte(`{"entries":{},"recent":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_ATTENTION_FILE", state)
	first, err := listSessions()
	if err != nil {
		t.Fatal(err)
	}
	second, err := listSessions()
	if err != nil {
		t.Fatal(err)
	}
	a := first.(map[string]any)["host_epoch"]
	b := second.(map[string]any)["host_epoch"]
	if a == "" || a != b {
		t.Fatalf("host epoch must stay stable across polls: %v, %v", a, b)
	}
}
