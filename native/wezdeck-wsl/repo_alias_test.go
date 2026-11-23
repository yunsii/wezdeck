package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseRepoAliases(t *testing.T) {
	got := parseRepoAliases(" wezterm-config = wezdeck ,fe1=front,bad, =x")
	if got["wezterm-config"] != "wezdeck" || got["fe1"] != "front" || len(got) != 2 {
		t.Fatalf("got %v", got)
	}
	for _, off := range []string{"", "none", "off", "0"} {
		if parseRepoAliases(off) != nil {
			t.Fatalf("%q should turn aliases off", off)
		}
	}
}

func TestRepoAliasSpecReadsSharedEnv(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "wezterm-x", "local"), 0o755); err != nil {
		t.Fatal(err)
	}
	env := "# comment\nOTHER=1\nWEZDECK_REPO_ALIASES='a=b,c=d'\n"
	if err := os.WriteFile(filepath.Join(root, "wezterm-x", "local", "shared.env"), []byte(env), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_REPO", root)
	os.Unsetenv("WEZDECK_REPO_ALIASES")
	if got := repoAliasSpec(); got != "a=b,c=d" {
		t.Fatalf("got %q", got)
	}
	t.Setenv("WEZDECK_REPO_ALIASES", "none")
	if got := repoAliasSpec(); got != "none" {
		t.Fatalf("env should win, got %q", got)
	}
}
