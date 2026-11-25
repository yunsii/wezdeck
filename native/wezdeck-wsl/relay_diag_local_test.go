package main

import (
	"encoding/json"
	"testing"
	"time"
)

func TestLocalPendingDiag(t *testing.T) {
	client := "0123456789abcdef"
	cid := "local-" + client
	diagMu.Lock()
	diagRequests["req1"] = &diagRequest{deadline: time.Now().Add(time.Minute), id: "req1", reason: "probe",
		steps: json.RawMessage(`[{"do":"query","selector":"x"}]`), targets: map[string]bool{},
		parts: map[string][]string{}, answered: map[string]bool{}, notify: make(chan struct{}, 1)}
	diagRequests["old"] = &diagRequest{deadline: time.Now().Add(-time.Second), targets: map[string]bool{},
		answered: map[string]bool{}}
	diagMu.Unlock()
	defer func() {
		diagMu.Lock()
		delete(diagRequests, "req1")
		delete(diagRequests, "old")
		diagMu.Unlock()
		// the seen page is global: later tests must not count it
		localMu.Lock()
		delete(localSeen, cid)
		localMu.Unlock()
	}()
	// other tests' requests may linger in the global table: look at ours
	pick := func(list []map[string]any) map[string]any {
		for _, r := range list {
			if r["id"] == "req1" {
				return r
			}
			if r["id"] == "old" {
				t.Fatal("an expired request is never offered")
			}
		}
		return nil
	}
	got := pick(localPending(client))
	if got == nil || got["reason"] != "probe" {
		t.Fatalf("pending %+v", got)
	}
	diagMu.Lock()
	ok := diagRequests["req1"].targets[cid]
	diagRequests["req1"].answered[cid] = true
	diagMu.Unlock()
	if !ok {
		t.Fatal("the polling page becomes a target")
	}
	if again := pick(localPending(client)); again != nil {
		t.Fatalf("answered: not offered again, got %+v", again)
	}
	found := false
	for _, seen := range recentLocalPages() {
		found = found || seen == cid
	}
	if !found {
		t.Fatal("a page that polled counts as seen")
	}
}
