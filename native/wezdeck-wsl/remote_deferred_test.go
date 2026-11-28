package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func useTempDeferred(t *testing.T) {
	t.Helper()
	t.Setenv("WEZDECK_DEFERRED_MESSAGES", filepath.Join(t.TempDir(), "deferred.json"))
}

func TestDeferredTurnOrderAndReview(t *testing.T) {
	useTempDeferred(t)
	first := deferredMessage{ID: "sent-first", ClientOp: "first", SessionID: "s1", Policy: "after_review", Status: "queued", CreatedAt: 1, ArmedAt: 100}
	second := deferredMessage{ID: "sent-second", ClientOp: "second", SessionID: "s1", Policy: "after_turn", Status: "queued", CreatedAt: 2, ArmedAt: 100}
	if err := withDeferredStore(func(s *deferredStore) error {
		s.Items = []deferredMessage{first, second}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var released []string
	release := func(item deferredMessage) { released = append(released, item.ID) }
	processDeferredSessionWith(attentionEntry{SessionID: "s1", Status: "done", TS: 200}, release)
	items := openDeferredForSession("s1")
	if len(released) != 0 || items[0].Status != "waiting_review" || items[1].ArmedAt != 0 {
		t.Fatalf("review must block later automatic messages: released=%v items=%+v", released, items)
	}
	processDeferredSessionWith(attentionEntry{SessionID: "s1", Status: "done", TS: 200}, release)
	if len(released) != 0 {
		t.Fatalf("same completion released a later message: %v", released)
	}
	if _, err := changeDeferredMessage([]byte(`{"id":"sent-first"}`), "cancel"); err != nil {
		t.Fatal(err)
	}
	processDeferredSessionWith(attentionEntry{SessionID: "s1", Status: "done", TS: 200}, release)
	if len(released) != 0 {
		t.Fatalf("cancellation released a message without another turn: %v", released)
	}
	processDeferredSessionWith(attentionEntry{SessionID: "s1", Status: "running", TS: 300}, release)
	processDeferredSessionWith(attentionEntry{SessionID: "s1", Status: "done", TS: 400}, release)
	if len(released) != 1 || released[0] != second.ID {
		t.Fatalf("next completion should release second message once: %v", released)
	}
}

func TestDeferredStoreSurvivesReadAndRejectsCorruption(t *testing.T) {
	useTempDeferred(t)
	if err := withDeferredStore(func(s *deferredStore) error {
		s.Items = append(s.Items, deferredMessage{ID: "sent-test", SessionID: "s1", Status: "queued", Text: "private"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if got := openDeferredForSession("s1"); len(got) != 1 || got[0].Text != "private" {
		t.Fatalf("host queue did not survive reload: %+v", got)
	}
	info, err := os.Stat(deferredFile())
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("deferred store must be owner-only: info=%v err=%v", info, err)
	}
	if err := os.WriteFile(deferredFile(), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readDeferredStore(); err == nil {
		t.Fatal("corrupt queue must not silently become empty")
	}
}

func TestDeferredAutoSendsOnlyOnePerCompletedTurn(t *testing.T) {
	useTempDeferred(t)
	if err := withDeferredStore(func(s *deferredStore) error {
		s.Items = []deferredMessage{
			{ID: "sent-a", SessionID: "s1", Policy: "after_turn", Status: "queued", CreatedAt: 1, ArmedAt: 100},
			{ID: "sent-b", SessionID: "s1", Policy: "after_turn", Status: "queued", CreatedAt: 2, ArmedAt: 100},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var released []string
	release := func(item deferredMessage) {
		released = append(released, item.ID)
		if err := withDeferredStore(func(s *deferredStore) error {
			for i := range s.Items {
				if s.Items[i].ID == item.ID {
					s.Items[i].Status = "sent"
				}
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	processDeferredSessionWith(attentionEntry{SessionID: "s1", Status: "done", TS: 200}, release)
	processDeferredSessionWith(attentionEntry{SessionID: "s1", Status: "done", TS: 200}, release)
	if len(released) != 1 || released[0] != "sent-a" {
		t.Fatalf("one completion released more than the first item: %v", released)
	}
	processDeferredSessionWith(attentionEntry{SessionID: "s1", Status: "running", TS: 300}, release)
	processDeferredSessionWith(attentionEntry{SessionID: "s1", Status: "done", TS: 400}, release)
	if len(released) != 2 || released[1] != "sent-b" {
		t.Fatalf("second item did not wait for the next completion: %v", released)
	}
}

func TestDeferredFastTurnAndIdempotentCancel(t *testing.T) {
	useTempDeferred(t)
	now := time.Now().UnixMilli()
	if err := withDeferredStore(func(s *deferredStore) error {
		s.Items = []deferredMessage{{ID: "sent-fast", SessionID: "s1", Policy: "after_review", Status: "queued", CreatedAt: now}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	processDeferredSessionWith(attentionEntry{SessionID: "s1", Status: "done", TurnStarted: now + 50, TS: now + 100}, func(deferredMessage) {
		t.Fatal("review item must not auto-send")
	})
	items := openDeferredForSession("s1")
	if items[0].Status != "waiting_review" || items[0].ArmedAt != now+50 {
		t.Fatalf("missed short turn did not reach review: %+v", items)
	}
	for i := 0; i < 2; i++ {
		if _, err := changeDeferredMessage([]byte(`{"id":"sent-fast"}`), "cancel"); err != nil {
			t.Fatalf("cancel retry %d: %v", i, err)
		}
	}
	if got := openDeferredForSession("s1"); len(got) != 0 {
		t.Fatalf("canceled item remains open: %+v", got)
	}
}

func TestDeferredPinsUploadedAttachments(t *testing.T) {
	useTempOutbox(t)
	if err := withDeferredStore(func(s *deferredStore) error {
		s.Items = []deferredMessage{{
			ID: "sent-image", SessionID: "s1", Status: "waiting_review",
			CreatedAt: time.Now().UnixMilli(), Attachments: []string{"image-keep-12345678.png"},
		}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !outboxPinnedUploads()["image-keep-12345678.png"] {
		t.Fatal("deferred attachment must survive upload pruning")
	}
}

func TestDeferredDeskRetryWaitsForRequestedDelay(t *testing.T) {
	useTempDeferred(t)
	now := time.Now().UnixMilli()
	if err := withDeferredStore(func(s *deferredStore) error {
		s.Items = []deferredMessage{{
			ID: "sent-retry", SessionID: "s1", Policy: "after_turn", Status: "releasing",
			CreatedAt: now - 100, ArmedAt: now - 100, ReleaseAt: now,
		}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := setDeferredResult("sent-retry", "queued", errors.New("someone typed at the desk 2s ago; retry in 7s")); err != nil {
		t.Fatal(err)
	}
	item := openDeferredForSession("s1")[0]
	if item.RetryAt < now+6_000 || item.RetryAt > now+8_000 {
		t.Fatalf("retry deadline ignored host delay: %+v", item)
	}
	called := false
	processDeferredSessionWith(attentionEntry{SessionID: "s1", Status: "done", TS: now + 100}, func(deferredMessage) { called = true })
	if called {
		t.Fatal("watcher retried before the desk hold expired")
	}
}

func TestDeferredFailedHeadBlocksDependentMessages(t *testing.T) {
	useTempDeferred(t)
	now := time.Now().UnixMilli()
	if err := withDeferredStore(func(s *deferredStore) error {
		s.Items = []deferredMessage{
			{ID: "sent-failed", SessionID: "s1", Policy: "after_turn", Status: "failed", CreatedAt: now - 2, ArmedAt: now - 10},
			{ID: "sent-next", SessionID: "s1", Policy: "after_turn", Status: "queued", CreatedAt: now - 1, ArmedAt: now - 10},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	processDeferredSessionWith(attentionEntry{SessionID: "s1", Status: "done", TS: now}, func(item deferredMessage) {
		t.Fatalf("later message bypassed failed head: %+v", item)
	})
	if got := openDeferredForSession("s1"); len(got) != 2 {
		t.Fatalf("failed head or dependent message vanished: %+v", got)
	}
}

func TestDeferredReplacedSessionRemainsEditable(t *testing.T) {
	useTempDeferred(t)
	now := time.Now().UnixMilli()
	if err := withDeferredStore(func(s *deferredStore) error {
		s.Items = []deferredMessage{{ID: "sent-old", SessionID: "old", Status: "queued", CreatedAt: now, Text: "continue"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	e := attentionEntry{SessionID: "new", TmuxSocket: "/tmp/socket", TmuxPane: "%1"}
	recent := []recentEntry{{attentionEntry: attentionEntry{SessionID: "old", TmuxSocket: "/tmp/socket", TmuxPane: "%1"}, ClearedTo: "new"}}
	ids := deferredPredecessors("new", e, recent)
	if len(ids) != 1 || ids[0] != "old" {
		t.Fatalf("replacement chain lost: %v", ids)
	}
	items, err := deferredSnapshotWithReplaced("new", ids)
	if err != nil || len(items) != 1 || items[0].Status != "stale" || items[0].Text != "continue" {
		t.Fatalf("old deferred message not visible for editing: items=%+v err=%v", items, err)
	}
}
