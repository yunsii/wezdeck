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
	got := localPending(client)
	if len(got) != 1 || got[0]["id"] != "req1" || got[0]["reason"] != "probe" {
		t.Fatalf("pending %+v", got)
	}
	diagMu.Lock()
	ok := diagRequests["req1"].targets[cid]
	diagRequests["req1"].answered[cid] = true
	diagMu.Unlock()
	if !ok {
		t.Fatal("the polling page becomes a target")
	}
	if again := localPending(client); len(again) != 0 {
		t.Fatalf("answered: nothing pending, got %+v", again)
	}
	found := false
	for _, seen := range recentLocalPages() {
		found = found || seen == cid
	}
	if !found {
		t.Fatal("a page that polled counts as seen")
	}
}
