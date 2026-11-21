package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReplacedDetectsRewrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bin")
	if err := os.WriteFile(path, []byte("v1"), 0o755); err != nil {
		t.Fatal(err)
	}
	start, err := stampOf(path)
	if err != nil {
		t.Fatal(err)
	}
	if replaced(path, start, path) {
		t.Fatal("unchanged binary must not count as replaced")
	}
	later := time.Now().Add(2 * time.Second)
	if err := os.WriteFile(path, []byte("v2-longer"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(path, later, later)
	if !replaced(path, start, path) {
		t.Fatal("rewritten binary must count as replaced")
	}
	if !replaced(path, start, path+" (deleted)") {
		t.Fatal("deleted /proc/self/exe must count as replaced")
	}
	if replaced(filepath.Join(t.TempDir(), "missing"), start, "x") {
		t.Fatal("missing file is transient, not replaced")
	}
}
