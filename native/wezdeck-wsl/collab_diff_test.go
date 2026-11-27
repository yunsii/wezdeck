package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestCollabDiff_WorktreeAndSecretRedaction(t *testing.T) {
	ticketsRoot := t.TempDir()
	t.Setenv("TICKETS_ROOT", ticketsRoot)

	repoDir := t.TempDir()
	runGit(t, repoDir, "init")
	runGit(t, repoDir, "config", "user.email", "test@example.com")
	runGit(t, repoDir, "config", "user.name", "Test")

	if err := os.WriteFile(filepath.Join(repoDir, "app.ts"), []byte("export const a = 1\nexport const b = 2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repoDir, "add", "app.ts")
	runGit(t, repoDir, "commit", "-m", "initial")
	baseSHA := runGit(t, repoDir, "rev-parse", "HEAD")

	// Modify tracked file and add an untracked file containing a token to verify redaction.
	if err := os.WriteFile(filepath.Join(repoDir, "app.ts"), []byte("export const a = 1\nexport const b = 42\nexport const c = 3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, "extra.ts"), []byte("export const key = 'sk-1234567890abcdefghijklmnop'\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	tid := "req-20261127-110001-diff01"
	tDir := filepath.Join(ticketsRoot, "_data", tid)
	if err := os.MkdirAll(tDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tDir, "ticket.md"), []byte("to: demo-repo\n\n## Summary\nDemo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	metaJSON, _ := json.Marshal(map[string]any{
		"worktree": repoDir,
		"branch":   "ticket/demo",
		"base_sha": baseSHA,
	})
	if err := os.WriteFile(filepath.Join(tDir, "meta.json"), metaJSON, 0o644); err != nil {
		t.Fatal(err)
	}

	raw, err := collabDiff(json.RawMessage(`{"id":"` + tid + `"}`))
	if err != nil {
		t.Fatalf("collabDiff error: %v", err)
	}
	res := raw.(map[string]any)
	if res["total_files"].(int) != 2 {
		t.Fatalf("expected 2 diff files, got %v", res["total_files"])
	}
	repos := res["repos"].([]collabDiffRepo)
	if len(repos) != 1 || repos[0].Repo != "demo-repo" {
		t.Fatalf("unexpected repos: %+v", repos)
	}
	var foundApp, foundExtra bool
	for _, f := range repos[0].Files {
		switch f.Path {
		case "app.ts":
			foundApp = true
			if !strings.HasPrefix(f.Patch, "@@ ") || !strings.Contains(f.Patch, "+export const b = 42") {
				t.Fatalf("unexpected app.ts patch: %q", f.Patch)
			}
		case "extra.ts":
			foundExtra = true
			if strings.Contains(f.Patch, "sk-1234567890abcdefghijklmnop") {
				t.Fatalf("expected secret token to be redacted in diff patch: %q", f.Patch)
			}
		}
	}
	if !foundApp || !foundExtra {
		t.Fatalf("missing expected diff files: app=%t extra=%t", foundApp, foundExtra)
	}

	// Rejects invalid ticket ID
	if _, err := collabDiff(json.RawMessage(`{"id":"../bad"}`)); err == nil {
		t.Fatal("expected error for invalid ticket id")
	}
}
