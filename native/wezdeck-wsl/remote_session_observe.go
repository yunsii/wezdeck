package main

// State-transition-gated observability for attention/redirect projection
// anomalies (docs/logging-conventions.md): emit once per signature change so
// 1 s polls never spam relay.log, while malformed entries or suppressed
// redirects leave an immediately greppable signal.

import (
	"sort"
	"strings"
	"sync"
)

var sessionAnomalyObs = struct {
	mu                     sync.Mutex
	lastMissingPaneSig     string
	lastSuppressedRedirect map[string]string // "from->to" -> reason
}{
	lastSuppressedRedirect: map[string]string{},
}

func observeMissingPaneEntries(ids []string) {
	sort.Strings(ids)
	sig := strings.Join(ids, ",")
	sessionAnomalyObs.mu.Lock()
	changed := sig != sessionAnomalyObs.lastMissingPaneSig
	sessionAnomalyObs.lastMissingPaneSig = sig
	sessionAnomalyObs.mu.Unlock()
	if !changed || len(ids) == 0 {
		return
	}
	sample := ids
	if len(sample) > 5 {
		sample = sample[:5]
	}
	relayLogf("attention_anomaly", "kind=entry_missing_pane count=%d ids=%s", len(ids), strings.Join(sample, ","))
}

func observeSuppressedRedirect(from, to, reason string) {
	key := from + "->" + to
	sessionAnomalyObs.mu.Lock()
	prev := sessionAnomalyObs.lastSuppressedRedirect[key]
	if prev == reason {
		sessionAnomalyObs.mu.Unlock()
		return
	}
	if len(sessionAnomalyObs.lastSuppressedRedirect) > 256 {
		clear(sessionAnomalyObs.lastSuppressedRedirect)
	}
	sessionAnomalyObs.lastSuppressedRedirect[key] = reason
	sessionAnomalyObs.mu.Unlock()
	relayLogf("session_redirect_suppressed", "from=%s to=%s reason=%s", from, to, reason)
}

func recentPendingIDsForPane(recent []recentEntry, socket, pane string) map[string]bool {
	if pane == "" {
		return nil
	}
	var out map[string]bool
	add := func(id string) {
		if !strings.HasPrefix(id, "pending-") {
			return
		}
		if out == nil {
			out = map[string]bool{}
		}
		out[id] = true
	}
	for _, r := range recent {
		if r.TmuxPane == pane && r.TmuxSocket == socket {
			add(r.SessionID)
			add(r.ClearedTo)
		}
	}
	return out
}
