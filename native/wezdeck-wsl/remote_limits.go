package main

// Claude account limits for the phone (docs/remote-sessions.md "Account
// limits"): Claude Code hands its statusLine command the account's rate
// limits on every refresh; scripts/runtime/claude-statusline-tap.sh keeps
// that snapshot per session. Limits are account-wide, so the newest snapshot
// from any session is the answer.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

type rateWindow struct {
	UsedPercentage float64 `json:"used_percentage"`
	ResetsAt       float64 `json:"resets_at,omitempty"` // unix seconds (may be fractional)
}

type accountLimits struct {
	FiveHour *rateWindow `json:"five_hour,omitempty"`
	SevenDay *rateWindow `json:"seven_day,omitempty"`
	At       int64       `json:"at"` // when Claude Code reported them (unix seconds)
}

func claudeStatusDir() string {
	if p := os.Getenv("WEZDECK_CLAUDE_STATUS_DIR"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local/state/wezdeck/claude-status")
}

// claudeAccountLimits returns the newest reported limits, or nil when no
// session has reported any (statusLine tap not installed, or not logged in
// with a subscription).
func claudeAccountLimits() *accountLimits {
	entries, _ := os.ReadDir(claudeStatusDir())
	var best *accountLimits
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(claudeStatusDir(), entry.Name()))
		if err != nil {
			continue
		}
		var snap struct {
			TS         int64 `json:"ts"`
			RateLimits *struct {
				FiveHour *rateWindow `json:"five_hour"`
				SevenDay *rateWindow `json:"seven_day"`
			} `json:"rate_limits"`
		}
		if json.Unmarshal(raw, &snap) != nil || snap.RateLimits == nil ||
			(snap.RateLimits.FiveHour == nil && snap.RateLimits.SevenDay == nil) {
			continue
		}
		if best == nil || snap.TS > best.At {
			best = &accountLimits{FiveHour: snap.RateLimits.FiveHour, SevenDay: snap.RateLimits.SevenDay, At: snap.TS}
		}
	}
	// a week-old snapshot says nothing about now
	if best != nil && time.Since(time.Unix(best.At, 0)) > 7*24*time.Hour {
		return nil
	}
	return best
}

// claudeContextSize is the context window Claude Code reports for one
// session (it knows the 1M variants; the model catalog may not), or 0.
func claudeContextSize(sessionID string) int {
	if !sessionIDPattern.MatchString(sessionID) {
		return 0
	}
	raw, err := os.ReadFile(filepath.Join(claudeStatusDir(), sessionID+".json"))
	if err != nil {
		return 0
	}
	var snap struct {
		ContextWindow struct {
			Size int `json:"context_window_size"`
		} `json:"context_window"`
	}
	if json.Unmarshal(raw, &snap) != nil {
		return 0
	}
	return snap.ContextWindow.Size
}
