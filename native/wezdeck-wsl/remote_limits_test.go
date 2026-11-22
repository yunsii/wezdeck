package main

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestClaudeAccountLimitsNewestSnapshotWins(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_CLAUDE_STATUS_DIR", dir)
	if claudeAccountLimits() != nil {
		t.Fatal("no snapshots: no limits")
	}
	now := time.Now().Unix()
	write := func(name string, ts int64, body string) {
		_ = os.WriteFile(filepath.Join(dir, name), []byte(`{"session_id":"x","ts":`+strconv.FormatInt(ts, 10)+`,`+body+`}`), 0o600)
	}
	write("old.json", now-600, `"rate_limits":{"five_hour":{"used_percentage":10,"resets_at":1},"seven_day":{"used_percentage":5}}`)
	write("new.json", now-60, `"rate_limits":{"five_hour":{"used_percentage":42.5,"resets_at":1795330000.5},"seven_day":{"used_percentage":18,"resets_at":1795900000}}`)
	write("nolimits.json", now, `"rate_limits":null`)
	write("broken.json", now, `nope`)
	got := claudeAccountLimits()
	if got == nil || got.FiveHour == nil || got.FiveHour.UsedPercentage != 42.5 || got.SevenDay.UsedPercentage != 18 || got.At != now-60 {
		t.Fatalf("limits: %+v", got)
	}
	_ = os.Remove(filepath.Join(dir, "new.json"))
	_ = os.Remove(filepath.Join(dir, "old.json"))
	write("stale.json", now-8*24*3600, `"rate_limits":{"five_hour":{"used_percentage":1}}`)
	if claudeAccountLimits() != nil {
		t.Fatal("a week-old snapshot must not be shown")
	}
}

func TestClaudeContextSizeFromSnapshot(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_CLAUDE_STATUS_DIR", dir)
	id := "9d29cac4-4401-4b94-952f-41772658af3f"
	_ = os.WriteFile(filepath.Join(dir, id+".json"), []byte(`{"context_window":{"context_window_size":1000000}}`), 0o600)
	if got := claudeContextSize(id); got != 1000000 {
		t.Fatalf("size %d", got)
	}
	if claudeContextSize("../etc") != 0 || claudeContextSize("missing-1") != 0 {
		t.Fatal("bad or unknown ids report nothing")
	}
}
