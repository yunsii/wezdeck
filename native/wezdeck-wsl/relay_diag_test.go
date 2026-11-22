package main

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestDiagRequestRoundTrip(t *testing.T) {
	t.Setenv("WEZDECK_REMOTE_UPLOADS", t.TempDir())
	r := &relay{}
	r.touchPhone("cid-1")

	if _, err := diagSubmit(json.RawMessage(`{"id":"nope","phone":"abcdef0123456789","seq":0,"total":1,"data":"{}"}`), "cid-1", r); err == nil {
		t.Fatal("chunk for an unknown request must be refused")
	}

	done := make(chan map[string]any)
	go func() {
		done <- r.requestDiagnostics(5*time.Second, "test", json.RawMessage(`[{"do":"wait","ms":10}]`))
	}()
	// the phone answers in two chunks once the request exists
	var id string
	for deadline := time.Now().Add(2 * time.Second); id == "" && time.Now().Before(deadline); {
		diagMu.Lock()
		for k := range diagRequests {
			id = k
		}
		diagMu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	if id == "" {
		t.Fatal("request never registered")
	}
	// a client the request was not pushed to cannot answer it
	stranger, _ := json.Marshal(map[string]any{"id": id, "phone": "ffffffff00000000", "seq": 0, "total": 1, "data": "{}"})
	if _, err := diagSubmit(stranger, "cid-other", r); err == nil {
		t.Fatal("a cid that was not asked must be refused")
	}
	snap := `{"build":"x","steps":[{"do":"wait","frames":3}]}`
	for i, part := range []string{snap[:15], snap[15:]} {
		args, _ := json.Marshal(map[string]any{"id": id, "phone": "abcdef0123456789", "seq": i, "total": 2, "data": part})
		if _, err := diagSubmit(args, "cid-1", r); err != nil {
			t.Fatal(err)
		}
	}
	out := <-done
	results := out["results"].([]diagResult)
	if out["phones"] != 1 || len(results) != 1 {
		t.Fatalf("want one result from one phone, got %+v", out)
	}
	// and the asked cid cannot answer twice
	again, _ := json.Marshal(map[string]any{"id": id, "phone": "abcdef0123456789", "seq": 0, "total": 1, "data": "{}"})
	if _, err := diagSubmit(again, "cid-1", r); err == nil {
		t.Fatal("a second answer from the same cid must be refused")
	}
	body, err := os.ReadFile(results[0].File)
	if err != nil || string(body) != snap {
		t.Fatalf("stored %q err=%v", body, err)
	}
}
