package main

import (
	"path/filepath"
	"testing"
)

func TestSessionPinsPersistAndOnlyMigratePendingIDs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session-pins.json")
	pending := "pending-00000000-0000-4000-8000-000000000001"
	at, err := setSessionPin(path, pending, true)
	if err != nil || at <= 0 {
		t.Fatalf("pin: at=%d err=%v", at, err)
	}
	retry, err := setSessionPin(path, pending, true)
	if err != nil || retry != at {
		t.Fatalf("repeated pin: at=%d err=%v", retry, err)
	}
	redirects := []sessionRedirect{
		{From: pending, To: "real"},
		{From: "real", To: "fresh"},
	}
	pins, err := loadSessionPinsForList(path, redirects)
	if err != nil || len(pins) != 1 || pins["real"] != at {
		t.Fatalf("migration: pins=%v err=%v", pins, err)
	}
	if _, err := setSessionPin(path, "real", false); err != nil {
		t.Fatal(err)
	}
	pins, err = loadSessionPinsForList(path, redirects)
	if err != nil || len(pins) != 0 {
		t.Fatalf("unpin: pins=%v err=%v", pins, err)
	}
}
