package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReadCodexSessionTitleTracksIndexChanges(t *testing.T) {
	dir := t.TempDir()
	const id = "01a21570-0ec1-7a02-b66d-5227c29aaf74"
	rollout := filepath.Join(dir, "sessions", "2026", "11", "26", "rollout-2026-11-26T09-19-55-"+id+".jsonl")
	index := filepath.Join(dir, "session_index.jsonl")
	assertTitle := func(want string) {
		t.Helper()
		if got := readSessionTitle(rollout, "codex"); got != want {
			t.Fatalf("title = %q, want %q", got, want)
		}
	}
	write := func(path, content string, flags int) {
		t.Helper()
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|flags, 0600)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.WriteString(content)
		closeErr := f.Close()
		if err != nil || closeErr != nil {
			t.Fatalf("write error: %v, close error: %v", err, closeErr)
		}
	}

	assertTitle("")
	write(index, "{invalid}\n"+`{"id":"`+id+`","thread_name":"回应问候"}`+"\n", os.O_TRUNC)
	assertTitle("回应问候")
	write(index, `{"id":"`+id+`","thread_name":"手动改名"}`+"\n", os.O_APPEND)
	assertTitle("手动改名")

	// A compacted index can replace the inode while keeping the size and mtime.
	replacement := filepath.Join(dir, "replacement.jsonl")
	write(replacement, "{invalid}\n"+`{"id":"`+id+`","thread_name":"回应问候"}`+"\n"+
		`{"id":"`+id+`","thread_name":"新的标题"}`+"\n", os.O_TRUNC)
	info, err := os.Stat(index)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(replacement, time.Now(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, index); err != nil {
		t.Fatal(err)
	}
	assertTitle("新的标题")
}
