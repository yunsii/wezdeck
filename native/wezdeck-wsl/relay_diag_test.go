package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func approveDiagClient(t *testing.T, r *relay, cid string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "remote-devices.json")
	t.Setenv("WEZDECK_REMOTE_DEVICES", path)
	t.Setenv("WEZDECK_RELAY_OPEN_READS", "")
	dev := newTestDevice(t)
	writeDevices(t, path, dev)
	if _, err := r.deviceHello(dev.hello(t, "n-diag-"+cid), cid, "test"); err != nil {
		t.Fatalf("deviceHello(%s): %v", cid, err)
	}
	return path
}

func TestDiagRequestRoundTrip(t *testing.T) {
	t.Setenv("WEZDECK_REMOTE_UPLOADS", t.TempDir())
	r := &relay{}
	approveDiagClient(t, r, "cid-1")
	r.touchClient("cid-1")
	// an unapproved client that pinged the relay must never receive diag requests
	r.touchClient("cid-unapproved")

	if _, err := diagSubmit(json.RawMessage(`{"id":"nope","client":"abcdef0123456789","seq":0,"total":1,"data":"{}"}`), "cid-1", r); err == nil {
		t.Fatal("chunk for an unknown request must be refused")
	}

	// requests other tests left in the global table (they linger 10 s)
	before := map[string]bool{}
	diagMu.Lock()
	for k := range diagRequests {
		before[k] = true
	}
	diagMu.Unlock()
	done := make(chan map[string]any)
	go func() {
		done <- r.requestDiagnostics(5*time.Second, "test", json.RawMessage(`[{"do":"wait","ms":10}]`))
	}()
	// the page answers in two chunks once the request exists
	var id string
	for deadline := time.Now().Add(2 * time.Second); id == "" && time.Now().Before(deadline); {
		diagMu.Lock()
		for k := range diagRequests {
			if !before[k] {
				id = k
			}
		}
		diagMu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	if id == "" {
		t.Fatal("request never registered")
	}
	// a client the request was not pushed to cannot answer it
	stranger, _ := json.Marshal(map[string]any{"id": id, "client": "ffffffff00000000", "seq": 0, "total": 1, "data": "{}"})
	if _, err := diagSubmit(stranger, "cid-other", r); err == nil {
		t.Fatal("a cid that was not asked must be refused")
	}
	snap := `{"build":"x","steps":[{"do":"wait","frames":3}]}`
	for i, part := range []string{snap[:15], snap[15:]} {
		args, _ := json.Marshal(map[string]any{"id": id, "client": "abcdef0123456789", "seq": i, "total": 2, "data": part})
		if _, err := diagSubmit(args, "cid-1", r); err != nil {
			t.Fatal(err)
		}
	}
	out := <-done
	results := out["results"].([]diagResult)
	if out["clients"] != 1 || len(results) != 1 {
		t.Fatalf("want one result from one page, got %+v", out)
	}
	// and the asked cid cannot answer twice
	again, _ := json.Marshal(map[string]any{"id": id, "client": "abcdef0123456789", "seq": 0, "total": 1, "data": "{}"})
	if _, err := diagSubmit(again, "cid-1", r); err == nil {
		t.Fatal("a second answer from the same cid must be refused")
	}
	body, err := os.ReadFile(results[0].File)
	if err != nil || string(body) != snap {
		t.Fatalf("stored %q err=%v", body, err)
	}
}

// A page still open from a build before the rename answers with "phone":
// taken (the release's reload asks those pages), with a warning row naming
// the old field.
func TestDiagSubmitLegacyPhoneField(t *testing.T) {
	t.Setenv("WEZDECK_REMOTE_UPLOADS", t.TempDir())
	logFile, err := os.CreateTemp(t.TempDir(), "relay.log")
	if err != nil {
		t.Fatal(err)
	}
	diagMu.Lock()
	diagRequests = map[string]*diagRequest{} // none left from another test
	diagMu.Unlock()
	r := &relay{log: logFile}
	approveDiagClient(t, r, "cid-old")
	r.touchClient("cid-old")
	done := make(chan map[string]any)
	go func() { done <- r.requestDiagnostics(5*time.Second, "test", nil) }()
	var id string
	for deadline := time.Now().Add(2 * time.Second); id == "" && time.Now().Before(deadline); {
		diagMu.Lock()
		for k := range diagRequests {
			id = k
		}
		diagMu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	old, _ := json.Marshal(map[string]any{"id": id, "phone": "0123456789abcdef", "seq": 0, "total": 1, "data": "{}"})
	if _, err := diagSubmit(old, "cid-old", r); err != nil {
		t.Fatalf("an old page's answer must still be taken: %v", err)
	}
	out := <-done
	if results := out["results"].([]diagResult); len(results) != 1 || results[0].Client != "01234567" {
		t.Fatalf("got %+v", out)
	}
	logged, _ := os.ReadFile(logFile.Name())
	if !strings.Contains(string(logged), "event=diag_legacy_field") ||
		!strings.Contains(string(logged), "field=phone want=client") {
		t.Fatalf("no legacy warning in %q", logged)
	}
}

func TestDiagExcludesUnapprovedAndRevokedClients(t *testing.T) {
	t.Setenv("WEZDECK_REMOTE_UPLOADS", t.TempDir())
	r := &relay{}
	devicesPath := approveDiagClient(t, r, "cid-approved")
	r.touchClient("cid-approved")
	r.touchClient("cid-stranger")

	recent := r.recentClients()
	if len(recent) != 1 || recent[0] != "cid-approved" {
		t.Fatalf("recentClients must include only approved cids, got %v", recent)
	}
	pushed := r.pushToClients(relayFrame{T: "diag.request", ID: "d1"})
	if len(pushed) != 1 || pushed[0] != "cid-approved" {
		t.Fatalf("pushToClients must include only approved cids, got %v", pushed)
	}

	// Revoke mid-flight after a request targeted cid-approved: diagSubmit must refuse.
	diagMu.Lock()
	diagRequests["revoked-req"] = &diagRequest{
		deadline: time.Now().Add(time.Minute),
		id:       "revoked-req",
		targets:  map[string]bool{"cid-approved": true},
		parts:    map[string][]string{},
		answered: map[string]bool{},
		notify:   make(chan struct{}, 1),
	}
	diagMu.Unlock()
	defer func() {
		diagMu.Lock()
		delete(diagRequests, "revoked-req")
		diagMu.Unlock()
	}()
	writeDevices(t, devicesPath)
	args, _ := json.Marshal(map[string]any{"id": "revoked-req", "client": "abcdef0123456789", "seq": 0, "total": 1, "data": "{}"})
	if _, err := diagSubmit(args, "cid-approved", r); err == nil {
		t.Fatal("revoked client must not submit diagnostics")
	}
}
