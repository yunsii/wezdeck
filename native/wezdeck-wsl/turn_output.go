package main

// Output tokens of the running turn, for the phone's "4m 39s · ↓ 19.1k
// tokens": every reply's usage (counted once per message id) with its time,
// summed from the turn's start (attention turn_started). Lags the TUI's live
// counter by one reply — the transcript gets a reply's usage when it is
// written — but needs no screen reading.

import "time"

type outputMark struct {
	at int64 // ms
	n  int
}

const outputMarksKept = 2000

func (t *transcript) markOutput(ts string, n int) {
	at, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil || n <= 0 {
		return
	}
	t.outputs = append(t.outputs, outputMark{at: at.UnixMilli(), n: n})
	if len(t.outputs) > outputMarksKept {
		t.outputs = t.outputs[len(t.outputs)-outputMarksKept:]
	}
}

// turnOutput: output tokens of the replies written at or after since (ms).
func (t *transcript) turnOutput(since int64) int {
	total := 0
	for i := len(t.outputs) - 1; i >= 0 && t.outputs[i].at >= since; i-- {
		total += t.outputs[i].n
	}
	return total
}
