package main

import (
	"encoding/json"
	"testing"
)

// The relay must not widen what a remote browser can run: unknown or write
// actions are refused by the same allowlist as the Runtime bridge, before any
// process starts.
func TestRelayRPCRejectsActionsOutsideAllowlist(t *testing.T) {
	r := &relay{}
	for _, action := range []string{"reply", "close", "fanout", "", "../x"} {
		res := handleRPC(relayFrame{T: "rpc", ID: "r1", Action: action, Args: json.RawMessage(`{}`)}, "test", r)
		if res.T != "res" || res.ID != "r1" || res.OK == nil || *res.OK {
			t.Fatalf("action %q: want refused res, got %+v", action, res)
		}
	}
}

func TestRelayRPCRejectsUnsafeArgs(t *testing.T) {
	r := &relay{}
	res := handleRPC(relayFrame{T: "rpc", ID: "r2", Action: "show", Args: json.RawMessage(`{"id":"T1; rm -rf /"}`)}, "test", r)
	if res.OK == nil || *res.OK {
		t.Fatalf("want invalid value refused, got %+v", res)
	}
}

func TestRelayFrameRoundTrip(t *testing.T) {
	ok := true
	body, _ := json.Marshal(relayFrame{T: "res", Cid: "c1", ID: "r3", OK: &ok, Result: map[string]any{"v": 1}})
	var back relayFrame
	if err := json.Unmarshal(body, &back); err != nil || back.Cid != "c1" || back.OK == nil || !*back.OK {
		t.Fatalf("round trip: %s → %+v (%v)", body, back, err)
	}
}

func TestCandidateSummary(t *testing.T) {
	sdp := "v=0\na=candidate:1 1 udp 2122260223 abcd-1234.local 54321 typ host generation 0\n" +
		"a=candidate:2 1 udp 2122194687 192.168.3.20 54322 typ host\n" +
		"a=candidate:3 1 udp 1686052607 203.0.113.9 40000 typ srflx raddr 0.0.0.0 rport 0\n"
	if got := candidateSummary(sdp); got != "host=2(mdns=1) srflx=1" {
		t.Fatalf("got %q", got)
	}
}
