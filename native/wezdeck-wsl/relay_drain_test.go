package main

import (
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
