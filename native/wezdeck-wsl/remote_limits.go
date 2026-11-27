package main

// Account limits for the phone (docs/remote-sessions.md "Account limits"):
// Claude Code and Antigravity CLI (agy) hand their statusLine commands the
// account's rate limits on every refresh; scripts/runtime/{claude,agy}-statusline-tap.sh
// keep those snapshots under ~/.local/state/wezdeck/{claude,agy}-status/.
// Limits are account-wide, so the newest snapshot from any session is the answer.

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
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

type agyQuotaBucket struct {
	RemainingFraction *float64 `json:"remaining_fraction"`
	ResetTime         string   `json:"reset_time"`
	ResetInSeconds    float64  `json:"reset_in_seconds"`
}

func agyStatusDir() string {
	if p := os.Getenv("WEZDECK_AGY_STATUS_DIR"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local/state/wezdeck/agy-status")
}

func agyRateWindow(b *agyQuotaBucket, snapTS int64) *rateWindow {
	if b == nil || b.RemainingFraction == nil {
		return nil
	}
	used := (1 - *b.RemainingFraction) * 100
	if used < 0 {
		used = 0
	} else if used > 100 {
		used = 100
	}
	used = math.Round(used*10) / 10
	var resetsAt float64
	if b.ResetInSeconds > 0 {
		if b.ResetTime != "" {
			if parsed, err := time.Parse(time.RFC3339, b.ResetTime); err == nil && parsed.Unix() > 0 {
				resetsAt = float64(parsed.Unix())
			}
		}
		if resetsAt == 0 && snapTS > 0 {
			resetsAt = float64(snapTS) + b.ResetInSeconds
		}
	}
	return &rateWindow{UsedPercentage: used, ResetsAt: resetsAt}
}

func agyQuotaPrefix(model string, quota map[string]*agyQuotaBucket) string {
	has := func(prefix string) bool {
		return quota[prefix+"-5h"] != nil || quota[prefix+"-weekly"] != nil
	}
	want3p := model != "" && !strings.Contains(strings.ToLower(model), "gemini")
	if want3p && has("3p") {
		return "3p"
	}
	if has("gemini") {
		return "gemini"
	}
	if has("3p") {
		return "3p"
	}
	return ""
}

// agyAccountLimits returns the newest reported Agy model-group limits for the
// active model (gemini-5h/gemini-weekly for Gemini models, 3p-5h/3p-weekly for
// third-party models), or nil when no fresh statusLine snapshot exists.
func agyAccountLimits(model string) *accountLimits {
	entries, _ := os.ReadDir(agyStatusDir())
	var best *accountLimits
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(agyStatusDir(), entry.Name()))
		if err != nil {
			continue
		}
		var snap struct {
			TS    int64                      `json:"ts"`
			Quota map[string]*agyQuotaBucket `json:"quota"`
		}
		if json.Unmarshal(raw, &snap) != nil || len(snap.Quota) == 0 {
			continue
		}
		prefix := agyQuotaPrefix(model, snap.Quota)
		if prefix == "" {
			continue
		}
		five := agyRateWindow(snap.Quota[prefix+"-5h"], snap.TS)
		week := agyRateWindow(snap.Quota[prefix+"-weekly"], snap.TS)
		if five == nil && week == nil {
			continue
		}
		if best == nil || snap.TS > best.At {
			best = &accountLimits{FiveHour: five, SevenDay: week, At: snap.TS}
		}
	}
	if best != nil && time.Since(time.Unix(best.At, 0)) > 7*24*time.Hour {
		return nil
	}
	return best
}

// agyContextSize is the context window Agy reports for one conversation, or 0.
func agyContextSize(sessionID string) int {
	if !sessionIDPattern.MatchString(sessionID) {
		return 0
	}
	raw, err := os.ReadFile(filepath.Join(agyStatusDir(), sessionID+".json"))
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
