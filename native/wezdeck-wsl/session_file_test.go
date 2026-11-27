package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadSessionFileAllowedScopesAndSecurity(t *testing.T) {
	tmp := t.TempDir()
	home := filepath.Join(tmp, "home")
	repo := filepath.Join(tmp, "repo")
	outside := filepath.Join(tmp, "outside")
	sid := "08ed53cc-be57-4d47-ba24-8031a6d86803"
	brainDir := filepath.Join(home, ".gemini", "antigravity-cli", "brain", sid)
	otherBrain := filepath.Join(home, ".gemini", "antigravity-cli", "brain", "other-session-id")
	plansDir := filepath.Join(home, ".claude", "plans")

	for _, dir := range []string{repo, filepath.Join(repo, "docs"), outside, brainDir, otherBrain, plansDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	planPath := filepath.Join(brainDir, "ticket-plan.md")
	if err := os.WriteFile(planPath, []byte("# Plan\n\nline 2\nline 3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	docPath := filepath.Join(repo, "docs", "note.ts")
	if err := os.WriteFile(docPath, []byte("const a = 1\nconst key = 'sk-ant-1234567890abcdefghij12345'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	claudePlan := filepath.Join(plansDir, "my-plan.md")
	if err := os.WriteFile(claudePlan, []byte("# Claude Plan\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	claudeNonMd := filepath.Join(plansDir, "secret.json")
	if err := os.WriteFile(claudeNonMd, []byte(`{"x":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	otherArtifact := filepath.Join(otherBrain, "private.md")
	if err := os.WriteFile(otherArtifact, []byte("# Other\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	outsideFile := filepath.Join(outside, "passwd.txt")
	if err := os.WriteFile(outsideFile, []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	symlinkEscape := filepath.Join(repo, "escape.txt")
	if err := os.Symlink(outsideFile, symlinkEscape); err != nil {
		t.Fatal(err)
	}
	envFile := filepath.Join(repo, ".env")
	if err := os.WriteFile(envFile, []byte("TOKEN=abc\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	envExample := filepath.Join(repo, ".env.example")
	if err := os.WriteFile(envExample, []byte("TOKEN=placeholder\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	binFile := filepath.Join(repo, "blob.dat")
	if err := os.WriteFile(binFile, []byte{0x89, 'P', 'N', 'G', 0x00, 0x01}, 0o644); err != nil {
		t.Fatal(err)
	}

	// 1. Own Agy artifact via file:// URL + line range fragment
	res, err := readSessionFile(sid, "file://"+planPath+"#L2-L3", 0, 0, repo, repo, home)
	if err != nil {
		t.Fatalf("artifact read failed: %v", err)
	}
	if res.Kind != "markdown" || res.Lang != "markdown" || res.LineStart != 2 || res.LineEnd != 3 || res.Name != "ticket-plan.md" {
		t.Fatalf("unexpected artifact reply: %+v", res)
	}

	// 2. Relative repo code path + secret redaction
	res, err = readSessionFile(sid, "docs/note.ts", 1, 2, repo, repo, home)
	if err != nil {
		t.Fatalf("repo file failed: %v", err)
	}
	if res.Kind != "code" || res.Lang != "typescript" || res.RelPath != "docs/note.ts" || !res.Redacted {
		t.Fatalf("unexpected repo file reply: %+v", res)
	}
	if strings.Contains(res.Content, "sk-ant-") || !strings.Contains(res.Content, "«redacted»") {
		t.Fatalf("expected secret redaction, got %q", res.Content)
	}

	// 3. Claude plans .md allowed, non-.md refused
	if _, err := readSessionFile(sid, claudePlan, 0, 0, repo, repo, home); err != nil {
		t.Fatalf("claude plan should be allowed: %v", err)
	}
	if _, err := readSessionFile(sid, claudeNonMd, 0, 0, repo, repo, home); err == nil {
		t.Fatal("non-md in claude plans should be refused")
	}

	// 4. .env refused, .env.example allowed
	if _, err := readSessionFile(sid, envFile, 0, 0, repo, repo, home); err == nil {
		t.Fatal(".env should be refused")
	}
	if _, err := readSessionFile(sid, envExample, 0, 0, repo, repo, home); err != nil {
		t.Fatalf(".env.example should be allowed: %v", err)
	}

	// 5. Cross-session artifact, outside path, symlink escape, binary refused
	for label, p := range map[string]string{
		"other session artifact": otherArtifact,
		"outside file":           outsideFile,
		"symlink escape":         symlinkEscape,
		"binary file":            binFile,
	} {
		if _, err := readSessionFile(sid, p, 0, 0, repo, repo, home); err == nil {
			t.Fatalf("%s should have been refused", label)
		}
	}
}

func TestReadSessionFileTruncatesLargeFile(t *testing.T) {
	tmp := t.TempDir()
	bigPath := filepath.Join(tmp, "big.md")
	line := strings.Repeat("a", 100) + "\n"
	content := strings.Repeat(line, (sessionFileMaxBytes/len(line))+50)
	if err := os.WriteFile(bigPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := readSessionFile("sid-1", bigPath, 0, 0, tmp, tmp, tmp)
	if err != nil {
		t.Fatalf("big file read failed: %v", err)
	}
	if !res.Truncated || len(res.Content) > sessionFileMaxBytes {
		t.Fatalf("expected truncated file <= %d, got truncated=%v len=%d", sessionFileMaxBytes, res.Truncated, len(res.Content))
	}
}

func TestAgyArtifactMessageEmitted(t *testing.T) {
	tr := &transcript{format: "agy", tools: map[string]int{}}
	row := map[string]any{
		"type":       "PLANNER_RESPONSE",
		"created_at": "2026-11-27T16:43:08Z",
		"tool_calls": []map[string]any{
			{
				"name": "write_file",
				"args": map[string]any{
					"Path":    "/home/yuns/.gemini/antigravity-cli/brain/abc/design-plan.md",
					"Content": "# Design\n",
					"ArtifactMetadata": map[string]any{
						"UserFacing":      true,
						"RequestFeedback": true,
						"Summary":         "Full architecture proposal",
					},
				},
			},
		},
	}
	raw, _ := json.Marshal(row)
	tr.feedAgy(raw)
	if len(tr.messages) != 2 {
		t.Fatalf("expected tool + artifact message, got %d: %+v", len(tr.messages), tr.messages)
	}
	art := tr.messages[1]
	if art.Role != "system" || art.Kind != "artifact" || art.Text != "design-plan.md" || art.Body != "Full architecture proposal" || art.File != "/home/yuns/.gemini/antigravity-cli/brain/abc/design-plan.md" {
		t.Fatalf("unexpected artifact message: %+v", art)
	}
	// Trailing GENERIC result should still pair with index 0 (write_file), not the artifact card.
	gen, _ := json.Marshal(map[string]any{"type": "GENERIC", "content": "Created file."})
	tr.feedAgy(gen)
	if tr.messages[0].Pending || tr.messages[0].Result != "Created file." {
		t.Fatalf("expected GENERIC result on tool index 0, got %+v", tr.messages[0])
	}
}
