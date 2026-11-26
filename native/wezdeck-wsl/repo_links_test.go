package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseVSCodeLinksNDJSONFiltersSchemesAndCollectsDiagnostics(t *testing.T) {
	raw := strings.Join([]string{
		`{"kind":"link","data":{"type":"detected","source":"detected:github","url":"https://github.com/yunsii/wezterm-config","title":"Repository","description":"Main source repo"}}`,
		`{"kind":"link","data":{"type":"local","source":"settings:links.resources","url":"http://localhost:3000","title":"Local Dev"}}`,
		`{"kind":"link","data":{"type":"local","source":"bad","url":"javascript:alert(1)","title":"XSS"}}`,
		`{"kind":"link","data":{"type":"local","source":"bad","url":"file:///etc/passwd","title":"Local File"}}`,
		`{"kind":"diagnostic","data":{"level":"warn","source":"csv:shared","message":"network offline"}}`,
		`not-json`,
	}, "\n")
	links, diags := parseVSCodeLinksNDJSON([]byte(raw))
	if len(links) != 2 {
		t.Fatalf("want 2 safe links, got %+v", links)
	}
	if links[0].URL != "https://github.com/yunsii/wezterm-config" || links[0].Title != "Repository" || links[0].Description != "Main source repo" || links[0].Type != "detected" {
		t.Fatalf("first link mismatch: %+v", links[0])
	}
	if links[1].URL != "http://localhost:3000" || links[1].Type != "local" {
		t.Fatalf("second link mismatch: %+v", links[1])
	}
	if len(diags) != 1 || diags[0] != "[warn] csv:shared: network offline" {
		t.Fatalf("want 1 diagnostic, got %+v", diags)
	}
}

func TestRepoLinksResolvesKnownRepoAndCachesUntilRefresh(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "demo-repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "init", repo).CombinedOutput(); err != nil {
		t.Fatalf("git init: %s", out)
	}
	ledger := filepath.Join(dir, "access-ledger.json")
	ledgerDoc, _ := json.Marshal(map[string]any{
		"worktrees": map[string]any{
			repo: map[string]any{"last_access_ms": int64(1000)},
		},
	})
	if err := os.WriteFile(ledger, ledgerDoc, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_ACCESS_LEDGER", ledger)
	t.Setenv("WEZDECK_ATTENTION_FILE", filepath.Join(dir, "missing-attention.json"))

	// Unlisted directory must be rejected.
	if _, err := repoLinks(json.RawMessage(`{"repo":"/tmp"}`)); err == nil {
		t.Fatal("unknown repo must be refused")
	}

	// Missing binary reports available=false with a diagnostic.
	t.Setenv("VSCODE_LINKS_BIN", "")
	res, err := repoLinks(json.RawMessage(`{"repo":"` + repo + `"}`))
	if err != nil {
		t.Fatalf("missing binary should degrade cleanly, got err: %v", err)
	}
	missing := res.(repoLinksReply)
	if missing.CLIAvailable || len(missing.Links) != 0 || len(missing.Diagnostics) == 0 {
		t.Fatalf("want unavailable reply with diagnostic, got %+v", missing)
	}

	// Fake vscode-links script records call count to verify caching + refresh.
	counterFile := filepath.Join(dir, "calls.txt")
	fakeBin := filepath.Join(dir, "fake-vscode-links")
	script := `#!/usr/bin/env bash
count=0
[[ -f "` + counterFile + `" ]] && count=$(cat "` + counterFile + `")
count=$((count + 1))
echo "$count" > "` + counterFile + `"
printf '{"kind":"link","data":{"type":"detected","source":"detected:github","url":"https://github.com/yunsii/demo","title":"Demo #%s"}}\n' "$count"
`
	if err := os.WriteFile(fakeBin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VSCODE_LINKS_BIN", fakeBin)

	res1, err := repoLinks(json.RawMessage(`{"repo":"` + repo + `"}`))
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	r1 := res1.(repoLinksReply)
	if !r1.CLIAvailable || len(r1.Links) != 1 || r1.Links[0].Title != "Demo #1" {
		t.Fatalf("unexpected first reply: %+v", r1)
	}

	// Second call hits cache.
	res2, err := repoLinks(json.RawMessage(`{"repo":"` + repo + `"}`))
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if res2.(repoLinksReply).Links[0].Title != "Demo #1" {
		t.Fatalf("expected cached Demo #1, got %+v", res2)
	}

	// Refresh bypasses cache.
	res3, err := repoLinks(json.RawMessage(`{"repo":"` + repo + `","refresh":true}`))
	if err != nil {
		t.Fatalf("refresh call: %v", err)
	}
	if res3.(repoLinksReply).Links[0].Title != "Demo #2" {
		t.Fatalf("expected refreshed Demo #2, got %+v", res3)
	}
}
