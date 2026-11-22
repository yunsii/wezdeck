package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// A device name is attacker-chosen and printed by --devices: no terminal
// control sequences survive (ESC, CR, BEL, OSC 52 …).
func TestPrintableStripsControlCharacters(t *testing.T) {
	got := printable("\x1b[1A\x1b[2K\rpending abcd iPhone\x07\x1b]52;c;aGk=\x07")
	if strings.ContainsAny(got, "\x1b\r\x07") {
		t.Fatalf("control characters left: %q", got)
	}
	if !strings.Contains(got, "pending abcd iPhone") {
		t.Fatalf("visible text lost: %q", got)
	}
}

// Resending a chunk replaces it, and the size limit counts the replacement:
// 1-byte chunks resent at 64 KB must not slip past uploadFileMax.
func TestUploadResentChunkCountsTowardsLimit(t *testing.T) {
	t.Setenv("WEZDECK_REMOTE_UPLOADS", t.TempDir())
	total := uploadChunksMax
	send := func(seq int, data []byte) error {
		args, _ := json.Marshal(map[string]any{"upload": "0123456789abcdef", "seq": seq, "total": total,
			"mime": "image/png", "data": base64.StdEncoding.EncodeToString(data)})
		_, err := uploadChunk(args)
		return err
	}
	for seq := 0; seq < total-1; seq++ {
		if err := send(seq, []byte{1}); err != nil {
			t.Fatal(err)
		}
	}
	big := make([]byte, uploadChunkMax)
	var err error
	for seq := 0; seq < total-1 && err == nil; seq++ {
		err = send(seq, big)
	}
	if err == nil || !strings.Contains(err.Error(), "MB") {
		t.Fatalf("resent chunks went past the limit unnoticed (err=%v)", err)
	}
}
