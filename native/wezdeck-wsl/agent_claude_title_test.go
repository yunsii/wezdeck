package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLastClaudeAITitle(t *testing.T) {
	cases := []struct {
		name  string
		lines string
		want  string
	}{
		{"none", `{"type":"user","message":{"role":"user","content":"hi"}}` + "\n", ""},
		{"ai only, newest wins", `{"type":"ai-title","aiTitle":"old"}` + "\n" + `{"type":"ai-title","aiTitle":"new"}` + "\n", "new"},
		{"custom beats newer ai", `{"type":"custom-title","customTitle":"mine"}` + "\n" + `{"type":"ai-title","aiTitle":"gen"}` + "\n", "mine"},
		{"custom only (carried across /clear)", `{"type":"custom-title","customTitle":"kept"}` + "\n" + `{"type":"user","message":{"role":"user","content":"x"}}` + "\n", "kept"},
		{"newest custom wins", `{"type":"custom-title","customTitle":"a"}` + "\n" + `{"type":"custom-title","customTitle":"b"}` + "\n", "b"},
		{"empty custom ignored", `{"type":"ai-title","aiTitle":"gen"}` + "\n" + `{"type":"custom-title","customTitle":""}` + "\n", "gen"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "s.jsonl")
			if err := os.WriteFile(p, []byte(c.lines), 0o644); err != nil {
				t.Fatal(err)
			}
			if got := lastClaudeAITitle(p); got != c.want {
				t.Fatalf("got %q want %q", got, c.want)
			}
		})
	}
}
