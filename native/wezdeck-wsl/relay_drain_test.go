package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRelayWaitInflightCompletesBeforeTimeout(t *testing.T) {
	r := &relay{}
	r.inflight.Add(1)
	go func() {
		time.Sleep(40 * time.Millisecond)
		r.inflight.Done()
	}()
	if !r.waitInflight(500 * time.Millisecond) {
		t.Fatal("expected waitInflight to finish cleanly before timeout")
	}
}

func TestRelayWaitInflightRespectsTimeout(t *testing.T) {
	r := &relay{}
	r.inflight.Add(1)
	defer r.inflight.Done()
	if r.waitInflight(40 * time.Millisecond) {
		t.Fatal("expected waitInflight to return false when RPC exceeds drain timeout")
	}
}

func TestRelayPersistsAuthedBindingsAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_RELAY_CONTROL", filepath.Join(dir, "relay.sock"))

	first := &relay{}
	first.authorize("cid-1", "dev-approved")
	first.authorize("cid-2", "dev-other")
	first.forgetAuth("cid-2")

	second := &relay{}
	second.loadAuthed()
	if got := second.deviceOf("cid-1"); got != "dev-approved" {
		t.Fatalf("expected cid-1 to restore dev-approved, got %q", got)
	}
	if got := second.deviceOf("cid-2"); got != "" {
		t.Fatalf("expected forgotten cid-2 to stay empty, got %q", got)
	}
}

func TestClosedSessionsSetReadsMarkersOnce(t *testing.T) {
	dir := t.TempDir()
	att := filepath.Join(dir, "attention.json")
	t.Setenv("WEZDECK_ATTENTION_FILE", att)
	if err := markSessionClosed("sess-closed-1"); err != nil {
		t.Fatal(err)
	}
	set := closedSessionsSet()
	if !set["sess-closed-1"] {
		t.Fatalf("expected sess-closed-1 in closedSessionsSet, got %+v", set)
	}
	if set["sess-open-2"] {
		t.Fatalf("unexpected open session in closedSessionsSet")
	}
	if _, err := os.Stat(closedSessionMarker("sess-closed-1")); err != nil {
		t.Fatalf("marker missing: %v", err)
	}
}
