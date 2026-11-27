package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func ticketFixture(t *testing.T) (root, alphaDir, ran string) {
	t.Helper()
	root = t.TempDir()
	alphaDir = t.TempDir()
	t.Setenv("TICKETS_ROOT", root)
	os.WriteFile(filepath.Join(root, "config.yml"), []byte(`# collab targets
version: 1
targets:
  alpha:
    path: `+alphaDir+`
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
	return root, alphaDir, ran
}

func TestTicketTargetsAndWorktreeResolve(t *testing.T) {
	_, alphaDir, _ := ticketFixture(t)
	targets := ticketTargets()
	if len(targets) != 2 || targets[0].Key != "alpha" || targets[1].Key != "beta" {
		t.Fatalf("targets (gamma is outside targets:): %+v", targets)
	}
	home, _ := os.UserHomeDir()
	if targets[1].Path != filepath.Join(home, "beta") {
		t.Fatalf("~ expanded, quotes dropped: %q", targets[1].Path)
	}
	// Subdir of alpha resolves to alpha.
	sub := filepath.Join(alphaDir, "sub", "dir")
	os.MkdirAll(sub, 0o755)
	if got := resolveTargetForDir(sub, targets); got != "alpha" {
		t.Fatalf("subdir resolve got %q, want alpha", got)
	}
	// Linked worktree pointing at alpha/.git/worktrees/feat resolves to alpha.
	wt := t.TempDir()
	os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: "+filepath.Join(alphaDir, ".git", "worktrees", "feat")+"\n"), 0o600)
	if got := resolveTargetForDir(wt, targets); got != "alpha" {
		t.Fatalf("worktree resolve got %q, want alpha", got)
	}
}

func TestCreateTicketValidates(t *testing.T) {
	ticketFixture(t)
	ok := map[string]any{"mode": "manual", "from": "alpha", "to": "beta", "title": "t", "observed": "o", "assumed": "a"}
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

func TestCreateTicketManualSingleRepoAndRun(t *testing.T) {
	root, _, ran := ticketFixture(t)
	// Single-repo (from == to) normalizes from to "web".
	raw, _ := json.Marshal(map[string]any{
		"mode":     "manual",
		"from":     "beta",
		"to":       "beta",
		"title":    "从手机提的单",
		"observed": "看到了 X",
		"assumed":  "应该是 Y",
		"run":      true,
	})
	res, err := createTicket(raw)
	if err != nil {
		t.Fatal(err)
	}
	out := res.(map[string]any)
	id, _ := out["id"].(string)
	if !ticketIDPattern.MatchString(id) || out["run"] != "started" {
		t.Fatalf("result: %+v", out)
	}
	ticketMd, err := os.ReadFile(filepath.Join(root, "_data", id, "ticket.md"))
	if err != nil {
		t.Fatalf("ticket.md missing: %v", err)
	}
	if !strings.Contains(string(ticketMd), "from: web") || !strings.Contains(string(ticketMd), "to: beta") {
		t.Fatalf("expected from: web & to: beta in ticket.md:\n%s", string(ticketMd))
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

func TestQuickTicketWithAttachmentEnrichAndUploadGet(t *testing.T) {
	root, _, _ := ticketFixture(t)
	upDir := t.TempDir()
	t.Setenv("WEZDECK_REMOTE_UPLOADS", upDir)
	imgName := "img-20261127-190000-abcdef12.png"
	pngBytes := []byte("\x89PNG\r\n\x1a\nfake-png-body")
	if err := os.WriteFile(filepath.Join(upDir, imgName), pngBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	origDraft := runTicketDraftFunc
	origHook := ticketEnrichDoneHook
	doneCh := make(chan bool, 1)
	runTicketDraftFunc = func(_ context.Context, _ string) (string, string, error) {
		return `{"title":"修复发送弹窗切换抖动","summary":"切换三个作用域时弹窗高度跳动。","observed":"见 [图片1]，切换会话/仓库/全部时列表高度归零。","assumed":"三个 tab 保持固定高度不抖动。","suggested_to":"beta"}`, "grok", nil
	}
	ticketEnrichDoneHook = func(_ string, ok bool) {
		doneCh <- ok
	}
	t.Cleanup(func() {
		runTicketDraftFunc = origDraft
		ticketEnrichDoneHook = origHook
	})

	// 1. Test synchronous ticket.draft first.
	draftRaw, _ := json.Marshal(map[string]any{
		"to":          "alpha",
		"text":        "看 [图片1] 切换 tab 会抖动",
		"attachments": []string{imgName},
	})
	draftRes, err := draftTicket(draftRaw)
	if err != nil {
		t.Fatalf("draftTicket failed: %v", err)
	}
	dm := draftRes.(map[string]any)
	if dm["title"] != "修复发送弹窗切换抖动" || dm["suggested_to"] != "beta" || dm["provider"] != "grok" {
		t.Fatalf("unexpected draft result: %+v", dm)
	}

	// 2. Test quick ticket creation (0-wait + async enrich + attachment copy).
	quickRaw, _ := json.Marshal(map[string]any{
		"mode":        "quick",
		"to":          "alpha",
		"text":        "看 [图片1] 切换 tab 会抖动",
		"attachments": []string{imgName},
	})
	created, err := createTicket(quickRaw)
	if err != nil {
		t.Fatalf("quick createTicket failed: %v", err)
	}
	cm := created.(map[string]any)
	id, _ := cm["id"].(string)
	if !ticketIDPattern.MatchString(id) || cm["enriching"] != true {
		t.Fatalf("unexpected quick create result: %+v", cm)
	}

	select {
	case ok := <-doneCh:
		if !ok {
			t.Fatal("background enrich failed")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("background enrich timed out")
	}

	// Verify ticket.md has enriched title AND preserved Original request + Attachments.
	mdBytes, err := os.ReadFile(filepath.Join(root, "_data", id, "ticket.md"))
	if err != nil {
		t.Fatal(err)
	}
	md := string(mdBytes)
	for _, want := range []string{"修复发送弹窗切换抖动", "## Original request", "看 [图片1] 切换 tab 会抖动", "## Attachments", imgName} {
		if !strings.Contains(md, want) {
			t.Fatalf("ticket.md missing %q:\n%s", want, md)
		}
	}

	// Verify ticket attachment copy survives even after remote-uploads file is removed.
	if err := os.Remove(filepath.Join(upDir, imgName)); err != nil {
		t.Fatal(err)
	}
	getRaw, _ := json.Marshal(map[string]any{"name": imgName, "ticket": id, "offset": 0})
	if _, err := uploadGet(getRaw); err != nil {
		t.Fatalf("uploadGet with ticket fallback failed after upload prune: %v", err)
	}
}
