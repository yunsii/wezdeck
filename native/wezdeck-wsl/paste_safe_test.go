package main

import "testing"

func TestPasteSafe(t *testing.T) {
	cases := map[string]string{
		"hi\x1b[201~\x1b[Z\x1b[Z": "hi[201~[Z[Z", // paste end + Shift+Tab: inert text
		"a\r\nb\rc":               "a\nb\nc",
		"tab\there\nline":         "tab\there\nline",
		"bell\x07del\x7fnul\x00":  "belldelnul",
		"csi\u009b31m":            "csi31m", // 8-bit CSI
		"中文 emoji 🙂 ok":           "中文 emoji 🙂 ok",
	}
	for in, want := range cases {
		if got := pasteSafe(in); got != want {
			t.Errorf("pasteSafe(%q) = %q, want %q", in, got, want)
		}
	}
}
