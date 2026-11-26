package main

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestAllowedKeys(t *testing.T) {
	for _, k := range []string{"Enter", "Escape", "Space", "C-c", "C-b", "1", "5", "6", "9", "Tab"} {
		if !allowedKeys[k] {
			t.Errorf("%s should be allowed", k)
		}
	}
	// anything else stays at the desk: no EOF, no suspend, no free text
	for _, k := range []string{"C-d", "C-z", "C-\\", "rm -rf /", "C-b C-b", ""} {
		if allowedKeys[k] {
			t.Errorf("%q must not be allowed", k)
		}
	}
}

func TestToolBackgroundFlag(t *testing.T) {
	tr := &transcript{tools: map[string]int{}}
	for _, l := range []string{
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"fg","name":"Bash","input":{"command":"sleep 60"}}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"bg","name":"Bash","input":{"command":"npm run dev","run_in_background":true}}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"ag","name":"Agent","input":{"prompt":"x","run_in_background":true}}]}}`,
	} {
		tr.feedLine([]byte(l))
	}
	if len(tr.messages) != 3 {
		t.Fatalf("messages: %+v", tr.messages)
	}
	if fg := tr.messages[0]; fg.Background || !fg.Pending {
		t.Errorf("foreground call: %+v", fg)
	}
	if !tr.messages[1].Background || !tr.messages[2].Background {
		t.Errorf("background calls: %+v %+v", tr.messages[1], tr.messages[2])
	}
}

func TestDeviceInfoCleanAndSeen(t *testing.T) {
	raw := &deviceInfo{Browser: "Chrome 157\x1b[31m", OS: "Android 16", UA: strings.Repeat("x", 500)}
	info := raw.clean()
	if strings.ContainsRune(info.Browser, '\x1b') || utf8.RuneCountInString(info.UA) > 301 { // 300 + "…"
		t.Fatalf("not cleaned: %+v", info)
	}
	if (*deviceInfo)(nil).clean() != nil {
		t.Fatal("nil info must stay nil")
	}
	now := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	d := deviceRecord{ID: "a"}
	if !d.seen(info, now) || d.Info == nil || d.SeenAt == "" {
		t.Fatalf("first sight must write: %+v", d)
	}
	if d.seen(info, now.Add(10*time.Minute)) {
		t.Error("same info within an hour must not write")
	}
	if !d.seen(info, now.Add(2*time.Hour)) {
		t.Error("an hour later must refresh seen_at")
	}
	other := *info
	other.Browser = "Chrome 158"
	if !d.seen(&other, now.Add(2*time.Hour+time.Minute)) || d.Info.Browser != "Chrome 158" {
		t.Error("changed info must write at once")
	}
	if d.seen(nil, now.Add(2*time.Hour+2*time.Minute)) || d.Info == nil {
		t.Error("an old client sending no info keeps what is stored")
	}
}
