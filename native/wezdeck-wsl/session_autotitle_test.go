package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestIsSubstantivePrompt(t *testing.T) {
	trivial := []string{"", " ", "可以", "继续", "修复", "上线", "ok", "OK!", "yes", "好。", "<task-notification>x</task-notification>", "/rename foo", "abc"}
	for _, s := range trivial {
		if isSubstantivePrompt(s) {
			t.Errorf("expected trivial/non-substantive for %q", s)
		}
	}
	real := []string{
		"现在会话列表标题不能及时反映在做什么，能否加后台自动更新",
		"fix the avatar icon clipping on dark theme",
		"排查 relay 鉴权逻辑",
	}
	for _, s := range real {
		if !isSubstantivePrompt(s) {
			t.Errorf("expected substantive for %q", s)
		}
	}
}

func TestParseAutoTitleOutput(t *testing.T) {
	cases := []struct {
		raw       string
		want      string
		unchanged bool
		valid     bool
	}{
		{"消除会话交互卡等待态抖动", "消除会话交互卡等待态抖动", false, true},
		{"标题：「修复深色模式确认按钮图标」。\n多余解释", "修复深色模式确认按钮图标", false, true},
		{"```\nTitle: \"Harden runtime HTTP access\"\n```", "Harden runtime HTTP access", false, true},
		{"UNCHANGED", "", true, true},
		{"unchanged (still same task)", "", true, true},
		{"__PROVIDER_UNAVAILABLE__", "", false, false},
		{"Error: timeout", "", false, false},
		{"我先根据会话规则写一条简洁标题，并写入计划文件供确认", "", false, false},
		{"", "", false, false},
		{"a", "", false, false},
	}
	for _, tc := range cases {
		got, unch, ok := parseAutoTitleOutput(tc.raw)
		if got != tc.want || unch != tc.unchanged || ok != tc.valid {
			t.Errorf("parseAutoTitleOutput(%q) = (%q, %v, %v), want (%q, %v, %v)",
				tc.raw, got, unch, ok, tc.want, tc.unchanged, tc.valid)
		}
	}
}

func TestShouldAutoTitleDebounceAndTriggers(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	baseCtx := autoTitleContext{promptText: "p", substantiveUsers: 1, digest: "d1"}
	running := attentionEntry{SessionID: "s1", Status: "running"}
	done := attentionEntry{SessionID: "s1", Status: "done"}

	// First turn fires even while running so new sessions get titled quickly.
	if trig, ok := shouldAutoTitle(running, autoTitleEntry{}, false, baseCtx, now); !ok || trig != "first_turn" {
		t.Fatalf("first turn = (%q, %v), want (first_turn, true)", trig, ok)
	}

	prev := autoTitleEntry{
		Title:      "修复图标裁剪",
		UpdatedAt:  now.Add(-30 * time.Second).UnixMilli(),
		UserTurns:  1,
		LastDigest: "d1",
	}
	// Identical digest never re-runs.
	if _, ok := shouldAutoTitle(done, prev, true, baseCtx, now); ok {
		t.Fatal("same digest must not re-run")
	}

	// Cooldown blocks re-run within 90s even with new turns.
	ctx3 := autoTitleContext{promptText: "p3", substantiveUsers: 3, digest: "d3"}
	if _, ok := shouldAutoTitle(done, prev, true, ctx3, now); ok {
		t.Fatal("cooldown must block re-run")
	}

	// After cooldown: running session waits for turn completion; done triggers topic_shift.
	prev.UpdatedAt = now.Add(-2 * time.Minute).UnixMilli()
	if _, ok := shouldAutoTitle(running, prev, true, ctx3, now); ok {
		t.Fatal("running session with existing title must wait for settle")
	}
	if trig, ok := shouldAutoTitle(done, prev, true, ctx3, now); !ok || trig != "topic_shift" {
		t.Fatalf("2+ new turns after cooldown = (%q, %v), want (topic_shift, true)", trig, ok)
	}

	// 1 new turn triggers only after TopicShiftAge (4m).
	ctx2 := autoTitleContext{promptText: "p2", substantiveUsers: 2, digest: "d2"}
	if _, ok := shouldAutoTitle(done, prev, true, ctx2, now); ok {
		t.Fatal("1 new turn before 4m must not re-run")
	}
	prev.UpdatedAt = now.Add(-5 * time.Minute).UnixMilli()
	if trig, ok := shouldAutoTitle(done, prev, true, ctx2, now); !ok || trig != "topic_shift" {
		t.Fatalf("1 new turn after 5m = (%q, %v), want (topic_shift, true)", trig, ok)
	}

	// Locked manual /rename never re-runs.
	prev.Locked = true
	if _, ok := shouldAutoTitle(done, prev, true, ctx3, now); ok {
		t.Fatal("locked entry must never auto-title")
	}
}

func TestAutoTitlePrecedenceAndStore(t *testing.T) {
	dir := t.TempDir()
	storeFile := filepath.Join(dir, "session-titles.json")
	t.Setenv("WEZDECK_SESSION_TITLES_FILE", storeFile)

	// Claude transcript with ai-title (not manual) vs custom-title (manual).
	claudeAI := filepath.Join(dir, "claude-ai.jsonl")
	_ = os.WriteFile(claudeAI, []byte(`{"type":"ai-title","aiTitle":"旧 AI 标题"}`+"\n"), 0o600)

	claudeManual := filepath.Join(dir, "claude-manual.jsonl")
	_ = os.WriteFile(claudeManual, []byte(
		`{"type":"user","message":{"role":"user","content":"hello"}}`+"\n"+
			`{"type":"custom-title","customTitle":"人工重命名标题"}`+"\n",
	), 0o600)

	// Native fallback before auto-title exists.
	if got := resolveSessionTitle("sid-ai", claudeAI, "claude"); got != "旧 AI 标题" {
		t.Fatalf("fallback title = %q, want 旧 AI 标题", got)
	}

	// Auto-title overrides native ai-title...
	if err := saveAutoTitleEntry("sid-ai", autoTitleEntry{
		Title: "自动更新后的新标题", Agent: "claude", UpdatedAt: time.Now().UnixMilli(), UserTurns: 3,
	}); err != nil {
		t.Fatal(err)
	}
	if got := resolveSessionTitle("sid-ai", claudeAI, "claude"); got != "自动更新后的新标题" {
		t.Fatalf("auto title = %q, want 自动更新后的新标题", got)
	}

	// ...but Claude's manual custom-title always wins over auto-title.
	_ = saveAutoTitleEntry("sid-manual", autoTitleEntry{
		Title: "不应覆盖人工标题", Agent: "claude", UpdatedAt: time.Now().UnixMilli(), UserTurns: 3,
	})
	if got := resolveSessionTitle("sid-manual", claudeManual, "claude"); got != "人工重命名标题" {
		t.Fatalf("manual custom-title = %q, want 人工重命名标题", got)
	}

	// Web /rename lock wins and cannot be overwritten by a subsequent auto save.
	lockSessionTitle("sid-agy", "agy", "手动固定标题")
	_ = saveAutoTitleEntry("sid-agy", autoTitleEntry{
		Title: "后台试图覆盖", Agent: "agy", UpdatedAt: time.Now().UnixMilli(), UserTurns: 5,
	})
	if got := resolveSessionTitle("sid-agy", "", "agy"); got != "手动固定标题" {
		t.Fatalf("locked rename = %q, want 手动固定标题", got)
	}
}

func TestAutoTitlerSweepEndToEnd(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	storeFile := filepath.Join(home, ".local", "state", "wezdeck", "session-titles.json")
	t.Setenv("WEZDECK_SESSION_TITLES_FILE", storeFile)

	// Write a minimal Agy transcript so findTranscript resolves it.
	convID := "11111111-2222-3333-4444-555555555555"
	agyLogDir := filepath.Join(home, ".gemini", "antigravity-cli", "brain", convID, ".system_generated", "logs")
	if err := os.MkdirAll(agyLogDir, 0o700); err != nil {
		t.Fatal(err)
	}
	agyPath := filepath.Join(agyLogDir, "transcript_full.jsonl")
	writeAgyRows := func(rows []map[string]any) {
		var lines []string
		for _, r := range rows {
			b, _ := json.Marshal(r)
			lines = append(lines, string(b))
		}
		if err := os.WriteFile(agyPath, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeAgyRows([]map[string]any{
		{"type": "USER_INPUT", "content": "<USER_REQUEST>\n加固本机 Runtime 和远程中转访问控制\n</USER_REQUEST>", "timestamp": "2026-11-27T01:00:00Z"},
		{"type": "PLANNER_RESPONSE", "content": "已完成安全加固并上线。", "timestamp": "2026-11-27T01:05:00Z"},
	})

	origRun := runAutoTitleFunc
	defer func() { runAutoTitleFunc = origRun }()

	calls := 0
	var lastPrompt string
	runAutoTitleFunc = func(_ context.Context, prompt string) (string, string, error) {
		calls++
		lastPrompt = prompt
		if calls == 1 {
			return "加固 Runtime 与中转访问控制", "grok", nil
		}
		if calls == 2 {
			return "UNCHANGED", "grok", nil
		}
		return "", "grok", errors.New("boom")
	}

	now := time.Unix(1_700_000_000, 0)
	titler := newAutoTitler()
	titler.now = func() time.Time { return now }

	entries := map[string]attentionEntry{
		convID: {SessionID: convID, AgentName: "agy", Status: "done", TS: now.UnixMilli()},
	}

	// Sweep 1: first_turn generates title.
	if n := titler.sweep(context.Background(), entries); n != 1 {
		t.Fatalf("sweep 1 processed = %d, want 1", n)
	}
	if got := resolveSessionTitle(convID, agyPath, "agy"); got != "加固 Runtime 与中转访问控制" {
		t.Fatalf("title after sweep 1 = %q", got)
	}
	if !strings.Contains(lastPrompt, "加固本机 Runtime") {
		t.Fatalf("prompt missing user context: %s", lastPrompt)
	}

	// Sweep 2 immediately: same digest, skipped.
	if n := titler.sweep(context.Background(), entries); n != 0 {
		t.Fatalf("sweep 2 processed = %d, want 0", n)
	}

	// Append 2 substantive turns + advance clock past cooldown → UNCHANGED keeps title.
	writeAgyRows([]map[string]any{
		{"type": "USER_INPUT", "content": "<USER_REQUEST>\n加固本机 Runtime 和远程中转访问控制\n</USER_REQUEST>", "timestamp": "2026-11-27T01:00:00Z"},
		{"type": "PLANNER_RESPONSE", "content": "已完成安全加固并上线。", "timestamp": "2026-11-27T01:05:00Z"},
		{"type": "USER_INPUT", "content": "<USER_REQUEST>\n可以\n</USER_REQUEST>", "timestamp": "2026-11-27T01:06:00Z"},
		{"type": "USER_INPUT", "content": "<USER_REQUEST>\n继续排查会话列表图标切换闪烁原因\n</USER_REQUEST>", "timestamp": "2026-11-27T01:10:00Z"},
		{"type": "USER_INPUT", "content": "<USER_REQUEST>\n再把交互卡等待提示抖动也一并修复\n</USER_REQUEST>", "timestamp": "2026-11-27T01:15:00Z"},
		{"type": "PLANNER_RESPONSE", "content": "已完成零布局位移改造。", "timestamp": "2026-11-27T01:16:00Z"},
	})
	now = now.Add(3 * time.Minute)
	if n := titler.sweep(context.Background(), entries); n != 1 {
		t.Fatalf("sweep 3 processed = %d, want 1", n)
	}
	if got := resolveSessionTitle(convID, agyPath, "agy"); got != "加固 Runtime 与中转访问控制" {
		t.Fatalf("UNCHANGED must keep title, got %q", got)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want 2", calls)
	}
}

func TestAutoTitleConfigStatusAndUnlock(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_SESSION_TITLES_FILE", filepath.Join(dir, "session-titles.json"))
	t.Setenv("WEZDECK_AUTOTITLE_CONFIG_FILE", filepath.Join(dir, "autotitle-config.json"))
	t.Setenv("WEZDECK_ATTENTION_FILE", filepath.Join(dir, "attention.json"))

	// Configure enabled=false, provider=claude, interval=60
	res, err := updateAutoTitle(json.RawMessage(`{"op":"configure","enabled":false,"provider":"claude","interval_s":60}`))
	if err != nil {
		t.Fatalf("configure failed: %v", err)
	}
	m := res.(map[string]any)
	if m["enabled"] != false || m["provider"] != "claude" || m["interval_s"] != 60 {
		t.Fatalf("unexpected status after configure: %#v", m)
	}

	// Reject unknown provider
	if _, err := updateAutoTitle(json.RawMessage(`{"op":"configure","provider":"bogus"}`)); err == nil {
		t.Fatal("expected error for unsupported provider")
	}

	// Lock & unlock title + source reporting
	sid := "11111111-2222-3333-4444-555555555555"
	lockSessionTitle(sid, "agy", "人工固定标题")
	if src := resolveSessionTitleSource(sid, "", "agy"); src != "manual" {
		t.Fatalf("locked source = %q, want manual", src)
	}
	if _, err := updateAutoTitle(json.RawMessage(`{"op":"unlock","session_id":"` + sid + `"}`)); err != nil {
		t.Fatalf("unlock failed: %v", err)
	}
	if src := resolveSessionTitleSource(sid, "", "agy"); src != "auto" {
		t.Fatalf("unlocked source = %q, want auto", src)
	}
}

