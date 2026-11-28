package main

// Agent readiness detection, first-message submit verification, and
// structured telemetry for new-session creation (session_new.go / session_group.go).

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

var (
	agentReadyPollInterval = 250 * time.Millisecond
	agentTUISettleDuration = 500 * time.Millisecond
	agentStaticScreenWait  = 1500 * time.Millisecond
	sessionIDPollInterval  = 300 * time.Millisecond
	sessionIDStubWait      = 400 * time.Millisecond
	sessionNudgeFirstAfter = 2500 * time.Millisecond
	sessionNudgeRetryGap   = 3 * time.Second
	sessionNudgeMaxCount   = 2
)

type agentReadyInfo struct {
	Reason     string // trust_prompt | tui_ready | static_screen
	Command    string
	HasAgent   bool
	BannerSeen bool
	Duration   time.Duration
}

type newSessionTelemetry struct {
	Stage       string
	Pane        string
	Command     string
	SessionID   string
	WorktreeMS  int64
	ReadyMS     int64
	ReadyReason string
	BannerSeen  bool
	TrustMS     int64
	PasteMS     int64
	WaitIDMS    int64
	Nudges      int
	TotalMS     int64
}

// isLauncherLoadingBanner returns true when the pane only shows
// agent-launcher.sh's pre-exec banner ("Loading <agent> ..." / "Mode: ...").
// Returning ready while this banner is still on screen causes pasteToPane to
// write into the PTY before the agent TUI's input loop starts, so Enter can be
// swallowed while the pasted text stays unsubmitted in the composer.
func isLauncherLoadingBanner(screen string) bool {
	var lines []string
	for _, raw := range strings.Split(screen, "\n") {
		if line := strings.TrimSpace(raw); line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 || len(lines) > 4 {
		return false
	}
	if !strings.HasPrefix(lines[0], "Loading ") || !strings.HasSuffix(lines[0], "...") {
		return false
	}
	for _, line := range lines[1:] {
		if strings.HasPrefix(line, "Mode:") ||
			(strings.HasPrefix(line, "Loading ") && strings.HasSuffix(line, "...")) {
			continue
		}
		return false
	}
	return true
}

func isCodexConversationLocked(screen string) bool {
	return strings.Contains(strings.Join(strings.Fields(screen), " "),
		"This conversation is open in another app")
}

// waitAgentReady waits until the agent TUI has actually painted past the
// launcher's Loading banner and settled briefly, or surfaced a trust dialog.
// Shell/test-stub panes without a known agent binary keep the static-screen
// fallback so isolated cat/sh fixtures still work.
func waitAgentReady(socket, pane string, limit time.Duration) error {
	_, err := waitAgentReadyDetailed(socket, pane, limit)
	return err
}

func waitAgentReadyDetailed(socket, pane string, limit time.Duration) (agentReadyInfo, error) {
	started := time.Now()
	deadline := started.Add(limit)
	info := agentReadyInfo{}
	last, stable, tuiSince := "", time.Time{}, time.Time{}
	for time.Now().Before(deadline) {
		time.Sleep(agentReadyPollInterval)
		cmd, err := tmuxCmd(socket, "display-message", "-p", "-t", pane, "#{pane_current_command}").Output()
		if err != nil {
			info.Duration = time.Since(started)
			return info, errors.New("the agent pane closed while starting")
		}
		command := strings.TrimSpace(string(cmd))
		hasAgent := agentCommands[command] || paneHasAgentProcess(socket, pane)
		info.Command = command
		info.HasAgent = hasAgent
		if shells[command] && !hasAgent {
			last, stable, tuiSince = "", time.Time{}, time.Time{}
			continue
		}
		screen, _ := tmuxCmd(socket, "capture-pane", "-p", "-t", pane).Output()
		s := strings.TrimSpace(string(screen))
		if s == "" {
			last, stable, tuiSince = "", time.Time{}, time.Time{}
			continue
		}
		if isCodexConversationLocked(s) {
			info.Reason = "conversation_locked"
			info.Duration = time.Since(started)
			return info, errors.New("the Codex conversation is open in another app")
		}
		if isLauncherLoadingBanner(s) {
			info.BannerSeen = true
			last, stable, tuiSince = "", time.Time{}, time.Time{}
			continue
		}
		if kind, _ := detectWorkspaceTrustPrompt(s); kind != "" {
			info.Reason = "trust_prompt"
			info.Duration = time.Since(started)
			return info, nil
		}
		if hasAgent {
			if tuiSince.IsZero() {
				tuiSince = time.Now()
			}
			if time.Since(tuiSince) >= agentTUISettleDuration {
				info.Reason = "tui_ready"
				info.Duration = time.Since(started)
				return info, nil
			}
			continue
		}
		if s == last {
			if !stable.IsZero() && time.Since(stable) >= agentStaticScreenWait {
				info.Reason = "static_screen"
				info.Duration = time.Since(started)
				return info, nil
			}
			if stable.IsZero() {
				stable = time.Now()
			}
		} else {
			last, stable = s, time.Time{}
		}
	}
	info.Duration = time.Since(started)
	return info, fmt.Errorf("the agent did not come up within %s", limit.Round(time.Second))
}

func promptOpeningNeedle(prompt string) string {
	for _, raw := range strings.Split(prompt, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		compact := strings.Join(strings.Fields(line), "")
		runes := []rune(compact)
		if len(runes) < 2 {
			return ""
		}
		if len(runes) > 10 {
			runes = runes[:10]
		}
		return string(runes)
	}
	return ""
}

// promptStillUnsubmitted checks whether the bottom-most TUI composer line
// (› / ❯ / >) still holds the opening of prompt without having been submitted,
// while no trust dialog is active. Checking only the last composer line avoids
// matching a previously submitted history echo above an empty composer.
func promptStillUnsubmitted(screen, prompt string) bool {
	if kind, _ := detectWorkspaceTrustPrompt(screen); kind != "" {
		return false
	}
	needle := promptOpeningNeedle(prompt)
	if needle == "" {
		return false
	}
	lines := strings.Split(screen, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		matchedPrefix := false
		rest := ""
		for _, prefix := range []string{"›", "❯", ">"} {
			if strings.HasPrefix(trimmed, prefix) {
				matchedPrefix = true
				rest = strings.TrimSpace(strings.TrimPrefix(trimmed, prefix))
				break
			}
		}
		if !matchedPrefix {
			continue
		}
		// Found the bottom-most composer prompt line; decide based on it alone.
		if rest == "" {
			return false
		}
		combined := rest
		if i+1 < len(lines) {
			combined += strings.TrimSpace(lines[i+1])
		}
		compact := strings.Join(strings.Fields(combined), "")
		return strings.HasPrefix(compact, needle)
	}
	return false
}

func paneCommandAlive(socket, pane string) (string, bool) {
	out, err := tmuxCmd(socket, "display-message", "-p", "-t", pane, "#{pane_current_command}").Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

func requireNewSessionAttentionID() bool {
	if v := os.Getenv("WEZDECK_SESSION_NEW_REQUIRE_ID"); v == "1" {
		return true
	}
	if v := os.Getenv("WEZDECK_SESSION_NEW_REQUIRE_ID"); v == "0" {
		return false
	}
	return os.Getenv("WEZDECK_SESSION_NEW_CMD") == "" && os.Getenv("WEZDECK_SESSION_REUSE_CMD") == ""
}

// waitNewSessionIDWithNudge polls attention.json for the new pane's session id.
// If the prompt is visibly stuck unsubmitted in the TUI composer, it nudges
// Enter (never re-pasting text) up to sessionNudgeMaxCount times.
func waitNewSessionIDWithNudge(ctx context.Context, jobID, socket, pane, prompt string, before map[string]bool, limit time.Duration) (sessionID string, nudges int, paneDead bool, lastCmd string) {
	started := time.Now()
	deadline := started.Add(limit)
	lastNudge := time.Time{}
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			break
		}
		for id := range paneAttentionIDs(socket, pane) {
			if !before[id] {
				return id, nudges, false, lastCmd
			}
		}
		cmd, alive := paneCommandAlive(socket, pane)
		if !alive {
			return "", nudges, true, lastCmd
		}
		lastCmd = cmd
		if nudges < sessionNudgeMaxCount &&
			time.Since(started) >= sessionNudgeFirstAfter &&
			(lastNudge.IsZero() || time.Since(lastNudge) >= sessionNudgeRetryGap) {
			if screen, err := tmuxCmd(socket, "capture-pane", "-p", "-t", pane).Output(); err == nil {
				if promptStillUnsubmitted(string(screen), prompt) {
					nudges++
					lastNudge = time.Now()
					if out, err := tmuxCmd(socket, "send-keys", "-t", pane, "Enter").CombinedOutput(); err != nil {
						relayLogf("session_new_nudge", "job=%s pane=%s attempt=%d ok=false err=%q",
							jobID, pane, nudges, strings.TrimSpace(string(out)))
					} else {
						relayLogf("session_new_nudge", "job=%s pane=%s attempt=%d ok=true",
							jobID, pane, nudges)
					}
				}
			}
		}
		time.Sleep(sessionIDPollInterval)
	}
	for id := range paneAttentionIDs(socket, pane) {
		if !before[id] {
			return id, nudges, false, lastCmd
		}
	}
	return "", nudges, false, lastCmd
}
