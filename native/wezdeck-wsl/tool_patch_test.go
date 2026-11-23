package main

import (
	"strings"
	"testing"
)

func TestPatchBody(t *testing.T) {
	got := patchBody([]patchHunk{{OldStart: 3, OldLines: 2, NewStart: 3, NewLines: 3,
		Lines: []string{" keep", "-old", "+new", "+more"}}})
	want := "@@ -3,2 +3,3 @@\n keep\n-old\n+new\n+more"
	if got != want {
		t.Fatalf("got %q", got)
	}
	if patchBody(nil) != "" {
		t.Fatal("no hunks, no body")
	}
	long := patchHunk{OldStart: 1, NewStart: 1, Lines: make([]string, 300)}
	for i := range long.Lines {
		long.Lines[i] = "+x"
	}
	body := patchBody([]patchHunk{long})
	if lines := strings.Count(body, "\n") + 1; lines > patchMaxLines+2 || !strings.Contains(body, "… (+140 lines)") {
		t.Fatalf("clipped wrong: %d lines, tail %q", lines, body[len(body)-20:])
	}
}

// the transcript's tool result swaps the input-built body for the hunks
func TestClaudeEditBodyFromStructuredPatch(t *testing.T) {
	lines := []string{
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/r/a.ts","old_string":"a\nb","new_string":"a\nc"}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"toolUseResult":{"structuredPatch":[{"oldStart":7,"oldLines":2,"newStart":7,"newLines":2,"lines":[" a","-b","+c"]}]}}`,
	}
	tr := &transcript{tools: map[string]int{}}
	for _, l := range lines {
		tr.feedLine([]byte(l))
	}
	if len(tr.messages) != 1 || !strings.HasPrefix(tr.messages[0].Body, "@@ -7,2 +7,2 @@") {
		t.Fatalf("messages %+v", tr.messages)
	}
}
