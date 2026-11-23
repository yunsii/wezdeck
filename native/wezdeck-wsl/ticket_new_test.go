package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func ticketFixture(t *testing.T) (root, ran string) {
	t.Helper()
	root = t.TempDir()
	t.Setenv("TICKETS_ROOT", root)
	os.WriteFile(filepath.Join(root, "config.yml"), []byte(`# collab targets
version: 1
targets:
  alpha:
    path: `+t.TempDir()+`
    aliases: [a]
  beta:
    path: "~/beta"
other:
  gamma:
    path: /nope
`), 0o600)
	ran = filepath.Join(t.TempDir(), "ran")
	fake := filepath.Join(t.TempDir(), "fake-run")
	os.WriteFile(fake, []byte("#!/usr/bin/env bash\necho \"$1\" >"+ran+"\n"), 0o755)
	t.Setenv("WEZDECK_TICKET_RUN_CMD", fake)
	return root, ran
}

func TestTicketTargets(t *testing.T) {
	ticketFixture(t)
	targets := ticketTargets()
	if len(targets) != 2 || targets[0].Key != "alpha" || targets[1].Key != "beta" {
		t.Fatalf("targets (gamma is outside targets:): %+v", targets)
	}
	home, _ := os.UserHomeDir()
	if targets[1].Path != filepath.Join(home, "beta") {
		t.Fatalf("~ expanded, quotes dropped: %q", targets[1].Path)
	}
}

func TestCreateTicketValidates(t *testing.T) {
	ticketFixture(t)
	ok := map[string]any{"from": "alpha", "to": "beta", "title": "t", "observed": "o", "assumed": "a"}
	with := func(k string, v any) json.RawMessage {
		m := map[string]any{}
		for kk, vv := range ok {
			m[kk] = vv
		}
		m[k] = v
		raw, _ := json.Marshal(m)
		return raw
	}
	for name, raw := range map[string]json.RawMessage{
		"unknown target": with("to", "gamma"),
		"same repo":      with("to", "alpha"),
		"empty title":    with("title", " "),
		"two lines":      with("title", "a\nb"),
		"long title":     with("title", strings.Repeat("x", 121)),
		"no observed":    with("observed", ""),
		"no assumed":     with("assumed", ""),
		"option-like":    with("from", "--help"),
	} {
		if _, err := createTicket(raw); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestCreateTicketAndRun(t *testing.T) {
	root, ran := ticketFixture(t)
	raw, _ := json.Marshal(map[string]any{"from": "alpha", "to": "beta", "title": "从手机提的单",
		"observed": "看到了 X", "assumed": "应该是 Y", "run": true})
	res, err := createTicket(raw)
	if err != nil {
		t.Fatal(err)
	}
	out := res.(map[string]any)
	id, _ := out["id"].(string)
	if !ticketIDPattern.MatchString(id) || out["run"] != "started" {
		t.Fatalf("result: %+v", out)
	}
	matches, _ := filepath.Glob(filepath.Join(root, "*", id+"*"))
	data, _ := filepath.Glob(filepath.Join(root, "_data", id, "*"))
	if len(matches)+len(data) == 0 {
		t.Fatalf("ticket %s not in the store %s", id, root)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if b, _ := os.ReadFile(ran); strings.TrimSpace(string(b)) == id {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the run was not started for the new ticket")
}
