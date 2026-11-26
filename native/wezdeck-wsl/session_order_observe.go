package main

import "sync"

type sessionOrderObservation struct {
	timeAt      int64
	timeSource  string
	orderAt     int64
	orderSource string
}

var sessionOrderSeen sync.Map

func sessionOrderChanged(old sessionOrderObservation, seen bool, current sessionOrderObservation) bool {
	if !seen {
		return current.timeSource == "window_activity" || current.timeSource == "transcript_mtime"
	}
	if old.orderAt != current.orderAt || old.orderSource != current.orderSource || old.timeSource != current.timeSource {
		return true
	}
	return (current.timeSource == "window_activity" || current.timeSource == "transcript_mtime") && old.timeAt != current.timeAt
}

func observeSessionOrder(card sessionCard, attentionTS int64) {
	current := sessionOrderObservation{card.TS, card.TimeSource, card.OrderAt, card.OrderSource}
	previous, seen := sessionOrderSeen.Swap(card.ID, current)
	old := sessionOrderObservation{}
	if seen {
		old = previous.(sessionOrderObservation)
	}
	if !sessionOrderChanged(old, seen, current) {
		return
	}
	relayLogf("session_order", "id=%s pane=%s status=%s old_time_at_ms=%d time_at_ms=%d old_time_source=%s time_source=%s old_order_at_ms=%d order_at_ms=%d old_order_source=%s order_source=%s attention_ts_ms=%d",
		card.ID, card.TmuxPane, card.Status, old.timeAt, current.timeAt, old.timeSource, current.timeSource,
		old.orderAt, current.orderAt, old.orderSource, current.orderSource, attentionTS)
}
