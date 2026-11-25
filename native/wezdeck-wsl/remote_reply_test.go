package main

import (
	"reflect"
	"testing"
)

func TestReplyArgv(t *testing.T) {
	id := "req-20261125-120000-abcdef"
	cases := []struct {
		name string
		in   ticketReply
		want []string
		err  bool
	}{
		{"reply", ticketReply{ID: id, Text: "ok"}, []string{"reply", "--id", id, "--decision", "ok"}, false},
		{"reply continue", ticketReply{ID: id, Text: "ok", Continue: true}, []string{"reply", "--id", id, "--decision", "ok", "--continue"}, false},
		{"empty reply", ticketReply{ID: id, Text: "  "}, nil, true},
		{"approve without text", ticketReply{ID: id, Proposal: "p2", Verdict: "approve"}, []string{"fanout", "approve", "--parent", id, "--proposal", "p2", "--run"}, false},
		{"reject with reason", ticketReply{ID: id, Proposal: "p1", Verdict: "reject", Text: "split by layer"}, []string{"fanout", "reject", "--parent", id, "--proposal", "p1", "--reason", "split by layer"}, false},
		{"reject needs a reason", ticketReply{ID: id, Proposal: "p1", Verdict: "reject"}, nil, true},
		{"unknown verdict", ticketReply{ID: id, Proposal: "p1", Verdict: "maybe"}, nil, true},
		{"bad proposal id", ticketReply{ID: id, Proposal: "p1;rm", Verdict: "approve"}, nil, true},
		{"bad ticket id", ticketReply{ID: "../x", Proposal: "p1", Verdict: "approve"}, nil, true},
	}
	for _, c := range cases {
		got, err := replyArgv(c.in)
		if (err != nil) != c.err || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %v, %v; want %v (err=%v)", c.name, got, err, c.want, c.err)
		}
	}
}
