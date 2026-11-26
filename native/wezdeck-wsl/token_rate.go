package main

// Session-level token output rate for the `session` RPC (Route B OTel primary,
// Route A transcript step-window fallback).
//
// Reads the loopback collector's atomic status.json with a 1-second mtime/size
// cache so 1 Hz session polling does zero unnecessary disk parsing.

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

type sessionTokenRate struct {
	Source        string  `json:"source"`                     // otel | transcript
	TokPerS       float64 `json:"tok_per_s"`                  // EWMA effective tok/s
	LastTokPerS   float64 `json:"last_tok_per_s"`             // latest step effective tok/s
	DecodeTokPerS float64 `json:"decode_tok_per_s,omitempty"` // pure decode tok/s when TTFT/SSE known
	TTFTMS        int64   `json:"ttft_ms,omitempty"`
	Samples       int     `json:"samples"`
	Profile       string  `json:"profile,omitempty"`
	UpdatedAtMS   int64   `json:"updated_at_ms,omitempty"`
}

var (
	otelStatusCacheMu      sync.Mutex
	otelStatusCachePath    string
	otelStatusCacheChecked time.Time
	otelStatusCacheMod     time.Time
	otelStatusCacheSize    int64
	otelStatusCacheSnap    *otelStatusSnapshot
)

func cachedOTelStatus() *otelStatusSnapshot {
	_, statusPath := defaultOTelPaths()
	if statusPath == "" {
		return nil
	}
	now := time.Now()
	otelStatusCacheMu.Lock()
	defer otelStatusCacheMu.Unlock()
	if otelStatusCachePath == statusPath && now.Sub(otelStatusCacheChecked) < time.Second {
		return otelStatusCacheSnap
	}
	otelStatusCachePath = statusPath
	otelStatusCacheChecked = now
	info, err := os.Stat(statusPath)
	if err != nil {
		otelStatusCacheSnap = nil
		return nil
	}
	if otelStatusCacheSnap != nil && info.ModTime().Equal(otelStatusCacheMod) && info.Size() == otelStatusCacheSize {
		return otelStatusCacheSnap
	}
	raw, err := os.ReadFile(statusPath)
	if err != nil {
		otelStatusCacheSnap = nil
		return nil
	}
	var snap otelStatusSnapshot
	if json.Unmarshal(raw, &snap) != nil {
		return otelStatusCacheSnap
	}
	otelStatusCacheMod = info.ModTime()
	otelStatusCacheSize = info.Size()
	otelStatusCacheSnap = &snap
	return otelStatusCacheSnap
}

// sessionTokenRateFor returns Route B (OTel) rate when available for sessionID,
// else Route A (transcript step-window) rate from t, else nil.
func sessionTokenRateFor(sessionID string, t *transcript) *sessionTokenRate {
	if sessionID != "" {
		if snap := cachedOTelStatus(); snap != nil && snap.RecentSessions != nil {
			if st := snap.RecentSessions[sessionID]; st != nil && st.Samples > 0 && st.EWMATokPerS > 0 {
				return &sessionTokenRate{
					Source:        "otel",
					TokPerS:       st.EWMATokPerS,
					LastTokPerS:   st.LastTokPerS,
					DecodeTokPerS: st.LastDecodeTokPerS,
					TTFTMS:        st.LastTTFTMS,
					Samples:       st.Samples,
					Profile:       st.Profile,
					UpdatedAtMS:   st.TSMS,
				}
			}
		}
	}
	if t != nil {
		last, ewma, n := t.latestTranscriptRate()
		if n > 0 && ewma > 0 {
			return &sessionTokenRate{
				Source:      "transcript",
				TokPerS:     ewma,
				LastTokPerS: last,
				Samples:     n,
			}
		}
	}
	return nil
}
