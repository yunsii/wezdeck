package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProjectHistoryListsEarlierConversations(t *testing.T) {
	dir := t.TempDir()
	write := func(id string, lines []string, age time.Duration) {
		path := filepath.Join(dir, id+".jsonl")
		if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		at := time.Now().Add(-age)
		_ = os.Chtimes(path, at, at)
	}
	write("current", []string{`{"type":"user","message":{"role":"user","content":"now"}}`}, 0)
	write("older", []string{
		`{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>x</local-command-caveat>"}}`,
		`{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>"}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"修一下登录页"}]}}`,
		`{"type":"ai-title","aiTitle":"登录页修复"}`,
	}, 2*time.Hour)
	write("newer", []string{`{"type":"user","message":{"role":"user","content":"看下会话列表"}}`}, time.Hour)
	write("empty", []string{`{"type":"summary","summary":"x"}`}, 3*time.Hour)
	write("open-one", []string{`{"type":"user","message":{"role":"user","content":"还开着的"}}`}, 4*time.Hour)

	items := projectHistory(dir, "current", map[string]attentionEntry{"open-one": {}})
	if len(items) != 3 {
		t.Fatalf("want newer, older, open-one; got %+v", items)
	}
	if items[0].ID != "newer" || items[1].ID != "older" || items[1].Prompt != "修一下登录页" || !items[2].Open {
		t.Fatalf("order / prompt / open wrong: %+v", items)
	}
}
