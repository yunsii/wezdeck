package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReadOnlyTmuxWriteStages(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	t.Setenv("TMUX", "")
	t.Setenv("TMUX_PANE", "")
	dir := t.TempDir()
	t.Setenv("WEZDECK_RELAY_LOG_DIR", dir)
	socket := filepath.Join(dir, "tmux.sock")
	tmux := func(args ...string) string {
		t.Helper()
		out, err := tmuxCmd(socket, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("tmux %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	tmux("-f", "/dev/null", "new-session", "-ds", "probe", "cat")
	t.Cleanup(func() { _ = tmuxCmd(socket, "kill-server").Run() })
	e := attentionEntry{SessionID: "session-test", TmuxSocket: socket, TmuxPane: "%0"}
	if err := pasteToPane(socket, e.TmuxPane, "detached"); err != nil {
		t.Fatalf("detached write: %v", err)
	}

	observer := tmuxCmd(socket, "-C", "attach-session", "-r", "-f", "ignore-size", "-t", "probe")
	stdin, err := observer.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = observer.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = stdin.Close()
		_ = observer.Process.Kill()
		_ = observer.Wait()
	}()
	deadline := time.Now().Add(3 * time.Second)
	for !strings.Contains(tmux("list-clients", "-F", "#{client_flags}"), "read-only") {
		if time.Now().After(deadline) {
			t.Fatal("read-only control client did not attach")
		}
		time.Sleep(20 * time.Millisecond)
	}
	_, err = sendSessionKey(e, "Escape")
	var failure *paneWriteError
	if !errors.As(err, &failure) || failure.stage != "key" || failure.detail != "client is read-only" {
		t.Fatalf("expected read-only key failure, got %v", err)
	}
	start := time.Now()
	err = pasteToPane(socket, e.TmuxPane, "test-private-message")
	if !errors.As(err, &failure) || failure.stage != "submit" || failure.detail != "client is read-only" {
		t.Fatalf("expected partial send, got %v", err)
	}
	logPaneWrite(e, "test-operation", "send", start, err)
	lines, err := os.ReadFile(filepath.Join(dir, "relay.log"))
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`op_id="test-operation"`, `pane="%0"`, `stage="submit"`, "read-only"} {
		if !strings.Contains(string(lines), field) {
			t.Fatalf("missing %s in %s", field, lines)
		}
	}
	if strings.Contains(string(lines), "test-private-message") {
		t.Fatal("message body leaked into pane diagnostics")
	}

	tmux("detach-client", "-s", "probe")
	tmux("send-keys", "-t", e.TmuxPane, "Enter")
	screen := tmux("capture-pane", "-p", "-t", e.TmuxPane)
	if !strings.Contains(screen, "detached") || !strings.Contains(screen, "test-private-message") {
		t.Fatalf("pane did not retain the partial input: %s", screen)
	}
}
