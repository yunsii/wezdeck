package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func useTempOutbox(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "sent-messages.json")
	t.Setenv("WEZDECK_SENT_MESSAGES", p)
	return p
}

func TestOutboxRecordDedupAndSlashFilter(t *testing.T) {
	useTempOutbox(t)
	if !isSlashCommand("/new") || !isSlashCommand("  /compact focus") {
		t.Fatalf("expected slash commands to be detected")
	}
	if isSlashCommand("/home/user/foo.png") || isSlashCommand("hello /new") {
		t.Fatalf("paths and plain messages must not be treated as slash commands")
	}

	op := "11111111-1111-4111-8111-111111111111"
	first, deduped := outboxRecordStart(sentRecord{
		ClientOp:    op,
		Kind:        "message",
		SessionID:   "sess-1",
		RepoKey:     "/repo/wezdeck",
		RepoLabel:   "wezdeck",
		Text:        "hello [图片1]",
		Attachments: []string{"img-20261127-180000-aaaaaaaa.jpg"},
		Status:      "pending",
	})
	if deduped || first.ID == "" {
		t.Fatalf("expected fresh record, got deduped=%v rec=%+v", deduped, first)
	}
	second, deduped := outboxRecordStart(sentRecord{
		ClientOp:  op,
		Kind:      "message",
		SessionID: "sess-1",
		Text:      "hello [图片1]",
		Status:    "pasting",
	})
	if !deduped || second.ID != first.ID {
		t.Fatalf("expected deduped record %s, got deduped=%v id=%s", first.ID, deduped, second.ID)
	}
}

func TestOutboxReconcileExactMergedAndUnconfirmed(t *testing.T) {
	useTempOutbox(t)
	now := time.Now().UnixMilli()

	// Record 1: exact text + attachment note at index >= 1
	r1, _ := outboxRecordStart(sentRecord{
		SessionID:           "s1",
		Text:                "check this",
		Attachments:         []string{"img-1-aaaa1111.jpg"},
		CreatedAt:           now - 10_000,
		Status:              "pending",
		TranscriptEndAtSend: 1,
	})
	// Record 2: terminal had half-typed prefix merged with web paste
	r2, _ := outboxRecordStart(sentRecord{
		SessionID:           "s1",
		Text:                "fix the scroll jump",
		CreatedAt:           now - 5_000,
		Status:              "pending",
		TranscriptEndAtSend: 1,
	})
	// Record 3: never appeared, older than 60s
	r3, _ := outboxRecordStart(sentRecord{
		SessionID:           "s1",
		Text:                "swallowed by tui",
		CreatedAt:           now - outboxUnconfirmedAfterMs - 5_000,
		Status:              "pending",
		TranscriptEndAtSend: 1,
	})

	msgs := []chatMessage{
		{Role: "user", Text: "check this"}, // index 0: BEFORE TranscriptEndAtSend — must not match!
		{Role: "assistant", Text: "ok"},
		{Role: "user", Text: "check this\n\n[网页附件]\n- 图片1: /tmp/img-1-aaaa1111.jpg"},
		{Role: "user", Text: "顺便帮我 fix the scroll jump 谢谢"},
	}

	// While busy, r3 stays pending (not marked unconfirmed mid-turn).
	leftBusy := reconcileSessionOutbox("s1", msgs, true, now)
	if len(leftBusy) != 1 || leftBusy[0].ID != r3.ID || leftBusy[0].Status != "pending" {
		t.Fatalf("expected only r3 pending while busy, got %+v", leftBusy)
	}

	// Verify r1 and r2 confirmed with expected indices.
	s := readOutboxCached()
	statusByID := map[string]sentRecord{}
	for _, item := range s.Items {
		statusByID[item.ID] = item
	}
	if statusByID[r1.ID].Status != "confirmed" || statusByID[r1.ID].ConfirmedMsgIndex == nil || *statusByID[r1.ID].ConfirmedMsgIndex != 2 {
		t.Fatalf("r1 should confirm at idx 2, got %+v", statusByID[r1.ID])
	}
	if statusByID[r2.ID].Status != "confirmed" || statusByID[r2.ID].ConfirmedMsgIndex == nil || *statusByID[r2.ID].ConfirmedMsgIndex != 3 {
		t.Fatalf("r2 should confirm via merged draft at idx 3, got %+v", statusByID[r2.ID])
	}

	// Once idle, r3 flips to unconfirmed.
	leftIdle := reconcileSessionOutbox("s1", msgs, false, now)
	if len(leftIdle) != 1 || leftIdle[0].ID != r3.ID || leftIdle[0].Status != "unconfirmed" {
		t.Fatalf("expected r3 unconfirmed when idle, got %+v", leftIdle)
	}

	// Late arrival still settles an unconfirmed record.
	msgs = append(msgs, chatMessage{Role: "user", Text: "swallowed by tui"})
	leftLate := reconcileSessionOutbox("s1", msgs, false, now+5_000)
	if len(leftLate) != 0 {
		t.Fatalf("expected late arrival to settle r3, got %+v", leftLate)
	}
}

func TestOutboxListAndActionsAndPruneProtection(t *testing.T) {
	useTempOutbox(t)
	now := time.Now().UnixMilli()

	r1, _ := outboxRecordStart(sentRecord{
		SessionID:   "s1",
		RepoKey:     "/repo/a",
		RepoLabel:   "repo-a",
		Text:        "first",
		Attachments: []string{"img-keep-11111111.jpg"},
		CreatedAt:   now - 2_000,
		Status:      "confirmed",
	})
	r2, _ := outboxRecordStart(sentRecord{
		SessionID: "s2",
		RepoKey:   "/repo/a",
		RepoLabel: "repo-a",
		Text:      "second",
		CreatedAt: now - 1_000,
		Status:    "unconfirmed",
	})
	_, _ = outboxRecordStart(sentRecord{
		SessionID: "s3",
		RepoKey:   "/repo/b",
		RepoLabel: "repo-b",
		Text:      "third",
		CreatedAt: now,
		Status:    "failed",
		Error:     "tmux pane gone",
	})

	// Scope=repo with repo_key filters to repo-a (2 items, 1 unsettled).
	res, err := listSentMessages(json.RawMessage(`{"scope":"repo","repo_key":"/repo/a"}`))
	if err != nil {
		t.Fatalf("listSentMessages: %v", err)
	}
	m := res.(map[string]any)
	items := m["items"].([]sentRecord)
	if len(items) != 2 || m["unsettled_count"].(int) != 1 {
		t.Fatalf("unexpected repo list: len=%d unsettled=%v", len(items), m["unsettled_count"])
	}

	// Scope=all, status=unsettled returns r3, r2.
	res, err = listSentMessages(json.RawMessage(`{"scope":"all","status":"unsettled"}`))
	if err != nil {
		t.Fatalf("listSentMessages unsettled: %v", err)
	}
	if got := res.(map[string]any)["items"].([]sentRecord); len(got) != 2 {
		t.Fatalf("expected 2 unsettled across all, got %d", len(got))
	}

	// Dismiss r2 hides it from default list.
	if _, err := writeSentAction(json.RawMessage(`{"op":"dismiss","id":"` + r2.ID + `"}`)); err != nil {
		t.Fatalf("dismiss r2: %v", err)
	}
	res, _ = listSentMessages(json.RawMessage(`{"scope":"repo","repo_key":"/repo/a"}`))
	if got := res.(map[string]any)["items"].([]sentRecord); len(got) != 1 || got[0].ID != r1.ID {
		t.Fatalf("expected only r1 after dismissing r2, got %+v", got)
	}

	// Upload GC protection: pinned file survives pruneUploads even when >30d old.
	dir := t.TempDir()
	keepPath := filepath.Join(dir, "img-keep-11111111.jpg")
	dropPath := filepath.Join(dir, "img-drop-22222222.jpg")
	_ = os.WriteFile(keepPath, []byte("keep"), 0o600)
	_ = os.WriteFile(dropPath, []byte("drop"), 0o600)
	oldTime := time.Now().Add(-40 * 24 * time.Hour)
	_ = os.Chtimes(keepPath, oldTime, oldTime)
	_ = os.Chtimes(dropPath, oldTime, oldTime)

	pruneUploads(dir)
	if _, err := os.Stat(keepPath); err != nil {
		t.Fatalf("expected pinned upload to survive prune: %v", err)
	}
	if _, err := os.Stat(dropPath); !os.IsNotExist(err) {
		t.Fatalf("expected unpinned stale upload to be pruned")
	}

	// Delete r1 removes it completely.
	if _, err := writeSentAction(json.RawMessage(`{"op":"delete","id":"` + r1.ID + `"}`)); err != nil {
		t.Fatalf("delete r1: %v", err)
	}
	if pinned := outboxPinnedUploads(); pinned["img-keep-11111111.jpg"] {
		t.Fatalf("deleted record should no longer pin upload")
	}
}
