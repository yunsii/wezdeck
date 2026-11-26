package main

// Output tokens and step-level effective output rate (Route A fallback) for
// transcripts.
//
// `turnOutput` sums each reply's output_tokens since attention `turn_started`
// for the phone's "4m 39s · ↓ 19.1k tokens" line.
//
// `stepRates` records per-LLM-step `(outputTokens, durationMS)` windows — from
// the preceding user/tool_result trigger to the reply timestamp (Claude/Codex),
// or from PLANNER_RESPONSE.created_at to the following step's created_at (Agy)
// — so local tool execution time is excluded from token-rate estimates.

import "time"

type outputMark struct {
	at int64 // ms
	n  int
}

type stepRateMark struct {
	at           int64 // ms
	outputTokens int
	durationMS   int64
}

type pendingStepOutput struct {
	startMS      int64
	outputTokens int
	remaining    int   // expected tool-call GENERIC steps before model stream ends
	lastToolMS   int64 // created_at of most recent GENERIC step seen
}

const (
	outputMarksKept   = 2000
	stepRatesKept     = 200
	maxStepDurationMS = 30 * 60 * 1000 // 30m sanity cap
)

func parseTranscriptMS(ts string) (int64, bool) {
	if ts == "" {
		return 0, false
	}
	at, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return 0, false
	}
	return at.UnixMilli(), true
}

func (t *transcript) markStepStart(ts string) {
	if at, ok := parseTranscriptMS(ts); ok {
		t.stepStartMS = at
	}
}

func (t *transcript) recordStepRate(at int64, outputTokens int, durationMS int64) {
	if outputTokens <= 0 || durationMS <= 0 || durationMS > maxStepDurationMS {
		return
	}
	t.stepRates = append(t.stepRates, stepRateMark{
		at:           at,
		outputTokens: outputTokens,
		durationMS:   durationMS,
	})
	if len(t.stepRates) > stepRatesKept {
		t.stepRates = t.stepRates[len(t.stepRates)-stepRatesKept:]
	}
}

func (t *transcript) markOutput(ts string, n int) {
	at, ok := parseTranscriptMS(ts)
	if !ok || n <= 0 {
		return
	}
	t.outputs = append(t.outputs, outputMark{at: at, n: n})
	if len(t.outputs) > outputMarksKept {
		t.outputs = t.outputs[len(t.outputs)-outputMarksKept:]
	}
	if t.stepStartMS > 0 && at > t.stepStartMS {
		t.recordStepRate(at, n, at-t.stepStartMS)
		t.stepStartMS = 0
	}
}

// markAgyStepOpen records an Agy PLANNER_RESPONSE whose created_at marks model
// invocation start. Only responses with toolCalls > 0 have a reliable end
// boundary: the Nth subsequent GENERIC row's created_at marks when the model
// finished emitting its last tool call (avoiding human/idle wait time on final
// replies and avoiding early-first-tool under-counting on parallel tool calls).
func (t *transcript) markAgyStepOpen(ts string, n, toolCalls int) {
	at, ok := parseTranscriptMS(ts)
	if !ok || n <= 0 {
		return
	}
	t.outputs = append(t.outputs, outputMark{at: at, n: n})
	if len(t.outputs) > outputMarksKept {
		t.outputs = t.outputs[len(t.outputs)-outputMarksKept:]
	}
	if toolCalls > 0 {
		t.pendingAgy = &pendingStepOutput{startMS: at, outputTokens: n, remaining: toolCalls}
	} else {
		t.pendingAgy = nil
	}
}

func (t *transcript) advanceAgyStep(rowType, ts string) {
	if t.pendingAgy == nil {
		return
	}
	at, ok := parseTranscriptMS(ts)
	if rowType == "GENERIC" {
		if ok && at > t.pendingAgy.startMS {
			t.pendingAgy.lastToolMS = at
		}
		t.pendingAgy.remaining--
		if t.pendingAgy.remaining <= 0 {
			if t.pendingAgy.lastToolMS > t.pendingAgy.startMS {
				t.recordStepRate(t.pendingAgy.lastToolMS, t.pendingAgy.outputTokens, t.pendingAgy.lastToolMS-t.pendingAgy.startMS)
			}
			t.pendingAgy = nil
		}
		return
	}
	// Interrupted by a non-tool row: flush using the last GENERIC step if any.
	if t.pendingAgy.lastToolMS > t.pendingAgy.startMS {
		t.recordStepRate(t.pendingAgy.lastToolMS, t.pendingAgy.outputTokens, t.pendingAgy.lastToolMS-t.pendingAgy.startMS)
	}
	t.pendingAgy = nil
}

// turnOutput: output tokens of the replies written at or after since (ms).
func (t *transcript) turnOutput(since int64) int {
	total := 0
	for i := len(t.outputs) - 1; i >= 0 && t.outputs[i].at >= since; i-- {
		total += t.outputs[i].n
	}
	return total
}

// latestTranscriptRate computes the latest and EWMA tok/s over non-noisy step
// windows (matching the OTel collector's noise filter and EWMA alpha=0.4).
func (t *transcript) latestTranscriptRate() (lastTokPerS, ewmaTokPerS float64, samples int) {
	for _, s := range t.stepRates {
		if s.outputTokens < otelRateMinTokens || s.durationMS < otelRateMinDurationMS {
			continue
		}
		rate := round1(float64(s.outputTokens) / (float64(s.durationMS) / 1000.0))
		if samples == 0 {
			ewmaTokPerS = rate
		} else {
			ewmaTokPerS = round1(0.4*rate + 0.6*ewmaTokPerS)
		}
		lastTokPerS = rate
		samples++
	}
	return lastTokPerS, ewmaTokPerS, samples
}
