package main

// Large replies over the WebRTC DataChannel. Chrome takes at most 256 KiB in
// one DataChannel message (SDP max-message-size); a bigger SendText failed
// and the reply was dropped, so the phone waited out its 10 s RPC timeout
// ("remote host did not answer in time") — a session page asking for 180+
// messages came to ~270 KB. A reply above dcPartThreshold goes as `part`
// frames instead, which the page joins back (lib/remote-link.ts):
//
//	{t:"part", id, seq, total, data}   data = a slice of the reply's JSON text
//
// Only replies that could not have been sent whole are split, so a page
// without part support loses nothing it had before.

import (
	"encoding/json"
	"fmt"
	"unicode/utf8"

	"github.com/pion/webrtc/v4"
)

const (
	dcPartThreshold = 200 << 10 // send whole up to this; 256 KiB is the hard cap
	dcPartSize      = 60 << 10
)

type partFrame struct {
	T     string `json:"t"`
	ID    string `json:"id"`
	Seq   int    `json:"seq"`
	Total int    `json:"total"`
	Data  string `json:"data"`
}

// splitParts cuts body into slices of at most size bytes, never inside a
// UTF-8 sequence (each slice must survive JSON string encoding unchanged).
func splitParts(body string, size int) []string {
	var parts []string
	for len(body) > size {
		cut := size
		for cut > 0 && !utf8.RuneStart(body[cut]) {
			cut--
		}
		parts = append(parts, body[:cut])
		body = body[cut:]
	}
	return append(parts, body)
}

// sendOverDC sends one reply frame, split into parts when it is too big for
// a single DataChannel message. A failed send is returned, not dropped.
func sendOverDC(dc *webrtc.DataChannel, id string, body []byte) error {
	if len(body) <= dcPartThreshold {
		return dc.SendText(string(body))
	}
	parts := splitParts(string(body), dcPartSize)
	for i, p := range parts {
		frame, _ := json.Marshal(partFrame{T: "part", ID: id, Seq: i, Total: len(parts), Data: p})
		if err := dc.SendText(string(frame)); err != nil {
			return fmt.Errorf("part %d/%d: %w", i+1, len(parts), err)
		}
	}
	return nil
}
