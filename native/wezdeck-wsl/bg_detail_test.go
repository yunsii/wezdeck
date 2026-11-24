package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnrichBackground(t *testing.T) {
	root := t.TempDir()
	t.Setenv("WEZTERM_ATTENTION_CLAUDE_TASKS_ROOT", root)
	sid := "0f3c2b1a-1111-2222-3333-444455556666"
	dir := filepath.Join(root, "claude-1000", "proj", sid, "tasks")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	out := "first line cut\nbuilding…\n\x1b[32mok\x1b[0m step 1\n\nprogress 10%\rprogress 90%\nline 4\nline 5\n"
	if err := os.WriteFile(filepath.Join(dir, "b1x.output"), []byte(out), 0o644); err != nil {
		t.Fatal(err)
	}
	tr := &transcript{
		messages: []chatMessage{
			{Role: "user", Text: "go"},
			{Role: "tool", Tool: "Bash", Text: "Bash Run the web tests", Body: "pnpm test --run", TS: "2026-11-25T00:01:02Z", Background: true},
		},
		tasks: map[string]int{"b1x": 1},
	}
	got := enrichBackground([]bgTask{{ID: "b1x", Type: "shell", Summary: "task:b1x"}, {ID: "zz9", Summary: "task:zz9"}}, tr, sid)
	if len(got) != 2 {
		t.Fatalf("len %d", len(got))
	}
	a := got[0]
	if a.Tool != "Bash" || a.Label != "Run the web tests" || a.Command != "pnpm test --run" || a.Started == "" || a.At == nil || *a.At != 1 {
		t.Fatalf("call fields: %+v", a)
	}
	want := []string{"ok step 1", "progress 90%", "line 4", "line 5"}
	if len(a.Tail) != len(want) {
		t.Fatalf("tail %q", a.Tail)
	}
	for i := range want {
		if a.Tail[i] != want[i] {
			t.Fatalf("tail %q want %q", a.Tail, want)
		}
	}
	if b := got[1]; b.Tool != "" || b.At != nil || b.Tail != nil || b.Summary != "task:zz9" {
		t.Fatalf("unknown task keeps id only: %+v", b)
	}
	// unsafe ids never reach the filesystem
	if bgOutputTail(sid, "../x") != nil || bgOutputTail("not-a-uuid/..", "b1x") != nil {
		t.Fatal("unsafe ids must be refused")
	}
}
