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

func TestAgyAccountLimitsByModelAndFreshness(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_AGY_STATUS_DIR", dir)
	if agyAccountLimits("Gemini 4 Neon (High)") != nil {
		t.Fatal("no snapshots: no limits")
	}
	now := time.Now().Unix()
	write := func(name string, ts int64, body string) {
		_ = os.WriteFile(filepath.Join(dir, name), []byte(`{"ts":`+strconv.FormatInt(ts, 10)+`,`+body+`}`), 0o600)
	}
	write("old.json", now-600, `"quota":{"gemini-5h":{"remaining_fraction":0.5,"reset_in_seconds":100}}`)
	write("_account.json", now-30, `"quota":{`+
		`"gemini-5h":{"remaining_fraction":0.9516,"reset_time":"2026-11-27T18:59:05Z","reset_in_seconds":15638},`+
		`"gemini-weekly":{"remaining_fraction":0.434,"reset_time":"2026-12-03T06:59:01Z","reset_in_seconds":490834},`+
		`"3p-5h":{"remaining_fraction":1,"reset_time":"1970-01-01T00:00:00Z","reset_in_seconds":0},`+
		`"3p-weekly":{"remaining_fraction":0.5,"reset_time":"2026-12-04T06:26:12Z","reset_in_seconds":575265}`+
		`}`)
	write("noquota.json", now, `"quota":null`)
	write("broken.json", now, `nope`)

	gem := agyAccountLimits("Gemini 4 Neon (High)")
	if gem == nil || gem.FiveHour == nil || gem.SevenDay == nil || gem.At != now-30 {
		t.Fatalf("gemini limits: %+v", gem)
	}
	if gem.FiveHour.UsedPercentage != 4.8 || gem.SevenDay.UsedPercentage != 56.6 {
		t.Fatalf("gemini percentages: 5h=%+v 7d=%+v", gem.FiveHour, gem.SevenDay)
	}
	if gem.FiveHour.ResetsAt == 0 || gem.SevenDay.ResetsAt == 0 {
		t.Fatalf("gemini resets_at should be parsed: 5h=%+v 7d=%+v", gem.FiveHour, gem.SevenDay)
	}

	tp := agyAccountLimits("Claude Sonnet 4.5")
	if tp == nil || tp.FiveHour == nil || tp.SevenDay == nil {
		t.Fatalf("3p limits: %+v", tp)
	}
	if tp.FiveHour.UsedPercentage != 0 || tp.FiveHour.ResetsAt != 0 {
		t.Fatalf("unused 3p-5h epoch-0 window must omit resets_at: %+v", tp.FiveHour)
	}
	if tp.SevenDay.UsedPercentage != 50 || tp.SevenDay.ResetsAt == 0 {
		t.Fatalf("3p-weekly: %+v", tp.SevenDay)
	}

	_ = os.Remove(filepath.Join(dir, "_account.json"))
	_ = os.Remove(filepath.Join(dir, "old.json"))
	write("stale.json", now-8*24*3600, `"quota":{"gemini-5h":{"remaining_fraction":0.2,"reset_in_seconds":60}}`)
	if agyAccountLimits("Gemini 4 Neon (High)") != nil {
		t.Fatal("a week-old snapshot must not be shown")
	}
}

func TestAgyContextSizeFromSnapshot(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_AGY_STATUS_DIR", dir)
	id := "bc0c1e21-bed2-4dd6-9848-c7f466052594"
	_ = os.WriteFile(filepath.Join(dir, id+".json"), []byte(`{"context_window":{"context_window_size":1048576}}`), 0o600)
	if got := agyContextSize(id); got != 1048576 {
		t.Fatalf("size %d", got)
	}
	if agyContextSize("../etc") != 0 || agyContextSize("missing-1") != 0 {
		t.Fatal("bad or unknown ids report nothing")
	}
}
