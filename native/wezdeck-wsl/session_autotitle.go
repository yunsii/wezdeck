package main

// Background session auto-titler for `wezdeck-wsl relay`.
//
// Why: Claude / Codex / Grok name a session once at the start and Agy only
// clips its first user message, so long sessions that move on to a new task
// keep a stale title in the web session list. This worker periodically scans
// active sessions (liveSessions), extracts the latest substantive user turns
// plus the newest assistant summary, and asks a host CLI via
// `scripts/runtime/session-autotitle.sh` (which routes through
// adversarial-review/lib/provider.sh) whether the title should update.
//
// Precedence: manual `/rename` (Claude custom-title or locked web rename) >
// auto-title (`~/.local/state/wezdeck/session-titles.json`) > agent native
// title (`readSessionTitle`). Never mutates any agent's transcript files.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	autoTitleDefaultInterval = 20 * time.Second
	autoTitleMinCooldown     = 90 * time.Second
	autoTitleTopicShiftAge   = 4 * time.Minute
	autoTitleExecTimeout     = 45 * time.Second
	autoTitleMaxPerSweep     = 2
	autoTitleMaxRunes        = 40
	autoTitlePruneAfter      = 30 * 24 * time.Hour
)

type autoTitleEntry struct {
	Title      string `json:"title"`
	Agent      string `json:"agent,omitempty"`
	UpdatedAt  int64  `json:"updated_at"` // unix ms
	UserTurns  int    `json:"user_turns"` // substantive user turns seen when generated
	LastDigest string `json:"last_digest,omitempty"`
	Locked     bool   `json:"locked,omitempty"` // explicit manual /rename
	Provider   string `json:"provider,omitempty"`
}

type autoTitleFile struct {
	Version int                       `json:"version"`
	Entries map[string]autoTitleEntry `json:"entries"`
}

var autoTitleCache struct {
	mu      sync.Mutex
	path    string
	info    os.FileInfo
	entries map[string]autoTitleEntry
}

func autoTitleStorePath() string {
	if p := strings.TrimSpace(os.Getenv("WEZDECK_SESSION_TITLES_FILE")); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".local", "state", "wezdeck", "session-titles.json")
}

func loadAutoTitles() map[string]autoTitleEntry {
	path := autoTitleStorePath()
	if path == "" {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	autoTitleCache.mu.Lock()
	defer autoTitleCache.mu.Unlock()
	if autoTitleCache.path == path && autoTitleCache.info != nil &&
		os.SameFile(autoTitleCache.info, info) &&
		autoTitleCache.info.ModTime().Equal(info.ModTime()) &&
		autoTitleCache.info.Size() == info.Size() {
		return cloneAutoTitles(autoTitleCache.entries)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var doc autoTitleFile
	if json.Unmarshal(data, &doc) != nil || doc.Entries == nil {
		return nil
	}
	autoTitleCache.path = path
	autoTitleCache.info = info
	autoTitleCache.entries = doc.Entries
	return cloneAutoTitles(doc.Entries)
}

func cloneAutoTitles(in map[string]autoTitleEntry) map[string]autoTitleEntry {
	out := make(map[string]autoTitleEntry, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func saveAutoTitleEntry(sessionID string, entry autoTitleEntry) error {
	path := autoTitleStorePath()
	if path == "" || sessionID == "" {
		return nil
	}
	autoTitleCache.mu.Lock()
	defer autoTitleCache.mu.Unlock()

	entries := map[string]autoTitleEntry{}
	if data, err := os.ReadFile(path); err == nil {
		var doc autoTitleFile
		if json.Unmarshal(data, &doc) == nil && doc.Entries != nil {
			entries = doc.Entries
		}
	}
	// Do not clobber a manual lock with an automatic update.
	if existing, ok := entries[sessionID]; ok && existing.Locked && !entry.Locked {
		return nil
	}
	entries[sessionID] = entry

	cutoff := time.Now().Add(-autoTitlePruneAfter).UnixMilli()
	for id, e := range entries {
		if id != sessionID && !e.Locked && e.UpdatedAt > 0 && e.UpdatedAt < cutoff {
			delete(entries, id)
		}
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(autoTitleFile{Version: 1, Entries: entries}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".session-titles-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(append(body, '\n')); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	_ = tmp.Chmod(0o600)
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if info, err := os.Stat(path); err == nil {
		autoTitleCache.path = path
		autoTitleCache.info = info
		autoTitleCache.entries = cloneAutoTitles(entries)
	}
	return nil
}

// lockSessionTitle records an explicit /rename from the web console so it takes
// effect immediately across all agents and prevents background auto-titling
// from overwriting the user's chosen title.
func lockSessionTitle(sessionID, agent, title string) {
	title = strings.TrimSpace(title)
	if sessionID == "" || title == "" {
		return
	}
	_ = saveAutoTitleEntry(sessionID, autoTitleEntry{
		Title:     clip(title, autoTitleMaxRunes),
		Agent:     agent,
		UpdatedAt: time.Now().UnixMilli(),
		Locked:    true,
	})
}

// resolveSessionTitle applies the unified title precedence:
// 1. Claude manual `/rename` (non-inherited custom-title)
// 2. Locked manual rename in session-titles.json (web `/rename` for any agent)
// 3. Background auto-generated title in session-titles.json
// 4. Agent native title (Claude ai-title, Grok summary, Codex index, Agy first turn)
func resolveSessionTitle(sessionID, path, agent string) string {
	if agent == "claude" && path != "" {
		if manual := claudeCustomTitle(path); manual != "" {
			return manual
		}
	}
	if sessionID != "" {
		if entries := loadAutoTitles(); entries != nil {
			if rec, ok := entries[sessionID]; ok && rec.Title != "" {
				return rec.Title
			}
		}
	}
	return readSessionTitle(path, agent)
}

var trivialAckWords = map[string]bool{
	"ok": true, "okay": true, "yes": true, "y": true, "no": true, "n": true,
	"go": true, "do it": true, "continue": true, "fix": true, "fix it": true,
	"ship": true, "ship it": true, "lgtm": true, "done": true, "thanks": true,
	"thx": true, "ty": true, "proceed": true, "sure": true, "yep": true,
	"可以": true, "好": true, "好的": true, "嗯": true, "行": true, "继续": true,
	"修复": true, "修吧": true, "改吧": true, "上线": true, "发布": true, "落地": true,
	"继续优化": true, "提交": true, "收到": true, "明白": true, "确认": true, "对": true,
	"是的": true, "没错": true, "同意": true, "开始": true, "开始吧": true, "弄吧": true,
}

func isSubstantivePrompt(text string) bool {
	s := strings.TrimSpace(text)
	if s == "" || strings.HasPrefix(s, "<") || strings.HasPrefix(s, "/") {
		return false
	}
	norm := strings.ToLower(strings.TrimRight(s, "。！!？?.，,~ "))
	if norm == "" || trivialAckWords[norm] {
		return false
	}
	return len([]rune(norm)) >= 4
}

type autoTitleContext struct {
	promptText       string
	substantiveUsers int
	digest           string
}

func buildAutoTitleContext(e attentionEntry, path, agent, currentTitle string) autoTitleContext {
	t, err := loadTranscript(path, agent)
	if err != nil || t == nil || len(t.messages) == 0 {
		return autoTitleContext{}
	}
	var allUsers []string
	substantive := 0
	lastAssistant := ""
	for _, m := range t.messages {
		switch m.Role {
		case "user":
			s := strings.TrimSpace(m.Text)
			if s == "" || strings.HasPrefix(s, "<") {
				continue
			}
			allUsers = append(allUsers, s)
			if isSubstantivePrompt(s) {
				substantive++
			}
		case "assistant":
			if s := strings.TrimSpace(m.Text); s != "" {
				lastAssistant = s
			}
		}
	}
	if substantive == 0 {
		return autoTitleContext{}
	}

	// Keep the last 5 user turns (preferring recent context so pivots dominate).
	const maxUsers = 5
	recentUsers := allUsers
	if len(recentUsers) > maxUsers {
		recentUsers = recentUsers[len(recentUsers)-maxUsers:]
	}

	var b strings.Builder
	if currentTitle != "" {
		fmt.Fprintf(&b, "Current title: %s\n", clip(currentTitle, 80))
	} else {
		b.WriteString("Current title: (none)\n")
	}
	if e.WindowName != "" && e.GitBranch != "" {
		fmt.Fprintf(&b, "Workspace: %s (%s)\n", e.WindowName, e.GitBranch)
	} else if e.GitBranch != "" {
		fmt.Fprintf(&b, "Branch: %s\n", e.GitBranch)
	} else if e.WindowName != "" {
		fmt.Fprintf(&b, "Window: %s\n", e.WindowName)
	}
	b.WriteString("\nRecent user messages (oldest to newest):\n")
	for i, u := range recentUsers {
		fmt.Fprintf(&b, "%d. %s\n", i+1, clip(strings.ReplaceAll(u, "\n", " "), 220))
	}
	if lastAssistant != "" {
		fmt.Fprintf(&b, "\nLatest assistant reply:\n%s\n", clip(strings.ReplaceAll(lastAssistant, "\n", " "), 300))
	}

	// Digest tracks substantive count + recent window so identical state never re-runs.
	h := sha256.New()
	fmt.Fprintf(h, "u=%d\n", substantive)
	for _, u := range recentUsers {
		h.Write([]byte(clip(u, 220)))
		h.Write([]byte{'\n'})
	}
	h.Write([]byte(clip(lastAssistant, 300)))
	digest := hex.EncodeToString(h.Sum(nil))[:16]

	return autoTitleContext{
		promptText:       b.String(),
		substantiveUsers: substantive,
		digest:           digest,
	}
}

func shouldAutoTitle(e attentionEntry, prev autoTitleEntry, hasPrev bool, ctx autoTitleContext, now time.Time) (string, bool) {
	if ctx.substantiveUsers == 0 || ctx.digest == "" {
		return "", false
	}
	if hasPrev && prev.Locked {
		return "", false
	}
	if hasPrev && prev.LastDigest == ctx.digest {
		return "", false
	}
	if !hasPrev || prev.Title == "" {
		return "first_turn", true
	}
	// Existing auto-title: wait until the turn settles so we see the full reply
	// and never compete with an active turn.
	if e.Status == "running" {
		return "", false
	}
	age := now.Sub(time.UnixMilli(prev.UpdatedAt))
	if age < autoTitleMinCooldown {
		return "", false
	}
	if ctx.substantiveUsers >= prev.UserTurns+2 {
		return "topic_shift", true
	}
	if ctx.substantiveUsers > prev.UserTurns && age >= autoTitleTopicShiftAge {
		return "topic_shift", true
	}
	return "", false
}

// parseAutoTitleOutput cleans raw single-shot CLI output into a safe title.
// Returns (title, unchanged, valid).
func parseAutoTitleOutput(raw string) (string, bool, bool) {
	line := ""
	for _, l := range strings.Split(raw, "\n") {
		s := strings.TrimSpace(l)
		if s == "" || strings.HasPrefix(s, "```") {
			continue
		}
		line = s
		break
	}
	if line == "" {
		return "", false, false
	}
	// Strip common bullet / prefix / quote wrappers.
	for _, prefix := range []string{"标题：", "标题:", "Title:", "title:", "- ", "* "} {
		if strings.HasPrefix(line, prefix) {
			line = strings.TrimSpace(strings.TrimPrefix(line, prefix))
		}
	}
	line = strings.Trim(line, "\"'`“”‘’《》【】「」")
	line = strings.TrimRight(line, "。.;；")
	line = strings.Trim(line, "\"'`“”‘’《》【】「」")
	line = strings.TrimSpace(line)
	if line == "" {
		return "", false, false
	}
	upper := strings.ToUpper(line)
	if upper == "UNCHANGED" || strings.HasPrefix(upper, "UNCHANGED ") || strings.HasPrefix(upper, "UNCHANGED(") {
		return "", true, true
	}
	if strings.Contains(line, "__PROVIDER_UNAVAILABLE__") ||
		strings.HasPrefix(strings.ToLower(line), "error:") ||
		strings.HasPrefix(line, "我先") ||
		strings.HasPrefix(line, "我将") ||
		strings.Contains(line, "计划文件") {
		return "", false, false
	}
	runes := []rune(line)
	if len(runes) < 2 {
		return "", false, false
	}
	if len(runes) > autoTitleMaxRunes {
		line = strings.TrimSpace(string(runes[:autoTitleMaxRunes]))
	}
	return line, false, true
}

// runAutoTitleFunc is injectable for tests; production routes through
// scripts/runtime/session-autotitle.sh → adversarial-review/lib/provider.sh.
var runAutoTitleFunc = runAutoTitleCLI

func runAutoTitleCLI(ctx context.Context, promptInput string) (output string, provider string, err error) {
	script := filepath.Join(repoRoot(), "scripts", "runtime", "session-autotitle.sh")
	if _, statErr := os.Stat(script); statErr != nil {
		return "", "", fmt.Errorf("autotitle script missing: %w", statErr)
	}
	args := []string{script}
	if cfg := loadAutoTitleConfig(); cfg.Provider != "" {
		args = append(args, "--provider", cfg.Provider)
	}
	cmd := exec.CommandContext(ctx, "bash", args...)
	cmd.Stdin = strings.NewReader(promptInput)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	for _, line := range strings.Split(stderr.String(), "\n") {
		if p, ok := strings.CutPrefix(strings.TrimSpace(line), "provider="); ok && p != "" {
			provider = p
		}
	}
	if err != nil {
		return "", provider, fmt.Errorf("%w: %s", err, clip(stderr.String(), 180))
	}
	return stdout.String(), provider, nil
}

type autoTitleBackoff struct {
	fails     int
	nextAfter time.Time
}

type autoTitler struct {
	mu      sync.Mutex
	backoff map[string]autoTitleBackoff
	now     func() time.Time
}

func newAutoTitler() *autoTitler {
	return &autoTitler{
		backoff: map[string]autoTitleBackoff{},
		now:     time.Now,
	}
}

func (a *autoTitler) recordFailure(sessionID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	b := a.backoff[sessionID]
	b.fails++
	delay := 2 * time.Minute
	if b.fails == 2 {
		delay = 5 * time.Minute
	} else if b.fails >= 3 {
		delay = 15 * time.Minute
	}
	b.nextAfter = a.now().Add(delay)
	a.backoff[sessionID] = b
}

func (a *autoTitler) clearFailure(sessionID string) {
	a.mu.Lock()
	delete(a.backoff, sessionID)
	a.mu.Unlock()
}

func (a *autoTitler) coolingDown(sessionID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	b, ok := a.backoff[sessionID]
	return ok && a.now().Before(b.nextAfter)
}

type autoTitleCandidate struct {
	id           string
	entry        attentionEntry
	path         string
	agent        string
	currentTitle string
	prev         autoTitleEntry
	hasPrev      bool
	ctx          autoTitleContext
	trigger      string
}

func (a *autoTitler) sweep(ctx context.Context, entries map[string]attentionEntry) int {
	saved := loadAutoTitles()
	now := a.now()
	var cands []autoTitleCandidate

	for id, e := range entries {
		if id == "" || a.coolingDown(id) {
			continue
		}
		path, agent := findTranscript(id)
		if path == "" || agent == "" {
			continue
		}
		// Never override Claude's manual /rename.
		if agent == "claude" && claudeCustomTitle(path) != "" {
			continue
		}
		prev, hasPrev := saved[id]
		if hasPrev && prev.Locked {
			continue
		}
		currentTitle := prev.Title
		if currentTitle == "" {
			currentTitle = readSessionTitle(path, agent)
		}
		tctx := buildAutoTitleContext(e, path, agent, currentTitle)
		trigger, ok := shouldAutoTitle(e, prev, hasPrev, tctx, now)
		if !ok {
			continue
		}
		cands = append(cands, autoTitleCandidate{
			id: id, entry: e, path: path, agent: agent,
			currentTitle: currentTitle, prev: prev, hasPrev: hasPrev,
			ctx: tctx, trigger: trigger,
		})
	}

	// Prioritize newest sessions first; cap per sweep so restarts never burst.
	sort.Slice(cands, func(i, j int) bool {
		return cands[i].entry.TS > cands[j].entry.TS
	})
	if len(cands) > autoTitleMaxPerSweep {
		cands = cands[:autoTitleMaxPerSweep]
	}

	processed := 0
	for _, c := range cands {
		if ctx.Err() != nil {
			break
		}
		a.runCandidate(ctx, c)
		processed++
	}
	return processed
}

func (a *autoTitler) runCandidate(parent context.Context, c autoTitleCandidate) {
	started := a.now()
	runCtx, cancel := context.WithTimeout(parent, autoTitleExecTimeout)
	defer cancel()

	raw, provider, err := runAutoTitleFunc(runCtx, c.ctx.promptText)
	elapsed := a.now().Sub(started).Milliseconds()
	if err != nil {
		a.recordFailure(c.id)
		outcome := "error"
		if runCtx.Err() == context.DeadlineExceeded {
			outcome = "timeout"
		}
		relayLogf("session_title_auto", "session_id=%s agent=%s provider=%s trigger=%s outcome=%s latency_ms=%d",
			c.id, c.agent, provider, c.trigger, outcome, elapsed)
		return
	}

	title, unchanged, valid := parseAutoTitleOutput(raw)
	if !valid {
		a.recordFailure(c.id)
		relayLogf("session_title_auto", "session_id=%s agent=%s provider=%s trigger=%s outcome=invalid latency_ms=%d",
			c.id, c.agent, provider, c.trigger, elapsed)
		return
	}
	a.clearFailure(c.id)

	if unchanged {
		kept := c.prev.Title
		if kept == "" {
			kept = c.currentTitle
		}
		_ = saveAutoTitleEntry(c.id, autoTitleEntry{
			Title:      kept,
			Agent:      c.agent,
			UpdatedAt:  a.now().UnixMilli(),
			UserTurns:  c.ctx.substantiveUsers,
			LastDigest: c.ctx.digest,
			Provider:   provider,
		})
		relayLogf("session_title_auto", "session_id=%s agent=%s provider=%s trigger=%s outcome=unchanged latency_ms=%d",
			c.id, c.agent, provider, c.trigger, elapsed)
		return
	}

	_ = saveAutoTitleEntry(c.id, autoTitleEntry{
		Title:      title,
		Agent:      c.agent,
		UpdatedAt:  a.now().UnixMilli(),
		UserTurns:  c.ctx.substantiveUsers,
		LastDigest: c.ctx.digest,
		Provider:   provider,
	})
	relayLogf("session_title_auto", "session_id=%s agent=%s provider=%s trigger=%s outcome=updated len=%d latency_ms=%d",
		c.id, c.agent, provider, c.trigger, len([]rune(title)), elapsed)
}

func autoTitleInterval() time.Duration {
	if raw := strings.TrimSpace(os.Getenv("WEZDECK_AUTOTITLE_INTERVAL_S")); raw != "" {
		if secs, err := strconv.Atoi(raw); err == nil && secs >= 5 {
			return time.Duration(secs) * time.Second
		}
	}
	return autoTitleDefaultInterval
}

func startAutoTitler(ctx context.Context) {
	titler := newAutoTitler()
	setActiveTitler(titler)
	cfg := loadAutoTitleConfig()
	relayLogf("session_title_auto", "outcome=started enabled=%t provider=%q interval_s=%d",
		cfg.Enabled, cfg.Provider, cfg.IntervalS)

	// Initial short delay so relay startup / websocket connect finishes first.
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			cfg = loadAutoTitleConfig()
			if cfg.Enabled {
				if entries, err := liveSessions(); err == nil && len(entries) > 0 {
					titler.sweep(ctx, entries)
				}
			}
			next := time.Duration(cfg.IntervalS) * time.Second
			if next < 10*time.Second {
				next = autoTitleDefaultInterval
			}
			timer.Reset(next)
		}
	}
}
