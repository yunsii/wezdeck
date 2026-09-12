package main

import "testing"

func TestRefreshClearAllSentinel(t *testing.T) {
	rows := []attentionRow{
		{status: "running", id: "a", body: "live-a"},
		{status: "waiting", id: "b", body: "live-b"},
		{status: "recent", id: "recent::x::1", body: "old"},
		{status: "__sentinel__", id: "__clear_all__", body: "clear all · 99 entries", rawBody: "clear all · 99 entries"},
	}
	rows = removeAttentionRowByID(rows, "a")
	rows = refreshClearAllSentinel(rows)
	var sentinel attentionRow
	found := false
	for _, r := range rows {
		if r.id == "__clear_all__" {
			sentinel = r
			found = true
			break
		}
	}
	if !found {
		t.Fatal("sentinel missing after refresh")
	}
	want := "clear all · 2 entries"
	if sentinel.body != want || sentinel.rawBody != want {
		t.Fatalf("sentinel body=%q rawBody=%q want %q", sentinel.body, sentinel.rawBody, want)
	}
}

func TestForgetAttentionEntryGuards(t *testing.T) {
	cases := []struct {
		name string
		row  attentionRow
		js   string
	}{
		{"sb", attentionRow{status: "sb", id: "sb::w-1"}, "/bin/true"},
		{"recent", attentionRow{status: "recent", id: "recent::x::1"}, "/bin/true"},
		{"sentinel", attentionRow{status: "__sentinel__", id: "__clear_all__"}, "/bin/true"},
		{"empty-script", attentionRow{status: "running", id: "sid"}, ""},
		{"empty-id", attentionRow{status: "running", id: ""}, "/bin/true"},
	}
	for _, tc := range cases {
		if forgetAttentionEntry(tc.row, tc.js) {
			t.Fatalf("%s: expected false", tc.name)
		}
	}
}
