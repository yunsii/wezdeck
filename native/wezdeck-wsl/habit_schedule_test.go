package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestHabitScheduleReadAndValidation(t *testing.T) {
	if got := habitSystemdTime("Sat 2026-11-28 12:30:00 +08"); got != "2026-11-28T12:30:00+08:00" {
		t.Fatalf("systemd time=%q", got)
	}
	dir := t.TempDir()
	t.Setenv("WEZDECK_HABIT_SYSTEMD_DIR", dir)

	result, known, err := readRPC("habit.schedule.status", json.RawMessage("{}"))
	if err != nil || !known || result.(map[string]any)["installed"] != false {
		t.Fatalf("missing timer status: known=%t result=%v err=%v", known, result, err)
	}
	if !signedActions["habit.schedule.update"] {
		t.Fatal("schedule writes must require a device signature")
	}
	override := habitOverridePath()
	if err := os.MkdirAll(filepath.Dir(override), 0o700); err != nil {
		t.Fatal(err)
	}
	data := []byte("[Timer]\nOnCalendar=\n" +
		"OnCalendar=*-*-* 09:00:00 Asia/Singapore\n" +
		"OnCalendar=*-*-* 12:30:00 Asia/Singapore\n" +
		"OnCalendar=*-*-* 18:30:00 Asia/Singapore\n")
	if err := os.WriteFile(override, data, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := habitTimes()
	if err != nil || !reflect.DeepEqual(got, defaultHabitTimes) {
		t.Fatalf("override times=%v err=%v", got, err)
	}
	if err := os.WriteFile(filepath.Join(dir, habitTimer), []byte("timer"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		`{"op":"set_times","times":["09:00","12:30","12:30"]}`,
		`{"op":"set_times","times":["09:00","24:00","18:30"]}`,
	} {
		if _, err := habitScheduleUpdate(json.RawMessage(bad)); err == nil {
			t.Fatalf("invalid schedule accepted: %s", bad)
		}
	}
}

func TestHabitScheduleRestoresOverrideWhenReloadFails(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_HABIT_SYSTEMD_DIR", dir)
	fake := filepath.Join(dir, "systemctl")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_HABIT_SYSTEMCTL", fake)
	if err := os.WriteFile(filepath.Join(dir, habitTimer), []byte("timer"), 0o600); err != nil {
		t.Fatal(err)
	}
	override := habitOverridePath()
	if err := os.MkdirAll(filepath.Dir(override), 0o700); err != nil {
		t.Fatal(err)
	}
	old := []byte("[Timer]\nOnCalendar=\nOnCalendar=*-*-* 09:00:00 Asia/Singapore\n")
	if err := os.WriteFile(override, old, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := habitScheduleUpdate(json.RawMessage(`{"op":"set_times","times":["09:30","12:30","18:30"]}`))
	if err == nil {
		t.Fatal("systemctl failure did not fail the update")
	}
	got, err := os.ReadFile(override)
	if err != nil || string(got) != string(old) {
		t.Fatalf("override changed after failure: %q err=%v", got, err)
	}
}
