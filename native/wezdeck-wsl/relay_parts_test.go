package main

import (
	"strings"
	"testing"
)

func TestSplitPartsKeepsRunesWhole(t *testing.T) {
	body := strings.Repeat("会话a", 50000) // multi-byte runes across every cut
	parts := splitParts(body, 1000)
	if strings.Join(parts, "") != body {
		t.Fatal("parts do not join back to the body")
	}
	for i, p := range parts {
		if len(p) > 1000 {
			t.Fatalf("part %d is %d bytes", i, len(p))
		}
		if !strings.HasPrefix(p, "会") && !strings.HasPrefix(p, "话") && !strings.HasPrefix(p, "a") {
			t.Fatalf("part %d starts inside a rune: %q", i, p[:3])
		}
	}
	if got := splitParts("small", 1000); len(got) != 1 || got[0] != "small" {
		t.Fatalf("a small body stays one part: %q", got)
	}
}
