package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func agyNewConvFixture(t *testing.T, procName string) (dir, socket, pane, attention, pins string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux missing")
	}
	if wd, err := os.Getwd(); err == nil {
		t.Setenv("WEZDECK_REPO", filepath.Dir(filepath.Dir(wd)))
	}
	dir = t.TempDir()
	for _, v := range []string{"WINDOWS_RUNTIME_STATE_WSL", "LOCALAPPDATA_WSL", "USERPROFILE_WSL"} {
		p := filepath.Join(dir, strings.ToLower(v))
		_ = os.MkdirAll(p, 0o755)
		t.Setenv(v, p)
	}
	t.Setenv("XDG_STATE_HOME", filepath.Join(dir, "state"))
	pins = filepath.Join(dir, "agent-session-pins.json")
	t.Setenv("WEZDECK_AGENT_SESSION_PINS_PATH", pins)
	socket = filepath.Join("/tmp", "wd-agy-new-"+newDiagID())
	t.Cleanup(func() { _ = exec.Command("tmux", "-S", socket, "kill-server").Run() })

	binDir := filepath.Join(dir, "bin")
	_ = os.MkdirAll(binDir, 0o755)
	catBin, err := exec.LookPath("cat")
	if err != nil {
		t.Skip("cat missing")
	}
	cmdPath := filepath.Join(binDir, procName)
	if err := os.Symlink(catBin, cmdPath); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("tmux", "-S", socket, "new-session", "-d", "-s", "work", "-c", dir,
		"-x", "100", "-y", "24", cmdPath).CombinedOutput(); err != nil {
		t.Fatalf("tmux: %s", out)
	}
	out, _ := exec.Command("tmux", "-S", socket, "display-message", "-p", "-t", "work", "#{pane_id}").Output()
	pane = strings.TrimSpace(string(out))
	attention = filepath.Join(dir, "attention.json")
	t.Setenv("WEZDECK_ATTENTION_FILE", attention)
	time.Sleep(150 * time.Millisecond)
	return dir, socket, pane, attention, pins
}

func TestSendNewToAgyMarksPendingClearedAndFollowsFirstPrompt(t *testing.T) {
	for _, tc := range []struct {
		name     string
		archived bool
	}{
		{"live_done_entry", false},
		{"already_archived_idle", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir, socket, pane, attention, pins := agyNewConvFixture(t, "agy")
			_ = exec.Command("tmux", "-S", socket, "set-option", "-p", "-t", pane, "@wezterm_pane_role", "agent-cli:agy").Run()
			_ = exec.Command("tmux", "-S", socket, "set-option", "-p", "-t", pane, "@wezterm_agent_session_id", "agy-old").Run()
			_ = os.WriteFile(pins, []byte(`{"version":1,"pins":{"`+dir+"\tprimary"+`":{"session_id":"agy-old","agent":"agy","slot":"primary","cwd":"`+dir+`","updated_ts":100}}}`), 0o600)

			var doc map[string]any
			if tc.archived {
				doc = map[string]any{
					"entries": map[string]any{},
					"recent": []map[string]any{{
						"session_id": "agy-old", "tmux_socket": socket, "tmux_session": "work",
						"tmux_pane": pane, "tmux_window_name": "agy", "agent_name": "agy",
						"last_user_prompt": "old task", "last_status": "done", "archived_ts": int64(100),
					}},
				}
			} else {
				doc = map[string]any{
					"entries": map[string]any{
						"agy-old": map[string]any{
							"session_id": "agy-old", "tmux_socket": socket, "tmux_session": "work",
							"tmux_pane": pane, "tmux_window_name": "agy", "agent_name": "agy",
							"last_user_prompt": "old task", "status": "done", "ts": int64(100),
						},
					},
					"recent": []any{},
				}
			}
			raw, _ := json.Marshal(doc)
			_ = os.WriteFile(attention, raw, 0o600)

			res, err := sendToSession(json.RawMessage(`{"id":"agy-old","text":"/new"}`))
			if err != nil {
				t.Fatalf("send /new: %v", err)
			}
			reply := res.(map[string]any)
			pendingID, _ := reply["session_id"].(string)
			if !strings.HasPrefix(pendingID, "pending-") {
				t.Fatalf("want pending-* session_id on Agy /new, got %+v", reply)
			}

			// Pane pin must be cleared so F5 cannot resurrect the discarded conversation.
			opt, _ := exec.Command("tmux", "-S", socket, "show-options", "-pqv", "-t", pane, "@wezterm_agent_session_id").Output()
			if strings.TrimSpace(string(opt)) != "" {
				t.Fatalf("pane pin still set after Agy /new: %q", opt)
			}

			// Old session immediately redirects to pending-*; list shows the blank Agy card.
			oldDetail, err := sessionDetail(json.RawMessage(`{"id":"agy-old"}`))
			if err != nil || oldDetail.(map[string]any)["replaced_by"] != pendingID {
				t.Fatalf("old session must point at %s immediately, got %v err=%v", pendingID, oldDetail, err)
			}
			list, err := listSessions()
			if err != nil {
				t.Fatalf("listSessions: %v", err)
			}
			cards := list.(map[string]any)["sessions"].([]sessionCard)
			if len(cards) != 1 || cards[0].ID != pendingID || cards[0].Agent != "agy" || cards[0].LastPrompt != "" {
				t.Fatalf("want single blank Agy pending card, got %+v", cards)
			}
			redirects := list.(map[string]any)["redirects"].([]sessionRedirect)
			if len(redirects) == 0 || redirects[0].From != "agy-old" || redirects[0].To != pendingID {
				t.Fatalf("want redirect agy-old -> %s, got %+v", pendingID, redirects)
			}

			// First prompt on pending-* succeeds and follows to the real Agy session id once SessionStart lands.
			if _, err := sendToSession(json.RawMessage(`{"id":"` + pendingID + `","text":"first real prompt"}`)); err != nil {
				t.Fatalf("send on pending session: %v", err)
			}
			nextDoc, _ := json.Marshal(map[string]any{
				"entries": map[string]any{
					"agy-real-2": map[string]any{
						"session_id": "agy-real-2", "tmux_socket": socket, "tmux_session": "work",
						"tmux_pane": pane, "tmux_window_name": "agy", "agent_name": "agy",
						"status": "running", "ts": int64(200),
					},
				},
				"recent": []map[string]any{
					{"session_id": "agy-old", "tmux_socket": socket, "tmux_session": "work", "tmux_pane": pane, "archived_ts": int64(100), "cleared_to": "agy-real-2"},
					{"session_id": pendingID, "tmux_socket": socket, "tmux_pane": pane, "archived_ts": int64(150), "cleared_to": "agy-real-2"},
				},
			})
			_ = os.WriteFile(attention, nextDoc, 0o600)
			pendingDetail, err := sessionDetail(json.RawMessage(`{"id":"` + pendingID + `"}`))
			if err != nil || pendingDetail.(map[string]any)["replaced_by"] != "agy-real-2" {
				t.Fatalf("pending session must follow to agy-real-2, got %v err=%v", pendingDetail, err)
			}
		})
	}
}

func TestWrappedBashAgyPhantomStubStaysListedWithBackfilledMeta(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux missing")
	}
	dir := t.TempDir()
	binDir := filepath.Join(dir, "bin")
	_ = os.MkdirAll(binDir, 0o755)
	sleepBin, err := exec.LookPath("sleep")
	if err != nil {
		t.Skip("sleep missing")
	}
	agyBin := filepath.Join(binDir, "agy")
	if err := os.Symlink(sleepBin, agyBin); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join("/tmp", "wd-agy-wrap-"+newDiagID())
	t.Cleanup(func() { _ = exec.Command("tmux", "-S", socket, "kill-server").Run() })
	// Keep bash as the pane's current command while agy runs as a child.
	if out, err := exec.Command("tmux", "-S", socket, "new-session", "-d", "-s", "work", "-c", dir,
		"bash", "-c", agyBin+" 600 & wait").CombinedOutput(); err != nil {
		t.Fatalf("tmux: %s", out)
	}
	out, _ := exec.Command("tmux", "-S", socket, "display-message", "-p", "-t", "work", "#{pane_id}").Output()
	pane := strings.TrimSpace(string(out))
	attention := filepath.Join(dir, "attention.json")
	doc, _ := json.Marshal(map[string]any{
		"entries": map[string]any{},
		"recent": []map[string]any{
			{"session_id": "agy-old", "tmux_socket": socket, "tmux_session": "work", "tmux_pane": pane, "tmux_window_name": "dev-agy", "git_branch": "dev/agy", "agent_name": "agy", "archived_ts": int64(100), "cleared_to": "pending-2"},
			{"session_id": "pending-1", "tmux_socket": socket, "tmux_pane": pane, "last_status": "idle", "archived_ts": int64(200), "cleared_to": "pending-2"},
		},
	})
	_ = os.WriteFile(attention, doc, 0o600)
	t.Setenv("WEZDECK_ATTENTION_FILE", attention)
	time.Sleep(250 * time.Millisecond)

	list, err := listSessions()
	if err != nil {
		t.Fatalf("listSessions: %v", err)
	}
	cards := list.(map[string]any)["sessions"].([]sessionCard)
	if len(cards) != 1 || cards[0].ID != "pending-2" || cards[0].Agent != "agy" || cards[0].TmuxSession != "work" {
		t.Fatalf("wrapped bash Agy phantom stub must stay listed with backfilled TmuxSession, got %+v", cards)
	}
}

func TestSendNewToClaudeDoesNotMintPendingID(t *testing.T) {
	_, socket, pane, attention, _ := agyNewConvFixture(t, "claude")
	doc, _ := json.Marshal(map[string]any{
		"entries": map[string]any{
			"claude-1": map[string]any{
				"session_id": "claude-1", "tmux_socket": socket, "tmux_session": "work",
				"tmux_pane": pane, "agent_name": "claude", "status": "done", "ts": int64(100),
			},
		},
	})
	_ = os.WriteFile(attention, doc, 0o600)

	res, err := sendToSession(json.RawMessage(`{"id":"claude-1","text":"/new"}`))
	if err != nil {
		t.Fatalf("send /new to claude: %v", err)
	}
	if _, hasID := res.(map[string]any)["session_id"]; hasID {
		t.Fatalf("claude /new must leave SessionStart hook in charge, got %+v", res)
	}
}
