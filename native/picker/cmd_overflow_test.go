package main

import (
	"io"
	"os"
	"strings"
	"testing"
)

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()

	oldStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	os.Stdout = w
	t.Cleanup(func() {
		os.Stdout = oldStdout
		_ = r.Close()
	})

	fn()

	_ = w.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read captured stdout: %v", err)
	}
	return string(out)
}

func TestRenderOverflowFrameHighlightsSelectedRow(t *testing.T) {
	rows := []overflowRow{
		{
			workspace: "config",
			label:     "first-session",
			cwd:       "/tmp/first",
			state:     "visible",
			isCurrent: true,
		},
		{
			workspace: "work",
			label:     "selected-session",
			cwd:       "/tmp/selected",
			state:     "cold",
		},
	}

	out := captureStdout(t, func() {
		renderOverflowFrame(rows, 1, perfTimings{}, "", "all", 8)
	})

	selectedBg := "\x1b[48;5;255m"
	if !strings.Contains(out, "\x1b[5;1H"+selectedBg+"▶ ") {
		t.Fatalf("selected row does not start with background highlight: %q", out)
	}
	if !strings.Contains(out, "\x1b[1mselected-session\x1b[22;23;24;27;39m") {
		t.Fatalf("selected session label is not bold with local SGR restore: %q", out)
	}
	selectedLineStart := strings.Index(out, "\x1b[5;1H"+selectedBg)
	if selectedLineStart < 0 {
		t.Fatalf("selected row not found: %q", out)
	}
	selectedLineTail := out[selectedLineStart:]
	selectedLineEnd := strings.Index(selectedLineTail, "\x1b[K")
	if selectedLineEnd < 0 {
		t.Fatalf("selected row clear-to-EOL not found: %q", out)
	}
	selectedLine := selectedLineTail[:selectedLineEnd]
	if strings.Contains(selectedLine, "\x1b[0m") {
		t.Fatalf("selected row reset before clear-to-EOL would break continuous background: %q", selectedLine)
	}
	if strings.Contains(out, "\x1b[1mfirst-session") {
		t.Fatalf("unselected session label unexpectedly rendered bold: %q", out)
	}
}
