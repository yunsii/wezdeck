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

// Reproduces the 2026-11-28 incident:
//  1. `session.restart fresh=false` on a pending-* session created a pane-less
//     zombie entry `{"restart_pending": true}` in attention.json.entries.
//  2. The old session resumed on the same pane while recent[] still held
//     `old -> pending-*`.
//  3. Opening the live session must NEVER redirect to the zombie pending-*,
//     opening pending-* must redirect to the live session, and unsettled
//     outbox messages sent under pending-* on that pane must rebind and settle.
func TestLiveSessionNeverRedirectsToPaneLessZombieAndRebindsOutbox(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	outboxPath := filepath.Join(dir, "sent-messages.json")
	t.Setenv("WEZDECK_SENT_MESSAGES", outboxPath)

	bin := filepath.Join(dir, "bin")
	_ = os.MkdirAll(bin, 0o755)
	cat, _ := exec.LookPath("cat")
	if err := os.Symlink(cat, filepath.Join(bin, "codex")); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join("/tmp", "wd-inv-"+newDiagID())
	if out, err := exec.Command("tmux", "-S", socket, "new-session", "-d", "-s", "work", filepath.Join(bin, "codex")).CombinedOutput(); err != nil {
		t.Fatalf("tmux: %s", out)
	}
	t.Cleanup(func() { _ = exec.Command("tmux", "-S", socket, "kill-server").Run() })
	paneOut, _ := exec.Command("tmux", "-S", socket, "display-message", "-p", "-t", "work", "#{pane_id}").Output()
	pane := strings.TrimSpace(string(paneOut))

	liveID := "01a21d88-4621-7a01-aaeb-9d39c274b59c"
	zombieID := "pending-17808d2b-6d2d-4b76-9d23-686405d81bcf"

	// Create a minimal Codex rollout containing the message sent while on pending-*.
	rolloutDir := filepath.Join(dir, ".codex", "sessions", "2026", "11", "28")
	_ = os.MkdirAll(rolloutDir, 0o700)
	rolloutPath := filepath.Join(rolloutDir, "rollout-2026-11-28T00-34-40-"+liveID+".jsonl")
	rollout := strings.Join([]string{
		`{"timestamp":"2026-11-28T00:34:40.000Z","type":"session_meta","payload":{"id":"` + liveID + `","cwd":"` + dir + `"}}`,
		`{"timestamp":"2026-11-28T00:34:41.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello from pending pane"}]}}`,
		`{"timestamp":"2026-11-28T00:34:45.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"received on live session"}]}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(rolloutPath, []byte(rollout), 0o600); err != nil {
		t.Fatal(err)
	}

	// Seed an unsettled outbox record under the temporary pending-* id on the same pane.
	now := time.Now().UnixMilli()
	rec, _ := outboxRecordStart(sentRecord{
		SessionID: zombieID,
		Pane:      pane,
		Text:      "hello from pending pane",
		CreatedAt: now - outboxUnconfirmedAfterMs - 10_000,
		Status:    "unconfirmed",
	})

	// attention.json with live session + pane-less zombie entry + stale cleared_to edge.
	doc, _ := json.Marshal(map[string]any{
		"entries": map[string]any{
			liveID: map[string]any{
				"session_id": liveID, "tmux_socket": socket, "tmux_session": "work",
				"tmux_pane": pane, "status": "done", "agent_name": "codex", "ts": now,
			},
			zombieID: map[string]any{
				"restart_pending": true,
			},
		},
		"recent": []map[string]any{
			{
				"session_id": liveID, "tmux_socket": socket, "tmux_session": "work",
				"tmux_pane": pane, "last_status": "done", "archived_ts": now - 120_000,
				"cleared_to": zombieID,
			},
		},
	})
	attnPath := filepath.Join(dir, "attention.json")
	if err := os.WriteFile(attnPath, doc, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_ATTENTION_FILE", attnPath)
	time.Sleep(150 * time.Millisecond)

	// 1. listSessions lists only the live session and redirects zombieID -> liveID (never liveID -> zombieID).
	listRaw, err := listSessions()
	if err != nil {
		t.Fatal(err)
	}
	list := listRaw.(map[string]any)
	cards := list["sessions"].([]sessionCard)
	if len(cards) != 1 || cards[0].ID != liveID {
		t.Fatalf("want only live session %s, got %+v", liveID, cards)
	}
	redirects := list["redirects"].([]sessionRedirect)
	sawPendingToLive := false
	for _, r := range redirects {
		if r.From == liveID {
			t.Fatalf("must never redirect live session %s: %+v", liveID, redirects)
		}
		if r.To == zombieID {
			t.Fatalf("must never redirect to unlisted zombie %s: %+v", zombieID, redirects)
		}
		if r.From == zombieID && r.To == liveID {
			sawPendingToLive = true
		}
	}
	if !sawPendingToLive {
		t.Fatalf("want stale pending redirect %s -> %s, got %+v", zombieID, liveID, redirects)
	}

	// 2. sessionDetail on zombieID follows to liveID instead of rendering a pane-less shell.
	zombieDetail, err := sessionDetail(json.RawMessage(`{"id":"` + zombieID + `"}`))
	if err != nil {
		t.Fatalf("zombie detail: %v", err)
	}
	if zombieDetail.(map[string]any)["replaced_by"] != liveID {
		t.Fatalf("want zombie replaced_by %s, got %+v", liveID, zombieDetail)
	}

	// 3. sessionDetail on liveID renders its transcript and rebinds + confirms the pane's pending outbox record.
	liveDetail, err := sessionDetail(json.RawMessage(`{"id":"` + liveID + `"}`))
	if err != nil {
		t.Fatalf("live detail: %v", err)
	}
	dm := liveDetail.(map[string]any)
	if dm["replaced_by"] != nil {
		t.Fatalf("live session must not answer replaced_by: %+v", dm)
	}
	if dm["outbox"] != nil {
		t.Fatalf("expected rebound outbox record to confirm against transcript, got %+v", dm["outbox"])
	}
	store := readOutboxCached()
	found := false
	for _, item := range store.Items {
		if item.ID == rec.ID {
			found = true
			if item.SessionID != liveID || item.Status != "confirmed" {
				t.Fatalf("expected outbox record rebound to %s and confirmed, got %+v", liveID, item)
			}
		}
	}
	if !found {
		t.Fatalf("outbox record %s vanished", rec.ID)
	}
}

func TestAttentionRestartLibNeverCreatesZombieEntriesAndPrunesMalformed(t *testing.T) {
	dir := t.TempDir()
	attn := filepath.Join(dir, "attention.json")
	doc, _ := json.Marshal(map[string]any{
		"version": 1,
		"entries": map[string]any{
			"live-1": map[string]any{
				"session_id": "live-1", "tmux_socket": "/tmp/s", "tmux_pane": "%1", "status": "done",
			},
			"legacy-zombie": map[string]any{
				"restart_pending": true,
			},
		},
		"recent": []any{},
	})
	if err := os.WriteFile(attn, doc, 0o600); err != nil {
		t.Fatal(err)
	}

	worktreeRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	script := `set -euo pipefail
source "` + filepath.Join(worktreeRoot, "scripts", "runtime", "attention-state-lib.sh") + `"
attention_state_mark_restart_pending "pending-missing"
attention_state_mark_restart_pending "legacy-zombie"
attention_state_mark_restart_pending "live-1"
`
	cmd := exec.Command("bash", "-c", script)
	cmd.Env = append(os.Environ(),
		"WEZDECK_ATTENTION_STATE_PATH="+attn,
		"WEZTERM_ATTENTION_LOCK_FILE="+attn+".lock",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("mark script failed: %v\n%s", err, out)
	}

	readEntries := func() map[string]map[string]any {
		raw, err := os.ReadFile(attn)
		if err != nil {
			t.Fatal(err)
		}
		var state struct {
			Entries map[string]map[string]any `json:"entries"`
		}
		if err := json.Unmarshal(raw, &state); err != nil {
			t.Fatal(err)
		}
		return state.Entries
	}

	entries := readEntries()
	if _, created := entries["pending-missing"]; created {
		t.Fatalf("mark_restart_pending created a zombie entry for missing session: %+v", entries)
	}
	if entries["live-1"]["restart_pending"] != true {
		t.Fatalf("expected live-1 restart_pending=true, got %+v", entries["live-1"])
	}

	// Clear on live-1 removes restart_pending; prune deletes legacy-zombie.
	script2 := `set -euo pipefail
source "` + filepath.Join(worktreeRoot, "scripts", "runtime", "attention-state-lib.sh") + `"
attention_state_clear_restart_pending "live-1"
attention_state_prune_malformed_entries
`
	cmd2 := exec.Command("bash", "-c", script2)
	cmd2.Env = append(os.Environ(),
		"WEZDECK_ATTENTION_STATE_PATH="+attn,
		"WEZTERM_ATTENTION_LOCK_FILE="+attn+".lock",
	)
	if out, err := cmd2.CombinedOutput(); err != nil {
		t.Fatalf("prune script failed: %v\n%s", err, out)
	}

	entries = readEntries()
	if _, still := entries["legacy-zombie"]; still {
		t.Fatalf("prune did not remove legacy-zombie: %+v", entries)
	}
	if _, stillFlag := entries["live-1"]["restart_pending"]; stillFlag {
		t.Fatalf("clear did not remove restart_pending from live-1: %+v", entries["live-1"])
	}
	if entries["live-1"]["tmux_pane"] != "%1" {
		t.Fatalf("live-1 was corrupted: %+v", entries["live-1"])
	}
}
