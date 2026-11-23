package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSubagentsOfReadsMetaAndTranscript(t *testing.T) {
	dir := t.TempDir()
	parent := filepath.Join(dir, "sess.jsonl")
	sub := filepath.Join(dir, "sess", "subagents")
	_ = os.MkdirAll(sub, 0o755)
	_ = os.WriteFile(parent, []byte("{}\n"), 0o600)
	write := func(name, body string) { _ = os.WriteFile(filepath.Join(sub, name), []byte(body), 0o600) }
	write("agent-aaa.meta.json", `{"agentType":"general-purpose","description":"/code-review high","name":"code-review","requestShape":"background"}`)
	write("agent-aaa.jsonl", `{"type":"user","timestamp":"2026-11-23T01:00:00Z","message":{"content":"review"}}
{"type":"assistant","timestamp":"2026-11-23T01:00:05Z","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/x/relay.go"}}]}}
{"type":"assistant","timestamp":"2026-11-23T01:00:09Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"go test ./..."}}]}}
`)
	write("agent-bbb.meta.json", `{"agentType":"web-fetch","description":"Read docs","requestShape":"foreground","finished":true}`)
	write("agent-bbb.jsonl", `{"type":"user","timestamp":"2026-11-23T00:50:00Z","message":{"content":"x"}}`+"\n")
	// silent for an hour, never finished: still listed, as stale
	write("agent-ccc.meta.json", `{"agentType":"Explore","description":"hung"}`)
	hour := time.Now().Add(-time.Hour)
	_ = os.Chtimes(filepath.Join(sub, "agent-ccc.meta.json"), hour, hour)
	// stale past the keep window: gone
	write("agent-ddd.meta.json", `{"agentType":"Explore","description":"long gone"}`)
	old := time.Now().Add(-3 * time.Hour)
	_ = os.Chtimes(filepath.Join(sub, "agent-ddd.meta.json"), old, old)

	got := subagentsOf(parent)
	if len(got) != 2 {
		t.Fatalf("want running + stale only (finished ones leave), got %+v", got)
	}
	a := got[0]
	if a.ID != "aaa" || a.State != "running" || !a.Background || a.Tools != 2 || a.Name != "code-review" ||
		a.LastTool == "" || a.StartedAt != "2026-11-23T01:00:00Z" {
		t.Fatalf("running subagent wrong: %+v", a)
	}
	if got[1].ID != "ccc" || got[1].State != "stale" {
		t.Fatalf("stale subagent wrong: %+v", got[1])
	}
}
