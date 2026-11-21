package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCollabArgsAllowlist(t *testing.T) {
	args, err := collabArgs("events", json.RawMessage(`{"after":12,"ticket":"req-20261121-070403-4f7c15","limit":"50","ignored":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"events", "--after", "12", "--ticket", "req-20261121-070403-4f7c15", "--limit", "50"}
	if len(args) != len(want) {
		t.Fatalf("args=%v want %v", args, want)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("args=%v want %v", args, want)
		}
	}
	if _, err := collabArgs("close", nil); err == nil {
		t.Fatal("write verb must be rejected")
	}
	if _, err := collabArgs("show", json.RawMessage(`{"id":"../../etc"}`)); err == nil {
		t.Fatal("path-like value must be rejected")
	}
	if _, err := collabArgs("show", json.RawMessage(`{"id":"a b"}`)); err == nil {
		t.Fatal("whitespace value must be rejected")
	}
}

func TestRunCollabHealth(t *testing.T) {
	repo, _ := filepath.Abs("../..")
	t.Setenv("WEZDECK_REPO", repo)
	t.Setenv("TICKETS_ROOT", t.TempDir())
	if _, err := os.Stat(filepath.Join(repo, "skills", "agent-collab", "lib", "api.py")); err != nil {
		t.Skip("api.py not present")
	}
	out, err := runCollab("health", nil)
	if err != nil {
		t.Fatal(err)
	}
	m, _ := out.(map[string]any)
	if m["ok"] != true || m["command"] != "health" {
		t.Fatalf("unexpected envelope: %v", out)
	}
	bad, err := runCollab("show", json.RawMessage(`{"id":"req-nope"}`))
	if err != nil {
		t.Fatal(err)
	}
	if bm, _ := bad.(map[string]any); bm["ok"] != false {
		t.Fatalf("not_found must pass through as ok:false, got %v", bad)
	}
}
