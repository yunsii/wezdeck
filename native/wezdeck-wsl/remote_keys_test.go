package main

import "testing"

func TestAllowedKeys(t *testing.T) {
	for _, k := range []string{"Enter", "Escape", "C-c", "C-b", "1", "Tab"} {
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
